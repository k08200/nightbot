import type { ExecResult } from "./sandbox.js";

export type ErrorCategory =
  | "compilation"
  | "runtime"
  | "test_failure"
  | "timeout"
  | "permission"
  | "not_found"
  | "unknown";

export interface StructuredFeedback {
  success: boolean;
  lang: string;
  exitCode: number;
  category: ErrorCategory;
  summary: string;
  errors: ParsedError[];
  stdout: string;
  stderr: string;
}

export interface ParsedError {
  file?: string;
  line?: number;
  message: string;
}

/**
 * Analyze a raw execution result and produce structured feedback
 * that the LLM can act on more effectively.
 */
export function analyzeResult(lang: string, result: ExecResult): StructuredFeedback {
  const combined = `${result.stdout}\n${result.stderr}`;
  const category = classifyError(combined, result.exitCode);
  const errors = extractErrors(combined);

  const summary = result.exitCode === 0
    ? buildSuccessSummary(lang, result)
    : buildErrorSummary(category, errors, result);

  return {
    success: result.exitCode === 0,
    lang,
    exitCode: result.exitCode,
    category,
    summary,
    errors,
    stdout: trimOutput(result.stdout, 2000),
    stderr: trimOutput(result.stderr, 1500),
  };
}

function classifyError(output: string, exitCode: number): ErrorCategory {
  if (exitCode === 0) return "unknown"; // not an error

  // TypeScript / compilation errors
  if (/error TS\d+/.test(output)) return "compilation";
  if (/SyntaxError:/.test(output)) return "compilation";
  if (/Cannot find module/.test(output)) return "compilation";
  if (/Module not found/.test(output)) return "compilation";

  // Test failures
  if (/FAIL|Tests?:\s+\d+\s+failed/i.test(output)) return "test_failure";
  if (/AssertionError|expect\(/.test(output)) return "test_failure";
  if (/✗|✕|FAILED/.test(output)) return "test_failure";

  // Runtime errors
  if (/TypeError:|ReferenceError:|RangeError:/.test(output)) return "runtime";
  if (/Uncaught|unhandled|FATAL/.test(output)) return "runtime";

  // Timeout
  if (/SIGTERM|ETIMEDOUT|timed?\s*out/i.test(output)) return "timeout";

  // Permission
  if (/EACCES|Permission denied/i.test(output)) return "permission";

  // Not found
  if (/ENOENT|command not found|No such file/i.test(output)) return "not_found";

  return "unknown";
}

/**
 * Extract file:line:message error patterns from output.
 * Handles TypeScript, ESLint, Node.js stack traces, and Python errors.
 */
function extractErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const seen = new Set<string>();

  const patterns: RegExp[] = [
    // TypeScript: src/foo.ts(10,5): error TS2345: ...
    /([^\s]+\.tsx?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/g,
    // TypeScript/ESLint: src/foo.ts:10:5 - error ...
    /([^\s]+\.tsx?):(\d+):\d+\s*[-–]\s*(?:error|warning)\s*(.+)/g,
    // Node.js: at Object.<anonymous> (/path/file.js:10:5)
    /at\s+.+\(([^)]+):(\d+):\d+\)/g,
    // Python: File "test.py", line 10, in ...
    /File "([^"]+)",\s*line\s*(\d+)/g,
    // Generic: Error: message
    /^(?:Error|TypeError|ReferenceError|SyntaxError):\s*(.+)/gm,
  ];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    for (match = re.exec(output); match !== null; match = re.exec(output)) {
      const file = match[1] && !match[1].startsWith("Error") ? match[1] : undefined;
      const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
      const message = (match[3] ?? match[1] ?? match[0]).trim();
      const key = `${file}:${line}:${message}`;

      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ file, line, message });
      }
    }

    if (errors.length >= 10) break; // cap to prevent noise
  }

  return errors;
}

function buildSuccessSummary(lang: string, result: ExecResult): string {
  const lines: string[] = [`[${lang}] SUCCESS (exit=0)`];

  // Check for test results in output
  const testMatch = result.stdout.match(/Tests?:\s+(\d+)\s+passed/i);
  if (testMatch) {
    lines.push(`Tests passed: ${testMatch[1]}`);
  }

  // Show truncated output preview
  const preview = result.stdout.trim().split("\n").slice(-3).join("\n");
  if (preview) {
    lines.push(`Last output: ${preview.slice(0, 300)}`);
  }

  return lines.join("\n");
}

function buildErrorSummary(
  category: ErrorCategory,
  errors: ParsedError[],
  result: ExecResult,
): string {
  const labels: Record<ErrorCategory, string> = {
    compilation: "COMPILATION ERROR",
    runtime: "RUNTIME ERROR",
    test_failure: "TEST FAILURE",
    timeout: "TIMEOUT",
    permission: "PERMISSION ERROR",
    not_found: "NOT FOUND",
    unknown: "ERROR",
  };

  const lines: string[] = [`${labels[category]} (exit=${result.exitCode})`];

  if (errors.length > 0) {
    lines.push("");
    lines.push("Key errors:");
    for (const e of errors.slice(0, 5)) {
      const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : "";
      lines.push(`  ${loc ? `[${loc}] ` : ""}${e.message}`);
    }
    if (errors.length > 5) {
      lines.push(`  ... and ${errors.length - 5} more`);
    }
  }

  // Add stderr tail for context
  const stderrTail = result.stderr.trim().split("\n").slice(-5).join("\n");
  if (stderrTail && errors.length === 0) {
    lines.push("");
    lines.push(`stderr: ${stderrTail.slice(0, 500)}`);
  }

  return lines.join("\n");
}

/**
 * Format multiple structured feedbacks into a single message for the LLM.
 */
export function formatFeedbackMessage(feedbacks: StructuredFeedback[]): string {
  const sections: string[] = [];

  for (const fb of feedbacks) {
    sections.push(fb.summary);

    // Only include raw output if errors weren't parsed well
    if (!fb.success && fb.errors.length === 0) {
      if (fb.stdout.trim()) {
        sections.push(`stdout:\n${fb.stdout.slice(-1000)}`);
      }
      if (fb.stderr.trim()) {
        sections.push(`stderr:\n${fb.stderr.slice(-1000)}`);
      }
    }

    sections.push("---");
  }

  const allSuccess = feedbacks.every(f => f.success);
  const allFail = feedbacks.every(f => !f.success);

  let instruction: string;
  if (allSuccess) {
    instruction = "All executions succeeded. Continue with your plan. Say DONE when finished.";
  } else if (allFail) {
    instruction = "All executions failed. Read the errors carefully, fix the issues, and try again. Say ESCALATE if stuck.";
  } else {
    instruction = "Some executions succeeded, some failed. Fix the failures and continue. Say DONE when finished.";
  }

  return `Execution results:\n\n${sections.join("\n")}\n\n${instruction}`;
}

function trimOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `...(truncated)...\n${text.slice(-maxLen)}`;
}
