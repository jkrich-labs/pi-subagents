/**
 * Child token-command scanner — the hub-control codes children speak
 * inside their completions (CONTEXT.md invariants):
 *   DONE-PARENT  RESET-PARENT  INCR-PARENT   ASK: <question>
 */
export const DONE = "DONE-PARENT";
export const RESET = "RESET-PARENT";
export const INCR = "INCR-PARENT";

export interface ChildReport {
  done: boolean;
  reset: boolean;
  incr: boolean;
  ask?: string;
}

export function reportFrom(text: string): ChildReport {
  return {
    done: text.includes(DONE),
    reset: text.includes(RESET),
    incr: text.includes(INCR),
    ask: askFrom(text),
  };
}

function askFrom(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const m = /^\s*ASK:\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}
