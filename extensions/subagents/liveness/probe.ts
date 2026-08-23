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
  let escalate = false;

  if (childSaidKeepGoing) {
    // ×2 per re-fire
    cooldown = Math.max(cooldown, 1) * 2;
    unaddressed = 0;
    return { probe: false, message: "", cooldown, escalate: false };
  }

  if (cooldown > 0 && !cooldownExpired) {
    return { probe: false, message: "", cooldown, escalate: false };
  }

  if (cooldown > 0 && cooldownExpired) {
    cooldown = 0;
  }

  if (prev.unaddressed >= 2) {
    escalate = true;
    return { probe: false, message: "", cooldown, escalate };
  }

  fires += 1;
  unaddressed += 1;
  const message = trip === "stall" ? PROBE_STALL_MSG : PROBE_LOOP_MSG;
  return { probe: true, message, cooldown, escalate };
}

export function applyKeepGoing(prev: ProbeState): ProbeState {
  return { cooldownTurns: Math.max(prev.cooldownTurns, 1) * 2, fires: prev.fires, unaddressed: 0 };
}
