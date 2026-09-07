import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface IcpCriterion {
  name: string;
  description: string;
  weight: number;
  /**
   * Optional veto. When the LLM rates this criterion at or below this value,
   * the lead is disqualified outright regardless of its weighted score.
   *
   * Exists because a weighted average dilutes a decisive negative: the offline
   * eval caught a competitor rated `pain_signal: 0` still scoring 36/100 —
   * above the disqualify cutoff — on the strength of its industry and size.
   * Omit to leave a criterion non-gating.
   */
  disqualifyAtOrBelow?: number;
}

export interface IcpConfig {
  productPitch: string;
  targetCustomer: string;
  criteria: IcpCriterion[];
  tierThresholds: { hot: number; warm: number };
  disqualifyBelow: number;
}

function loadIcpConfig(): IcpConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath =
    process.env.ICP_CONFIG_PATH ?? path.resolve(here, "../../icp.config.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as IcpConfig;
}

export type LlmProvider = "anthropic" | "openai";

/**
 * Both defaults are the smallest model that actually clears `npm run eval`'s
 * committed thresholds. gpt-5.4-mini and -nano are ~4-13x cheaper again but
 * both fail it in business-meaningful ways (see the README's model table), so
 * they're documented rather than defaulted to.
 */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.4",
};

/**
 * Which chat provider the agent runs on. `LLM_PROVIDER` wins when set;
 * otherwise infer from whichever key is present, preferring Anthropic — it's
 * the documented default and what the README's numbers were measured on.
 *
 * Inference only breaks the tie when exactly one key exists, so a machine with
 * both keys must choose explicitly rather than silently getting whichever the
 * code happens to check first.
 */
function resolveProvider(): LlmProvider {
  const explicit = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  if (explicit !== "") {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "openai", got "${explicit}"`);
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "anthropic";
}

const llmProvider = resolveProvider();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  llmProvider,
  /** Model id for the active provider — what every call site and the cost table use. */
  llmModel:
    (llmProvider === "openai" ? process.env.OPENAI_MODEL : process.env.ANTHROPIC_MODEL) ||
    DEFAULT_MODELS[llmProvider],
  webhookApiKey: process.env.WEBHOOK_API_KEY ?? "",
  hubspotAccessToken: process.env.HUBSPOT_ACCESS_TOKEN ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  outreachFromEmail:
    process.env.OUTREACH_FROM_EMAIL || "LeadFlow <onboarding@resend.dev>",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackApprovalChannel: process.env.SLACK_APPROVAL_CHANNEL ?? "",
  icp: loadIcpConfig(),
};
