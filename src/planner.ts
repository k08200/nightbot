import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { LLM } from "./llm.js";
import type { Task } from "./task.js";

export interface Plan {
  tasks: Array<{
    id: string;
    name: string;
    type: string;
    dependsOn: string[];
    estimatedHours: number;
    status: string;
  }>;
  executionOrder: string[];
  reasoning: string;
}

export async function createPlan(tasks: Task[], config: Config, llm: LLM): Promise<Plan> {
  const taskList = tasks.map(t => `- [${t.id}] (${t.type}) ${t.question} [${t.status}]`).join("\n");

  const prompt = `You are a task planner. Given these tasks, create a plan.

Tasks:
${taskList || "(no tasks)"}

Output JSON only:
{"tasks": [{"id":"...","name":"...","type":"...","dependsOn":[],"estimatedHours":2,"status":"ready"}], "executionOrder": ["id1","id2"], "reasoning": "..."}`;

  const response = await llm.chat(config.models.planner, [{ role: "user", content: prompt }], 0.3);
  return parseJSON(response);
}

export async function replan(currentPlan: Plan, report: string, config: Config, llm: LLM): Promise<Plan> {
  const prompt = `Scout finished a task. Report:\n${report.slice(0, 3000)}\n\nCurrent plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nUpdate the plan. Output JSON only (same format).`;

  const response = await llm.chat(config.models.planner, [{ role: "user", content: prompt }], 0.3);
  return parseJSON(response);
}

export async function generateBriefing(config: Config, llm: LLM): Promise<string> {
  const plan = readJSON(resolve(config.paths.plans, "current.json"));
  const reports = readRecentFiles(config.paths.reports, 10);
  const decisions = readRecentFiles(config.paths.decisions, 5);

  const prompt = `Morning briefing based on:\nPlan: ${JSON.stringify(plan)}\nReports: ${reports}\nDecisions: ${decisions}\n\nFormat: # Briefing — ${new Date().toISOString().slice(0, 10)}\n## Status\n## Key Findings\n## Decisions Needed\n## Recommended Actions\nBe concise.`;

  return llm.chat(config.models.planner, [{ role: "user", content: prompt }], 0.5);
}

export function getNextTask(plan: Plan, completedIds: Set<string>): string | null {
  for (const id of plan.executionOrder) {
    const task = plan.tasks.find(t => t.id === id);
    if (!task || ["done", "failed", "skipped"].includes(task.status)) continue;
    if (task.dependsOn.every(d => completedIds.has(d))) return id;
  }
  return null;
}

export function savePlan(plan: Plan, plansDir: string): void {
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(resolve(plansDir, "current.json"), JSON.stringify(plan, null, 2));
  const histDir = resolve(plansDir, "history");
  mkdirSync(histDir, { recursive: true });
  writeFileSync(resolve(histDir, `${Date.now()}.json`), JSON.stringify(plan, null, 2));
}

function parseJSON(text: string): Plan {
  let clean = text.trim();
  if (clean.startsWith("```")) clean = clean.split("\n").slice(1).join("\n");
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  try {
    return JSON.parse(clean.trim());
  } catch {
    return { tasks: [], executionOrder: [], reasoning: "parse error" };
  }
}

function readJSON(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readRecentFiles(dir: string, limit: number): string {
  if (!existsSync(dir)) return "(none)";
  const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, limit);
  return files.map(f => readFileSync(resolve(dir, f), "utf-8").slice(0, 1000)).join("\n---\n") || "(none)";
}
