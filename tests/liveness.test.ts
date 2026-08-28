/**
 * S-08 liveness tests — unit seams (fingerprint/stall/probe/heartbeat/
 * reaper) on synthetic transcripts + engine integration with a live child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameFor, isLooping, nextCooldown } from "../extensions/subagents/liveness/loop-fingerprint.ts";
import { freshStallState, isStalled, stallStep, shouldProbe } from "../extensions/subagents/liveness/stall.ts";
import { probeDecision, applyKeepGoing } from "../extensions/subagents/liveness/probe.ts";
import { freshHeartbeat, heartbeatTick, MISSES_TO_TERMINATE } from "../extensions/subagents/liveness/heartbeat.ts";
import { writePidfile, sweep } from "../extensions/subagents/liveness/orphan-reaper.ts";
import { Ground } from "../extensions/subagents/ground.ts";
import { Hub, type Delivery } from "../extensions/subagents/hub.ts";
import type { CommandResponse, RpcChildHandle, WireLine } from "../extensions/subagents/child.ts";
import { LivenessEngine } from "../extensions/subagents/liveness/engine.ts";
import { ring } from "../extensions/subagents/ring/store.ts";

function controlledChild(options: {
  getState?: () => Promise<CommandResponse>;
} = {}): {
  child: RpcChildHandle;
  emit: (line: WireLine) => void;
  commands: string[];
} {
  const lines: WireLine[] = [];
  const commands: string[] = [];
  let handler: ((line: WireLine) => void) | null = null;
  let running = true;
  const child: RpcChildHandle = {
    proc: { pid: 2_000_000_000 },
    lines,
    sessionFile: "/sessions/controlled.jsonl",
    onExit: null,
    setLineHandler(fn) { handler = fn; },
    async send(command: string): Promise<CommandResponse> {
      commands.push(command);
      if (command === "get_state" && options.getState) return options.getState();
      return { command, success: true };
    },
    events(type: string) { return lines.filter((line) => line.type === type); },
    isRunning() { return running; },
    kill() { running = false; },
    async shutdown() { running = false; },
  };
  return {
    child,
    commands,
    emit(line) {
      lines.push(line);
      handler?.(line);
    },
  };
}

test("loop fingerprint flags a 10× repeated tool-multiset+args window; not varied work", () => {
  const repeat = (n: number) =>
    Array.from({ length: n }, () =>
      frameFor({
        toolNames: ["bash", "read"],
        toolArgsHash: "same-args",
        toolResultsHash: "same-results",
        assistantText: "still investigating the failing test output",
      }),
    );
  const windowRepeated = repeat(10);
  assert.equal(isLooping(windowRepeated), true, "10× repeat dominates the 12-window");

  const varied = repeat(2);
  varied.push(
    frameFor({
      toolNames: ["edit", "write"],
      toolArgsHash: "different-args",
      toolResultsHash: "different-results",
      assistantText: "fixed the root cause by moving the module boundary",
    }),
    frameFor({
      toolNames: ["bash"],
      toolArgsHash: "other-args",
      toolResultsHash: "other-results",
      assistantText: "verified with the acceptance suite",
    }),
  );
  assert.equal(isLooping(varied), false, "varied work is not flagged");
});

test("KEEP-GOING cooldown doubles", () => {
  assert.equal(nextCooldown(2), 4);
  assert.equal(applyKeepGoing({ cooldownTurns: 4, fires: 1, unaddressed: 1 }).cooldownTurns, 8);
});

test("stall probe fires at exactly 2 settled no-tool/no-thinking/no-report turns", () => {
  const stalledTurn = { toolCallCount: 0, thinkingText: "", reportText: "" };
  const busyTurn = { toolCallCount: 1, thinkingText: "hmm", reportText: "working" };

  assert.equal(isStalled(stalledTurn), true);
  assert.equal(isStalled(busyTurn), false);

  let st = freshStallState();
  st = stallStep(st, 0, stalledTurn, () => false);
  assert.equal(shouldProbe(st), false, "one stalled turn is not a probe");
  st = stallStep(st, 1, stalledTurn, () => false);
  assert.equal(shouldProbe(st), true, "exactly 2 → probe fires");
  st = stallStep(st, 2, busyTurn, () => false);
  assert.equal(st.consecutive, 0, "work resets the counter");

  // KEEP-GOING cooldown pauses counting (no repeat probes while cooling)
  let cooled = freshStallState();
  cooled = stallStep(cooled, 0, stalledTurn, () => false);
  cooled = stallStep(cooled, 1, stalledTurn, () => true);
  cooled = stallStep(cooled, 2, stalledTurn, () => true);
  assert.equal(shouldProbe(cooled), false, "cooldown suppresses further probing");
});

test("probe escalates only after unaddressed + still-tripping; KEEP-GOING cools", () => {
  let p = { cooldownTurns: 0, fires: 0, unaddressed: 0 };
  const d1 = probeDecision(p, "stall", false, true);
  assert.equal(d1.probe, true);
  p = d1.state;
  const d2 = probeDecision(p, "stall", false, true);
  assert.equal(d2.probe, true);
  p = d2.state;
  const d3 = probeDecision(p, "stall", false, true);
  assert.equal(d3.escalate, true, "third unaddressed trip escalates to human");
  assert.equal(d3.probe, false, "escalation replaces probing");

  // KEEP-GOING applies the cooldown and resets unaddressed
  const cooled = applyKeepGoing(p);
  assert.equal(cooled.cooldownTurns, Math.max(p.cooldownTurns, 1) * 2);
  assert.equal(cooled.unaddressed, 0);
});

test("heartbeat: 3 misses + no activity → dead; mid-tool misses not counted", () => {
  let hb = freshHeartbeat(1000);
  hb = heartbeatTick(hb, { now: 2000, activitySinceLastHeartbeat: false, midTool: false, heartbeatRoundTripOk: false, lastMissWasMidToolInARow: false });
  hb = heartbeatTick(hb, { now: 3000, activitySinceLastHeartbeat: false, midTool: false, heartbeatRoundTripOk: false, lastMissWasMidToolInARow: false });
  assert.equal(hb.dead, false, "two misses is not dead");
  hb = heartbeatTick(hb, { now: 4000, activitySinceLastHeartbeat: false, midTool: false, heartbeatRoundTripOk: false, lastMissWasMidToolInARow: false });
  assert.equal(hb.dead, true, `exactly ${MISSES_TO_TERMINATE} misses → transport-dead`);

  let mid = freshHeartbeat(1000);
  for (let i = 0; i < 5; i++) {
    mid = heartbeatTick(mid, { now: 2000 + i, activitySinceLastHeartbeat: false, midTool: true, heartbeatRoundTripOk: false, lastMissWasMidToolInARow: false });
  }
  assert.equal(mid.dead, false, "mid-tool misses never accumulate to a kill");
});

test("reaper: dead parent's pidfile orphan is reclaimed; live parent untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pids-"));
  // orphan with dead parent (ppid 1)
  const orphanPid = 2147483600; // improbably high pid won't exist
  writePidfile(dir, { childId: "orphan-child", pid: orphanPid, ppid: 1, sessionFile: "", spawnedAt: Date.now() });
  // child of a live parent (our own process)
  const livePid = 2147483601;
  writePidfile(dir, { childId: "live-child", pid: livePid, ppid: process.pid, sessionFile: "", spawnedAt: Date.now() });

  const killed: number[] = [];
  const result = sweep(dir, (pid) => killed.push(pid));
  assert.deepEqual(result.reclaimed, ["orphan-child"]);
  assert.equal(killed.length, 0, "orphan pid was already nonexistent; live-child untouched");
});

test("engine: streaming-but-unfinished child trips long-turn attention past the threshold and survives message deltas", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  const controlled = controlledChild({
    getState: async () => ({ command: "get_state", success: true, data: { isStreaming: true } }),
  });
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-longturn-")));
  const hub = new Hub({ ground, deliver: (delivery) => deliveries.push(delivery), spawnChild: async () => controlled.child });
  const engine = new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: Number.POSITIVE_INFINITY,
    providerQuietMs: Number.POSITIVE_INFINITY,
    toolQuietMs: Number.POSITIVE_INFINITY,
    longTurnMs: 50,
  });

  const id = await hub.spawn({ title: "long-turn", prompt: "work" });
  controlled.emit({ type: "agent_start" });
  // Warm streaming deltas keep lastActivityAt fresh — the exact scenario that
  // hid the k3::max runaway from provider-stall detection.
  const base = Date.now();
  engine.tick(base + 20);
  controlled.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tokens" } });
  engine.tick(base + 60);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(hub.isAlive(id), true, "long-turn is advisory; the child is never killed");
  assert.equal(hub.getView(id)?.attentionKind, "long-turn");
  const attentions = deliveries.filter((delivery) => delivery.type === "attention");
  assert.equal(attentions.length, 1, "one long-turn attention fires");
  assert.equal(attentions[0].kind, "long-turn");

  controlled.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "still working" } });
  assert.equal(
    hub.getView(id)?.attentionKind,
    "long-turn",
    "streaming deltas do not clear an active long-turn attention",
  );
  engine.tick(base + 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    deliveries.filter((delivery) => delivery.type === "attention").length,
    1,
    "a single long episode cannot create a wake-up loop",
  );

  controlled.emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "progress" }], stopReason: "toolUse" } });
  engine.tick(base + 300);
  controlled.emit({ type: "agent_settled" });
  engine.tick(base + 400);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(hub.getView(id)?.attentionKind, undefined, "settling closes the long-turn episode");
  await hub.shutdownAll();
});

test("engine: long-turn stays silent while a tool is running (tool-stall regime owns mid-tool)", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  const controlled = controlledChild({
    getState: async () => ({ command: "get_state", success: true, data: { isStreaming: true } }),
  });
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-longtool-")));
  const hub = new Hub({ ground, deliver: (delivery) => deliveries.push(delivery), spawnChild: async () => controlled.child });
  const engine = new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: Number.POSITIVE_INFINITY,
    providerQuietMs: Number.POSITIVE_INFINITY,
    toolQuietMs: Number.POSITIVE_INFINITY,
    longTurnMs: 50,
  });

  const id = await hub.spawn({ title: "long-tool", prompt: "work" });
  controlled.emit({ type: "agent_start" });
  controlled.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
  engine.tick(Date.now() + 500);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(hub.getView(id)?.attentionKind, undefined, "mid-tool long runs stay in the tool-stall regime, not long-turn");
  await hub.shutdownAll();
});

test("engine: responsive but quiet inference raises attention without killing the child", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  const controlled = controlledChild({
    getState: async () => ({
      command: "get_state",
      success: true,
      data: { isStreaming: true },
    }),
  });
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-stall-")));
  const hub = new Hub({ ground, deliver: (delivery) => deliveries.push(delivery), spawnChild: async () => controlled.child });
  const engine = new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: 0,
    providerQuietMs: 10,
    toolQuietMs: 100,
  });

  const id = await hub.spawn({ title: "quiet-inference", prompt: "work" });
  controlled.emit({ type: "agent_start" });
  controlled.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  const quietSince = hub.getView(id)?.lastActivityAt ?? Date.now();
  engine.tick(quietSince + 11);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(hub.isAlive(id), true, "semantic suspicion never kills a responsive child");
  assert.equal(hub.getView(id)?.attentionKind, "provider-stall");
  assert.equal(
    deliveries.filter((delivery) => (delivery as { type: string }).type === "attention").length,
    1,
    "the idle parent receives one proactive wake-up",
  );

  engine.tick(quietSince + 1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    deliveries.filter((delivery) => (delivery as { type: string }).type === "attention").length,
    1,
    "one quiet episode cannot create a wake-up loop",
  );
  controlled.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "progress" },
  });
  assert.equal(hub.getView(id)?.attentionKind, undefined, "new progress closes the attention episode");
  await hub.shutdownAll();
});

test("engine: heartbeats do not overlap and mid-tool misses cannot terminate", async () => {
  ring.reset();
  let rejectState!: (error: Error) => void;
  let statePromise = new Promise<CommandResponse>((_resolve, reject) => { rejectState = reject; });
  const controlled = controlledChild({ getState: () => statePromise });
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-heartbeat-")));
  const hub = new Hub({ ground, deliver: () => {}, spawnChild: async () => controlled.child });
  const engine = new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: 0,
    providerQuietMs: Number.POSITIVE_INFINITY,
    toolQuietMs: Number.POSITIVE_INFINITY,
  });

  const id = await hub.spawn({ title: "long-tool", prompt: "work" });
  controlled.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
  engine.tick(Date.now() + 1);
  engine.tick(Date.now() + 2);
  engine.tick(Date.now() + 3);
  assert.equal(controlled.commands.filter((command) => command === "get_state").length, 1, "one heartbeat may be in flight per child");

  for (let miss = 0; miss < 4; miss++) {
    rejectState(new Error("rpc unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    statePromise = new Promise<CommandResponse>((_resolve, reject) => { rejectState = reject; });
    engine.tick(Date.now() + 10 + miss);
  }
  rejectState(new Error("rpc unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(hub.isAlive(id), true, "heartbeat misses during a known running tool are non-fatal");
  await hub.shutdownAll();
});

test("engine: unaddressed semantic loop probes escalate to parent attention without a kill", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  const controlled = controlledChild();
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-loop-")));
  const hub = new Hub({ ground, deliver: (delivery) => deliveries.push(delivery), spawnChild: async () => controlled.child });
  new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: Number.POSITIVE_INFINITY,
    providerQuietMs: Number.POSITIVE_INFINITY,
    toolQuietMs: Number.POSITIVE_INFINITY,
  });
  const id = await hub.spawn({ title: "looping", prompt: "work" });
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "still investigating the same failing output" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "same" } },
    ],
    stopReason: "toolUse",
  };
  for (let turn = 0; turn < 5; turn++) {
    controlled.emit({ type: "turn_end", message, toolResults: [{ output: "same" }] });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(hub.isAlive(id), true);
  assert.equal(hub.getView(id)?.attentionKind, "semantic-loop");
  assert.ok(deliveries.some((delivery) => delivery.type === "attention" && delivery.kind === "semantic-loop"));
  await hub.shutdownAll();
});

test("engine: three transport misses produce one exact failure and release the child", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  const controlled = controlledChild({
    getState: async () => { throw new Error("rpc unavailable"); },
  });
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-dead-")));
  const hub = new Hub({ ground, deliver: (delivery) => deliveries.push(delivery), spawnChild: async () => controlled.child });
  const engine = new LivenessEngine(hub, ground.tombstones, {
    heartbeatQuietMs: 0,
    providerQuietMs: Number.POSITIVE_INFINITY,
    toolQuietMs: Number.POSITIVE_INFINITY,
  });
  const id = await hub.spawn({ title: "dead-rpc", prompt: "work" });

  for (let miss = 0; miss < 3; miss++) {
    engine.tick(Date.now() + miss);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(hub.isAlive(id), false);
  const crashes = deliveries.filter((delivery) => delivery.type === "crash");
  assert.equal(crashes.length, 1);
  assert.match(crashes[0].type === "crash" ? crashes[0].reason : "", /transport-dead.*3 heartbeat misses/i);
  assert.equal(hub.getView(id)?.status, "crashed");
  await hub.shutdownAll();
});

test("engine integration: spawn, probe liveness, tombstone on kill", { timeout: 240_000, concurrency: 1 }, async () => {
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-live-")));
  const { Hub } = await import("../extensions/subagents/hub.ts");
  const { LivenessEngine } = await import("../extensions/subagents/liveness/engine.ts");
  const deliveries: string[] = [];
  const hub = new Hub({ ground, deliver: (d) => deliveries.push(d.type) });
  new LivenessEngine(hub, ground.tombstones);

  const id = await hub.spawn({
    title: "liveness",
    prompt: "Reply with exactly: LIVE-OK then on a new line write exactly: DONE-PARENT",
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (hub.getView(id)?.status === "done") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(hub.getView(id)?.status, "done");

  await hub.kill(id);
  const { readFileSync, existsSync } = await import("node:fs");
  const tomb = join(ground.tombstones, `${id}.tombstone.jsonl`);
  assert.ok(existsSync(tomb), "tombstone written on kill");
  const line = readFileSync(tomb, "utf8").trim();
  assert.ok(line.includes("kill"), `tombstone records the reason: ${line}`);
  const tombstone = JSON.parse(line) as { sessionFile?: string };
  assert.equal(tombstone.sessionFile, hub.getView(id)?.sessionFile, "tombstone retains the resumable session reference");
  await hub.shutdownAll();
});

test("hub.resume re-links a killed child's session and continues (resume AC)", { timeout: 240_000, concurrency: 1 }, async () => {
  const ground = new Ground(mkdtempSync(join(tmpdir(), "subagentGround-resume-")));
  const { Hub } = await import("../extensions/subagents/hub.ts");
  const deliveries: Array<{ type: string; lens?: { digest?: string } }> = [];
  const hub = new Hub({ ground, deliver: (d) => deliveries.push(d as { type: string; lens?: { digest?: string } }) });

  const id = await hub.spawn({
    title: "resume-probe",
    prompt: "Remember the word FALCON. Reply with exactly: REMEMBERED then on a new line write exactly: DONE-PARENT",
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && hub.getView(id)?.status !== "done") {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(hub.getView(id)?.status, "done");

  await hub.kill(id);
  const resumed = await hub.resume(id, "Which word did I ask you to remember? Reply with exactly that word.");
  assert.equal(resumed, true, "resume re-links the session");

  const deadline2 = Date.now() + 120_000;
  while (Date.now() < deadline2) {
    if (deliveries.some((d) => d.type === "lens" && d.lens?.digest?.includes("FALCON"))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const recallLens = deliveries.find((d) => d.type === "lens" && d.lens?.digest?.includes("FALCON"));
  assert.ok(recallLens, "the resumed child recalls the pre-kill word (conversation continuity)");
  await hub.shutdownAll();
});
