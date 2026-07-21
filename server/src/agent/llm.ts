import { ChatAnthropic } from "@langchain/anthropic";
import type { AIMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * USD per 1M tokens. If you change ANTHROPIC_MODEL, add a matching entry —
 * an unlisted model logs a warning and skips the cost estimate rather than
 * silently pricing against the wrong model.
 */
const PRICING_PER_1M_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function createModel(maxTokens = 2048): ChatAnthropic {
  return new ChatAnthropic({
    model: config.anthropicModel,
    maxTokens,
    // Opus 4.7+ and Sonnet 5 reject temperature/top_k/top_p outright (400).
    // @langchain/anthropic 0.3.x only knows to omit them for an older model
    // allowlist, so force them off the wire here. invocationKwargs is spread
    // last into the request body; explicit `undefined` values are dropped
    // during JSON serialization.
    invocationKwargs: {
      temperature: undefined,
      top_k: undefined,
      top_p: undefined,
    },
  });
}

export function logTokenUsage(step: string, message: AIMessage): void {
  const usage = message.usage_metadata;
  if (!usage) return;
  const pricing = PRICING_PER_1M_TOKENS_USD[config.anthropicModel];
  if (!pricing) {
    logger.warn(
      { step, model: config.anthropicModel, ...usage },
      "token usage (no pricing entry for model — cost not estimated)",
    );
    return;
  }
  const costUsd =
    (usage.input_tokens / 1_000_000) * pricing.input +
    (usage.output_tokens / 1_000_000) * pricing.output;
  logger.info(
    {
      step,
      model: config.anthropicModel,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_cost_usd: Number(costUsd.toFixed(6)),
    },
    "llm token usage",
  );
}
