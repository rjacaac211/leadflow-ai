import pg from "pg";
import { Command, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { IntakeState, ReplyState } from "./state.js";
import type { ApprovalDecision } from "./state.js";
import {
  approvalGateNode,
  classifyReplyNode,
  crmSyncNode,
  draftOutreachNode,
  enrichNode,
  handleReplyNode,
  qualifyNode,
  sendNode,
} from "./nodes.js";

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
    .addNode("enrich", enrichNode)
    .addNode("qualify", qualifyNode)
    .addNode("crmSync", crmSyncNode)
    .addNode("draftOutreach", draftOutreachNode)
    .addNode("approvalGate", approvalGateNode)
    .addNode("send", sendNode)
    .addEdge(START, "enrich")
    .addEdge("enrich", "qualify")
    .addEdge("qualify", "crmSync")
    .addConditionalEdges(
      "crmSync",
      (state) => (state.qualified ? "draftOutreach" : END),
      ["draftOutreach", END],
    )
    .addEdge("draftOutreach", "approvalGate")
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
  await requireIntakeGraph().invoke({ leadId }, threadConfig(leadId));
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

  await graph.invoke(new Command({ resume: decision }), threadConfig(leadId));
  return intakeStatus(leadId);
}

/** Run the reply pipeline for an inbound email reply. */
export async function runReplyPipeline(
  leadId: string,
  replyText: string,
): Promise<{ intent: string; responseBody: string | null }> {
  if (!replyGraph) throw new Error("graphs not initialized — call initGraphs() first");
  const result = await replyGraph.invoke({ leadId, replyText });
  return { intent: result.intent, responseBody: result.responseBody ?? null };
}
