import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeResult, formatFeedbackMessage } from "./feedback.js";

describe("analyzeResult", () => {
  it("returns success for exit code 0", () => {
    const result = analyzeResult("ts", { exitCode: 0, stdout: "OK", stderr: "" });
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.lang, "ts");
    assert.ok(result.summary.includes("SUCCESS"));
  });

  it("classifies TypeScript compilation errors", () => {
    const stderr = "src/index.ts(5,3): error TS2345: Argument of type 'string' is not assignable";
    const result = analyzeResult("ts", { exitCode: 1, stdout: "", stderr });
    assert.equal(result.success, false);
    assert.equal(result.category, "compilation");
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].file, "src/index.ts");
    assert.equal(result.errors[0].line, 5);
  });

  it("classifies test failures", () => {
    const stderr = "FAIL src/app.test.ts\nTests: 2 failed, 1 passed";
    const result = analyzeResult("ts", { exitCode: 1, stdout: "", stderr });
    assert.equal(result.category, "test_failure");
  });

  it("classifies runtime errors", () => {
    const stderr = "TypeError: Cannot read properties of undefined";
    const result = analyzeResult("ts", { exitCode: 1, stdout: "", stderr });
    assert.equal(result.category, "runtime");
  });

  it("classifies timeout", () => {
    const stderr = "process timed out after 120s";
    const result = analyzeResult("ts", { exitCode: 1, stdout: "", stderr });
    assert.equal(result.category, "timeout");
  });
});

describe("formatFeedbackMessage", () => {
  it("formats all-success", () => {
    const fb = analyzeResult("ts", { exitCode: 0, stdout: "done", stderr: "" });
    const msg = formatFeedbackMessage([fb]);
    assert.ok(msg.includes("All executions succeeded"));
    assert.ok(msg.includes("DONE"));
  });

  it("formats all-failure", () => {
    const fb = analyzeResult("ts", { exitCode: 1, stdout: "", stderr: "TypeError: oops" });
    const msg = formatFeedbackMessage([fb]);
    assert.ok(msg.includes("All executions failed"));
    assert.ok(msg.includes("ESCALATE"));
  });

  it("formats mixed results", () => {
    const ok = analyzeResult("ts", { exitCode: 0, stdout: "ok", stderr: "" });
    const fail = analyzeResult("ts", { exitCode: 1, stdout: "", stderr: "Error" });
    const msg = formatFeedbackMessage([ok, fail]);
    assert.ok(msg.includes("Some executions succeeded"));
  });
});
