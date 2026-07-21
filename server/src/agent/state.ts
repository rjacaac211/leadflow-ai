import { Annotation } from "@langchain/langgraph";

/** State for the lead-intake pipeline (one thread per lead). */
export const IntakeState = Annotation.Root({
  leadId: Annotation<string>,
  enrichment: Annotation<string | null>,
  score: Annotation<number>,
  tier: Annotation<string>,
  qualified: Annotation<boolean>,
  qualificationReason: Annotation<string>,
  draftMessageId: Annotation<string | null>,
  draftSubject: Annotation<string>,
  draftBody: Annotation<string>,
  approved: Annotation<boolean>,
});

export type IntakeStateType = typeof IntakeState.State;

/** Resume payload sent when a human approves/rejects a drafted outreach email. */
export interface ApprovalDecision {
  decision: "approve" | "reject";
  subject?: string;
  body?: string;
  reason?: string;
}

/** State for the inbound-reply pipeline (stateless, one run per reply). */
export const ReplyState = Annotation.Root({
  leadId: Annotation<string>,
  replyText: Annotation<string>,
  intent: Annotation<"interested" | "question" | "opt_out" | "other">,
  intentReasoning: Annotation<string>,
  responseBody: Annotation<string | null>,
});

export type ReplyStateType = typeof ReplyState.State;
