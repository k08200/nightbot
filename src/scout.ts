import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { Config } from "./config.js";
import { compressContext } from "./context.js";
import { analyzeResult, formatFeedbackMessage, type StructuredFeedback } from "./feedback.js";
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

interface CodeBlock {
  lang: string;
  code: string;
  targetFile?: string;
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /(?:<!--\s*FILE:\s*(\S+)\s*-->\s*\n)?```(\w*)\n([\s\S]*?)```/g;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    blocks.push({
      targetFile: match[1] || undefined,
      lang: match[2] || "bash",
      code: match[3].trim(),
    });
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
- Your changes will be reviewed by automated gates before merging.

Testing:
- After making changes, ALWAYS write tests for the code you changed.
- Check existing test patterns first: look for *.test.ts, *.spec.ts, or __tests__/ directories.
- Match the existing test framework (jest, vitest, mocha, etc). If none exists, use the built-in node:test module.
- Test files must be placed alongside the source or in the project's test directory.
- Run the tests to verify they pass before saying DONE.

Multi-file editing:
To write to a specific file, put a FILE comment before your code block:
<!-- FILE: src/utils/helper.ts -->
\`\`\`typescript
export function helper() { return 42; }
\`\`\`

You can write multiple files in one response. Code blocks without FILE comments are executed as scripts.
Use \`\`\`bash blocks to run commands (tests, builds, file reads).`;

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

  let messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const compression = config.contextCompression;

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

      // Compress context if history is getting too long
      if (iterations > compression.compressAfterIteration) {
        messages = await compressContext(messages, llm, config.models.lightweight, compression);
      }

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

      const feedbacks: StructuredFeedback[] = [];
      for (const block of blocks) {
        const { lang, code, targetFile } = block;
        let result: import("./sandbox.js").ExecResult;

        // If a target file is specified, write to that path instead of a temp file
        if (targetFile && !["bash", "sh", "shell"].includes(lang)) {
          const filePath = targetFile.startsWith("/")
            ? targetFile
            : `${workdir}/${targetFile}`;
          sandbox.writeFileAt(filePath, code);
          feedbacks.push(analyzeResult(lang, { exitCode: 0, stdout: `Wrote ${filePath}`, stderr: "" }));
          continue;
        }

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
        feedbacks.push(analyzeResult(lang, result));
      }

      const feedbackMessage = formatFeedbackMessage(feedbacks);
      messages.push({ role: "user", content: feedbackMessage });

      // Circuit breaker: same error repeated
      const hasError = feedbacks.some(f => !f.success);
      if (hasError) {
        recentErrors.push(feedbackMessage.slice(0, 200));
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

    // Auto-generate tests if implement mode and no tests were written
    if (isImplement && !escalated) {
      const testCheck = sandbox.exec(
        "cd /project && git diff --name-only HEAD | grep -E '\\.(test|spec)\\.(ts|js|tsx|jsx)$' | head -5",
      );
      const hasTests = testCheck.stdout.trim().length > 0;

      if (!hasTests) {
        const changedSrc = sandbox.exec(
          "cd /project && git diff --name-only HEAD | grep -E '\\.(ts|js|tsx|jsx)$' | head -10",
        );
        if (changedSrc.stdout.trim()) {
          console.log("[scout:implement] No tests found in changes, requesting test generation");
          messages.push({
            role: "user",
            content: `You changed these files but wrote no tests:\n${changedSrc.stdout}\n\nWrite tests for your changes now. Match the project's existing test patterns. Use <!-- FILE: path --> syntax to create test files. Then run them.`,
          });

          // Give the scout 2 more iterations to write tests
          for (let t = 0; t < 2; t++) {
            const testResp = await llm.chat(model, messages);
            messages.push({ role: "assistant", content: testResp });

            const testBlocks = extractCodeBlocks(testResp);
            if (testBlocks.length === 0) break;

            const testFeedbacks: StructuredFeedback[] = [];
            for (const block of testBlocks) {
              const { lang, code, targetFile } = block;
              if (targetFile && !["bash", "sh", "shell"].includes(lang)) {
                const filePath = targetFile.startsWith("/") ? targetFile : `${workdir}/${targetFile}`;
                sandbox.writeFileAt(filePath, code);
                testFeedbacks.push(analyzeResult(lang, { exitCode: 0, stdout: `Wrote ${filePath}`, stderr: "" }));
              } else {
                const result = sandbox.exec(`cd ${workdir} && ${code}`);
                testFeedbacks.push(analyzeResult(lang, result));
              }
            }

            const fbMsg = formatFeedbackMessage(testFeedbacks);
            messages.push({ role: "user", content: fbMsg });

            if (testFeedbacks.every(f => f.success)) {
              console.log("[scout:implement] Tests generated and passing");
              break;
            }
          }
        }
      } else {
        console.log("[scout:implement] Tests found in changes");
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
