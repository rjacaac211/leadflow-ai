import pg from "pg";
import { Command, END, START, StateGraph, type NodeError, type RetryPolicy } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordEvent } from "../db.js";
import { isRetriableError } from "./errors.js";
import { IntakeState, ReplyState } from "./state.js";
import type { ApprovalDecision, IntakeStateType } from "./state.js";
import {
  approvalGateNode,
  classifyReplyNode,
  critiqueOutreachNode,
  crmSyncNode,
  draftOutreachNode,
  enrichNode,
  handleReplyNode,
  MAX_OUTREACH_REVISIONS,
  nextAfterCrmSync,
  qualifyNode,
  reviseOutreachNode,
  sendNode,
} from "./nodes.js";
import { shouldRevise } from "./outreach-critique.js";
import { drainUsage } from "./usage.js";

// Applied to every node via setNodeDefaults below. interrupt() (used by
// approvalGate) bypasses retry entirely regardless of this default, so it's
// safe to apply graph-wide rather than listing it on each addNode call.
const RETRY_POLICY: RetryPolicy = { maxAttempts: 3, retryOn: isRetriableError };

// Saga-style compensation for crmSync: once retries are exhausted, the CRM
// outage must not lose the lead or block outreach (see crmSyncNode), so this
// records the failure and routes to exactly where a successful crmSync would
// have gone, using the same qualified/disqualified rule as the normal edge.
async function crmSyncErrorHandler(
  state: IntakeStateType,
  error: NodeError,
): Promise<Command> {
  logger.error(
    { leadId: state.leadId, err: error.error },
    "crm sync failed after retries — continuing without CRM sync",
  );
  await recordEvent(state.leadId, "crm_sync_failed", {
    error: error.error.message,
  });
  return new Command({ update: {}, goto: nextAfterCrmSync(state.qualified) });
}

/**
 * Build the checkpointer's pg.Pool ourselves instead of handing PostgresSaver
 * the raw DATABASE_URL. `pg` re-parses `connectionString` internally and
 * applies the result AFTER any explicit config, so a `sslmode=require` left
 * in the string would silently re-enable strict cert verification and fail
 * against managed Postgres (RDS et al) with SELF_SIGNED_CERT_IN_CHAIN.
 * Strip sslmode from the string and pass ssl explicitly instead.
 */
function buildCheckpointerPool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  return new pg.Pool({
    connectionString: url.toString(),
    max: 5,
    ...(sslmode && sslmode !== "disable"
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });
}

function buildIntakeGraph(checkpointer: PostgresSaver) {
  return new StateGraph(IntakeState)
    .setNodeDefaults({ retryPolicy: RETRY_POLICY })
    .addNode("enrich", enrichNode)
    .addNode("qualify", qualifyNode)
    .addNode("crmSync", crmSyncNode, { errorHandler: crmSyncErrorHandler })
    .addNode("draftOutreach", draftOutreachNode)
    .addNode("critiqueOutreach", critiqueOutreachNode)
    .addNode("reviseOutreach", reviseOutreachNode)
    .addNode("approvalGate", approvalGateNode)
    .addNode("send", sendNode)
    .addEdge(START, "enrich")
    .addEdge("enrich", "qualify")
    .addEdge("qualify", "crmSync")
    .addConditionalEdges(
      "crmSync",
      (state) => nextAfterCrmSync(state.qualified),
      ["draftOutreach", END],
    )
    .addEdge("draftOutreach", "critiqueOutreach")
    .addConditionalEdges(
      "critiqueOutreach",
      (state) =>
        shouldRevise(state.critiquePassed, state.revisionCount, MAX_OUTREACH_REVISIONS)
          ? "reviseOutreach"
          : "approvalGate",
      ["reviseOutreach", "approvalGate"],
    )
    .addEdge("reviseOutreach", "critiqueOutreach")
    .addEdge("approvalGate", "send")
    .addEdge("send", END)
    .compile({ checkpointer });
}

function buildReplyGraph() {
  return new StateGraph(ReplyState)
    .addNode("classifyReply", classifyReplyNode)
    .addNode("handleReply", handleReplyNode)
    .addEdge(START, "classifyReply")
    .addEdge("classifyReply", "handleReply")
    .addEdge("handleReply", END)
    .compile();
}

type IntakeGraph = ReturnType<typeof buildIntakeGraph>;
type ReplyGraph = ReturnType<typeof buildReplyGraph>;

let intakeGraph: IntakeGraph | null = null;
let replyGraph: ReplyGraph | null = null;

/** Called once at server boot: creates checkpoint tables and compiles graphs. */
export async function initGraphs(): Promise<void> {
  const pool = buildCheckpointerPool(config.databaseUrl);
  const checkpointer = new PostgresSaver(pool);
  await checkpointer.setup();
  intakeGraph = buildIntakeGraph(checkpointer);
  replyGraph = buildReplyGraph();
  logger.info("agent graphs compiled (postgres checkpointer ready)");
}

function threadConfig(leadId: string) {
  return { configurable: { thread_id: `lead-${leadId}` } };
}

export type IntakeRunResult = { status: "completed" | "awaiting_approval" };

/**
 * Flush whatever LLM spend this run accumulated into the audit trail. Runs in
 * a `finally` so a failed pipeline still records what it burned before dying —
 * a run that costs money and then throws is exactly the one worth costing out.
 * Best-effort: a failure to record usage must never mask the real error.
 */
async function recordUsage(leadId: string): Promise<void> {
  const usage = drainUsage(leadId);
  if (!usage) return;
  try {
    await recordEvent(leadId, "llm_usage", { ...usage });
  } catch (error) {
    logger.warn({ leadId, err: error }, "failed to record llm usage event");
  }
}

function requireIntakeGraph(): IntakeGraph {
  if (!intakeGraph) throw new Error("graphs not initialized — call initGraphs() first");
  return intakeGraph;
}

async function intakeStatus(leadId: string): Promise<IntakeRunResult> {
  const state = await requireIntakeGraph().getState(threadConfig(leadId));
  const paused = state.tasks.some((task) => task.interrupts.length > 0);
  return { status: paused ? "awaiting_approval" : "completed" };
}

/** Run the intake pipeline for a new lead until it completes or pauses for approval. */
export async function runIntakePipeline(leadId: string): Promise<IntakeRunResult> {
  try {
    await requireIntakeGraph().invoke({ leadId }, threadConfig(leadId));
  } finally {
    await recordUsage(leadId);
  }
  return intakeStatus(leadId);
}

/** Resume a pipeline paused at the approval gate with a human decision. */
export async function resumeWithDecision(
  leadId: string,
  decision: ApprovalDecision,
): Promise<IntakeRunResult> {
  const graph = requireIntakeGraph();
  const state = await graph.getState(threadConfig(leadId));
  const paused = state.tasks.some((task) => task.interrupts.length > 0);
  if (!paused) throw new Error(`lead ${leadId} is not awaiting approval`);

  try {
    await graph.invoke(new Command({ resume: decision }), threadConfig(leadId));
  } finally {
    await recordUsage(leadId);
  }
  return intakeStatus(leadId);
}

/**
 * Recover a lead stuck mid-graph after a node past the approval gate threw
 * (e.g. `send` failing on a bad recipient) once retries were exhausted. The
 * approval interrupt is already consumed by that point, so `resumeWithDecision`
 * can't help — this instead asks the checkpoint itself (the actual source of
 * truth, unlike `Lead.stage`, which can be stale after such a failure) and
 * replays from the last checkpoint via `graph.invoke(null, ...)`.
 */
export async function retryFailedStep(leadId: string): Promise<IntakeRunResult> {
  const graph = requireIntakeGraph();
  const state = await graph.getState(threadConfig(leadId));
  const paused = state.tasks.some((task) => task.interrupts.length > 0);
  if (paused) {
    throw new Error(`lead ${leadId} has a pending approval — use approve/reject, not retry`);
  }
  if (state.next.length === 0) {
    throw new Error(`lead ${leadId} pipeline has already completed — nothing to retry`);
  }

  try {
    await graph.invoke(null, threadConfig(leadId));
  } finally {
    await recordUsage(leadId);
  }
  return intakeStatus(leadId);
}

/** Run the reply pipeline for an inbound email reply. */
export async function runReplyPipeline(
  leadId: string,
  replyText: string,
): Promise<{ intent: string; responseBody: string | null }> {
  if (!replyGraph) throw new Error("graphs not initialized — call initGraphs() first");
  let result;
  try {
    result = await replyGraph.invoke({ leadId, replyText });
  } finally {
    await recordUsage(leadId);
  }
  return { intent: result.intent, responseBody: result.responseBody ?? null };
}
