import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatGateReport, type GateReport, gateFailureSummary } from "./gate.js";

describe("formatGateReport", () => {
  it("formats a passing report", () => {
    const report: GateReport = {
      results: [{ gate: "build", verdict: "pass", message: "Build OK" }],
      passed: true,
      failCount: 0,
      warnCount: 0,
    };
    const text = formatGateReport(report);
    assert.ok(text.includes("PASSED"));
    assert.ok(text.includes("Build OK"));
  });

  it("formats a failing report", () => {
    const report: GateReport = {
      results: [
        { gate: "build", verdict: "fail", message: "Build failed", details: "error TS1234" },
        { gate: "security", verdict: "pass", message: "OK" },
      ],
      passed: false,
      failCount: 1,
      warnCount: 0,
    };
    const text = formatGateReport(report);
    assert.ok(text.includes("FAILED"));
    assert.ok(text.includes("Build failed"));
    assert.ok(text.includes("error TS1234"));
  });
});

describe("gateFailureSummary", () => {
  it("returns only failed gates", () => {
    const report: GateReport = {
      results: [
        { gate: "build", verdict: "pass", message: "Build OK" },
        { gate: "lint:any", verdict: "fail", message: "2 'any' types" },
        { gate: "security", verdict: "warning", message: "deps changed" },
      ],
      passed: false,
      failCount: 1,
      warnCount: 1,
    };
    const summary = gateFailureSummary(report);
    assert.ok(summary.includes("lint:any"));
    assert.ok(!summary.includes("build"));
    assert.ok(!summary.includes("security"));
  });

  it("returns empty string when all pass", () => {
    const report: GateReport = {
      results: [{ gate: "build", verdict: "pass", message: "OK" }],
      passed: true,
      failCount: 0,
      warnCount: 0,
    };
    assert.equal(gateFailureSummary(report), "");
  });
});

describe("diff-based gate checks (via report format)", () => {
  it("detects security patterns in diff lines", () => {
    const diff = `diff --git a/src/config.ts b/src/config.ts
+const api_key = "sk-1234567890abcdef"`;
    const addedLines = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
    const hasSecret = addedLines.some(l => /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i.test(l));
    assert.ok(hasSecret, "Should detect API key pattern");
  });

  it("detects any types in diff lines", () => {
    const diff = `+const x: any = 5;`;
    const addedLines = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
    const anyLines = addedLines.filter(l => /:\s*any[\s;,)>\]=]|as\s+any\b|<any>/.test(l));
    assert.equal(anyLines.length, 1);
  });

  it("counts diff size correctly", () => {
    const diff = `diff --git a/a.ts b/a.ts
+line1
+line2
-old1
diff --git a/b.ts b/b.ts
+new`;
    const lines = diff.split("\n");
    const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
    const files = lines.filter(l => l.startsWith("diff --git")).length;
    assert.equal(added, 3);
    assert.equal(removed, 1);
    assert.equal(files, 2);
  });
});
