import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { log } from "./utils.js";

describe("log", () => {
  it("should prefix the message with an ISO timestamp", () => {
    const originalConsoleLog = console.log;
    const mockConsoleLog = mock.fn();
    console.log = mockConsoleLog;

    const message = "Test message";
    log(message);

    console.log = originalConsoleLog; // Restore console.log

    assert.strictEqual(mockConsoleLog.mock.calls.length, 1);
    const logMessage = mockConsoleLog.mock.calls[0].arguments[0];
    assert.match(logMessage, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z - Test message$/);
  });
});
