import assert from "node:assert/strict";
import { test } from "node:test";
import type { WireLine } from "../harness/rpc-child.ts";
import {
  MAX_RUNNER_OUTPUT_LENGTH,
  runScenario,
  type BoundedCommandResult,
  type FixtureScopeResult,
  type PreparedFixture,
  type RunnerChildSnapshot,
  type RunnerClock,
  type RunnerParentProcess,
  type RunnerProcessPort,
  type ScenarioContract,
  type ScenarioEvidence,
} from "../harness/benchmark/runner.ts";
import {
  integrationAfterReports,
  spawnRecordsFromParentSession,
} from "../harness/benchmark/parallel-diagnosis.ts";

const marker = "SCRIPTED_PARALLEL_DONE";
const children: RunnerChildSnapshot[] = [
  { id: "a", pid: 101, startedAt: 1 },
  { id: "b", pid: 102, startedAt: 2 },
];

class FakeClock implements RunnerClock {
  private time = 0;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  }
}

class ScriptedParent implements RunnerParentProcess {
  readonly lines: WireLine[] = [];
  readonly promptMessages: string[] = [];
  private readonly listeners = new Set<(line: WireLine) => void>();
  private running = true;

  private readonly onPrompt?: (parent: ScriptedParent) => void;
  constructor(onPrompt?: (parent: ScriptedParent) => void) {
    this.onPrompt = onPrompt;
  }

  async sendInitialPrompt(message: string): Promise<void> {
    this.promptMessages.push(message);
    this.onPrompt?.(this);
  }
  subscribe(listener: (line: WireLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(line: WireLine): void {
    this.lines.push(line);
    for (const listener of this.listeners) listener(line);
  }
  async shutdown(): Promise<void> { this.running = false; }
  isRunning(): boolean { return this.running; }
}

class ScriptedPort implements RunnerProcessPort {
  readonly parent: ScriptedParent;
  readonly snapshots: readonly RunnerChildSnapshot[];
  cleanupCalls = 0;
  snapshotCalls = 0;
  constructor(
    onPrompt?: (parent: ScriptedParent) => void,
    snapshots: readonly RunnerChildSnapshot[] = children,
  ) {
    this.parent = new ScriptedParent(onPrompt);
    this.snapshots = snapshots;
  }
  async launchParent(): Promise<RunnerParentProcess> { return this.parent; }
  snapshotChildren(): readonly RunnerChildSnapshot[] { this.snapshotCalls += 1; return this.snapshots; }
  async cleanupChildren(observed: readonly RunnerChildSnapshot[]) {
    this.cleanupCalls += 1;
    return { childPids: observed.map((child) => child.pid), liveProcessPids: [] };
  }
}

class ScriptedFixture implements PreparedFixture {
  cleaned = false;
  readonly verification: BoundedCommandResult;
  readonly scopeResult: FixtureScopeResult;
  constructor(
    verification: BoundedCommandResult = { exitCode: 0, stdout: "verified", stderr: "", stdoutDropped: 0, stderrDropped: 0 },
    scopeResult: FixtureScopeResult = { passed: true, changedPaths: ["src/a.mjs"], unexpectedPaths: [] },
  ) {
    this.verification = verification;
    this.scopeResult = scopeResult;
  }
  root = "/fixture";
  async verify(): Promise<BoundedCommandResult> { return this.verification; }
  async scope(): Promise<FixtureScopeResult> { return this.scopeResult; }
  async cleanup(): Promise<boolean> { this.cleaned = true; return true; }
}

const completeEvidence: ScenarioEvidence = {
  observedRoles: [
    { title: "retry-after-explorer", agent: "explorer" },
    { title: "request-id-explorer", agent: "explorer" },
  ],
  childFailure: false,
  modelPolicyPassed: true,
  requiredChildCount: 2,
  completedChildReports: 2,
  childReportsBeforeTerminal: true,
  integrationAfterReports: true,
  requiredOverlap: true,
  autonomousCompletion: true,
};

function contract(fixture: ScriptedFixture, evidence: ScenarioEvidence = completeEvidence): ScenarioContract {
  return {
    id: "scripted-parallel",
    terminalMarker: marker,
    initialBrief: (root) => `brief for ${root}`,
    fixture: { async prepare() { return fixture; } },
    parentPolicy: { provider: "test", model: "model", thinking: "medium" },
    childPolicy: { provider: "test", model: "model", thinking: "medium" },
    deadlineMs: 10,
    pollIntervalMs: 2,
    minimumChildren: 2,
    expectedRoles: [
      { title: "retry-after-explorer", agent: "explorer" },
      { title: "request-id-explorer", agent: "explorer" },
    ],
    async collectEvidence() { return evidence; },
  };
}

function completionLine(): WireLine {
  return { type: "message", message: { role: "user", content: [{ type: "text", text: "[a] COMPLETED: evidence" }] } };
}
function terminalLine(): WireLine {
  return { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: marker }] }] };
}
function gate(result: Awaited<ReturnType<typeof runScenario>>, id: string): boolean {
  return result.qualityGates.find((entry) => entry.id === id)?.passed ?? false;
}

async function flushAsyncSteps(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

test("runner detects autonomous terminal and never injects a continuation", async () => {
  const fixture = new ScriptedFixture();
  const port = new ScriptedPort((parent) => {
    parent.emit(completionLine());
    parent.emit(terminalLine());
  });
  const result = await runScenario(contract(fixture), port, { clock: new FakeClock() });

  assert.equal(result.terminalReached, true);
  assert.equal(result.initialPromptCount, 1);
  assert.equal(port.parent.promptMessages.length, 1, "runner has no continuation send path");
  assert.equal(result.completionFollowUpBeforeTerminal, true);
  assert.equal(result.childLifetimes.length, 2);
  assert.equal(result.overlapIntervals.length > 0, true, "one child snapshot proves overlapping lifetimes");
  assert.equal(result.qualityGates.every((entry) => entry.passed), true);
});

test("runner hard-gates scope, model drift, child failure, missing role, and missing overlap", async () => {
  const fixture = new ScriptedFixture(
    { exitCode: 1, stdout: "", stderr: "fixture failed", stdoutDropped: 0, stderrDropped: 0 },
    { passed: false, changedPaths: ["src/a.mjs", "verifier.mjs"], unexpectedPaths: ["verifier.mjs"] },
  );
  const port = new ScriptedPort((parent) => {
    parent.emit(completionLine());
    parent.emit(terminalLine());
  }, [{ id: "one", pid: 101, startedAt: 1 }]);
  const result = await runScenario(contract(fixture, {
    observedRoles: [{ title: "retry-after-explorer", agent: "explorer" }],
    childFailure: true,
    modelPolicyPassed: false,
    requiredChildCount: 1,
    completedChildReports: 1,
    childReportsBeforeTerminal: false,
    integrationAfterReports: false,
    requiredOverlap: false,
    autonomousCompletion: false,
  }), port, { clock: new FakeClock() });

  assert.equal(gate(result, "fixture-verification"), false);
  assert.equal(gate(result, "fixture-scope"), false);
  assert.equal(gate(result, "suite-model-policy"), false, "persisted model drift invalidates the sample");
  assert.equal(gate(result, "no-child-failure"), false);
  assert.equal(gate(result, "role:request-id-explorer"), false);
  assert.equal(gate(result, "child-lifetime-overlap"), false);
  assert.equal(gate(result, "minimum-child-count"), false);
});

test("runner times out and cleans parent, child processes, and fixture", async () => {
  const fixture = new ScriptedFixture();
  const port = new ScriptedPort();
  const clock = new FakeClock();
  const pending = runScenario(contract(fixture), port, { clock });
  await flushAsyncSteps();
  clock.advance(11);
  const result = await pending;

  assert.equal(result.timeout, true);
  assert.equal(result.terminalReached, false);
  assert.equal(result.cleanup.parentStopped, true);
  assert.equal(result.cleanup.liveProcessPids.length, 0);
  assert.equal(port.cleanupCalls, 1);
  assert.equal(fixture.cleaned, true);
});

test("runner cancellation takes the same cleanup path", async () => {
  const fixture = new ScriptedFixture();
  const port = new ScriptedPort();
  const abort = new AbortController();
  const pending = runScenario(contract(fixture), port, { signal: abort.signal, clock: new FakeClock() });
  await flushAsyncSteps();
  abort.abort();
  const result = await pending;

  assert.equal(result.cancelled, true);
  assert.equal(result.cleanup.parentStopped, true);
  assert.equal(port.cleanupCalls, 1);
  assert.equal(fixture.cleaned, true);
});

test("runner cancels a pending fixture verifier before cleanup", async () => {
  class HangingFixture extends ScriptedFixture {
    aborted = false;
    started = false;
    override verify(signal?: AbortSignal): Promise<BoundedCommandResult> {
      this.started = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          this.aborted = true;
          reject(new Error("verifier aborted"));
        }, { once: true });
      });
    }
  }
  const fixture = new HangingFixture();
  const port = new ScriptedPort((parent) => {
    parent.emit(completionLine());
    parent.emit(terminalLine());
  });
  const abort = new AbortController();
  const pending = runScenario(contract(fixture), port, { signal: abort.signal, clock: new FakeClock() });
  for (let step = 0; step < 100; step += 1) await Promise.resolve();
  assert.equal(fixture.started, true);
  abort.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(fixture.aborted, true);
  assert.equal(fixture.cleaned, true);
});

test("runner binds integration ordering to required parent reports and mutation tools", () => {
  const line = (timestamp: string, message: Record<string, unknown>) => JSON.stringify({ type: "message", timestamp, message });
  const unrelated = [
    line("2026-08-23T00:00:01.000Z", { role: "user", content: [{ type: "text", text: "[subagent unrelated] COMPLETED: fake" }] }),
    line("2026-08-23T00:00:02.000Z", { role: "user", content: [{ type: "text", text: "[subagent other] COMPLETED: fake" }] }),
    line("2026-08-23T00:00:03.000Z", { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/x" } }] }),
    line("2026-08-23T00:00:04.000Z", { role: "assistant", content: [{ type: "text", text: "BENCHMARK_DONE" }] }),
  ].join("\n");
  assert.equal(integrationAfterReports(unrelated, ["required-a", "required-b"], "BENCHMARK_DONE", ["src/x"]), false);
  const readBeforeReports = [
    line("2026-08-23T00:00:01.000Z", { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/x" } }] }),
    line("2026-08-23T00:00:02.000Z", { role: "user", content: [{ type: "text", text: "[subagent required-a] COMPLETED: report" }] }),
    line("2026-08-23T00:00:03.000Z", { role: "user", content: [{ type: "text", text: "[subagent required-b] COMPLETED: report" }] }),
    line("2026-08-23T00:00:04.000Z", { role: "assistant", content: [{ type: "text", text: "BENCHMARK_DONE" }] }),
  ].join("\\n");
  assert.equal(integrationAfterReports(readBeforeReports, ["required-a", "required-b"], "BENCHMARK_DONE", ["src/x"]), false);
  const valid = [
    line("2026-08-23T00:00:01.000Z", { role: "user", content: [{ type: "text", text: "[subagent required-a] COMPLETED: report" }] }),
    line("2026-08-23T00:00:02.000Z", { role: "user", content: [{ type: "text", text: "[subagent required-b] COMPLETED: report" }] }),
    line("2026-08-23T00:00:03.000Z", { role: "assistant", content: [{ type: "toolCall", id: "edit-success", name: "edit", arguments: { path: "src/x", oldText: "a", newText: "b" } }] }),
    line("2026-08-23T00:00:03.500Z", { role: "toolResult", toolCallId: "edit-success", toolName: "edit", isError: false }),
    line("2026-08-23T00:00:04.000Z", { role: "assistant", content: [{ type: "text", text: "BENCHMARK_DONE" }] }),
  ].join("\n");
  assert.equal(integrationAfterReports(valid, ["required-a", "required-b"], "BENCHMARK_DONE", ["src/x"]), true);
});

test("runner counts only successful spawn calls with matching child identity", () => {
  const callId = "call-success";
  const jsonl = [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "spawn_subagent", arguments: { title: "retry-after-explorer", agent: "explorer" } }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "spawn_subagent", isError: false, details: { childId: "child-success" } } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-failed", name: "spawn_subagent", arguments: { title: "request-id-explorer", agent: "explorer" } }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call-failed", toolName: "spawn_subagent", isError: true, details: { childId: "child-failed" } } }),
  ].join("\n");
  assert.deepEqual(spawnRecordsFromParentSession(jsonl), [{ title: "retry-after-explorer", agent: "explorer", childId: "child-success" }]);
});

test("runner bounds verifier output and retained diagnostics", async () => {
  const fixture = new ScriptedFixture({
    exitCode: 1,
    stdout: "x".repeat(MAX_RUNNER_OUTPUT_LENGTH + 500),
    stderr: "y".repeat(MAX_RUNNER_OUTPUT_LENGTH + 500),
    stdoutDropped: 0,
    stderrDropped: 0,
  });
  const port = new ScriptedPort((parent) => {
    parent.emit(completionLine());
    parent.emit(terminalLine());
  });
  const result = await runScenario(contract(fixture), port, { clock: new FakeClock() });

  assert.equal(result.fixtureVerification?.stdout.length, MAX_RUNNER_OUTPUT_LENGTH);
  assert.equal(result.fixtureVerification?.stderr.length, MAX_RUNNER_OUTPUT_LENGTH);
  assert.equal(result.fixtureVerification?.stdoutDropped, 500);
  assert.equal(result.fixtureVerification?.stderrDropped, 500);
  assert.equal(result.diagnostics.length <= 20, true);
});
