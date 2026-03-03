import type { LLM, Message } from "./llm.js";

export interface CompressionConfig {
  enabled: boolean;
  maxTokenEstimate: number;
  keepRecentMessages: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate based on character count.
 * Not exact, but good enough for compression decisions.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil(m.content.length / CHARS_PER_TOKEN);
  }
  return total;
}

/**
 * Compress message history when it exceeds token threshold.
 *
 * Strategy:
 * - Always keep: system prompt (index 0) + original task (index 1)
 * - Always keep: last N messages (recent context)
 * - Summarize: everything in between into a single "[context summary]" message
 *
 * Returns the original array if compression is not needed.
 */
export async function compressContext(
  messages: Message[],
  llm: LLM,
  model: string,
  config: CompressionConfig,
): Promise<Message[]> {
  if (!config.enabled) return messages;

  const tokens = estimateTokens(messages);
  if (tokens <= config.maxTokenEstimate) return messages;

  // Need at least: system + task + keepRecent + some middle to compress
  const minMessages = 2 + config.keepRecentMessages + 2;
  if (messages.length < minMessages) return messages;

  const head = messages.slice(0, 2); // system + original task
  const keep = config.keepRecentMessages;
  const tail = messages.slice(-keep); // recent messages
  const middle = messages.slice(2, -keep); // everything to compress

  if (middle.length < 2) return messages;

  console.log(
    `[context] Compressing ${middle.length} messages (~${estimateTokens(middle)} tokens) → summary`,
  );

  const summary = await summarizeMessages(middle, llm, model);

  return [
    ...head,
    { role: "user" as const, content: `[Previous context summary]\n${summary}` },
    ...tail,
  ];
}

async function summarizeMessages(
  messages: Message[],
  llm: LLM,
  model: string,
): Promise<string> {
  // Build a condensed view of the conversation to summarize
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === "assistant" ? "Agent" : "System";
    // Truncate very long messages for the summary prompt itself
    const content = m.content.length > 800
      ? `${m.content.slice(0, 400)}\n...(truncated)...\n${m.content.slice(-400)}`
      : m.content;
    lines.push(`[${label}]: ${content}`);
  }

  const summaryPrompt: Message[] = [
    {
      role: "system",
      content: `You are a context summarizer. Summarize the following conversation between an AI coding agent and a system.
Focus on:
- What was attempted and what happened (success/failure)
- Key errors encountered and how they were resolved
- Important discoveries or findings
- Current state of the work
- Files that were created or modified

Be concise. Use bullet points. Keep only actionable information.`,
    },
    {
      role: "user",
      content: `Summarize this conversation:\n\n${lines.join("\n\n")}`,
    },
  ];

  const summary = await llm.chat(model, summaryPrompt, 0.3);
  console.log(`[context] Summary generated (${summary.length} chars)`);
  return summary;
}
