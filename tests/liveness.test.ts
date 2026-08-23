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
  p = { ...p, cooldownTurns: d1.cooldown, unaddressed: p.unaddressed + 1 };
  const d2 = probeDecision(p, "stall", false, true);
  assert.equal(d2.probe, true);
  p = { ...p, cooldownTurns: d2.cooldown, unaddressed: p.unaddressed + 1 };
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
