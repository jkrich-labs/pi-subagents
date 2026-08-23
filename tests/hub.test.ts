/**
 * S-04 hub controller tests — the same protocol seam as S-03, driven through
 * the real hub (extension core) with a recording delivery sink.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ground } from "../extensions/subagents/ground.ts";
import { LivenessEngine } from "../extensions/subagents/liveness/engine.ts";
import { Hub, type Delivery } from "../extensions/subagents/hub.ts";
import type { CommandResponse, RpcChildHandle, RpcChildOptions, WireLine } from "../extensions/subagents/child.ts";
import { ring } from "../extensions/subagents/ring/store.ts";
import { parseSteerLine, routeSteers, stripSteers } from "../extensions/subagents/route.ts";
import { reportFrom } from "../extensions/subagents/tokens.ts";
import { findModel, resolveSpawn } from "../extensions/subagents/registry.ts";
import { TESTING_MODEL, TESTING_PROVIDER, TESTING_THINKING } from "../harness/testing-models.ts";

function tmpGround(): Ground {
  return new Ground(mkdtempSync(join(tmpdir(), "subagentGround-hub-")));
}

test("routeSteers: parse, route and strip", () => {
  assert.deepEqual(parseSteerLine("@all everyone please"), { target: "all", text: "everyone please" });
  assert.deepEqual(parseSteerLine("@abc123 do the thing"), { target: "child", childId: "abc123", text: "do the thing" });
  assert.deepEqual(parseSteerLine("@user hello human"), { target: "user", text: "hello human" });
  assert.equal(parseSteerLine("no prefix here"), null);

  const routed = routeSteers("thinking out loud\n@abc123 steer this\n@all everyone\nplain line");
  assert.deepEqual(routed.map((r) => r.target), ["child", "all"]);
  assert.equal(routed[0].childId, "abc123");
  assert.deepEqual(
    routeSteers("@child-one @child-two Send final reports now").map(({ childId, text }) => ({ childId, text })),
    [
      { childId: "child-one", text: "Send final reports now" },
      { childId: "child-two", text: "Send final reports now" },
    ],
    "multiple child prefixes on one line steer every named child",
  );

  const stripped = stripSteers("keep me\n@all drop me\n@user drop me too");
  assert.equal(stripped.trim(), "keep me");
});

test("reportFrom: DONE/RESET/INCR/ASK tokens", () => {
  assert.deepEqual(reportFrom("work complete\nDONE-PARENT"), {
    done: true,
    reset: false,
    incr: false,
    ask: undefined,
  });
  assert.deepEqual(reportFrom("ASK: shall I proceed?\nRESET-PARENT"), {
    done: false,
    reset: true,
    incr: false,
    ask: "shall I proceed?",
  });
  assert.equal(reportFrom("INCR-PARENT").incr, true);
  assert.equal(reportFrom("plain report").done, false);
});

test("registry: model resolution falls back to testing model", () => {
  const luna = findModel(TESTING_MODEL);
  assert.ok(luna, "registry carries the testing model");
  assert.equal(luna.provider, TESTING_PROVIDER);

  const resolved = resolveSpawn({});
  assert.equal(resolved.model, TESTING_MODEL);
  assert.equal(resolved.provider, TESTING_PROVIDER);
  assert.equal(resolved.thinking, TESTING_THINKING);

  // sanity token + junk provider must drop to defaults
  const patched = resolveSpawn({ model: "testing", provider: "registry", thinking: "bogus" });
  assert.equal(patched.model, TESTING_MODEL);
  assert.equal(patched.provider, TESTING_PROVIDER);
  assert.equal(patched.thinking, TESTING_THINKING);

  const explicit = resolveSpawn({ model: "gpt-5.6-sol", provider: "openai-codex", thinking: "medium" });
  assert.deepEqual(explicit, {
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    thinking: "medium",
  }, "an explicit provider/model pair must not be silently rewritten by the local registry");
  assert.equal(
    resolveSpawn({ model: "gpt-5.6-sol", provider: "hyper" }).provider,
    "openai-codex",
    "OpenAI-family models cannot bypass the subscription-backed provider",
  );
  assert.deepEqual(
    resolveSpawn({ model: "cursor-grok-4.6-fast", provider: "cursor", thinking: "high" }),
    { model: "gpt-5.6-terra", provider: "openai-codex", thinking: "xhigh" },
    "retired Grok 4.6 launches migrate at the final generic launch boundary",
  );
});

function recordingChildren() {
  const launches: RpcChildOptions[] = [];
  const commands: Array<{ command: string; body: Record<string, unknown> }> = [];
  let spawnCount = 0;
  const spawnChild = async (opts: RpcChildOptions): Promise<RpcChildHandle> => {
    launches.push({ ...opts });
    spawnCount += 1;
    let running = true;
    const lines: WireLine[] = [];
    return {
      proc: { pid: 10_000 + spawnCount },
      lines,
      sessionFile: `/sessions/child-${spawnCount}.jsonl`,
      onExit: null,
      setLineHandler() {},
      async send(command: string, body: Record<string, unknown> = {}): Promise<CommandResponse> {
        commands.push({ command, body });
        return { command, success: true };
      },
      events(type: string) { return lines.filter((line) => line.type === type); },
      isRunning() { return running; },
      kill() { running = false; },
      async shutdown() { running = false; },
    };
  };
  return { launches, commands, spawnChild, get spawnCount() { return spawnCount; } };
}

test("hub: named launch reaches ring and resume preserves resolved preset configuration", async () => {
  ring.reset();
  const recorder = recordingChildren();
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: recorder.spawnChild });

  const cwd = "/tmp/isolated-worktree";
  const id = await hub.spawn({ agent: "explorer", prompt: "Map the launch path", cwd });
  const view = hub.getView(id)!;
  assert.equal(view.title, "explorer", "named calls may omit title");
  assert.equal(view.agent, "explorer");
  assert.equal(view.provider, "openai-codex");
  assert.equal(view.model, "gpt-5.6-luna");
  assert.equal(view.thinking, "medium");
  assert.equal(view.toolPolicy, "normal");
  assert.ok(view.systemPrompt?.includes("Read repository context"), "ring retains the composed role prompt");
  assert.equal(recorder.launches[0].systemPrompt, view.systemPrompt);
  assert.equal(recorder.launches[0].cwd, cwd, "named agents launch directly in their assigned worktree");

  await hub.kill(id);
  assert.equal(await hub.resume(id, "Continue the exploration"), true);
  assert.deepEqual(recorder.launches[1], {
    sessionDir: hub.ground.sessions,
    sessionName: `subagent-${id}-resume`,
    provider: view.provider,
    model: view.model,
    thinking: view.thinking,
    systemPrompt: view.systemPrompt,
    cwd,
  });
  assert.ok(recorder.commands.some((entry) => entry.command === "switch_session"));
  await hub.shutdownAll();
});

test("hub: generic launch uses the general-purpose preset and unknown agents fail before process creation", async () => {
  ring.reset();
  const recorder = recordingChildren();
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: recorder.spawnChild });

  const id = await hub.spawn({ title: "generic", prompt: "Do generic work" });
  assert.equal(hub.getView(id)?.agent, "general-purpose");
  assert.equal(hub.getView(id)?.provider, "openai-codex");
  assert.equal(hub.getView(id)?.model, "gpt-5.6-terra");
  assert.equal(hub.getView(id)?.thinking, "xhigh");
  assert.equal(hub.getView(id)?.toolPolicy, "normal");
  assert.ok(hub.getView(id)?.systemPrompt?.includes("Own the assigned engineering slice"));
  await assert.rejects(hub.spawn({ agent: "not-real", prompt: "Never starts" }), /unknown agent.*explorer.*reviewer-spec/i);
  assert.equal(recorder.spawnCount, 1, "unknown agent did not call the child factory");
  await hub.shutdownAll();
});

test("hub: rejects a retry title while the original child is still live", async () => {
  ring.reset();
  const recorder = recordingChildren();
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: recorder.spawnChild });

  const id = await hub.spawn({ title: "Review S-01 standards", prompt: "Review" });
  await assert.rejects(
    hub.spawn({ title: "Review S-01 standards retry", prompt: "Review again" }),
    new RegExp(`already working.*${id}`, "i"),
  );
  assert.equal(recorder.spawnCount, 1, "duplicate retry did not start another process");
  await hub.shutdownAll();
});

test("hub: reports ownership only for live child PIDs", async () => {
  ring.reset();
  const recorder = recordingChildren();
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: recorder.spawnChild });
  const id = await hub.spawn({ title: "owned", prompt: "Work" });
  assert.equal(hub.ownsProcess(10_001), true);
  assert.equal(hub.ownsProcess(99_999), false);
  await hub.kill(id);
  assert.equal(hub.ownsProcess(10_001), false);
});

test("hub: session shutdown suppresses stale-context delivery and clears the old fleet", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  let spawnedChild: RpcChildHandle | undefined;
  const spawnChild = async (): Promise<RpcChildHandle> => {
    let running = true;
    const child: RpcChildHandle = {
      proc: { pid: 12_344 },
      lines: [],
      sessionFile: "/sessions/replace.jsonl",
      onExit: null,
      setLineHandler() {},
      async send(command: string): Promise<CommandResponse> { return { command, success: true }; },
      events() { return []; },
      isRunning() { return running; },
      kill() { running = false; },
      async shutdown() {
        running = false;
        child.onExit?.();
      },
    };
    spawnedChild = child;
    return child;
  };
  const hub = new Hub({ ground: tmpGround(), deliver: (delivery) => deliveries.push(delivery), spawnChild });
  new LivenessEngine(hub, hub.ground.tombstones);

  await hub.spawn({ title: "old session", prompt: "work" });
  assert.equal(ring.list().length, 1);
  const queuedOldSessionExit = spawnedChild?.onExit;
  const shuttingDown = hub.shutdownAll();
  queuedOldSessionExit?.();
  await shuttingDown;

  assert.deepEqual(deliveries, [], "even a queued old-session callback cannot reach the stale parent closure");
  assert.deepEqual(ring.list(), [], "liveness cleanup cannot re-add old children after /clear or /new");
  assert.deepEqual(hub.list(), []);

  const newId = await hub.spawn({ title: "new session", prompt: "work" });
  assert.ok(hub.isAlive(newId), "the same extension hub remains reusable after session replacement");
  await hub.shutdownAll();
});

test("hub: a child whose spawn crosses session replacement is discarded", async () => {
  ring.reset();
  let releaseSpawn!: (child: RpcChildHandle) => void;
  let shutdowns = 0;
  const delayed = new Promise<RpcChildHandle>((resolve) => { releaseSpawn = resolve; });
  const child: RpcChildHandle = {
    proc: { pid: 12_346 },
    lines: [],
    sessionFile: "/sessions/late-spawn.jsonl",
    onExit: null,
    setLineHandler() {},
    async send(command: string): Promise<CommandResponse> { return { command, success: true }; },
    events() { return []; },
    isRunning() { return true; },
    kill() {},
    async shutdown() { shutdowns += 1; },
  };
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: () => delayed });

  const spawning = hub.spawn({ title: "old in-flight spawn", prompt: "work" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.shutdownAll();
  releaseSpawn(child);

  await assert.rejects(spawning, /spawn cancelled.*session replacement/i);
  assert.equal(shutdowns, 1, "late old-session process is terminated");
  assert.deepEqual(hub.list(), []);
  assert.deepEqual(ring.list(), []);
});

test("hub: a resume crossing session replacement is discarded", async () => {
  ring.reset();
  const id = "resume-old-session";
  ring.upsert(id, {
    id,
    title: "old resume",
    status: "killed",
    sessionFile: "/sessions/old.jsonl",
    spawnedAt: Date.now(),
  });
  let releaseSwitch!: (response: CommandResponse) => void;
  let shutdowns = 0;
  const switching = new Promise<CommandResponse>((resolve) => { releaseSwitch = resolve; });
  const child: RpcChildHandle = {
    proc: { pid: 12_347 },
    lines: [],
    sessionFile: "/sessions/new-process.jsonl",
    onExit: null,
    setLineHandler() {},
    send(command: string): Promise<CommandResponse> {
      return command === "switch_session" ? switching : Promise.resolve({ command, success: true });
    },
    events() { return []; },
    isRunning() { return true; },
    kill() {},
    async shutdown() { shutdowns += 1; },
  };
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: async () => child });

  const resuming = hub.resume(id, "continue");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.shutdownAll();
  releaseSwitch({ command: "switch_session", success: true });

  await assert.rejects(resuming, /resume cancelled.*session replacement/i);
  assert.equal(shutdowns, 1);
  assert.deepEqual(hub.list(), []);
  assert.deepEqual(ring.list(), []);
});

test("hub: resume migrates stale Grok 4.6 ring state before process launch", async () => {
  ring.reset();
  const id = "resume-retired-grok";
  ring.upsert(id, {
    id,
    title: "old review",
    status: "failed",
    sessionFile: "/sessions/old-grok.jsonl",
    provider: "cursor",
    model: "cursor-grok-4.6-fast",
    thinking: "high",
    spawnedAt: Date.now(),
  });
  let launched: RpcChildOptions | undefined;
  const child: RpcChildHandle = {
    proc: { pid: 12_349 },
    lines: [],
    onExit: null,
    setLineHandler() {},
    async send(command: string): Promise<CommandResponse> { return { command, success: true }; },
    events() { return []; },
    isRunning() { return true; },
    kill() {},
    async shutdown() {},
  };
  const hub = new Hub({
    ground: tmpGround(),
    deliver: () => {},
    spawnChild: async (opts) => { launched = opts; return child; },
  });

  assert.equal(await hub.resume(id, "continue"), true);
  assert.equal(launched?.provider, "openai-codex");
  assert.equal(launched?.model, "gpt-5.6-terra");
  assert.equal(launched?.thinking, "xhigh");
  await hub.shutdownAll();
});

test("hub: a rejected resume switch cleans up the unregistered child", async () => {
  ring.reset();
  const id = "resume-switch-error";
  ring.upsert(id, {
    id,
    title: "failed switch",
    status: "killed",
    sessionFile: "/sessions/old.jsonl",
    spawnedAt: Date.now(),
  });
  let shutdowns = 0;
  const child: RpcChildHandle = {
    proc: { pid: 12_348 },
    lines: [],
    onExit: null,
    setLineHandler() {},
    send(command: string): Promise<CommandResponse> {
      return command === "switch_session"
        ? Promise.reject(new Error("Authorization: Bearer resume-secret"))
        : Promise.resolve({ command, success: true });
    },
    events() { return []; },
    isRunning() { return true; },
    kill() {},
    async shutdown() { shutdowns += 1; },
  };
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: async () => child });

  await assert.rejects(hub.resume(id, "continue"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "subagent resume switch failed");
    assert.ok(!error.message.includes("resume-secret"));
    return true;
  });
  assert.equal(shutdowns, 1);
  assert.deepEqual(hub.list(), []);
  assert.equal(ring.get(id)?.status, "killed");
});

test("hub: a settled provider error becomes failed instead of remaining working", async () => {
  ring.reset();
  const deliveries: Delivery[] = [];
  let emit: ((line: WireLine) => void) | null = null;
  const lines: WireLine[] = [];
  const child: RpcChildHandle = {
    proc: { pid: 12_345 },
    lines,
    sessionFile: "/sessions/failed.jsonl",
    onExit: null,
    setLineHandler(handler) { emit = handler; },
    async send(command: string): Promise<CommandResponse> { return { command, success: true }; },
    events(type: string) { return lines.filter((line) => line.type === type); },
    isRunning() { return true; },
    kill() {},
    async shutdown() {},
  };
  const hub = new Hub({
    ground: tmpGround(),
    deliver: (delivery) => deliveries.push(delivery),
    spawnChild: async (_opts: RpcChildOptions) => child,
  });

  const id = await hub.spawn({ title: "unsupported", prompt: "run" });
  const assistant = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "401: model is not supported",
  };
  for (const line of [
    { type: "turn_end", message: assistant },
    { type: "agent_end", messages: [] },
    { type: "agent_settled" },
  ]) {
    lines.push(line);
    emit?.(line);
  }

  assert.equal(hub.getView(id)?.status, "failed");
  assert.equal(hub.getView(id)?.error, "model is not supported by provider");
  assert.equal(deliveries.filter((delivery) => delivery.type === "crash").length, 1);
  await assert.rejects(
    hub.spawn({ title: "unsupported retry under another title", prompt: "run again" }),
    /already failed as unsupported; choose a supported preset instead of retrying/,
    "an unsupported provider/model pair trips a session-local circuit breaker",
  );

  const exitAfterFailure = child.onExit;
  exitAfterFailure?.();
  assert.equal(hub.getView(id)?.status, "failed", "later transport exit preserves the provider failure");
  assert.equal(hub.getView(id)?.error, "model is not supported by provider");
  assert.equal(deliveries.filter((delivery) => delivery.type === "crash").length, 1, "failure is delivered once");

  assert.equal(await hub.resume(id, "retry"), true);
  assert.equal(hub.getView(id)?.status, "working");
  assert.equal(hub.getView(id)?.error, undefined, "resume clears stale error metadata");
  const success = {
    role: "assistant",
    content: [{ type: "text", text: "Recovered\nDONE-PARENT" }],
    stopReason: "stop",
  };
  for (const line of [
    { type: "turn_end", message: success },
    { type: "agent_end", messages: [] },
    { type: "agent_settled" },
  ]) {
    lines.push(line);
    emit?.(line);
  }
  assert.equal(hub.getView(id)?.status, "done");
  assert.equal(hub.getView(id)?.error, undefined);

  const sensitiveFailure = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Authorization: Bearer super-secret-token",
  };
  for (const line of [
    { type: "turn_end", message: sensitiveFailure },
    { type: "agent_end", messages: [] },
    { type: "agent_settled" },
  ]) {
    lines.push(line);
    emit?.(line);
  }
  assert.equal(hub.getView(id)?.status, "failed");
  assert.ok(!hub.getView(id)?.error?.includes("super-secret-token"), "provider secrets are not stored in ring state");
  await hub.shutdownAll();
});

test("hub: spawn → completion lens → DONE-PARENT → done status", { timeout: 240_000, concurrency: 1 }, async () => {
  const deliveries: Delivery[] = [];
  const hub = new Hub({ ground: tmpGround(), deliver: (d) => deliveries.push(d) });
  ring.reset();
  try {
    const id = await hub.spawn({
      title: "probe",
      prompt: "Reply with exactly: PONG, then on the next line write exactly: DONE-PARENT",
      thinking: "off",
    });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const view = hub.getView(id);
      if (view?.status === "done") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const view = hub.getView(id);
    assert.ok(view, "ring has the child");
    assert.equal(view.status, "done", "DONE-PARENT finalizes the child");
    assert.equal(view.turnCount, 1, "one child turn to complete");
    assert.ok(view.sessionFile, "session file referenced");

    const lensDeliveries = deliveries.filter((d) => d.type === "lens");
    assert.equal(lensDeliveries.length, 1, "exactly one lens per settled run (no duplicate finalization)");
    assert.ok(
      lensDeliveries[0].type === "lens" && lensDeliveries[0].lens.digest.includes("PONG"),
      "completion digest carries the child's answer",
    );

    const controls = deliveries.filter((d) => d.type === "control");
    assert.ok(controls.some((c) => c.type === "control" && c.token === "DONE-PARENT"), "DONE-PARENT control delivered");
  } finally {
    await hub.shutdownAll();
  }
});
