/**
 * Generic single-scenario runner control plane.
 *
 * The runner owns one initial prompt, observation, deadlines, fixture checks,
 * and cleanup. Scenario-specific code supplies only the fixture and evidence
 * parser; it never gets a continuation-prompt capability.
 */
import type { BenchmarkLaunchTrace, QualityGateResult } from "./contracts.ts";
import type { WireLine } from "../rpc-child.ts";

export const MAX_RUNNER_DIAGNOSTICS = 20;
export const MAX_RUNNER_DIAGNOSTIC_LENGTH = 240;
export const MAX_RUNNER_OUTPUT_LENGTH = 1_200;
export const MAX_RUNNER_OVERLAP_INTERVALS = 20;

export interface RunnerDiagnostic {
  code: string;
  message: string;
}

export interface BoundedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutDropped: number;
  stderrDropped: number;
}

export interface FixtureScopeResult {
  passed: boolean;
  changedPaths: readonly string[];
  unexpectedPaths: readonly string[];
}

/** A runner-created child worktree. Paths are sample-local and never artifacts. */
export interface FixtureWorktree {
  id: string;
  root: string;
  allowedPaths: readonly string[];
}

export interface FixtureWorktreeResult {
  id: string;
  passed: boolean;
  changedPaths: readonly string[];
  unexpectedPaths: readonly string[];
  /** Bounded source snapshots used to prove the parent integrated writer output. */
  contents?: Readonly<Record<string, string>>;
}

export interface PreparedFixture {
  /** Isolated fixture checkout/worktree supplied to the parent as its cwd. */
  readonly root: string;
  /** Pre-created, independently writable child worktrees when a workflow needs them. */
  readonly worktrees?: readonly FixtureWorktree[];
  verify(signal?: AbortSignal): Promise<BoundedCommandResult>;
  scope(signal?: AbortSignal): Promise<FixtureScopeResult>;
  /** Inspect child worktree edits before sample-local cleanup. */
  inspectWorktrees?(signal?: AbortSignal): Promise<readonly FixtureWorktreeResult[]>;
  cleanup(): Promise<boolean>;
}

export interface FixtureLifecycle {
  prepare(signal?: AbortSignal): Promise<PreparedFixture>;
}

export interface RunnerChildSnapshot {
  id: string;
  pid: number;
  /** Epoch milliseconds written by the hub when it launches the child. */
  startedAt: number;
  /** Process identity captured with the validated pidfile. */
  parentPid?: number;
  processGroup?: number;
  sessionId?: number;
}

export interface RunnerParentProcess {
  readonly pid?: number;
  readonly lines: readonly WireLine[];
  /** The sole runner-to-parent input. It is deliberately initial-only. */
  sendInitialPrompt(message: string): Promise<void>;
  subscribe(listener: (line: WireLine) => void): () => void;
  shutdown(): Promise<void>;
  isRunning(): boolean;
}

export interface RunnerCleanupResult {
  childPids: readonly number[];
  liveProcessPids: readonly number[];
}

/** Process boundary used by deterministic scripted tests and the real RPC port. */
export interface RunnerProcessPort {
  launchParent(input: {
    cwd: string;
    scenarioId: string;
    parentPolicy: { provider: string; model: string; thinking: string };
    signal: AbortSignal;
  }): Promise<RunnerParentProcess>;
  snapshotChildren(): readonly RunnerChildSnapshot[];
  cleanupChildren(observed: readonly RunnerChildSnapshot[]): Promise<RunnerCleanupResult>;
}

export interface RunnerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: RunnerClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RoleRequirement {
  /** Stable workstream title, independent of model wording in the child prompt. */
  title: string;
  /** Bundled agent preset expected for this workstream. */
  agent: string;
}

export interface ObservedRole {
  title: string;
  agent: string;
}

export interface ScenarioEvidence {
  observedRoles: readonly ObservedRole[];
  /** A child turn/process failure is distinct from persisted tool failures. */
  childFailure: boolean;
  /** The scenario-specific session parser validates all persisted model calls. */
  modelPolicyPassed: boolean;
  /** Number of successful required child identities observed in persisted sessions. */
  requiredChildCount: number;
  /** Required roles resolve to distinct persisted child identities. */
  distinctRequiredChildren: boolean;
  /** Number of child reports that ended in DONE-PARENT. */
  completedChildReports: number;
  /** Every required child report was persisted before the parent terminal marker. */
  childReportsBeforeTerminal: boolean;
  /** Parent integration/editing occurred only after required reports arrived. */
  integrationAfterReports: boolean;
  /** Required child model lifetimes overlapped; unrelated/idle children do not count. */
  requiredOverlap: boolean;
  /** Scenario session evidence may establish model-visible delivery after RPC compacts events. */
  autonomousCompletion: boolean;
  /** Scenario-specific hard gates, such as isolated writer cwd and review convergence. */
  workflowGates?: readonly QualityGateResult[];
}

export interface ScenarioContract {
  id: string;
  terminalMarker: string;
  initialBrief(fixtureRoot: string, worktrees?: readonly FixtureWorktree[]): string;
  fixture: FixtureLifecycle;
  parentPolicy: { provider: string; model: string; thinking: string };
  childPolicy: { provider: string; model: string; thinking: string };
  deadlineMs: number;
  pollIntervalMs?: number;
  minimumChildren: number;
  expectedRoles: readonly RoleRequirement[];
  /** Session/trace parsing belongs to the scenario, not the generic process loop. */
  collectEvidence(input: {
    parent: RunnerParentProcess;
    childSnapshots: readonly ChildLifetime[];
    fixture: PreparedFixture;
    signal: AbortSignal;
  }): Promise<ScenarioEvidence>;
}

export interface ChildLifetime extends RunnerChildSnapshot {
  /** Last monotonic time at which the runner saw the child alive. */
  observedAt: number;
}

export interface OverlapInterval {
  leftPid: number;
  rightPid: number;
  /** A direct snapshot demonstrates both children were live at this instant. */
  observedAt: number;
}

export interface ScenarioRunResult {
  id: string;
  terminalMarker: string;
  terminalReached: boolean;
  timeout: boolean;
  cancelled: boolean;
  initialPromptCount: number;
  completionFollowUpBeforeTerminal: boolean;
  childLifetimes: readonly ChildLifetime[];
  overlapIntervals: readonly OverlapInterval[];
  fixtureVerification?: BoundedCommandResult;
  scope?: FixtureScopeResult;
  evidence?: ScenarioEvidence;
  cleanup: {
    parentStopped: boolean;
    fixtureRemoved: boolean;
    childPids: readonly number[];
    liveProcessPids: readonly number[];
  };
  qualityGates: readonly QualityGateResult[];
  diagnostics: readonly RunnerDiagnostic[];
  diagnosticsDropped: number;
  /** Monotonic interval from initial parent prompt submission through verification. */
  measurementStartedAt: number;
  measurementFinishedAt: number;
  launchTrace: readonly BenchmarkLaunchTrace[];
  wallTimeMs: number;
}

function assistantText(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return "";
  return record.content
    .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null && !Array.isArray(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Terminal events differ between RPC versions; accept the documented turn forms only. */
export function lineHasTerminalMarker(line: WireLine, marker: string): boolean {
  if (line.type === "turn_end") return assistantText(line.message).includes(marker);
  if (line.type !== "agent_end" || !Array.isArray(line.messages)) return false;
  return line.messages.some((message) => assistantText(message).includes(marker));
}

/** Completion delivery is model-visible only when it appears as a parent user follow-up. */
export function lineHasCompletionFollowUp(line: WireLine): boolean {
  if (line.type !== "message" || typeof line.message !== "object" || line.message === null) return false;
  const message = line.message as { role?: unknown; content?: unknown };
  if (message.role !== "user" || !Array.isArray(message.content)) return false;
  return message.content.some((part) =>
    typeof part === "object" && part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.includes("] COMPLETED:"),
  );
}

function bounded(value: string, limit: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function boundedCommand(result: BoundedCommandResult): BoundedCommandResult {
  const stdout = result.stdout.slice(0, MAX_RUNNER_OUTPUT_LENGTH);
  const stderr = result.stderr.slice(0, MAX_RUNNER_OUTPUT_LENGTH);
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    stdoutDropped: Math.max(0, result.stdoutDropped) + Math.max(0, result.stdout.length - stdout.length),
    stderrDropped: Math.max(0, result.stderrDropped) + Math.max(0, result.stderr.length - stderr.length),
  };
}

function roleRequirementSatisfied(requirement: RoleRequirement, observed: readonly ObservedRole[]): boolean {
  return observed.some((role) => role.title === requirement.title && role.agent === requirement.agent);
}

function uniqueLifetimes(snapshots: readonly RunnerChildSnapshot[], observedAt: number, target: Map<number, ChildLifetime>): void {
  for (const child of snapshots) {
    if (!Number.isInteger(child.pid) || child.pid <= 0 || !Number.isFinite(child.startedAt)) continue;
    const previous = target.get(child.pid);
    if (previous) {
      previous.observedAt = Math.max(previous.observedAt, observedAt);
    } else {
      target.set(child.pid, { ...child, observedAt });
    }
  }
}

function overlapsForSnapshot(snapshots: readonly RunnerChildSnapshot[], observedAt: number): OverlapInterval[] {
  const valid = snapshots.filter((child) => Number.isInteger(child.pid) && child.pid > 0);
  const intervals: OverlapInterval[] = [];
  for (let left = 0; left < valid.length; left += 1) {
    for (let right = left + 1; right < valid.length; right += 1) {
      intervals.push({ leftPid: valid[left].pid, rightPid: valid[right].pid, observedAt });
    }
  }
  return intervals;
}

function noEvidence(): ScenarioEvidence {
  return {
    observedRoles: [],
    childFailure: false,
    modelPolicyPassed: false,
    requiredChildCount: 0,
    distinctRequiredChildren: false,
    completedChildReports: 0,
    childReportsBeforeTerminal: false,
    integrationAfterReports: false,
    requiredOverlap: false,
    autonomousCompletion: false,
    workflowGates: [],
  };
}

async function runBoundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineAt: () => number,
  clock: RunnerClock,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw new RunnerCancelledError();
  const remaining = deadlineAt() - clock.now();
  if (remaining <= 0) throw new RunnerTimeoutError();
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      controller.abort();
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = (): void => {
      controller.abort();
      finish(new RunnerCancelledError());
    };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    timer = clock.setTimeout(() => {
      controller.abort();
      finish(new RunnerTimeoutError());
    }, remaining);
    try {
      operation(controller.signal).then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function gatesFor(
  contract: ScenarioContract,
  result: Pick<ScenarioRunResult,
    "terminalReached" | "timeout" | "cancelled" | "initialPromptCount" | "completionFollowUpBeforeTerminal" |
    "childLifetimes" | "overlapIntervals" | "fixtureVerification" | "scope" | "evidence" | "cleanup">,
): QualityGateResult[] {
  const evidence = result.evidence ?? noEvidence();
  const verificationPassed = result.fixtureVerification?.exitCode === 0;
  return [
    { id: "initial-prompt-accepted", passed: result.initialPromptCount === 1 },
    { id: "autonomous-terminal-marker", passed: result.terminalReached && !result.timeout && !result.cancelled },
    { id: "model-visible-completion-before-terminal", passed: result.completionFollowUpBeforeTerminal || evidence.autonomousCompletion },
    { id: "child-completion-before-terminal", passed: evidence.childReportsBeforeTerminal },
    { id: "integration-after-child-reports", passed: evidence.integrationAfterReports },
    { id: "no-runner-continuation", passed: result.initialPromptCount === 1, detail: "one initial parent prompt only" },
    { id: "minimum-child-count", passed: evidence.requiredChildCount >= contract.minimumChildren },
    { id: "distinct-required-child-identities", passed: evidence.distinctRequiredChildren },
    { id: "child-lifetime-overlap", passed: evidence.requiredOverlap },
    ...(evidence.workflowGates ?? []),
    ...contract.expectedRoles.map((role) => ({
      id: `role:${role.title}`,
      passed: roleRequirementSatisfied(role, evidence.observedRoles),
      detail: `${role.agent}:${role.title}`,
    })),
    { id: "child-completion-reports", passed: evidence.completedChildReports >= contract.minimumChildren },
    { id: "no-child-failure", passed: !evidence.childFailure },
    { id: "suite-model-policy", passed: evidence.modelPolicyPassed },
    { id: "fixture-verification", passed: verificationPassed },
    { id: "fixture-scope", passed: result.scope?.passed === true },
    { id: "no-leaked-processes", passed: result.cleanup.liveProcessPids.length === 0 && result.cleanup.parentStopped },
    { id: "fixture-cleanup", passed: result.cleanup.fixtureRemoved },
  ];
}

/**
 * Run a scenario exactly once. Cleanup is in the finally path so successful,
 * failed, timed-out, and externally aborted runs all take the same ownership
 * path. There is intentionally no API for a second parent prompt.
 */
export async function runScenario(
  contract: ScenarioContract,
  port: RunnerProcessPort,
  options: { signal?: AbortSignal; clock?: RunnerClock } = {},
): Promise<ScenarioRunResult> {
  const clock = options.clock ?? systemClock;
  const runnerStartedAt = clock.now();
  let kpiStartedAt = runnerStartedAt;
  let qualityFinishedAt: number | undefined;
  const diagnostics: RunnerDiagnostic[] = [];
  let diagnosticsDropped = 0;
  const diagnostic = (code: string, message: string): void => {
    if (diagnostics.length < MAX_RUNNER_DIAGNOSTICS) diagnostics.push({ code, message: bounded(message, MAX_RUNNER_DIAGNOSTIC_LENGTH) });
    else diagnosticsDropped += 1;
  };

  let fixture: PreparedFixture | undefined;
  let parent: RunnerParentProcess | undefined;
  let terminalReached = false;
  let timeout = false;
  let cancelled = false;
  let initialPromptCount = 0;
  let completionFollowUpAt: number | undefined;
  let terminalAt: number | undefined;
  let fixtureVerification: BoundedCommandResult | undefined;
  let scope: FixtureScopeResult | undefined;
  let evidence: ScenarioEvidence | undefined;
  const lifetimes = new Map<number, ChildLifetime>();
  const overlapIntervals: OverlapInterval[] = [];
  const observedOverlapPairs = new Set<string>();
  const scenarioDeadlineAt = () => runnerStartedAt + contract.deadlineMs;
  let cleanup: ScenarioRunResult["cleanup"] = {
    parentStopped: false,
    fixtureRemoved: false,
    childPids: [],
    liveProcessPids: [],
  };

  const sampleChildren = (): void => {
    const now = clock.now();
    let snapshot: readonly RunnerChildSnapshot[] = [];
    try {
      snapshot = port.snapshotChildren();
      uniqueLifetimes(snapshot, now, lifetimes);
      for (const overlap of overlapsForSnapshot(snapshot, now)) {
        const key = `${Math.min(overlap.leftPid, overlap.rightPid)}:${Math.max(overlap.leftPid, overlap.rightPid)}`;
        if (observedOverlapPairs.has(key) || overlapIntervals.length >= MAX_RUNNER_OVERLAP_INTERVALS) continue;
        observedOverlapPairs.add(key);
        overlapIntervals.push(overlap);
      }
    } catch {
      diagnostic("child-observation", "unable to observe benchmark child processes");
    }
  };

  try {
    if (options.signal?.aborted) throw new RunnerCancelledError();
    fixture = await runBoundedOperation(
      (signal) => contract.fixture.prepare(signal),
      scenarioDeadlineAt,
      clock,
      options.signal,
    );
    const prepared = fixture;
    parent = await runBoundedOperation(
      (signal) => port.launchParent({
        cwd: prepared.root,
        scenarioId: contract.id,
        parentPolicy: contract.parentPolicy,
        signal,
      }),
      scenarioDeadlineAt,
      clock,
      options.signal,
    );
    const launchedParent = parent;
    kpiStartedAt = clock.now();
    await runBoundedOperation(
      () => launchedParent.sendInitialPrompt(contract.initialBrief(prepared.root, prepared.worktrees)),
      scenarioDeadlineAt,
      clock,
      options.signal,
    );
    initialPromptCount += 1;
    sampleChildren();

    // Capture synchronous scripted/RPC lines emitted while the prompt response
    // was in flight before subscribing for later autonomous completion.
    for (const line of parent.lines) {
      const now = clock.now();
      if (lineHasCompletionFollowUp(line) && completionFollowUpAt === undefined) completionFollowUpAt = now;
      if (lineHasTerminalMarker(line, contract.terminalMarker) && terminalAt === undefined) terminalAt = now;
    }
    await waitForTerminal({
      parent,
      marker: contract.terminalMarker,
      deadlineMs: Math.max(0, scenarioDeadlineAt() - clock.now()),
      pollIntervalMs: contract.pollIntervalMs ?? 100,
      clock,
      signal: options.signal,
      onLine: (line) => {
        const now = clock.now();
        if (lineHasCompletionFollowUp(line) && completionFollowUpAt === undefined) completionFollowUpAt = now;
        if (lineHasTerminalMarker(line, contract.terminalMarker) && terminalAt === undefined) terminalAt = now;
      },
      onPoll: sampleChildren,
    });
    terminalReached = true;
    if (!fixture || !parent) throw new Error("scenario completed without fixture and parent ownership");
    const preparedFixture = fixture;
    const runningParent = parent;
    // Stop all model-owned writers before inspecting or executing evaluator
    // files. Real benchmark ports terminate the authenticated process group.
    const preVerificationCleanup = await port.cleanupChildren([...lifetimes.values()]);
    if (preVerificationCleanup.liveProcessPids.length > 0) {
      throw new Error("model-owned processes remained alive before fixture scope/verifier");
    }
    await runningParent.shutdown();
    if (runningParent.isRunning()) throw new Error("model-owned parent remained alive before fixture scope/verifier");

    // Scope comes first. A candidate-controlled verifier must never execute
    // after an evaluator file, symlink, or out-of-scope path is detected.
    scope = await runBoundedOperation(
      (signal) => preparedFixture.scope(signal),
      scenarioDeadlineAt,
      clock,
      options.signal,
    );
    if (scope.passed) {
      fixtureVerification = boundedCommand(await runBoundedOperation(
        (signal) => preparedFixture.verify(signal),
        scenarioDeadlineAt,
        clock,
        options.signal,
      ));
      // Re-scope immediately after verification as a last TOCTOU tripwire;
      // evaluator code must not be able to create a symlink or out-of-scope
      // file and still receive a passing sample.
      const postVerificationScope = await runBoundedOperation(
        (signal) => preparedFixture.scope(signal),
        scenarioDeadlineAt,
        clock,
        options.signal,
      );
      if (!postVerificationScope.passed) {
        scope = {
          passed: false,
          changedPaths: [...new Set([...(scope?.changedPaths ?? []), ...postVerificationScope.changedPaths])].sort(),
          unexpectedPaths: [...new Set([...(scope?.unexpectedPaths ?? []), ...postVerificationScope.unexpectedPaths])].sort(),
        };
      }
    }
    evidence = await runBoundedOperation(
      (signal) => contract.collectEvidence({
        parent: runningParent,
        childSnapshots: [...lifetimes.values()],
        fixture: preparedFixture,
        signal,
      }),
      scenarioDeadlineAt,
      clock,
      options.signal,
    );
    qualityFinishedAt = clock.now();
  } catch (error) {
    if (error instanceof RunnerTimeoutError) {
      timeout = true;
      diagnostic("scenario-timeout", "scenario terminal marker did not arrive before its deadline");
    } else if (error instanceof RunnerCancelledError || options.signal?.aborted) {
      cancelled = true;
      diagnostic("scenario-cancelled", "scenario cancelled before terminal marker");
    } else {
      diagnostic("scenario-process", "scenario parent, fixture, or evidence operation failed");
    }
  } finally {
    sampleChildren();
    // Validate and stop observed children while their authenticated parentage
    // still exists; only then shut down the parent process.
    try {
      const cleaned = await port.cleanupChildren([...lifetimes.values()]);
      cleanup = { ...cleanup, childPids: [...cleaned.childPids], liveProcessPids: [...cleaned.liveProcessPids] };
    } catch {
      diagnostic("child-cleanup", "benchmark child cleanup failed");
      cleanup = { ...cleanup, liveProcessPids: [-1] };
    }
    if (parent) {
      try {
        await parent.shutdown();
      } catch {
        diagnostic("parent-cleanup", "benchmark parent did not shut down cleanly");
      }
      cleanup.parentStopped = !parent.isRunning();
    } else {
      cleanup.parentStopped = true;
    }
    if (fixture) {
      try {
        cleanup.fixtureRemoved = await fixture.cleanup();
      } catch {
        diagnostic("fixture-cleanup", "benchmark fixture cleanup failed");
      }
    }
  }

  const childLifetimes = [...lifetimes.values()].sort((left, right) => left.pid - right.pid);
  const completionIndex = parent?.lines.findIndex((line) => lineHasCompletionFollowUp(line)) ?? -1;
  const terminalIndex = parent?.lines.findIndex((line) => lineHasTerminalMarker(line, contract.terminalMarker)) ?? -1;
  // Event order is stronger than clock resolution: two RPC records can share a
  // monotonic tick while still being ordered on the parent transcript.
  const completionFollowUpBeforeTerminal = completionIndex >= 0 && terminalIndex >= 0 && completionIndex < terminalIndex ||
    (completionFollowUpAt !== undefined && terminalAt !== undefined && completionFollowUpAt < terminalAt);
  const partial: Omit<ScenarioRunResult, "qualityGates"> = {
    id: contract.id,
    terminalMarker: contract.terminalMarker,
    terminalReached,
    timeout,
    cancelled,
    initialPromptCount,
    completionFollowUpBeforeTerminal,
    childLifetimes,
    overlapIntervals,
    fixtureVerification,
    scope,
    evidence,
    cleanup,
    diagnostics,
    diagnosticsDropped,
    measurementStartedAt: kpiStartedAt,
    measurementFinishedAt: qualityFinishedAt ?? clock.now(),
    launchTrace: [
      {
        scenarioId: contract.id,
        participant: "parent",
        id: "parent",
        pid: parent?.pid ?? -1,
        startedAt: kpiStartedAt,
        ...contract.parentPolicy,
      },
      ...[...lifetimes.values()].map((child) => ({
        scenarioId: contract.id,
        participant: "child" as const,
        id: child.id,
        pid: child.pid,
        startedAt: child.startedAt,
        ...contract.childPolicy,
      })),
    ],
    wallTimeMs: Math.max(0, (qualityFinishedAt ?? clock.now()) - kpiStartedAt),
  };
  return { ...partial, qualityGates: gatesFor(contract, partial) };
}

class RunnerTimeoutError extends Error {}
class RunnerCancelledError extends Error {}

interface WaitForTerminalInput {
  parent: RunnerParentProcess;
  marker: string;
  deadlineMs: number;
  pollIntervalMs: number;
  clock: RunnerClock;
  signal?: AbortSignal;
  onLine(line: WireLine): void;
  onPoll(): void;
}

function waitForTerminal(input: WaitForTerminalInput): Promise<void> {
  if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
    return Promise.reject(new RunnerTimeoutError());
  }
  if (input.signal?.aborted) return Promise.reject(new RunnerCancelledError());
  if (input.parent.lines.some((line) => lineHasTerminalMarker(line, input.marker))) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let deadlineTimer: unknown;
    let pollTimer: unknown;
    let unsubscribe = (): void => {};
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      input.clock.clearTimeout(deadlineTimer);
      input.clock.clearTimeout(pollTimer);
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new RunnerCancelledError());
    const poll = (): void => {
      input.onPoll();
      if (!done) pollTimer = input.clock.setTimeout(poll, input.pollIntervalMs);
    };
    unsubscribe = input.parent.subscribe((line) => {
      input.onLine(line);
      if (lineHasTerminalMarker(line, input.marker)) finish();
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = input.clock.setTimeout(() => finish(new RunnerTimeoutError()), input.deadlineMs);
    pollTimer = input.clock.setTimeout(poll, input.pollIntervalMs);
    // A scripted process may have emitted between the first scan and subscription.
    if (input.parent.lines.some((line) => lineHasTerminalMarker(line, input.marker))) finish();
  });
}
