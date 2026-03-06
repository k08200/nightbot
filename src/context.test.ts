import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateTokens } from "./context.js";

describe("estimateTokens", () => {
  it("estimates tokens based on character count", () => {
    const messages = [
      { role: "user" as const, content: "Hello world" }, // 11 chars -> ceil(11/4) = 3
    ];
    const tokens = estimateTokens(messages);
    assert.equal(tokens, 3);
  });

  it("sums across multiple messages", () => {
    const messages = [
      { role: "system" as const, content: "A".repeat(100) }, // 25
      { role: "user" as const, content: "B".repeat(200) },   // 50
    ];
    const tokens = estimateTokens(messages);
    assert.equal(tokens, 75);
  });

  it("returns 0 for empty array", () => {
    assert.equal(estimateTokens([]), 0);
  });
});
