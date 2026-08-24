/**
 * Liveness engine — combines transport heartbeats with progress-based semantic
 * attention. Process/transport facts may terminate a child; semantic signals
 * only wake the parent and remain recoverable.
 */
import { Hub } from "../hub.ts";
import { freshHeartbeat, heartbeatTick } from "./heartbeat.ts";
import { freshStallState, stallStep, shouldProbe } from "./stall.ts";
import { frameFor, isLooping } from "./loop-fingerprint.ts";
import { applyKeepGoing, probeDecision, type ProbeState } from "./probe.ts";
import { JsonlTombstones } from "./tombstones.ts";
import { writePidfile, removePidfile, sweep, pidAlive, processIdentity } from "./orphan-reaper.ts";
import { ring, type AttentionKind } from "../ring/store.ts";

export interface EngineManifest {
  heartbeat: ReturnType<typeof freshHeartbeat>;
  heartbeatPending: boolean;
  transportFailing: boolean;
  stall: ReturnType<typeof freshStallState>;
  probe: ProbeState;
  window: ReturnType<typeof frameFor>[];
  turnIndex: number;
  midTool: boolean;
  isStreaming: boolean;
}

export interface LivenessOptions {
  /** Delay before probing an otherwise quiet RPC transport. */
  heartbeatQuietMs?: number;
  /** Quiet model-stream threshold. Warning only; never an automatic kill. */
  providerQuietMs?: number;
  /** Quiet in-tool threshold. Warning only; never an automatic kill. */
  toolQuietMs?: number;
}

const DEFAULT_HEARTBEAT_QUIET_MS = 5_000;
const DEFAULT_PROVIDER_QUIET_MS = 450_000;
const DEFAULT_TOOL_QUIET_MS = 1_200_000;
const LIVENESS_ATTENTION: readonly AttentionKind[] = [
  "provider-stall",
  "tool-stall",
  "semantic-stall",
  "semantic-loop",
];

function threshold(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (selected === Number.POSITIVE_INFINITY) return selected;
  if (!Number.isFinite(selected) || selected < 0) throw new Error("liveness thresholds must be non-negative or Infinity");
  return selected;
}

function exactLine(text: string, token: string): boolean {
  return text.split("\n").some((line) => line.trim() === token);
}

export class LivenessEngine {
  private readonly hub: Hub;
  private readonly tombstones: JsonlTombstones;
  private readonly heartbeatQuietMs: number;
  private readonly providerQuietMs: number;
  private readonly toolQuietMs: number;
  private states = new Map<string, EngineManifest>();

  constructor(hub: Hub, tombstonesDir: string, options: LivenessOptions = {}) {
    this.hub = hub;
    this.tombstones = new JsonlTombstones(tombstonesDir);
    this.heartbeatQuietMs = threshold(options.heartbeatQuietMs, DEFAULT_HEARTBEAT_QUIET_MS);
    this.providerQuietMs = threshold(options.providerQuietMs, DEFAULT_PROVIDER_QUIET_MS);
    this.toolQuietMs = threshold(options.toolQuietMs, DEFAULT_TOOL_QUIET_MS);
    this.hub.onSpawn = (id) => this.onSpawn(id);
    this.hub.onExit = (id, reason) => this.onExit(id, reason);
    this.hub.onEvent = (id, line) => this.onEvent(id, line);
    this.hub.onTurn = (id, rec) => this.onTurn(id, rec);
  }

  private onSpawn(id: string): void {
    const view = this.hub.getView(id);
    this.states.set(id, {
      heartbeat: freshHeartbeat(view?.spawnedAt),
      heartbeatPending: false,
      transportFailing: false,
      stall: freshStallState(),
      probe: { cooldownTurns: 0, fires: 0, unaddressed: 0 },
      window: [],
      turnIndex: 0,
      midTool: false,
      isStreaming: view?.isStreaming ?? true,
    });
    const child = this.hub.getChild(id);
    if (child?.proc.pid) {
      const identity = processIdentity(child.proc.pid);
      const parentIdentity = processIdentity(process.pid);
      if (identity && parentIdentity && identity.parentPid === process.pid) {
        writePidfile(this.hub.ground.pids, {
          childId: id,
          pid: child.proc.pid,
          ppid: process.pid,
          sessionFile: view?.sessionFile ?? "",
          spawnedAt: Date.now(),
          processStartTime: identity.processStartTime,
          processGroup: identity.processGroup,
          executable: identity.executable,
          parentStartTime: parentIdentity.processStartTime,
          parentExecutable: parentIdentity.executable,
        });
      }
    }
  }

  private onExit(id: string, reason: string): void {
    const st = this.states.get(id);
    const view = this.hub.getView(id);
    removePidfile(this.hub.ground.pids, id);
    this.states.delete(id);
    this.tombstones.write({
      childId: id,
      reason,
      lastCursor: st ? String(st.probe.fires) : null,
      at: new Date().toISOString(),
      sessionFile: view?.sessionFile,
      title: view?.title,
      provider: view?.provider,
      model: view?.model,
    });
  }

  private onEvent(id: string, line: Record<string, unknown>): void {
    const st = this.states.get(id);
    if (!st) return;
    const type = typeof line.type === "string" ? line.type : "";
    if (type === "agent_start") st.isStreaming = true;
    if (type === "agent_settled") {
      st.isStreaming = false;
      st.midTool = false;
    }
    if (type === "tool_execution_start") st.midTool = true;
    if (type === "tool_execution_end") st.midTool = false;

    const meaningful = type !== "response" && type !== "stderr" && type !== "queue_update";
    if (meaningful) {
      st.heartbeat = heartbeatTick(st.heartbeat, {
        now: Date.now(),
        activitySinceLastHeartbeat: true,
        midTool: st.midTool,
        heartbeatRoundTripOk: true,
        lastMissWasMidToolInARow: false,
      });
      if (type !== "agent_settled") this.hub.clearAttention(id, LIVENESS_ATTENTION);
    }
  }

  private applyProbe(id: string, st: EngineManifest, trip: "stall" | "loop"): void {
    const decision = probeDecision(st.probe, trip, false, st.probe.cooldownTurns === 0);
    st.probe = decision.state;
    if (decision.probe) {
      if (trip === "stall") {
        st.stall = { ...st.stall, consecutive: 0, probeFiredTurns: st.stall.probeFiredTurns + 1 };
        ring.upsert(id, { stallCount: (ring.get(id)?.stallCount ?? 0) + 1 });
      }
      void this.hub.steer(id, decision.message).catch((error) => {
        this.hub.reportAttention(id, trip === "stall" ? "semantic-stall" : "semantic-loop", `Liveness probe could not be delivered: ${String(error)}`);
      });
    }
    if (decision.escalate) {
      this.hub.reportAttention(
        id,
        trip === "stall" ? "semantic-stall" : "semantic-loop",
        trip === "stall"
          ? "Repeated empty settled turns did not address the liveness probe."
          : "A repeating tool pattern continued without addressing the liveness probe.",
      );
    }
  }

  private onTurn(id: string, rec: { toolCallCount: number; thinkingText: string; reportText: string; toolNames: string[]; toolArgsHash: string; toolResultsHash: string; assistantText: string }): void {
    const st = this.states.get(id);
    if (!st) return;
    st.turnIndex += 1;

    if (exactLine(rec.assistantText, "KEEP-GOING")) {
      st.probe = applyKeepGoing(st.probe);
      st.stall = { ...st.stall, consecutive: 0 };
      this.hub.clearAttention(id, LIVENESS_ATTENTION);
      return;
    }

    const cooling = st.probe.cooldownTurns > 0;
    if (cooling) st.probe = { ...st.probe, cooldownTurns: st.probe.cooldownTurns - 1 };
    st.stall = stallStep(st.stall, st.turnIndex, rec, () => cooling);
    if (!cooling && shouldProbe(st.stall)) this.applyProbe(id, st, "stall");

    if (rec.toolNames.length > 0) {
      st.window.push(frameFor({
        toolNames: rec.toolNames,
        toolArgsHash: rec.toolArgsHash,
        toolResultsHash: rec.toolResultsHash,
        assistantText: rec.assistantText,
      }));
      if (st.window.length > 12) st.window.shift();
      if (isLooping(st.window)) {
        ring.upsert(id, { loopHits: (ring.get(id)?.loopHits ?? 0) + 1 });
        if (!cooling) this.applyProbe(id, st, "loop");
      }
    }
  }

  private checkQuietProgress(id: string, now: number): void {
    const view = this.hub.getView(id);
    if (!view || !view.isStreaming) return;
    const lastActivityAt = view.lastActivityAt ?? view.spawnedAt;
    const quietMs = Math.max(0, now - lastActivityAt);
    if (view.currentTool) {
      if (quietMs >= this.toolQuietMs) {
        this.hub.reportAttention(
          id,
          "tool-stall",
          `No child activity for ${Math.floor(quietMs / 1000)}s while ${view.currentTool} is running. The tool was not interrupted.`,
        );
      }
      return;
    }
    if (quietMs >= this.providerQuietMs) {
      this.hub.reportAttention(
        id,
        "provider-stall",
        `No model or tool activity for ${Math.floor(quietMs / 1000)}s while the child remains streaming. The child was not interrupted.`,
      );
    }
  }

  /** Poll tick: sweep orphan pidfiles, check progress, and run one heartbeat per child. */
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
      const st = this.states.get(id);
      const view = this.hub.getView(id);
      if (!child || !child.isRunning() || !st || !view || st.transportFailing) continue;
      this.checkQuietProgress(id, now);
      if (st.heartbeatPending || now - (view.lastEventAt ?? view.spawnedAt) < this.heartbeatQuietMs) continue;

      st.heartbeatPending = true;
      void child.send("get_state", {}, 3000)
        .then((response) => {
          if (!response.success) throw new Error(response.error ?? "get_state failed");
          const data = response.data as { isStreaming?: unknown } | undefined;
          if (typeof data?.isStreaming === "boolean") {
            st.isStreaming = data.isStreaming;
            ring.upsert(id, { isStreaming: data.isStreaming, lastHeartbeatAt: now });
          } else {
            ring.upsert(id, { lastHeartbeatAt: now });
          }
          st.heartbeat = heartbeatTick(st.heartbeat, {
            now,
            activitySinceLastHeartbeat: false,
            midTool: st.midTool,
            heartbeatRoundTripOk: true,
            lastMissWasMidToolInARow: false,
          });
        })
        .catch(() => {
          st.heartbeat = heartbeatTick(st.heartbeat, {
            now,
            activitySinceLastHeartbeat: false,
            midTool: st.midTool,
            heartbeatRoundTripOk: false,
            lastMissWasMidToolInARow: st.midTool,
          });
          if (st.heartbeat.dead && !st.transportFailing) {
            st.transportFailing = true;
            void this.hub.failTransport(id, "transport-dead (3 heartbeat misses)");
          }
        })
        .finally(() => {
          st.heartbeatPending = false;
        });
    }
  }

  pidStillAlive(pid: number): boolean {
    return pidAlive(pid);
  }
}
