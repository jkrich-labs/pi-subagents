/**
 * Probe policy — stall/loop probes ask the child to reply KEEP-GOING when the
 * repetition is intentional. KEEP-GOING applies a ×2 cooldown per re-fire;
 * unaddressed + still-tripping escalates loudly to a human. Regime B —
 * probe code has no kill path.
 */
export interface ProbeResult {
  probe: boolean;
  message: string;
  cooldown: number;
  escalate: boolean;
  state: ProbeState;
}

export interface ProbeState {
  cooldownTurns: number;
  fires: number;
  unaddressed: number;
}

export const PROBE_STALL_MSG =
  "You appear stalled (no tools, no thinking, no report). State your situation or end the turn. " +
  "If you are intentionally waiting/retrying, reply with exactly: KEEP-GOING";
export const PROBE_LOOP_MSG =
  "Your recent turns show a repeating tool pattern. If this is intentional retry/backoff/waiting, " +
  "reply with exactly: KEEP-GOING. Otherwise state your blocker in one line.";

export function probeDecision(prev: ProbeState, trip: "stall" | "loop", childSaidKeepGoing: boolean, cooldownExpired: boolean): ProbeResult {
  let fires = prev.fires;
  let cooldown = prev.cooldownTurns;
  let unaddressed = prev.unaddressed;

  if (childSaidKeepGoing) {
    const state = applyKeepGoing(prev);
    return { probe: false, message: "", cooldown: state.cooldownTurns, escalate: false, state };
  }

  if (cooldown > 0 && !cooldownExpired) {
    return { probe: false, message: "", cooldown, escalate: false, state: { cooldownTurns: cooldown, fires, unaddressed } };
  }

  if (cooldown > 0 && cooldownExpired) cooldown = 0;

  if (unaddressed >= 2) {
    return { probe: false, message: "", cooldown, escalate: true, state: { cooldownTurns: cooldown, fires, unaddressed } };
  }

  fires += 1;
  unaddressed += 1;
  const message = trip === "stall" ? PROBE_STALL_MSG : PROBE_LOOP_MSG;
  return {
    probe: true,
    message,
    cooldown,
    escalate: false,
    state: { cooldownTurns: cooldown, fires, unaddressed },
  };
}

export function applyKeepGoing(prev: ProbeState): ProbeState {
  return { cooldownTurns: Math.max(prev.cooldownTurns, 1) * 2, fires: prev.fires, unaddressed: 0 };
}
