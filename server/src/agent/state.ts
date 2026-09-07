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
  revisionCount: Annotation<number>,
  critiquePassed: Annotation<boolean>,
  critiqueIssues: Annotation<string[]>,
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

/** Reply intent taxonomy. Auto-reply eligibility for each is in nodes.ts's AUTO_REPLY_INTENTS. */
export type ReplyIntent =
  | "interested"
  | "meeting_request"
  | "pricing_question"
  | "product_question"
  | "objection"
  | "referral"
  | "opt_out"
  | "wrong_person"
  | "other";

/** State for the inbound-reply pipeline (stateless, one run per reply). */
export const ReplyState = Annotation.Root({
  leadId: Annotation<string>,
  replyText: Annotation<string>,
  intent: Annotation<ReplyIntent>,
  intentReasoning: Annotation<string>,
  responseBody: Annotation<string | null>,
});

export type ReplyStateType = typeof ReplyState.State;
