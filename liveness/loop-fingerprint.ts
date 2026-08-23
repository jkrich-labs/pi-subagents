/**
 * Loop fingerprint — per-turn signature and repetition detection.
 *
 * Per the plan: fingerprint = tool-name multiset + hashed args + hashed
 * results + shingled assistant text over a ~12-turn sliding window.
 * Pure functions over synthetic or live turn records. Regime B semantics —
 * NEVER kills.
 */
import { createHash } from "node:crypto";

export interface TurnRecord {
  toolNames: string[]; // names in order of appearance
  toolArgsHash: string; // pre-hashed args
  toolResultsHash: string; // pre-hashed results
  assistantText: string;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("base64").slice(0, 16);
}

/** One 3-wide shingle set of the assistant text. */
export function shingles(text: string, width = 3): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length <= width) return words.length > 0 ? [words.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + width <= words.length; i++) {
    out.push(words.slice(i, i + width).join(" "));
  }
  return out;
}

export interface Fingerprint {
  toolMultiset: string;
  args: string;
  results: string;
  shingleSet: string[];
}

export function fingerprint(turn: TurnRecord): Fingerprint {
  const multiset = [...turn.toolNames].sort().join(",");
  return {
    toolMultiset: multiset,
    args: hash(turn.toolArgsHash),
    results: hash(turn.toolResultsHash),
    shingleSet: shingles(turn.assistantText),
  };
}

export interface WindowFrame extends Fingerprint {
  exactArgsResults: boolean;
}

export function frameFor(turn: TurnRecord): WindowFrame {
  const fp = fingerprint(turn);
  return {
    ...fp,
    exactArgsResults: turn.toolArgsHash === turn.toolResultsHash,
  };
}

/**
 * Repetition dominance: whether the window (max ~12 frames) is dominated by
 * an identical tool multiset + matched shingles with stale args/results.
 * Purely pattern-based, not time-based.
 */
export function isLooping(window: WindowFrame[], opts?: { minFrames?: number; dominance?: number }): boolean {
  const frames = window.slice(-(opts?.minFrames ?? 12));
  if (frames.length < 3) return false;
  const last = frames[frames.length - 1];
  let dominated = 0;
  for (const f of frames) {
    const sameTools = f.toolMultiset === last.toolMultiset && f.toolMultiset.length > 0;
    const overlap = f.shingleSet.length > 0 && last.shingleSet.length > 0 && f.shingleSet.some((s) => last.shingleSet.includes(s));
    if (sameTools && overlap) dominated++;
  }
  return dominated / frames.length >= (opts?.dominance ?? 0.7);
}

/** Cooldown double-ups for KEEP-GOING as specified. */
export function nextCooldown(current: number, cap = Infinity): number {
  return Math.min(cap, Math.max(current, 1) * 2);
}
