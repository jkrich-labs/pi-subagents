import assert from "node:assert/strict";
import { test } from "node:test";
import type { WireLine } from "../harness/rpc-child.ts";
import {
  PARALLEL_IMPLEMENTATION_REQUIREMENTS,
  parallelWriterWorkflowGates,
} from "../harness/benchmark/parallel-implementation.ts";
import {
  REVIEW_CONVERGENCE_REQUIREMENTS,
  reviewConvergenceWorkflowGates,
} from "../harness/benchmark/review-convergence.ts";
import {
  runScenario,
  type FixtureWorktree,
  type FixtureWorktreeResult,
  type PreparedFixture,
  type RunnerChildSnapshot,
  type RunnerParentProcess,
  type RunnerProcessPort,
  type ScenarioContract,
  type ScenarioEvidence,
} from "../harness/benchmark/runner.ts";

const writers: readonly FixtureWorktree[] = [
  { id: "endpoint-port", root: "/worktrees/endpoint-port", allowedPaths: ["src/endpoint-port.mjs"] },
  { id: "canonical-tags", root: "/worktrees/canonical-tags", allowedPaths: ["src/canonical-tags.mjs"] },
];
const writerEdits: readonly FixtureWorktreeResult[] = [
  { id: "endpoint-port", passed: true, changedPaths: ["src/endpoint-port.mjs"], unexpectedPaths: [], contents: { "src/endpoint-port.mjs": "endpoint implementation" } },
  { id: "canonical-tags", passed: true, changedPaths: ["src/canonical-tags.mjs"], unexpectedPaths: [], contents: { "src/canonical-tags.mjs": "tags implementation" } },
];
const integrationContents = {
  "src/endpoint-port.mjs": "endpoint implementation",
  "src/canonical-tags.mjs": "tags implementation",
};

test("parallel implementation gates require isolated writer cwd sessions and both independent edits", () => {
  const gates = parallelWriterWorkflowGates({
    observations: [
      { title: "endpoint-port-implementer", agent: "mechanical-worker", cwd: writers[0].root, childCwd: writers[0].root },
      { title: "canonical-tags-implementer", agent: "mechanical-worker", cwd: writers[1].root, childCwd: writers[1].root },
    ],
    worktrees: writers,
    worktreeResults: writerEdits,
    integrationContents,
  });
  assert.equal(gates.every((gate) => gate.passed), true);

  const sharedCwd = parallelWriterWorkflowGates({
    observations: [
      { title: "endpoint-port-implementer", agent: "mechanical-worker", cwd: "/fixture", childCwd: "/fixture" },
      { title: "canonical-tags-implementer", agent: "mechanical-worker", cwd: writers[1].root, childCwd: writers[1].root },
    ],
    worktrees: writers,
    worktreeResults: [{ ...writerEdits[0], changedPaths: [] }, writerEdits[1]],
    integrationContents,
  });
  assert.equal(sharedCwd.find((gate) => gate.id === "isolated-writer-cwd:endpoint-port-implementer")?.passed, false);
  assert.equal(sharedCwd.find((gate) => gate.id === "isolated-writer-edit:endpoint-port")?.passed, false);
});

test("review convergence gates require implementer then parallel reviewers with autonomous findings", () => {
  const implementationWorktree: FixtureWorktree = {
    id: "redaction-implementation",
    root: "/worktrees/redaction-implementation",
    allowedPaths: ["src/redact-headers.mjs"],
  };
  const gates = reviewConvergenceWorkflowGates({
    observations: [
      { title: "redaction-implementer", agent: "mechanical-worker", cwd: implementationWorktree.root, childCwd: implementationWorktree.root, finding: false },
      { title: "redaction-spec-reviewer", agent: "reviewer-spec", cwd: "/fixture", childCwd: "/fixture", spawnedAt: 20, finding: true },
      { title: "redaction-standards-reviewer", agent: "reviewer-standards", cwd: "/fixture", childCwd: "/fixture", spawnedAt: 21, finding: true },
    ],
    implementationDoneAt: 20,
    parentRoot: "/fixture",
    worktrees: [implementationWorktree],
    worktreeResults: [{ id: implementationWorktree.id, passed: true, changedPaths: ["src/redact-headers.mjs"], unexpectedPaths: [] }],
  });
  assert.equal(gates.every((gate) => gate.passed), true);

  const skippedReview = reviewConvergenceWorkflowGates({
    observations: [{ title: "redaction-implementer", agent: "mechanical-worker", cwd: implementationWorktree.root, childCwd: implementationWorktree.root, finding: false }],
    implementationDoneAt: 20,
    parentRoot: "/fixture",
    worktrees: [implementationWorktree],
    worktreeResults: [{ id: implementationWorktree.id, passed: true, changedPaths: ["src/redact-headers.mjs"], unexpectedPaths: [] }],
  });
  assert.equal(skippedReview.filter((gate) => gate.id.startsWith("reviewer-") || gate.id.startsWith("review-finding:")).every((gate) => !gate.passed), true);
});

class ScriptedParent implements RunnerParentProcess {
  readonly lines: WireLine[] = [];
  private readonly listeners = new Set<(line: WireLine) => void>();
  private running = true;
  prompts = 0;

  async sendInitialPrompt(): Promise<void> {
    this.prompts += 1;
    this.emit({ type: "message", message: { role: "user", content: [{ type: "text", text: "[child] COMPLETED: report" }] } });
    this.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "SCENARIO_DONE" }] }] });
  }
  subscribe(listener: (line: WireLine) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async shutdown(): Promise<void> { this.running = false; }
  isRunning(): boolean { return this.running; }
  private emit(line: WireLine): void { this.lines.push(line); for (const listener of this.listeners) listener(line); }
}

class ScriptedFixture implements PreparedFixture {
  readonly root = "/fixture";
  readonly worktrees = writers;
  async verify() { return { exitCode: 0, stdout: "verified", stderr: "", stdoutDropped: 0, stderrDropped: 0 }; }
  async scope() { return { passed: true, changedPaths: ["src/endpoint-port.mjs", "src/canonical-tags.mjs"], unexpectedPaths: [] }; }
  async inspectWorktrees() { return writerEdits; }
  async cleanup() { return true; }
}

class ScriptedPort implements RunnerProcessPort {
  readonly parent = new ScriptedParent();
  async launchParent() { return this.parent; }
  snapshotChildren(): readonly RunnerChildSnapshot[] {
    return [
      { id: "one", pid: 101, startedAt: 1 },
      { id: "two", pid: 102, startedAt: 1 },
    ];
  }
  async cleanupChildren(observed: readonly RunnerChildSnapshot[]) {
    return { childPids: observed.map((child) => child.pid), liveProcessPids: [] };
  }
}

test("common scenario runner hard-gates autonomous reports, overlapping children, roles, and final verification", async () => {
  const fixture = new ScriptedFixture();
  const evidence: ScenarioEvidence = {
    observedRoles: [...PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles],
    childFailure: false,
    modelPolicyPassed: true,
    requiredChildCount: 2,
    distinctRequiredChildren: true,
    delegatedWork: true,
    completedChildReports: 2,
    childReportsBeforeTerminal: true,
    integrationAfterReports: true,
    requiredOverlap: true,
    autonomousCompletion: true,
    workflowGates: parallelWriterWorkflowGates({
      observations: [
        { title: "endpoint-port-implementer", agent: "mechanical-worker", cwd: writers[0].root, childCwd: writers[0].root },
        { title: "canonical-tags-implementer", agent: "mechanical-worker", cwd: writers[1].root, childCwd: writers[1].root },
      ],
      worktrees: writers,
      worktreeResults: writerEdits,
      integrationContents,
    }),
  };
  const contract: ScenarioContract = {
    id: PARALLEL_IMPLEMENTATION_REQUIREMENTS.id,
    terminalMarker: "SCENARIO_DONE",
    initialBrief: () => "one autonomous prompt",
    fixture: { async prepare() { return fixture; } },
    parentPolicy: { provider: "test", model: "test", thinking: "medium" },
    childPolicy: { provider: "test", model: "test", thinking: "medium" },
    deadlineMs: 1_000,
    minimumChildren: 2,
    expectedRoles: PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles,
    async collectEvidence() { return evidence; },
  };
  const port = new ScriptedPort();
  const result = await runScenario(contract, port);
  assert.equal(port.parent.prompts, 1, "runner sends no continuation prompt");
  assert.equal(result.overlapIntervals.length > 0, true, "two child lifetimes overlap");
  assert.equal(result.qualityGates.find((gate) => gate.id === "model-visible-completion-before-terminal")?.passed, true);
  assert.equal(result.qualityGates.find((gate) => gate.id === "child-completion-before-terminal")?.passed, true);
  assert.equal(result.qualityGates.find((gate) => gate.id === "fixture-verification")?.passed, true);
  assert.equal(result.qualityGates.every((gate) => gate.passed), true);
  assert.deepEqual(REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.map((role) => role.agent), ["mechanical-worker", "reviewer-spec", "reviewer-standards"]);
});
