import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export type TaskType = "feasibility" | "migration" | "comparison" | "reproduction" | "exploration" | "implement";
export type TaskMode = "research" | "implement";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "escalated";

export interface Task {
  id: string;
  question: string;
  type: TaskType;
  mode: TaskMode;
  context?: string;
  targetRepo?: string;
  dependsOn: string[];
  maxIterations: number;
  timeoutHours: number;
  status: TaskStatus;
  createdAt: string;
}

export function createTask(
  question: string,
  type: TaskType = "feasibility",
  context?: string,
  mode: TaskMode = "research",
  targetRepo?: string,
): Task {
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    question,
    type,
    mode,
    context,
    targetRepo: targetRepo ?? context,
    dependsOn: [],
    maxIterations: 20,
    timeoutHours: 6,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export function saveTask(task: Task, queueDir: string): string {
  const dir = resolve(queueDir, task.status);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${task.id}.yaml`);
  writeFileSync(path, yaml.dump(task));
  return path;
}

export function loadTasks(queueDir: string, status?: TaskStatus): Task[] {
  const tasks: Task[] = [];
  const statuses: TaskStatus[] = status
    ? [status]
    : ["pending", "running", "done", "failed", "escalated"];

  for (const s of statuses) {
    const dir = resolve(queueDir, s);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".yaml"))) {
      const raw = yaml.load(readFileSync(resolve(dir, file), "utf-8")) as Task | undefined;
      if (raw) tasks.push(raw);
    }
  }
  return tasks;
}

export function moveTask(task: Task, queueDir: string, newStatus: TaskStatus): void {
  const oldPath = resolve(queueDir, task.status, `${task.id}.yaml`);
  if (existsSync(oldPath)) unlinkSync(oldPath);
  task.status = newStatus;
  saveTask(task, queueDir);
}
