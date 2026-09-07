import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { AIMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * USD per 1M tokens, keyed by model id across both providers. If you point
 * ANTHROPIC_MODEL / OPENAI_MODEL at something not listed here, add an entry —
 * an unlisted model logs a warning and skips the cost estimate rather than
 * silently pricing against the wrong model.
 */
const PRICING_PER_1M_TOKENS_USD: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // OpenAI — developers.openai.com/api/docs/pricing, verified 2026-08-12
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/**
 * Chat model for the configured provider. The concrete union rather than
 * `BaseChatModel`, because `bindTools` is optional on the base class and the
 * enrichment agent needs it — both of these implement it.
 *
 * Both branches return a model whose `.withStructuredOutput(schema, {
 * includeRaw: true })` yields the same `{ parsed, raw }` shape with populated
 * `usage_metadata`, which is the only contract the nodes and the eval harness
 * depend on.
 */
export function createModel(maxTokens = 2048): ChatAnthropic | ChatOpenAI {
  if (config.llmProvider === "openai") {
    // No temperature/top_p here: the GPT-5.x reasoning models reject anything
    // other than the default, and leaving them unset is also what keeps
    // structured-output calls reproducible enough for the eval to be useful.
    return new ChatOpenAI({ model: config.llmModel, maxTokens });
  }
  return new ChatAnthropic({
    model: config.llmModel,
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
  const pricing = PRICING_PER_1M_TOKENS_USD[config.llmModel];
  if (!pricing) {
    logger.warn(
      { step, provider: config.llmProvider, model: config.llmModel, ...usage },
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
      provider: config.llmProvider,
      model: config.llmModel,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_cost_usd: Number(costUsd.toFixed(6)),
    },
    "llm token usage",
  );
}
