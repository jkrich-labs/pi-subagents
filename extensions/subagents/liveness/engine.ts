/**
 * Liveness engine — wires heartbeat, stall/loop probes, tombstones and the
 * orphan reaper into the hub's poll tick. Regime A terminates on
 * process/transport facts only; Regime B (semantics) probes, never kills.
 */
import { Hub } from "../hub.ts";
import { freshHeartbeat, heartbeatTick } from "./heartbeat.ts";
import { freshStallState, stallStep, shouldProbe, isStalled } from "./stall.ts";
import { frameFor, isLooping } from "./loop-fingerprint.ts";
import { probeDecision, type ProbeState } from "./probe.ts";
import { JsonlTombstones } from "./tombstones.ts";
import { writePidfile, sweep, pidAlive } from "./orphan-reaper.ts";
import { ring } from "../ring/store.ts";

export interface EngineManifest {
  heartbeat: ReturnType<typeof freshHeartbeat>;
  stall: ReturnType<typeof freshStallState>;
  probe: ProbeState;
  window: ReturnType<typeof frameFor>[];
}

// Sole map keyed by child id; engine keeps rollup state per hub.
export class LivenessEngine {
  private readonly hub: Hub;
  private readonly tombstones: JsonlTombstones;
  private states = new Map<string, EngineManifest>();

  constructor(hub: Hub, tombstonesDir: string) {
    this.hub = hub;
    this.tombstones = new JsonlTombstones(tombstonesDir);
    this.hub.onSpawn = (id) => this.onSpawn(id);
    this.hub.onExit = (id, reason) => this.onExit(id, reason);
    this.hub.onTurn = (id, rec) => this.onTurn(id, rec);
  }

  private onSpawn(id: string): void {
    const view = this.hub.getView(id);
    this.states.set(id, {
      heartbeat: freshHeartbeat(),
      stall: freshStallState(),
      probe: { cooldownTurns: 0, fires: 0, unaddressed: 0 },
      window: [],
    });
    const child = this.hub.getChild(id);
    if (child) {
      writePidfile(this.hub.ground.pids, {
        childId: id,
        pid: child.proc.pid ?? -1,
        ppid: process.pid,
        sessionFile: view?.sessionFile ?? "",
        spawnedAt: Date.now(),
      });
    }
  }

  private onExit(id: string, reason: string): void {
    const st = this.states.get(id);
    this.tombstones.write({
      childId: id,
      reason,
      lastCursor: st ? String(st.probe.fires) : null,
      at: new Date().toISOString(),
    });
  }

  private onTurn(id: string, rec: { toolCallCount: number; thinkingText: string; reportText: string; toolNames: string[]; toolArgsHash: string; toolResultsHash: string; assistantText: string }): void {
    const st = this.states.get(id);
    if (!st) return;
    // heartbeat ground truth: activity happened
    st.heartbeat = heartbeatTick(st.heartbeat, {
      now: Date.now(),
      activitySinceLastHeartbeat: true,
      midTool: false,
      heartbeatRoundTripOk: true,
      lastMissWasMidToolInARow: false,
    });
    // stall
    st.stall = stallStep(st.stall, st.probe.fires, rec, () => st.probe.cooldownTurns === 0);
    if (shouldProbe(st.stall)) {
      const d = probeDecision(st.probe, "stall", false, true);
      st.probe = { ...st.probe, cooldownTurns: d.cooldown };
      if (d.probe) void this.hub.steer(id, d.message).catch(() => {});
    }
    // loop fingerprint
    if (rec.toolNames.length > 0) {
      st.window.push(frameFor({ toolNames: rec.toolNames, toolArgsHash: rec.toolArgsHash, toolResultsHash: rec.toolResultsHash, assistantText: rec.assistantText }));
      if (st.window.length > 12) st.window.shift();
      if (isLooping(st.window)) {
        const d = probeDecision(st.probe, "loop", false, true);
        st.probe = { ...st.probe, cooldownTurns: d.cooldown };
        if (d.probe) void this.hub.steer(id, d.message).catch(() => {});
        ring.upsert(id, { loopHits: (ring.get(id)?.loopHits ?? 0) + 1 });
      }
    }
  }

  /** Poll tick: sweep orphan pidfiles, run heartbeats. */
  tick(now = Date.now()): void {
    const result = sweep(this.hub.ground.pids, (pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already dead */ }
    });
    for (const id of result.reclaimed) {
      this.tombstones.write({ childId: id, reason: "orphan-reaped", lastCursor: null, at: new Date().toISOString() });
    }

    for (const id of this.hub.list()) {
      const child = this.hub.getChild(id);
      if (!child || !child.isRunning()) continue;
      const st = this.states.get(id);
      if (!st) continue;
      void child
        .send("get_state", {}, 3000)
        .then(() => {
          st.heartbeat = heartbeatTick(st.heartbeat, {
            now,
            activitySinceLastHeartbeat: false,
            midTool: false,
            heartbeatRoundTripOk: true,
            lastMissWasMidToolInARow: false,
          });
        })
        .catch(() => {
          st.heartbeat = heartbeatTick(st.heartbeat, {
            now,
            activitySinceLastHeartbeat: false,
            midTool: false,
            heartbeatRoundTripOk: false,
            lastMissWasMidToolInARow: false,
          });
          if (st.heartbeat.dead) {
            this.hub.getChild(id)?.kill();
            this.tombstones.write({ childId: id, reason: "transport-dead (3 heartbeat misses)", lastCursor: null, at: new Date().toISOString() });
            ring.upsert(id, { status: "crashed" });
          }
        });
    }
  }

  /** Was a pid recorded yet alive? (Reaper coherence assertion.) */
  pidStillAlive(pid: number): boolean {
    return pidAlive(pid);
  }
}
