/**
 * Steering router — pure function over parent/user text.
 * The hub's comms path parses these prefixes out of parent steering
 * (assistant text) and user input, and forwards via follow_up/steer.
 *
 * Prefixes (CONTEXT.md naming invariants):
 *   @all  <text> — every live child
 *   @<id> <text> — exactly one child
 *   @user <text> — back to the human user
 */
export type RouteTarget = "all" | "child" | "user";

export interface Steer {
  target: RouteTarget;
  childId?: string;
  text: string;
}

const PREFIX = /^\s*@(all|[A-Za-z0-9_-]+)\s+(.*)$/;

/** Parse one line into a steer, or null when the line is not steered. */
export function parseSteerLine(line: string): Steer | null {
  const m = PREFIX.exec(line);
  if (!m) return null;
  const token = m[1];
  const text = (m[2] ?? "").trim();
  if (token === "all") return { target: "all", text };
  if (token === "user") return { target: "user", text };
  return { target: "child", childId: token, text };
}

/** All steers in a multi-line message. */
export function routeSteers(text: string): Steer[] {
  const out: Steer[] = [];
  for (const line of text.split("\n")) {
    const s = parseSteerLine(line);
    if (s) out.push(s);
  }
  return out;
}

/** Strip routing prefixes from a message (used when text continues to the parent). */
export function stripSteers(text: string): string {
  return text
    .split("\n")
    .filter((line) => parseSteerLine(line) === null)
    .join("\n");
}
