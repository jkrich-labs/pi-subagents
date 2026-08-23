/**
 * Stall detector — counts consecutive settled turns with no tool calls, no
 * thinking content, and no report. Fires at exactly 2 (probe). Regime B —
 * never kills.
 */
export interface SettledTurn {
  toolCallCount: number;
  thinkingText: string;
  reportText: string;
}

export interface StallState {
  consecutive: number;
  lastStallAtTurn: number;
  cooldownAt: number; // KEEP-GOING cooldown (turn index it expires)
  probeFiredTurns: number;
}

export function freshStallState(): StallState {
  return { consecutive: 0, lastStallAtTurn: -1, cooldownAt: -1, probeFiredTurns: 0 };
}

export function isStalled(turn: SettledTurn): boolean {
  return turn.toolCallCount === 0 && turn.thinkingText.trim().length === 0 && turn.reportText.trim().length === 0;
}

export function stallStep(prev: StallState, turnIndex: number, turn: SettledTurn, cooldownActive: (turnIndex: number) => boolean): StallState {
  if (!isStalled(turn)) {
    return { ...prev, consecutive: 0, lastStallAtTurn: turnIndex };
  }
  if (cooldownActive(turnIndex)) {
    // KEEP-GOING cooldown: paused counting, not reset — long-horizon work
    // is never harassed while it self-reports intentional waits.
    return { ...prev, lastStallAtTurn: turnIndex };
  }
  return { ...prev, consecutive: prev.consecutive + 1, lastStallAtTurn: turnIndex };
}

export function shouldProbe(state: StallState): boolean {
  return state.consecutive === 2;
}
