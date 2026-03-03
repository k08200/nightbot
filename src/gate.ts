import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GateVerdict = "pass" | "fail" | "warning";

export interface GateResult {
  gate: string;
  verdict: GateVerdict;
  message: string;
  details?: string;
}

export interface GateReport {
  results: GateResult[];
  passed: boolean;
  failCount: number;
  warnCount: number;
}

function shell(cmd: string, cwd: string, timeout = 120): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: timeout * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output: output.slice(-5000) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: (`${e.stdout ?? ""}\n${e.stderr ?? ""}`).slice(-5000) };
  }
}

function loadPackageJson(repoPath: string): Record<string, unknown> | null {
  const p = resolve(repoPath, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function getAddedLines(diff: string): string[] {
  return diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
}

// ─── Gate 1: Build ───────────────────────────────────────────

function checkBuild(repoPath: string): GateResult {
  const hasTsConfig = existsSync(resolve(repoPath, "tsconfig.json"));
  const pkg = loadPackageJson(repoPath);
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  if (hasTsConfig) {
    const result = shell("npx tsc --noEmit", repoPath, 180);
    if (!result.ok) {
      return { gate: "build", verdict: "fail", message: "TypeScript compilation failed", details: result.output };
    }
    return { gate: "build", verdict: "pass", message: "TypeScript compilation OK" };
  }

  if (scripts.build) {
    const result = shell("npm run build", repoPath, 180);
    if (!result.ok) {
      return { gate: "build", verdict: "fail", message: "Build failed", details: result.output };
    }
    return { gate: "build", verdict: "pass", message: "Build OK" };
  }

  return { gate: "build", verdict: "pass", message: "No build configured, skipped" };
}

// ─── Gate 2: Lint ────────────────────────────────────────────

function checkLint(repoPath: string, diff: string): GateResult[] {
  const results: GateResult[] = [];
  const added = getAddedLines(diff);

  // Project linter
  const hasEslint =
    existsSync(resolve(repoPath, ".eslintrc.json")) ||
    existsSync(resolve(repoPath, ".eslintrc.js")) ||
    existsSync(resolve(repoPath, ".eslintrc.cjs")) ||
    existsSync(resolve(repoPath, "eslint.config.js")) ||
    existsSync(resolve(repoPath, "eslint.config.mjs"));
  const hasBiome = existsSync(resolve(repoPath, "biome.json")) || existsSync(resolve(repoPath, "biome.jsonc"));

  if (hasEslint) {
    const r = shell("npx eslint . --max-warnings 0", repoPath, 120);
    results.push(r.ok
      ? { gate: "lint:eslint", verdict: "pass", message: "ESLint passed" }
      : { gate: "lint:eslint", verdict: "fail", message: "ESLint errors", details: r.output });
  }

  if (hasBiome) {
    const r = shell("npx biome check .", repoPath, 120);
    results.push(r.ok
      ? { gate: "lint:biome", verdict: "pass", message: "Biome passed" }
      : { gate: "lint:biome", verdict: "fail", message: "Biome errors", details: r.output });
  }

  // Diff-specific: any type
  const anyLines = added.filter(l => /:\s*any[\s;,)>\]=]|as\s+any\b|<any>/.test(l));
  if (anyLines.length > 0) {
    results.push({
      gate: "lint:any",
      verdict: "fail",
      message: `${anyLines.length} 'any' type(s) in new code`,
      details: anyLines.map(l => l.slice(1).trim()).join("\n"),
    });
  }

  // Diff-specific: as any cast
  const asAnyCast = added.filter(l => /as\s+any\b/.test(l));
  if (asAnyCast.length > 0 && anyLines.length === 0) {
    results.push({
      gate: "lint:as-any",
      verdict: "fail",
      message: `${asAnyCast.length} 'as any' cast(s) in new code`,
      details: asAnyCast.map(l => l.slice(1).trim()).join("\n"),
    });
  }

  // Diff-specific: @ts-expect-error / @ts-expect-error
  const tsIgnore = added.filter(l => /@ts-ignore|@ts-expect-error/.test(l));
  if (tsIgnore.length > 0) {
    results.push({
      gate: "lint:ts-ignore",
      verdict: "fail",
      message: `${tsIgnore.length} @ts-ignore/@ts-expect-error in new code`,
    });
  }

  // Diff-specific: console.log
  const consoleLogs = added.filter(l => /console\.(log|debug|info)\(/.test(l));
  if (consoleLogs.length > 0) {
    results.push({
      gate: "lint:console",
      verdict: "fail",
      message: `${consoleLogs.length} console.log/debug/info in new code`,
    });
  }

  // Diff-specific: debugger
  const debuggers = added.filter(l => /^\+\s*debugger\s*;?\s*$/.test(l));
  if (debuggers.length > 0) {
    results.push({
      gate: "lint:debugger",
      verdict: "fail",
      message: `${debuggers.length} debugger statement(s) in new code`,
    });
  }

  if (results.length === 0) {
    results.push({ gate: "lint", verdict: "pass", message: "No linter configured, basic checks passed" });
  }

  return results;
}

// ─── Gate 3: Tests ───────────────────────────────────────────

function checkTests(repoPath: string): GateResult {
  const pkg = loadPackageJson(repoPath);
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  if (!scripts.test || scripts.test.includes("no test specified")) {
    return { gate: "test", verdict: "warning", message: "No test script configured" };
  }

  const result = shell("npm test", repoPath, 300);
  if (!result.ok) {
    return { gate: "test", verdict: "fail", message: "Tests failed", details: result.output };
  }
  return { gate: "test", verdict: "pass", message: "All tests passed" };
}

// ─── Gate 4: Diff Size ──────────────────────────────────────

function checkDiffSize(diff: string): GateResult {
  const lines = diff.split("\n");
  const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
  const changedFiles = lines.filter(l => l.startsWith("diff --git")).length;

  if (changedFiles > 10) {
    return {
      gate: "diff:files",
      verdict: "fail",
      message: `${changedFiles} files changed (max 10)`,
      details: "Split into smaller tasks",
    };
  }
  if (added + removed > 500) {
    return {
      gate: "diff:lines",
      verdict: "fail",
      message: `${added + removed} lines changed (max 500)`,
      details: "Split into smaller tasks",
    };
  }

  return { gate: "diff:size", verdict: "pass", message: `${changedFiles} files, +${added}/-${removed} lines` };
}

// ─── Gate 5: Security ────────────────────────────────────────

function checkSecurity(diff: string): GateResult[] {
  const results: GateResult[] = [];
  const added = getAddedLines(diff);

  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: "API Key", re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i },
    { name: "Password", re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/i },
    { name: "Token/Secret", re: /(?:token|secret|auth_?key)\s*[:=]\s*["'][^"']{8,}["']/i },
    { name: "Private Key", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
    { name: "AWS Key", re: /AKIA[0-9A-Z]{16}/ },
  ];

  for (const { name, re } of patterns) {
    const matches = added.filter(l => re.test(l));
    if (matches.length > 0) {
      results.push({
        gate: `security:${name.toLowerCase().replace(/\s+/g, "-")}`,
        verdict: "fail",
        message: `Possible ${name} in new code`,
        details: matches.map(l => l.slice(1, 100).trim()).join("\n"),
      });
    }
  }

  if (diff.includes("diff --git a/.env")) {
    results.push({ gate: "security:env", verdict: "fail", message: ".env file modified" });
  }

  // New dependency added
  if (diff.includes("diff --git a/package.json")) {
    const depLines = added.filter(l => /"dependencies"|"devDependencies"/.test(l));
    if (depLines.length > 0) {
      results.push({ gate: "security:deps", verdict: "warning", message: "package.json dependencies modified" });
    }
  }

  if (results.length === 0) {
    results.push({ gate: "security", verdict: "pass", message: "No security issues found" });
  }

  return results;
}

// ─── Gate 6: Code Quality (warnings only) ────────────────────

function checkQuality(diff: string): GateResult[] {
  const results: GateResult[] = [];
  const added = getAddedLines(diff);

  // TODO/FIXME/HACK
  const todos = added.filter(l => /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/.test(l));
  if (todos.length > 0) {
    results.push({ gate: "quality:todo", verdict: "warning", message: `${todos.length} TODO/FIXME in new code` });
  }

  // Function type
  const funcType = added.filter(l => /:\s*Function\b/.test(l));
  if (funcType.length > 0) {
    results.push({ gate: "quality:function-type", verdict: "warning", message: `${funcType.length} 'Function' type(s) — use specific signature` });
  }

  // {} type
  const emptyObj = added.filter(l => /:\s*\{\}\s*[;,)>\]=]/.test(l));
  if (emptyObj.length > 0) {
    results.push({ gate: "quality:empty-object", verdict: "warning", message: `${emptyObj.length} '{}' type(s) — use Record<string, unknown>` });
  }

  // unused import (basic check: import but never used in added lines)
  const unusedImport = added.filter(l => /^import\s.*from\s/.test(l.slice(1)));
  if (unusedImport.length > 5) {
    results.push({ gate: "quality:many-imports", verdict: "warning", message: `${unusedImport.length} new imports — verify all are used` });
  }

  if (results.length === 0) {
    results.push({ gate: "quality", verdict: "pass", message: "Code quality OK" });
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────

export function runGates(repoPath: string, diff: string): GateReport {
  const results: GateResult[] = [
    checkBuild(repoPath),
    ...checkLint(repoPath, diff),
    checkTests(repoPath),
    checkDiffSize(diff),
    ...checkSecurity(diff),
    ...checkQuality(diff),
  ];

  const failCount = results.filter(r => r.verdict === "fail").length;
  const warnCount = results.filter(r => r.verdict === "warning").length;

  return { results, passed: failCount === 0, failCount, warnCount };
}

export function formatGateReport(report: GateReport): string {
  const lines: string[] = [
    "# Code Gate Report",
    "",
    `**${report.passed ? "PASSED" : "FAILED"}** — ${report.failCount} failures, ${report.warnCount} warnings`,
    "",
  ];

  for (const r of report.results) {
    const icon = r.verdict === "pass" ? "✅" : r.verdict === "fail" ? "❌" : "⚠️";
    lines.push(`${icon} **${r.gate}**: ${r.message}`);
    if (r.details) {
      lines.push("```", r.details.slice(0, 500), "```");
    }
  }

  return lines.join("\n");
}

export function gateFailureSummary(report: GateReport): string {
  return report.results
    .filter(r => r.verdict === "fail")
    .map(r => `[${r.gate}] ${r.message}${r.details ? `: ${r.details.slice(0, 200)}` : ""}`)
    .join("\n");
}
