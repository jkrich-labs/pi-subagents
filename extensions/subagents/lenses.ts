/**
 * Lenses — the bounded digests the hub surfaces on the parent. Only the
 * per-turn lens budget (~1000 tokens) applies: raw transcripts always stay
 * in the child's own session file.
 */
import { join } from "node:path";

export interface CompletionLens {
  type: "completion";
  childId: string;
  ref: string;
  sessionPath: string;
  digest: string;
  lastTurnAt: number;
}

export interface AskLens {
  type: "ask";
  childId: string;
  question: string;
  sessionPath: string;
  at: number;
}

export interface StallLens {
  type: "stall";
  childId: string;
  summary: string;
  consecutiveTurns: number;
  at: number;
}

export type Lens = CompletionLens | AskLens | StallLens;

const MAX_DIGEST_CHARS = 4000;

function truncateWords(text: string, words: number): string {
  const parts = text.trim().split(/\s+/);
  const wordBounded = parts.length <= words ? text.trim() : `${parts.slice(0, words).join(" ")} …`;
  if (wordBounded.length <= MAX_DIGEST_CHARS) return wordBounded;
  return `${wordBounded.slice(0, MAX_DIGEST_CHARS).trimEnd()} …`;
}

/** Per-turn digest: at most ~150 words of the child's final text. */
export function makeCompletionLens(childId: string, finalText: string, sessionFile: string | undefined, now = Date.now()): CompletionLens {
  return {
    type: "completion",
    childId,
    ref: childId,
    sessionPath: sessionFile ?? join("(no session file — abnormal)", ""),
    digest: truncateWords(finalText, 150),
    lastTurnAt: now,
  };
}

export function makeAskLens(childId: string, question: string, sessionFile: string | undefined, now = Date.now()): AskLens {
  return {
    type: "ask",
    childId,
    question: truncateWords(question, 150),
    sessionPath: sessionFile ?? "",
    at: now,
  };
}
