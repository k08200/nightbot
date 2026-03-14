import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Config, loadConfig } from "./config.js";
import { checkDecisionResponses, classifyEscalation, escalate, Level, startEscalationTimer, stopEscalationTimer } from "./escalation.js";
import { formatGateReport, gateFailureSummary, runGates } from "./gate.js";
import { LLM } from "./llm.js";
import { createPlan, getNextTask, type Plan, replan, savePlan } from "./planner.js";
import { formatProbeFailures, runProbeVerification } from "./probeai.js";
import { runScout, type ScoutResult, saveReport } from "./scout.js";
import { createTask, loadTasks, moveTask, type Task } from "./task.js";
import { log } from "./utils.js";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const MAX_CONSECUTIVE_FAILURES = 3;

export async function startOrchestrator(config?: Config): Promise<void> {
  config = config ?? loadConfig();
  const llm = new LLM(config.llm.apiKey, config.llm.baseUrl);
  const completedIds = new Set<string>();
  const failureCount = new Map<string, number>();
  let consecutiveErrors = 0;
  let running = true;

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  log("[nightbot] Starting...");

  if (!(await llm.isAvailable())) {
    log("[nightbot] Claude API not reachable. Check ANTHROPIC_API_KEY.");
    return;
  }

  startEscalationTimer();

  // Crash recovery: move any stuck "running" tasks back to "pending"
  recoverRunningTasks(config);

  log("[nightbot] Claude API connected");
  log(`[nightbot] scout model: ${config.models.scout}`);

  let plan = await loadOrCreatePlan(config, llm);
  const MAX_IDLE_MINUTES = 15;
  let idleSince: number | null = null;

  while (running) {
    try {
      // Check if human responded to any escalations
      const resolved = checkDecisionResponses(config);
      if (resolved.length > 0) {
        log(`[nightbot] ${resolved.length} escalation(s) resolved`);
      }

      const nextId = getNextTask(plan, completedIds);

      if (!nextId) {
        const pending = loadTasks(config.paths.queue, "pending");
        if (pending.length > 0) {
          log(`[nightbot] ${pending.length} new tasks, replanning...`);
          plan = await createPlan(pending, config, llm);
          savePlan(plan, config.paths.plans);
          idleSince = null;
          continue;
        }

        // Auto-stop after MAX_IDLE_MINUTES with no tasks
        if (!idleSince) {
          idleSince = Date.now();
          log("[nightbot] No tasks. Waiting...");
        }
        const idleMin = Math.round((Date.now() - idleSince) / 60_000);
        if (idleMin >= MAX_IDLE_MINUTES) {
          log(`[nightbot] Idle for ${idleMin} minutes. Auto-stopping.`);
          break;
        }
        await sleep(config.scheduler.checkIntervalSeconds * 1000);
        continue;
      }

      idleSince = null;

      // Skip tasks that have failed too many times
      const failures = failureCount.get(nextId) ?? 0;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        log(`[nightbot] Skipping ${nextId}: failed ${failures} times consecutively`);
        completedIds.add(nextId);
        continue;
      }

      const task = findTask(nextId, plan, config);
      if (!task) {
        completedIds.add(nextId);
        continue;
      }

      log(`[nightbot] Assigning: ${task.id} — ${task.question}`);
      moveTask(task, config.paths.queue, "running");

      const result = await runScout(task, config, llm);
      saveReport(result, config.paths.reports);

      if (result.escalated) {
        const level = classifyEscalation(result.report, result.escalationReason);
        await escalate(
          `Task "${task.question}" needs input:\n${result.escalationReason.slice(0, 500)}`,
          Math.max(level, Level.NOTIFY),
          config,
          result.report.slice(0, 1000),
        );
        moveTask(task, config.paths.queue, "escalated");
        failureCount.set(nextId, failures + 1);
      } else if (task.mode === "implement" && result.diff?.trim()) {
        const handled = await handleImplementResult(task, result, config, llm);
        if (handled) {
          completedIds.add(nextId);
          failureCount.delete(nextId);
        } else {
          failureCount.set(nextId, failures + 1);
          const newCount = failures + 1;
          if (newCount >= MAX_CONSECUTIVE_FAILURES) {
            log(`[nightbot] Task ${task.id} failed ${newCount} times, giving up`);
            await escalate(
              `Task "${task.question}" failed ${newCount} consecutive times and has been abandoned`,
              Level.NOTIFY,
              config,
              result.report.slice(0, 1000),
            );
          }
        }
      } else {
        moveTask(task, config.paths.queue, "done");
        completedIds.add(nextId);
        failureCount.delete(nextId);
      }

      consecutiveErrors = 0;
      log(`[nightbot] Done: ${task.id} (${result.iterations} iters, ${(result.durationMs / 1000).toFixed(0)}s)`);

      try {
        log(`[nightbot] Replanning...`);
        const replanTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("replan timeout (60s)")), 60_000),
        );
        plan = await Promise.race([replan(plan, result.report, config, llm), replanTimeout]);
        savePlan(plan, config.paths.plans);
        log(`[nightbot] Replan done, ${plan.executionOrder.length} tasks in plan`);
      } catch (replanErr) {
        log(`[nightbot] Replan failed (non-fatal): ${String(replanErr).slice(0, 200)}`);
      }

    } catch (err) {
      consecutiveErrors++;
      log(`[nightbot] Error (${consecutiveErrors}/${MAX_CONSECUTIVE_FAILURES}): ${String(err).slice(0, 500)}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_FAILURES) {
        log(`[nightbot] ${MAX_CONSECUTIVE_FAILURES} consecutive loop errors, shutting down`);
        await escalate(
          `Orchestrator hit ${MAX_CONSECUTIVE_FAILURES} consecutive errors and is shutting down`,
          Level.URGENT,
          config,
          String(err).slice(0, 1000),
        );
        break;
      }
    }

    await sleep(config.scheduler.checkIntervalSeconds * 1000);
  }

  stopEscalationTimer();
  log("[nightbot] Stopped.");
}

async function loadOrCreatePlan(config: Config, llm: LLM): Promise<Plan> {
  const planPath = resolve(config.paths.plans, "current.json");
  if (existsSync(planPath)) {
    const plan = JSON.parse(readFileSync(planPath, "utf-8")) as Plan;
    log(`[nightbot] Loaded plan: ${plan.tasks?.length ?? 0} tasks`);
    return plan;
  }

  const tasks = loadTasks(config.paths.queue, "pending");
  if (tasks.length === 0) {
    log("[nightbot] No tasks. Add with: nightbot add 'question'");
    return { tasks: [], executionOrder: [], reasoning: "empty" };
  }

  log(`[nightbot] Creating plan from ${tasks.length} tasks...`);
  const plan = await createPlan(tasks, config, llm);
  savePlan(plan, config.paths.plans);
  return plan;
}

function findTask(taskId: string, plan: Plan, config: Config): Task | null {
  const all = loadTasks(config.paths.queue);

  // Direct ID match (queue task IDs match plan IDs)
  const found = all.find(t => t.id === taskId);
  if (found) return found;

  // Planner often generates new IDs. Try to match by name against pending queue tasks.
  const planTask = plan.tasks.find(t => t.id === taskId);
  if (planTask) {
    const pending = all.filter(t => t.status === "pending");
    const nameMatch = pending.find(t =>
      t.question.toLowerCase().includes(planTask.name.toLowerCase()) ||
      planTask.name.toLowerCase().includes(t.question.toLowerCase().slice(0, 30)),
    );
    if (nameMatch) return nameMatch;

    // Last resort: return first pending implement task if available
    const firstPending = pending[0];
    if (firstPending) return firstPending;

    const type = (planTask.type ?? "feasibility") as Task["type"];
    return createTask(planTask.name, type);
  }

  return null;
}

// ─── Crash recovery ─────────────────────────────────────────

function recoverRunningTasks(config: Config): void {
  const running = loadTasks(config.paths.queue, "running");
  if (running.length === 0) return;

  log(`[nightbot] Recovering ${running.length} stuck task(s) from previous run`);
  for (const task of running) {
    log(`[nightbot]   ${task.id} (running → pending)`);
    moveTask(task, config.paths.queue, "pending");
  }
}

// ─── Implement mode: gate check → branch → PR ───────────────

async function handleImplementResult(
  task: Task,
  result: ScoutResult,
  config: Config,
  llm?: LLM,
): Promise<boolean> {
  if (!result.diff?.trim() || !result.changedFiles?.length) {
    log("[gate] No changes to apply");
    moveTask(task, config.paths.queue, "done");
    return true;
  }

  const repoPath = task.targetRepo ?? task.context;
  if (!repoPath) {
    log("[gate] No target repo path, skipping gates");
    moveTask(task, config.paths.queue, "done");
    return true;
  }

  let currentResult = result;
  const maxAttempts = config.gateRetry.enabled ? config.gateRetry.maxAttempts : 0;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const isRetry = attempt > 0;
    const label = isRetry ? `[gate:retry ${attempt}/${maxAttempts}]` : "[gate]";

    // Run gates against the diff
    log(`${label} Running code gates...`);
    const gateReport = runGates(repoPath, currentResult.diff ?? "");
    const reportText = formatGateReport(gateReport);

    // Save gate report
    mkdirSync(config.paths.reports, { recursive: true });
    const suffix = isRetry ? `-gate-retry${attempt}` : "-gate";
    const gatePath = resolve(config.paths.reports, `${new Date().toISOString().slice(0, 10)}-${task.id}${suffix}.md`);
    writeFileSync(gatePath, reportText);
    log(`${label} Report: ${gatePath}`);

    if (gateReport.passed) {
      log(`${label} PASSED (${gateReport.warnCount} warnings)`);

      // ProbeAI verification (if enabled)
      if (config.probeai.enabled) {
        log(`${label} Running ProbeAI verification...`);
        const probeReport = await runProbeVerification(repoPath, config.probeai.scenarioDir);

        if (!probeReport.passed) {
          log(`${label} ProbeAI FAILED: ${probeReport.summary}`);

          if (attempt < maxAttempts && llm && config.gateRetry.enabled) {
            const probeSummary = formatProbeFailures(probeReport.results);
            log(`${label} Re-running scout with ProbeAI feedback...`);

            const fixTask: Task = {
              ...task,
              question: `Fix ProbeAI test failures for: ${task.question}\n\nTest failures:\n${probeSummary}\n\nFix these issues in the existing code. Do NOT introduce new features.`,
            };

            const fixResult = await runScout(fixTask, config, llm);
            saveReport(fixResult, config.paths.reports);

            if (fixResult.diff?.trim() && fixResult.changedFiles?.length) {
              currentResult = fixResult;
              continue;
            }

            log(`${label} Scout produced no changes on ProbeAI retry`);
          }

          await escalate(
            `Task "${task.question}" failed ProbeAI verification (after ${attempt + 1} attempt(s)):\n${probeReport.summary}`,
            Level.NOTIFY,
            config,
            formatProbeFailures(probeReport.results).slice(0, 1000),
          );
          moveTask(task, config.paths.queue, "failed");
          return false;
        }

        log(`${label} ProbeAI PASSED: ${probeReport.summary}`);
      }

      applyChanges(repoPath, task, currentResult);
      moveTask(task, config.paths.queue, "done");
      return true;
    }

    log(`${label} FAILED (${gateReport.failCount} failures)`);

    // If retries are available and LLM is provided, re-run scout with gate feedback
    if (attempt < maxAttempts && llm && config.gateRetry.enabled) {
      const summary = gateFailureSummary(gateReport);
      log(`${label} Re-running scout with gate feedback...`);

      const fixTask: Task = {
        ...task,
        question: `Fix gate failures for: ${task.question}\n\nGate failures:\n${summary}\n\nFix these issues in the existing code. Do NOT introduce new features.`,
      };

      const fixResult = await runScout(fixTask, config, llm);
      saveReport(fixResult, config.paths.reports);

      if (fixResult.diff?.trim() && fixResult.changedFiles?.length) {
        currentResult = fixResult;
        continue;
      }

      log(`${label} Scout produced no changes on retry`);
    }

    // Final failure: escalate
    const summary = gateFailureSummary(gateReport);
    await escalate(
      `Task "${task.question}" failed code gate (after ${attempt + 1} attempt(s)):\n${summary}`,
      Level.NOTIFY,
      config,
      reportText.slice(0, 1000),
    );
    moveTask(task, config.paths.queue, "failed");
    return false;
  }

  moveTask(task, config.paths.queue, "failed");
  return false;
}

function applyChanges(repoPath: string, task: Task, result: ScoutResult): void {
  if (!result.changedFiles?.length) return;

  const branch = `nightbot/${task.id}`;
  const gitOpts = { cwd: repoPath, encoding: "utf-8" as const, stdio: "pipe" as const };

  // Stash any dirty files (e.g. nightbot.log) so checkout doesn't fail
  let stashed = false;
  try {
    const stashOut = execSync("git stash --include-untracked", gitOpts).trim();
    stashed = !stashOut.includes("No local changes");
  } catch { /* nothing to stash */ }

  try {
    execSync(`git checkout -b ${branch}`, gitOpts);

    for (const file of result.changedFiles) {
      const filePath = resolve(repoPath, file.path);
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(filePath, file.content);
    }

    execSync("git add -A", gitOpts);
    execSync(`git commit -m "nightbot: ${task.question.slice(0, 50)}"`, gitOpts);

    log(`[gate] Changes committed on branch: ${branch}`);

    try {
      execSync(
        `gh pr create --title "nightbot: ${task.question.slice(0, 60)}" --body "Automated by nightbot task ${task.id}" --head ${branch}`,
        gitOpts,
      );
      log("[gate] PR created");
    } catch {
      log("[gate] gh CLI not available or failed, PR not created. Branch ready for manual PR.");
    }

    execSync("git checkout -", gitOpts);
  } catch (err) {
    log(`[gate] Failed to apply changes: ${String(err).slice(0, 300)}`);
    try { execSync("git checkout -", gitOpts); } catch { /* ignore */ }
  } finally {
    if (stashed) {
      try { execSync("git stash pop", gitOpts); } catch { /* ignore */ }
    }
  }
}
