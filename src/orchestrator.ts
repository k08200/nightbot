import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { Config, loadConfig } from "./config.js";
import { LLM } from "./llm.js";
import { createPlan, getNextTask, replan, savePlan, Plan } from "./planner.js";
import { runScout, saveReport, ScoutResult } from "./scout.js";
import { Task, createTask, loadTasks, moveTask } from "./task.js";
import { escalate, classifyEscalation, Level, startEscalationTimer, stopEscalationTimer, checkDecisionResponses } from "./escalation.js";
import { runGates, formatGateReport, gateFailureSummary } from "./gate.js";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function startOrchestrator(config?: Config): Promise<void> {
  config = config ?? loadConfig();
  const llm = new LLM(config.ollama.host);
  const completedIds = new Set<string>();
  let running = true;

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  console.log("[nightbot] Starting...");

  if (!(await llm.isAvailable())) {
    console.error("[nightbot] ollama not reachable. Run: ollama serve");
    return;
  }

  startEscalationTimer();
  console.log(`[nightbot] ollama connected`);
  console.log(`[nightbot] scout model: ${config.models.scout}`);

  let plan = await loadOrCreatePlan(config, llm);

  while (running) {
    try {
      // Check if human responded to any escalations
      const resolved = checkDecisionResponses(config);
      if (resolved.length > 0) {
        console.log(`[nightbot] ${resolved.length} escalation(s) resolved`);
      }

      const nextId = getNextTask(plan, completedIds);

      if (!nextId) {
        const pending = loadTasks(config.paths.queue, "pending");
        if (pending.length > 0) {
          console.log(`[nightbot] ${pending.length} new tasks, replanning...`);
          plan = await createPlan(pending, config, llm);
          savePlan(plan, config.paths.plans);
          continue;
        }
        console.log("[nightbot] No tasks. Waiting...");
        await sleep(config.scheduler.checkIntervalSeconds * 1000);
        continue;
      }

      const task = findTask(nextId, plan, config);
      if (!task) {
        completedIds.add(nextId);
        continue;
      }

      console.log(`[nightbot] Assigning: ${task.id} — ${task.question}`);
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
      } else if (task.mode === "implement" && result.diff?.trim()) {
        const handled = await handleImplementResult(task, result, config);
        if (handled) {
          completedIds.add(nextId);
        }
      } else {
        moveTask(task, config.paths.queue, "done");
        completedIds.add(nextId);
      }

      console.log(`[nightbot] Done: ${task.id} (${result.iterations} iters, ${(result.durationMs / 1000).toFixed(0)}s)`);

      plan = await replan(plan, result.report, config, llm);
      savePlan(plan, config.paths.plans);

    } catch (err) {
      console.error("[nightbot] Error:", err);
    }

    await sleep(config.scheduler.checkIntervalSeconds * 1000);
  }

  stopEscalationTimer();
  console.log("[nightbot] Stopped.");
}

async function loadOrCreatePlan(config: Config, llm: LLM): Promise<Plan> {
  const planPath = resolve(config.paths.plans, "current.json");
  if (existsSync(planPath)) {
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    console.log(`[nightbot] Loaded plan: ${plan.tasks?.length ?? 0} tasks`);
    return plan;
  }

  const tasks = loadTasks(config.paths.queue, "pending");
  if (tasks.length === 0) {
    console.log("[nightbot] No tasks. Add with: nightbot add 'question'");
    return { tasks: [], executionOrder: [], reasoning: "empty" };
  }

  console.log(`[nightbot] Creating plan from ${tasks.length} tasks...`);
  const plan = await createPlan(tasks, config, llm);
  savePlan(plan, config.paths.plans);
  return plan;
}

function findTask(taskId: string, plan: Plan, config: Config): Task | null {
  const all = loadTasks(config.paths.queue);
  const found = all.find(t => t.id === taskId);
  if (found) return found;

  const planTask = plan.tasks.find(t => t.id === taskId);
  if (planTask) {
    const type = (planTask.type ?? "feasibility") as Task["type"];
    return createTask(planTask.name, type);
  }

  return null;
}

// ─── Implement mode: gate check → branch → PR ───────────────

async function handleImplementResult(
  task: Task,
  result: ScoutResult,
  config: Config,
): Promise<boolean> {
  if (!result.diff?.trim() || !result.changedFiles?.length) {
    console.log("[gate] No changes to apply");
    moveTask(task, config.paths.queue, "done");
    return true;
  }

  const repoPath = task.targetRepo ?? task.context;
  if (!repoPath) {
    console.log("[gate] No target repo path, skipping gates");
    moveTask(task, config.paths.queue, "done");
    return true;
  }

  // Run gates against the diff
  console.log("[gate] Running code gates...");
  const gateReport = runGates(repoPath, result.diff);
  const reportText = formatGateReport(gateReport);

  // Save gate report
  mkdirSync(config.paths.reports, { recursive: true });
  const gatePath = resolve(config.paths.reports, `${new Date().toISOString().slice(0, 10)}-${task.id}-gate.md`);
  writeFileSync(gatePath, reportText);
  console.log(`[gate] Report: ${gatePath}`);

  if (gateReport.passed) {
    console.log(`[gate] PASSED (${gateReport.warnCount} warnings)`);
    applyChanges(repoPath, task, result);
    moveTask(task, config.paths.queue, "done");
    return true;
  }

  console.log(`[gate] FAILED (${gateReport.failCount} failures)`);
  const summary = gateFailureSummary(gateReport);
  await escalate(
    `Task "${task.question}" failed code gate:\n${summary}`,
    Level.NOTIFY,
    config,
    reportText.slice(0, 1000),
  );
  moveTask(task, config.paths.queue, "failed");
  return false;
}

function applyChanges(repoPath: string, task: Task, result: ScoutResult): void {
  if (!result.changedFiles?.length) return;

  const branch = `nightbot/${task.id}`;

  try {
    // Create branch
    execSync(`git checkout -b ${branch}`, { cwd: repoPath, encoding: "utf-8", stdio: "pipe" });

    // Apply changed files
    for (const file of result.changedFiles) {
      const filePath = resolve(repoPath, file.path);
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(filePath, file.content);
    }

    // Commit
    execSync("git add -A", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" });
    execSync(
      `git commit -m "nightbot: ${task.question.slice(0, 50)}"`,
      { cwd: repoPath, encoding: "utf-8", stdio: "pipe" },
    );

    console.log(`[gate] Changes committed on branch: ${branch}`);

    // Try to create PR via gh CLI
    try {
      execSync(
        `gh pr create --title "nightbot: ${task.question.slice(0, 60)}" --body "Automated by nightbot task ${task.id}" --head ${branch}`,
        { cwd: repoPath, encoding: "utf-8", stdio: "pipe" },
      );
      console.log("[gate] PR created");
    } catch {
      console.log("[gate] gh CLI not available or failed, PR not created. Branch ready for manual PR.");
    }

    // Switch back to previous branch
    execSync("git checkout -", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" });
  } catch (err) {
    console.error("[gate] Failed to apply changes:", err);
    try {
      execSync("git checkout -", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" });
    } catch { /* ignore */ }
  }
}
