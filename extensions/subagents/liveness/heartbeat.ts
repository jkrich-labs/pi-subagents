/**
 * Heartbeat — `get_state` when there is no recent child event traffic.
 * 3 consecutive misses + no activity since → transport-dead → terminate
 * (Regime A: process/transport facts only). Misses accumulated mid-tool
 * don't count.
 */
export interface HeartbeatState {
  misses: number;
  lastActivityAt: number;
  lastHeartbeatAt: number;
  dead: boolean;
}

export function freshHeartbeat(now = Date.now()): HeartbeatState {
  return { misses: 0, lastActivityAt: now, lastHeartbeatAt: 0, dead: false };
}

export interface HeartbeatTickInput {
  now: number;
  activitySinceLastHeartbeat: boolean; // any event traffic arrived?
  midTool: boolean; // is a tool running? (mid-tool misses don't count)
  heartbeatRoundTripOk: boolean; // did get_state answer?
  lastMissWasMidToolInARow: boolean; // defensive: refuse to count mid-tool miss chains
}

export function heartbeatTick(prev: HeartbeatState, input: HeartbeatTickInput): HeartbeatState {
  if (input.midTool || input.activitySinceLastHeartbeat) {
    return { ...prev, misses: 0, lastActivityAt: input.now, lastHeartbeatAt: input.now, dead: false };
  }
  const misses = input.heartbeatRoundTripOk ? 0 : prev.misses + 1;
  if (input.heartbeatRoundTripOk) {
    return { ...prev, misses: 0, lastHeartbeatAt: input.now };
  }
  // no traffic + failed round trip = accumulate
  const next = { ...prev, misses, lastHeartbeatAt: input.now };
  if (misses >= 3) next.dead = true;
  return next;
}

export const MISSES_TO_TERMINATE = 3;
