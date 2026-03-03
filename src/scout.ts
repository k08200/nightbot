import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { Config } from "./config.js";
import type { LLM, Message } from "./llm.js";
import { Sandbox } from "./sandbox.js";
import type { Task } from "./task.js";

export interface ScoutResult {
  task: Task;
  report: string;
  iterations: number;
  durationMs: number;
  escalated: boolean;
  escalationReason: string;
  diff?: string;
  changedFiles?: Array<{ path: string; content: string }>;
}

function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    blocks.push({ lang: match[1] || "bash", code: match[2].trim() });
  }
  return blocks;
}

function loadAgentPrompt(agent: string, fallback: string): string {
  const path = resolve(`config/agents/${agent}.yaml`);
  if (existsSync(path)) {
    const raw = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return (raw?.system_prompt as string) ?? fallback;
  }
  return fallback;
}

const SCOUT_FALLBACK = "You are a code scout. Write code, run it, report findings. Code will be thrown away.";

const IMPLEMENTER_FALLBACK = `You are a code implementer. You receive a task and a project mounted at /project.

Rules:
- Read the existing code first to understand structure and patterns.
- Make minimal, focused changes. Do NOT refactor unrelated code.
- Do NOT use 'any' types, @ts-ignore, or console.log.
- Run the project's existing tests after your changes to verify nothing breaks.
- Work ONLY inside /project. All file edits must be there.
- When finished, say DONE. If you need human input, say ESCALATE.
- Your changes will be reviewed by automated gates before merging.`;

export async function runScout(task: Task, config: Config, llm: LLM): Promise<ScoutResult> {
  const isImplement = task.mode === "implement";
  const model = config.models.scout;
  const cb = config.circuitBreakers;
  const start = Date.now();
  const modeLabel = isImplement ? "implement" : "research";

  console.log(`[scout:${modeLabel}] Starting: ${task.id} — ${task.question}`);

  const systemPrompt = isImplement
    ? loadAgentPrompt("implementer", IMPLEMENTER_FALLBACK)
    : loadAgentPrompt("scout", SCOUT_FALLBACK);

  const userPrompt = isImplement
    ? `Task: ${task.question}\nType: ${task.type}\n\nThe project is at /project. Read the code, make changes, run tests. Work inside /project only.`
    : `Task: ${task.question}\nType: ${task.type}\n\nValidate this by writing and running code.`;

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const sandbox = new Sandbox(
    config.sandbox.image,
    config.sandbox.memory,
    config.sandbox.cpus,
    config.sandbox.network,
  );

  let iterations = 0;
  let escalated = false;
  let escalationReason = "";
  const recentErrors: string[] = [];

  try {
    if (isImplement && task.targetRepo) {
      sandbox.createWithRepo(task.targetRepo);
    } else {
      sandbox.create(task.context);
    }

    const workdir = isImplement ? "/project" : "/sandbox";

    for (let i = 0; i < cb.iterationLimit; i++) {
      iterations = i + 1;
      const elapsed = Date.now() - start;

      if (elapsed > cb.timeoutPerTaskHours * 3600 * 1000) {
        console.log(`[scout:${modeLabel}] Timeout after ${(elapsed / 1000).toFixed(0)}s`);
        messages.push({ role: "user", content: "TIME'S UP. Summarize what you've done so far." });
        break;
      }

      console.log(`[scout:${modeLabel}] Iteration ${iterations}/${cb.iterationLimit}`);
      const response = await llm.chat(model, messages);
      messages.push({ role: "assistant", content: response });

      if (response.toUpperCase().includes("DONE") && i > 0) {
        console.log(`[scout:${modeLabel}] Reports DONE`);
        break;
      }

      if (response.toUpperCase().includes("ESCALATE")) {
        escalated = true;
        escalationReason = response;
        console.log(`[scout:${modeLabel}] Requests escalation`);
        break;
      }

      const blocks = extractCodeBlocks(response);
      if (blocks.length === 0) {
        messages.push({ role: "user", content: "No code found. Write actual code. Use ```bash or ```typescript blocks." });
        continue;
      }

      const results: string[] = [];
      for (const { lang, code } of blocks) {
        let result: import("./sandbox.js").ExecResult;
        if (["bash", "sh", "shell", ""].includes(lang)) {
          result = sandbox.exec(`cd ${workdir} && ${code}`);
        } else if (["typescript", "ts"].includes(lang)) {
          sandbox.writeFile("test.ts", code);
          result = sandbox.exec(`cd ${workdir} && npx tsx ${workdir}/test.ts`);
        } else if (["javascript", "js"].includes(lang)) {
          sandbox.writeFile("test.js", code);
          result = sandbox.exec(`cd ${workdir} && node ${workdir}/test.js`);
        } else if (lang === "python") {
          sandbox.writeFile("test.py", code);
          result = sandbox.exec(`cd ${workdir} && python3 ${workdir}/test.py`);
        } else {
          result = sandbox.exec(`cd ${workdir} && ${code}`);
        }
        results.push(`[${lang}] exit=${result.exitCode}\n${result.stdout}\n${result.stderr}`);
      }

      const output = results.join("\n---\n");
      messages.push({
        role: "user",
        content: `Execution results:\n\n${output}\n\nAnalyze and continue. Say DONE when finished. Say ESCALATE if you need human input.`,
      });

      // Circuit breaker: same error repeated
      const hasError = results.some(r => r.includes("exit=1") || r.includes("STDERR"));
      if (hasError) {
        recentErrors.push(output.slice(0, 200));
        if (recentErrors.length >= cb.sameErrorLimit) {
          const recent = recentErrors.slice(-cb.sameErrorLimit);
          if (new Set(recent).size === 1) {
            console.log(`[scout:${modeLabel}] Same error ${cb.sameErrorLimit} times, giving up`);
            messages.push({ role: "user", content: `Same error ${cb.sameErrorLimit} times. Stop and report what you learned.` });
            const final = await llm.chat(model, messages);
            messages.push({ role: "assistant", content: final });
            break;
          }
        }
      }
    }

    // Extract diff before destroying sandbox (implement mode)
    let diff: string | undefined;
    let changedFiles: Array<{ path: string; content: string }> | undefined;

    if (isImplement) {
      diff = sandbox.extractDiff();
      if (diff.trim()) {
        changedFiles = sandbox.extractChangedFiles();
        console.log(`[scout:implement] ${changedFiles.length} file(s) changed`);
      } else {
        console.log("[scout:implement] No changes detected");
      }
    }

    // Generate report
    const reportPrompt = isImplement
      ? `Write a concise report:\n# Report: ${task.question}\n## Changes Made\n## Tests Run\n## Remaining Issues\nFacts only.`
      : `Write a concise report:\n# Report: ${task.question}\n## Conclusion\n## What Works\n## What Doesn't\n## Key Discoveries\n## Recommended Next Steps\nFacts only. No filler.`;

    messages.push({ role: "user", content: reportPrompt });
    const report = await llm.chat(model, messages);
    const duration = Date.now() - start;
    const meta = `\n\n---\n## Meta\n- Mode: ${modeLabel}\n- Model: ${model}\n- Iterations: ${iterations}/${cb.iterationLimit}\n- Duration: ${(duration / 1000).toFixed(0)}s\n- Files changed: ${changedFiles?.length ?? 0}\n- Sandbox: destroyed\n`;

    return { task, report: report + meta, iterations, durationMs: duration, escalated, escalationReason, diff, changedFiles };
  } finally {
    sandbox.destroy();
  }
}

export function saveReport(result: ScoutResult, reportsDir: string): string {
  mkdirSync(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = resolve(reportsDir, `${date}-${result.task.id}.md`);
  writeFileSync(path, result.report);
  console.log(`[scout] Report saved: ${path}`);
  return path;
}
