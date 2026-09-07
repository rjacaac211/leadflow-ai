/**
 * Per-lead rollup of LLM token spend.
 *
 * `logTokenUsage` already logs every call, but a log line answers "what did
 * this one call cost", not "what did this lead cost" — which is the number
 * that actually matters when deciding whether the pipeline is affordable at
 * volume. This accumulates calls in memory keyed by lead, and graph.ts drains
 * it at the end of each pipeline run into an `llm_usage` LeadEvent so the cost
 * lands in the same audit trail the dashboard already renders.
 *
 * Keyed by leadId because intake runs are fire-and-forget and several can be
 * in flight at once. `drainUsage` deletes the entry, so a completed run leaves
 * nothing behind; a run that dies before draining leaks one small object,
 * which is why nothing here holds message content.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageTotals extends TokenUsage {
  calls: number;
}

const totals = new Map<string, UsageTotals>();

export function accumulateUsage(leadId: string, usage: TokenUsage): void {
  const current = totals.get(leadId);
  if (!current) {
    totals.set(leadId, { calls: 1, ...usage });
    return;
  }
  current.calls += 1;
  current.inputTokens += usage.inputTokens;
  current.outputTokens += usage.outputTokens;
  current.costUsd += usage.costUsd;
}

/** Returns and clears the totals for a lead, or null if nothing accumulated. */
export function drainUsage(leadId: string): UsageTotals | null {
  const current = totals.get(leadId);
  if (!current) return null;
  totals.delete(leadId);
  return { ...current, costUsd: Number(current.costUsd.toFixed(6)) };
}
