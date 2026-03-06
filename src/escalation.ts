import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { log } from "./utils.js";

export enum Level {
  SILENT = 0,
  REPORT = 1,
  NOTIFY = 2,
  URGENT = 3,
}

// ─── Pending escalation tracker ──────────────────────────────

interface PendingEscalation {
  id: string;
  message: string;
  context: string;
  level: Level;
  sentAt: number;
  config: Config;
}

const pending: Map<string, PendingEscalation> = new Map();
let upgradeTimer: ReturnType<typeof setInterval> | null = null;

const UPGRADE_THRESHOLDS: Record<number, number> = {
  [Level.REPORT]: 2 * 60 * 60 * 1000,  // L1 → L2: 2 hours
  [Level.NOTIFY]: 4 * 60 * 60 * 1000,  // L2 → L3: 4 hours
};

export function startEscalationTimer(): void {
  if (upgradeTimer) return;
  upgradeTimer = setInterval(checkPendingEscalations, 60 * 1000); // check every minute
  log("[escalation] Auto-upgrade timer started");
}

export function stopEscalationTimer(): void {
  if (upgradeTimer) {
    clearInterval(upgradeTimer);
    upgradeTimer = null;
  }
}

async function checkPendingEscalations(): Promise<void> {
  const now = Date.now();

  for (const [id, esc] of pending) {
    const threshold = UPGRADE_THRESHOLDS[esc.level];
    if (!threshold) continue;

    const elapsed = now - esc.sentAt;
    if (elapsed < threshold) continue;

    const newLevel = esc.level + 1;
    if (newLevel > Level.URGENT) {
      log(`[escalation] ${id}: L3 no response, pausing task`);
      pending.delete(id);
      continue;
    }

    log(`[escalation] ${id}: No response after ${(elapsed / 3600000).toFixed(1)}h, upgrading L${esc.level} → L${newLevel}`);
    esc.level = newLevel;
    esc.sentAt = now;

    await escalate(esc.message, newLevel, esc.config, esc.context);
  }
}

export function resolveEscalation(id: string): void {
  if (pending.has(id)) {
    pending.delete(id);
    log(`[escalation] ${id}: Resolved`);
  }
}

// ─── Core escalation ─────────────────────────────────────────

export async function escalate(message: string, level: Level, config: Config, context = ""): Promise<boolean> {
  log(`[escalation] L${level}: ${message.slice(0, 100)}`);

  if (level === Level.SILENT) return true;

  const id = saveDecisionRequest(message, context, config);

  // Track for auto-upgrade
  if (level >= Level.REPORT && level < Level.URGENT) {
    pending.set(id, { id, message, context, level, sentAt: Date.now(), config });
  }

  if (level >= Level.NOTIFY) {
    return slackNotify(level === Level.URGENT ? `[URGENT] ${message}` : message, config);
  }
  return true;
}

export function classifyEscalation(report: string, reason = ""): Level {
  const text = (report + reason).toLowerCase();
  if (text.includes("all tasks blocked") || text.includes("pipeline halt")) return Level.URGENT;
  if (["escalate", "decision needed", "trade-off", "which approach"].some(k => text.includes(k))) return Level.NOTIFY;
  if (["done", "completed", "conclusion"].some(k => text.includes(k))) return Level.REPORT;
  return Level.SILENT;
}

export function getPendingEscalations(): PendingEscalation[] {
  return Array.from(pending.values());
}

// ─── Slack ───────────────────────────────────────────────────

async function slackNotify(message: string, config: Config): Promise<boolean> {
  const webhook = config.escalation.slackWebhook;
  if (!webhook) {
    log("[escalation] Slack webhook not configured, skipping");
    return false;
  }
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    return resp.ok;
  } catch (err) {
    log(`[escalation] Slack failed: ${String(err).slice(0, 200)}`);
    return false;
  }
}

// ─── Decision files ──────────────────────────────────────────

function saveDecisionRequest(message: string, context: string, config: Config): string {
  const dir = config.paths.decisions;
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `esc-${ts}`;
  const path = resolve(dir, `${id}-pending.md`);
  writeFileSync(path, `# Decision Needed\n\n## ID\n${id}\n\n## Question\n${message}\n\n## Context\n${context || "(none)"}\n\n## Decision\n(write your decision here, then rename file to remove -pending)\n`);
  return id;
}

export function checkDecisionResponses(config: Config): string[] {
  const dir = config.paths.decisions;
  if (!existsSync(dir)) return [];

  const resolved: string[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".md") && !f.includes("-pending"));

  for (const file of files) {
    const match = file.match(/^(esc-[^.]+)\.md$/);
    if (match) {
      resolved.push(match[1]);
      resolveEscalation(match[1]);
      // Clean up the decision file
      try { unlinkSync(resolve(dir, file)); } catch { /* ignore */ }
    }
  }

  return resolved;
}
