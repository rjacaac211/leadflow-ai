const MIN_WORDS = 90;
const MAX_WORDS = 140;
const MAX_SUBJECT_CHARS = 80;

/**
 * Deterministic checks a draft must pass regardless of what the semantic
 * critique LLM call thinks — the constraints already stated in the draft
 * prompt (nodes.ts) but never actually verified before this. Kept separate
 * from LLM judgment for the same "auditable, not vibes" reason scoring.ts is.
 */
export function lintOutreachDraft(subject: string, body: string): string[] {
  const issues: string[] = [];

  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    issues.push(`body is ${wordCount} words, expected ${MIN_WORDS}-${MAX_WORDS}`);
  }

  if (subject.length > MAX_SUBJECT_CHARS) {
    issues.push(`subject is ${subject.length} characters, expected at most ${MAX_SUBJECT_CHARS}`);
  }

  if (/\[[^\]]*\]/.test(subject) || /\[[^\]]*\]/.test(body)) {
    issues.push("contains placeholder-style brackets");
  }

  if (/\*\*[^*]+\*\*|^#{1,6}\s|^[-*]\s|`[^`]+`/m.test(body)) {
    issues.push("contains markdown syntax");
  }

  if (/\bsource\b/i.test(body)) {
    issues.push("may leak internal lead-source metadata");
  }

  return issues;
}

/** Termination condition for the draft -> critique -> revise cycle in graph.ts. */
export function shouldRevise(
  passes: boolean,
  revisionCount: number,
  maxRevisions: number,
): boolean {
  return !passes && revisionCount < maxRevisions;
}
