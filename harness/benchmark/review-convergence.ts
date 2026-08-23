/** Real S-04 implementation plus parallel review-convergence scenario. */
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { accountPersistedSessions, type PersistedSession } from "./accounting.ts";
import { createBenchmarkSample, type BenchmarkDiagnostic, type BenchmarkSample, type QualityGateResult } from "./contracts.ts";
import { createReviewConvergenceFixtureLifecycle, REVIEW_CONVERGENCE_ALLOWED_PATHS } from "./fixtures.ts";
import { assertBenchmarkSuiteIntegrity, REVIEW_CONVERGENCE_MANIFEST } from "./profile.ts";
import {
  RealRunnerPort,
  childDoneAt,
  childHasDoneReport,
  childHasFailure,
  childSessionsOverlap,
  parentTerminalAt,
  reviewIntegrationOrdering,
  persistedAutonomousCompletion,
  sessionChildId,
  spawnRecordsFromParentSession,
} from "./parallel-diagnosis.ts";
import {
  runScenario,
  type FixtureWorktree,
  type FixtureWorktreeResult,
  type ScenarioContract,
  type ScenarioEvidence,
  type ScenarioRunResult,
} from "./runner.ts";

export const REVIEW_CONVERGENCE_SCENARIO_ID = "review-convergence";
export const REVIEW_CONVERGENCE_TERMINAL_MARKER = "BENCHMARK_REVIEW_CONVERGENCE_DONE";
const SCENARIO_TIMEOUT_MS = 5 * 60_000;

export const REVIEW_CONVERGENCE_REQUIREMENTS = {
  id: REVIEW_CONVERGENCE_SCENARIO_ID,
  terminalMarker: REVIEW_CONVERGENCE_TERMINAL_MARKER,
  minimumChildren: 3,
  expectedRoles: [
    { title: "redaction-implementer", agent: "mechanical-worker" },
    { title: "redaction-spec-reviewer", agent: "reviewer-spec" },
    { title: "redaction-standards-reviewer", agent: "reviewer-standards" },
  ],
  implementationWorktree: "redaction-implementation",
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sessionCwd(jsonl: string): string | undefined {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      if (entry?.type === "session" && typeof entry.cwd === "string" && entry.cwd !== "") return entry.cwd;
    } catch {
      continue;
    }
  }
  return undefined;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && resolve(left) === resolve(right);
}

function reviewFinding(jsonl: string): boolean {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content.map(asRecord)
        .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (/^FINDING:\s+\S.{15,}/m.test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface ReviewConvergenceObservation {
  title: string;
  agent: string;
  cwd?: string;
  childCwd?: string;
  spawnedAt?: number;
  finding: boolean;
}

/** Pure workflow gates keep review ordering and evidence visible to deterministic tests. */
export function reviewConvergenceWorkflowGates(input: {
  observations: readonly ReviewConvergenceObservation[];
  implementationDoneAt?: number;
  parentRoot: string;
  worktrees: readonly FixtureWorktree[];
  worktreeResults: readonly FixtureWorktreeResult[];
}): QualityGateResult[] {
  const implementation = input.observations.find((item) => item.title === "redaction-implementer" && item.agent === "mechanical-worker");
  const implementationWorktree = input.worktrees.find((item) => item.id === REVIEW_CONVERGENCE_REQUIREMENTS.implementationWorktree);
  const implementationChanges = input.worktreeResults.find((item) => item.id === REVIEW_CONVERGENCE_REQUIREMENTS.implementationWorktree);
  const reviewers = REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.slice(1);
  return [
    {
      id: "isolated-implementation-cwd",
      passed: implementationWorktree !== undefined && implementation !== undefined &&
        samePath(implementation.cwd, implementationWorktree.root) && samePath(implementation.childCwd, implementationWorktree.root),
    },
    {
      id: "isolated-implementation-edit",
      passed: implementationChanges?.passed === true && implementationChanges.changedPaths.includes("src/redact-headers.mjs"),
    },
    ...reviewers.flatMap((reviewer) => {
      const observation = input.observations.find((item) => item.title === reviewer.title && item.agent === reviewer.agent);
      return [
        {
          id: `reviewer-cwd:${reviewer.title}`,
          passed: observation !== undefined && samePath(observation.cwd, input.parentRoot) && samePath(observation.childCwd, input.parentRoot),
        },
        {
          id: `reviewer-after-implementer:${reviewer.title}`,
          passed: observation?.spawnedAt !== undefined && input.implementationDoneAt !== undefined &&
            observation.spawnedAt >= input.implementationDoneAt,
        },
        { id: `review-finding:${reviewer.title}`, passed: observation?.finding === true },
      ];
    }),
  ];
}

function scenarioContract(port: RealRunnerPort): ScenarioContract {
  return {
    id: REVIEW_CONVERGENCE_SCENARIO_ID,
    terminalMarker: REVIEW_CONVERGENCE_TERMINAL_MARKER,
    initialBrief: (fixtureRoot, worktrees) => brief(fixtureRoot, worktrees ?? []),
    fixture: createReviewConvergenceFixtureLifecycle(),
    parentPolicy: REVIEW_CONVERGENCE_MANIFEST.parent,
    childPolicy: REVIEW_CONVERGENCE_MANIFEST.child,
    deadlineMs: SCENARIO_TIMEOUT_MS,
    minimumChildren: REVIEW_CONVERGENCE_REQUIREMENTS.minimumChildren,
    expectedRoles: REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles,
    async collectEvidence(input): Promise<ScenarioEvidence> {
      const sessions = port.sessionRecords();
      const parent = sessions.find((session) => session.participant === "parent");
      const children = sessions.filter((session) => session.participant === "child");
      const spawns = parent ? spawnRecordsFromParentSession(parent.jsonl) : [];
      const childById = new Map(children.map((session) => [sessionChildId(session.jsonl), { session, cwd: sessionCwd(session.jsonl) }] as const));
      const required = REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.map((role) => {
        const spawn = spawns.find((item) => item.title === role.title && item.agent === role.agent);
        return { role, spawn, child: spawn ? childById.get(spawn.childId) : undefined };
      });
      const requiredChildren = required.map((item) => item.child?.session).filter((session): session is PersistedSession => session !== undefined);
      const terminalAt = parent ? parentTerminalAt(parent.jsonl, REVIEW_CONVERGENCE_TERMINAL_MARKER) : undefined;
      const childReportsBeforeTerminal = requiredChildren.length === REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.length &&
        requiredChildren.every((session) => {
          const doneAt = childDoneAt(session.jsonl);
          return doneAt !== undefined && terminalAt !== undefined && doneAt <= terminalAt;
        });
      let modelPolicyPassed = false;
      try {
        const accounting = accountPersistedSessions(REVIEW_CONVERGENCE_MANIFEST, sessions);
        modelPolicyPassed = accounting.diagnostics.length === 0 && accounting.diagnosticsDropped === 0;
      } catch {
        modelPolicyPassed = false;
      }
      const worktreeResults = await input.fixture.inspectWorktrees?.(input.signal) ?? [];
      const observations = required.flatMap(({ role, spawn, child }) => spawn ? [{
        title: role.title,
        agent: role.agent,
        cwd: spawn.cwd,
        childCwd: child?.cwd,
        spawnedAt: spawn.spawnedAt,
        finding: child ? reviewFinding(child.session.jsonl) : false,
      }] : []);
      const implementationChild = required.find((item) => item.role.title === "redaction-implementer")?.child?.session;
      const reviewerChildren = required
        .filter((item) => item.role.title !== "redaction-implementer")
        .map((item) => item.child?.session)
        .filter((session): session is PersistedSession => session !== undefined);
      return {
        observedRoles: required
          .filter((item) => item.spawn !== undefined && item.child !== undefined)
          .map(({ role }) => ({ title: role.title, agent: role.agent })),
        childFailure: port.hasChildFailure() || children.some((session) => childHasFailure(session.jsonl)),
        modelPolicyPassed,
        requiredChildCount: requiredChildren.length,
        distinctRequiredChildren: new Set(required.map((item) => item.spawn?.childId).filter((id): id is string => id !== undefined)).size === REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.length,
        completedChildReports: requiredChildren.filter((session) => childHasDoneReport(session.jsonl)).length,
        childReportsBeforeTerminal,
        integrationAfterReports: parent ? reviewIntegrationOrdering(
          parent.jsonl,
          required.find((item) => item.role.title === "redaction-implementer")?.spawn?.childId ?? "",
          required.filter((item) => item.role.title !== "redaction-implementer").map((item) => item.spawn?.childId ?? ""),
          REVIEW_CONVERGENCE_TERMINAL_MARKER,
          REVIEW_CONVERGENCE_ALLOWED_PATHS,
        ) : false,
        requiredOverlap: childSessionsOverlap(reviewerChildren),
        autonomousCompletion: parent ? persistedAutonomousCompletion(parent.jsonl, REVIEW_CONVERGENCE_TERMINAL_MARKER) : false,
        workflowGates: reviewConvergenceWorkflowGates({
          observations,
          implementationDoneAt: implementationChild ? childDoneAt(implementationChild.jsonl) : undefined,
          parentRoot: input.fixture.root,
          worktrees: input.fixture.worktrees ?? [],
          worktreeResults,
        }),
      };
    },
  };
}

function brief(fixtureRoot: string, worktrees: readonly FixtureWorktree[]): string {
  const implementationWorktree = worktrees.find((worktree) => worktree.id === "redaction-implementation")?.root ?? "";
  return [
    "Complete the implementation and review convergence benchmark autonomously.",
    `Your integration checkout is ${fixtureRoot}.`,
    `First spawn exactly one child with agent mechanical-worker, title redaction-implementer, and cwd ${implementationWorktree}. Its assignment is to edit only src/redact-headers.mjs in that isolated worktree and commit a baseline implementation which returns a copied object, redacts only exact lowercase authorization and cookie keys, and otherwise preserves values. It must report its commit and end DONE-PARENT.`,
    "After launching that implementer, end the turn. Do not edit the integration checkout, launch reviewers, poll, sleep, inspect processes, or use raw nested pi before its automatic completion report arrives.",
    "After the implementer report, integrate its commit into the integration checkout. Then, in one turn, spawn both reviewers with cwd set to the integration checkout: use agent reviewer-spec/title redaction-spec-reviewer and agent reviewer-standards/title redaction-standards-reviewer.",
    "Tell each reviewer to inspect src/redact-headers.mjs and verifier.mjs without editing, run node verifier.mjs if useful, state one evidence-backed line beginning FINDING: (use FINDING: no blocking issue only if truly clean), then end DONE-PARENT. Launch both reviewers before changing the integration checkout again, then end the turn and await both automatic reports.",
    "After both reviewer reports, apply the verified convergence fixes yourself. The final function must return a new object, redact authorization, cookie, and set-cookie case-insensitively while preserving original key spelling and safe values, and return {} for null/non-object input. Change only src/redact-headers.mjs.",
    "Run node verifier.mjs from the integration checkout. Only after it passes and all three child reports arrived, reply with this exact standalone terminal marker:",
    REVIEW_CONVERGENCE_TERMINAL_MARKER,
  ].join("\n");
}

interface ReviewConvergenceArtifact {
  schemaVersion: 1;
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  activeManifest: typeof REVIEW_CONVERGENCE_MANIFEST;
  profile: "quick";
  benchmarkStartedAt: number;
  benchmarkFinishedAt: number;
  launchTrace: readonly import("./contracts.ts").BenchmarkLaunchTrace[];
  scenario: {
    id: string;
    terminalMarker: string;
    terminalReached: boolean;
    parentCompletedAutonomously: boolean;
    runnerInjectedContinuationPrompts: number;
    expectedRoles: readonly string[];
    observedRoles: readonly string[];
    reviewConvergencePassed: boolean;
    fixtureVerification: { passed: boolean; exitCode: number | null; stdout: string; stderr: string; outputDropped: number };
    scope: { passed: boolean; changedPaths: readonly string[]; unexpectedPaths: readonly string[] };
  };
  children: readonly { provider: string; model: string; thinking: string; policyVerified: boolean }[];
  cleanup: ScenarioRunResult["cleanup"];
  noLeakedProcesses: boolean;
  noLeakedWorktrees: boolean;
  qualityGates: readonly QualityGateResult[];
  diagnostics: readonly BenchmarkDiagnostic[];
  diagnosticsDropped: number;
  kpis: { wall_time_ms: number; total_tokens: number; tool_failures: number };
  sample: BenchmarkSample;
}

function accountingFor(port: RealRunnerPort) {
  try {
    const accounting = accountPersistedSessions(REVIEW_CONVERGENCE_MANIFEST, port.sessionRecords());
    return { accounting, diagnostics: [...accounting.diagnostics] };
  } catch {
    const accounting = {
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, parentTokens: 0, childTokens: 0 },
      toolFailures: 0,
      diagnostics: [{ code: "session-accounting", message: "persisted session accounting rejected" }],
      diagnosticsDropped: 0,
    };
    return { accounting, diagnostics: [...accounting.diagnostics] };
  }
}

export async function runReviewConvergence(): Promise<ReviewConvergenceArtifact> {
  assertBenchmarkSuiteIntegrity(REVIEW_CONVERGENCE_MANIFEST);
  const sampleDirectory = mkdtempSync(join(tmpdir(), `pi-subagents-${REVIEW_CONVERGENCE_SCENARIO_ID}-`));
  const port = new RealRunnerPort(sampleDirectory, REVIEW_CONVERGENCE_MANIFEST);
  const result = await runScenario(scenarioContract(port), port);
  const { accounting, diagnostics: accountingDiagnostics } = accountingFor(port);
  const sample = createBenchmarkSample({
    manifest: REVIEW_CONVERGENCE_MANIFEST,
    wallTimeMs: result.wallTimeMs,
    accounting,
    launchTrace: result.launchTrace,
    scenarios: [{
      id: REVIEW_CONVERGENCE_SCENARIO_ID,
      wallTimeMs: result.wallTimeMs,
      usage: accounting.usage,
      toolFailures: accounting.toolFailures,
      qualityGates: result.qualityGates,
    }],
    qualityGates: result.qualityGates,
  });
  const verification = result.fixtureVerification;
  const scope = result.scope;
  const allDiagnostics: BenchmarkDiagnostic[] = [
    ...accountingDiagnostics,
    ...result.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
  ].slice(0, 20);
  const diagnosticsDropped = accounting.diagnosticsDropped + result.diagnosticsDropped +
    Math.max(0, accountingDiagnostics.length + result.diagnostics.length - allDiagnostics.length);
  const workflowGates = result.qualityGates.filter((gate) =>
    gate.id.startsWith("isolated-implementation-") || gate.id.startsWith("reviewer-") || gate.id.startsWith("review-finding:"));
  const artifact: ReviewConvergenceArtifact = {
    schemaVersion: 1,
    suiteId: REVIEW_CONVERGENCE_MANIFEST.id,
    suiteDigest: REVIEW_CONVERGENCE_MANIFEST.suiteDigest,
    modelPolicyDigest: REVIEW_CONVERGENCE_MANIFEST.modelPolicyDigest,
    activeManifest: REVIEW_CONVERGENCE_MANIFEST,
    profile: "quick",
    benchmarkStartedAt: result.measurementStartedAt,
    benchmarkFinishedAt: result.measurementFinishedAt,
    launchTrace: result.launchTrace,
    scenario: {
      id: result.id,
      terminalMarker: result.terminalMarker,
      terminalReached: result.terminalReached,
      parentCompletedAutonomously: result.completionFollowUpBeforeTerminal || result.evidence?.autonomousCompletion === true,
      runnerInjectedContinuationPrompts: Math.max(0, result.initialPromptCount - 1),
      expectedRoles: REVIEW_CONVERGENCE_REQUIREMENTS.expectedRoles.map((role) => role.title),
      observedRoles: result.evidence?.observedRoles.map((role) => role.title) ?? [],
      reviewConvergencePassed: workflowGates.length === 8 && workflowGates.every((gate) => gate.passed),
      fixtureVerification: {
        passed: verification?.exitCode === 0,
        exitCode: verification?.exitCode ?? null,
        stdout: verification?.stdout ?? "",
        stderr: verification?.stderr ?? "",
        outputDropped: (verification?.stdoutDropped ?? 0) + (verification?.stderrDropped ?? 0),
      },
      scope: {
        passed: scope?.passed === true,
        changedPaths: scope?.changedPaths ?? [],
        unexpectedPaths: scope?.unexpectedPaths ?? [],
      },
    },
    children: Array.from({ length: result.evidence?.completedChildReports ?? 0 }, () => ({
      ...REVIEW_CONVERGENCE_MANIFEST.child,
      policyVerified: result.evidence?.modelPolicyPassed === true,
    })),
    cleanup: result.cleanup,
    noLeakedProcesses: result.cleanup.parentStopped && result.cleanup.liveProcessPids.length === 0,
    noLeakedWorktrees: result.cleanup.fixtureRemoved,
    qualityGates: sample.qualityGates,
    diagnostics: allDiagnostics,
    diagnosticsDropped,
    kpis: { wall_time_ms: sample.wallTimeMs, total_tokens: sample.totalTokens, tool_failures: sample.toolFailures },
    sample,
  };
  rmSync(sampleDirectory, { recursive: true, force: true });
  return artifact;
}
