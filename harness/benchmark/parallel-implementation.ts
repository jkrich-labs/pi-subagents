/** Real S-04 isolated parallel-writer scenario on the common runner port. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { accountPersistedSessions, type PersistedSession } from "./accounting.ts";
import { createBenchmarkSample, type BenchmarkDiagnostic, type BenchmarkSample, type QualityGateResult } from "./contracts.ts";
import { createParallelImplementationFixtureLifecycle, PARALLEL_IMPLEMENTATION_ALLOWED_PATHS } from "./fixtures.ts";
import { assertBenchmarkSuiteIntegrity, PARALLEL_IMPLEMENTATION_MANIFEST } from "./profile.ts";
import {
  RealRunnerPort,
  childDoneAt,
  childHasDoneReport,
  childHasFailure,
  childSessionsOverlap,
  integrationAfterReports,
  parentTerminalAt,
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

export const PARALLEL_IMPLEMENTATION_SCENARIO_ID = "parallel-implementation";
export const PARALLEL_IMPLEMENTATION_TERMINAL_MARKER = "BENCHMARK_PARALLEL_IMPLEMENTATION_DONE";
const SCENARIO_TIMEOUT_MS = 5 * 60_000;

export const PARALLEL_IMPLEMENTATION_REQUIREMENTS = {
  id: PARALLEL_IMPLEMENTATION_SCENARIO_ID,
  terminalMarker: PARALLEL_IMPLEMENTATION_TERMINAL_MARKER,
  minimumChildren: 2,
  expectedRoles: [
    { title: "endpoint-port-implementer", agent: "mechanical-worker" },
    { title: "canonical-tags-implementer", agent: "mechanical-worker" },
  ],
  writers: [
    { title: "endpoint-port-implementer", agent: "mechanical-worker", worktree: "endpoint-port", path: "src/endpoint-port.mjs" },
    { title: "canonical-tags-implementer", agent: "mechanical-worker", worktree: "canonical-tags", path: "src/canonical-tags.mjs" },
  ],
} as const;

interface ChildSession {
  session: PersistedSession;
  cwd?: string;
}

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
  if (!left || !right) return false;
  return resolve(left) === resolve(right);
}

export interface ParallelWriterObservation {
  title: string;
  agent: string;
  cwd?: string;
  childCwd?: string;
}

/** Pure S-04 gate builder: a spawn request alone is insufficient; the child session cwd must agree too. */
export function parallelWriterWorkflowGates(input: {
  observations: readonly ParallelWriterObservation[];
  worktrees: readonly FixtureWorktree[];
  worktreeResults: readonly FixtureWorktreeResult[];
  integrationContents?: Readonly<Record<string, string>>;
}): QualityGateResult[] {
  return PARALLEL_IMPLEMENTATION_REQUIREMENTS.writers.flatMap((writer) => {
    const worktree = input.worktrees.find((candidate) => candidate.id === writer.worktree);
    const observation = input.observations.find((candidate) => candidate.title === writer.title && candidate.agent === writer.agent);
    const worktreeResult = input.worktreeResults.find((candidate) => candidate.id === writer.worktree);
    return [
      {
        id: `isolated-writer-cwd:${writer.title}`,
        passed: worktree !== undefined && observation !== undefined &&
          samePath(observation.cwd, worktree.root) && samePath(observation.childCwd, worktree.root),
      },
      {
        id: `isolated-writer-edit:${writer.worktree}`,
        passed: worktreeResult?.passed === true && worktreeResult.changedPaths.includes(writer.path),
      },
      {
        id: `integrated-writer-edit:${writer.worktree}`,
        passed: worktreeResult?.contents?.[writer.path] !== undefined &&
          input.integrationContents?.[writer.path] === worktreeResult.contents[writer.path],
      },
    ];
  });
}

function scenarioContract(port: RealRunnerPort): ScenarioContract {
  return {
    id: PARALLEL_IMPLEMENTATION_SCENARIO_ID,
    terminalMarker: PARALLEL_IMPLEMENTATION_TERMINAL_MARKER,
    initialBrief: (fixtureRoot, worktrees) => brief(fixtureRoot, worktrees ?? []),
    fixture: createParallelImplementationFixtureLifecycle(),
    parentPolicy: PARALLEL_IMPLEMENTATION_MANIFEST.parent,
    childPolicy: PARALLEL_IMPLEMENTATION_MANIFEST.child,
    deadlineMs: SCENARIO_TIMEOUT_MS,
    minimumChildren: PARALLEL_IMPLEMENTATION_REQUIREMENTS.minimumChildren,
    expectedRoles: PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles,
    async collectEvidence(input): Promise<ScenarioEvidence> {
      const sessions = port.sessionRecords();
      const parent = sessions.find((session) => session.participant === "parent");
      const children = sessions.filter((session) => session.participant === "child");
      const spawns = parent ? spawnRecordsFromParentSession(parent.jsonl) : [];
      const childById = new Map(children.map((session) => [sessionChildId(session.jsonl), {
        session,
        cwd: sessionCwd(session.jsonl),
      } satisfies ChildSession] as const));
      const required = PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles.map((role) => {
        const spawn = spawns.find((candidate) => candidate.title === role.title && candidate.agent === role.agent);
        return { role, spawn, child: spawn ? childById.get(spawn.childId) : undefined };
      });
      const requiredChildren = required.map((item) => item.child?.session).filter((session): session is PersistedSession => session !== undefined);
      const terminalAt = parent ? parentTerminalAt(parent.jsonl, PARALLEL_IMPLEMENTATION_TERMINAL_MARKER) : undefined;
      const childReportsBeforeTerminal = requiredChildren.length === PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles.length &&
        requiredChildren.every((session) => {
          const doneAt = childDoneAt(session.jsonl);
          return doneAt !== undefined && terminalAt !== undefined && doneAt <= terminalAt;
        });
      let modelPolicyPassed = false;
      try {
        const accounting = accountPersistedSessions(PARALLEL_IMPLEMENTATION_MANIFEST, sessions);
        modelPolicyPassed = accounting.diagnostics.length === 0 && accounting.diagnosticsDropped === 0;
      } catch {
        modelPolicyPassed = false;
      }
      const worktreeResults = await input.fixture.inspectWorktrees?.(input.signal) ?? [];
      const observations: ParallelWriterObservation[] = required.flatMap(({ role, spawn, child }) =>
        spawn ? [{ title: role.title, agent: role.agent, cwd: spawn.cwd, childCwd: child?.cwd }] : []);
      return {
        observedRoles: required
          .filter((item) => item.spawn !== undefined && item.child !== undefined)
          .map(({ role }) => ({ title: role.title, agent: role.agent })),
        childFailure: port.hasChildFailure() || children.some((session) => childHasFailure(session.jsonl)),
        modelPolicyPassed,
        requiredChildCount: requiredChildren.length,
        distinctRequiredChildren: new Set(required.map((item) => item.spawn?.childId).filter((id): id is string => id !== undefined)).size === PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles.length,
        completedChildReports: requiredChildren.filter((session) => childHasDoneReport(session.jsonl)).length,
        childReportsBeforeTerminal,
        integrationAfterReports: parent ? integrationAfterReports(
          parent.jsonl,
          required.map((item) => item.spawn?.childId).filter((id): id is string => id !== undefined),
          PARALLEL_IMPLEMENTATION_TERMINAL_MARKER,
          PARALLEL_IMPLEMENTATION_ALLOWED_PATHS,
        ) : false,
        requiredOverlap: childSessionsOverlap(requiredChildren),
        autonomousCompletion: parent ? persistedAutonomousCompletion(parent.jsonl, PARALLEL_IMPLEMENTATION_TERMINAL_MARKER) : false,
        workflowGates: parallelWriterWorkflowGates({
          observations,
          worktrees: input.fixture.worktrees ?? [],
          worktreeResults,
          integrationContents: Object.fromEntries(PARALLEL_IMPLEMENTATION_REQUIREMENTS.writers.map((writer) => [
            writer.path,
            readFileSync(join(input.fixture.root, writer.path), "utf8").slice(0, 1_200),
          ])),
        }),
      };
    },
  };
}

function brief(fixtureRoot: string, worktrees: readonly FixtureWorktree[]): string {
  const endpointWorktree = worktrees.find((worktree) => worktree.id === "endpoint-port")?.root ?? "";
  const tagsWorktree = worktrees.find((worktree) => worktree.id === "canonical-tags")?.root ?? "";
  return [
    "Complete the isolated parallel implementation benchmark autonomously.",
    `Your integration checkout is ${fixtureRoot}.`,
    "Before editing the integration checkout, issue TWO spawn_subagent calls in the same turn. Both use agent mechanical-worker and the exact titles endpoint-port-implementer and canonical-tags-implementer.",
    `Launch endpoint-port-implementer with cwd ${endpointWorktree}. Its sole assignment is to implement src/endpoint-port.mjs: return explicit HTTP(S) ports, default HTTP/HTTPS ports, and zero for invalid or unsupported endpoints. It must change only that file, commit its worktree change, give a concise report, and end DONE-PARENT.`,
    `Launch canonical-tags-implementer with cwd ${tagsWorktree}. Its sole assignment is to implement src/canonical-tags.mjs: normalize an array of string tags by trim/lowercase, omit empty/non-string values, and keep first occurrences. It must change only that file, commit its worktree change, give a concise report, and end DONE-PARENT.`,
    "Do not edit the integration checkout while the writers work. Do not use sleep, process inspection, raw nested pi, or shell-created agents. Wait for both automatic model-visible completion reports.",
    "After both reports, integrate both isolated worktree changes into the integration checkout (for example by cherry-picking their commits). Only src/endpoint-port.mjs and src/canonical-tags.mjs may change there.",
    "Run node verifier.mjs from the integration checkout. Only after it passes and both reports have arrived, reply with this exact standalone terminal marker:",
    PARALLEL_IMPLEMENTATION_TERMINAL_MARKER,
  ].join("\n");
}

interface ParallelImplementationArtifact {
  schemaVersion: 1;
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  activeManifest: typeof PARALLEL_IMPLEMENTATION_MANIFEST;
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
    isolatedWriterWorktreesPassed: boolean;
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
    const accounting = accountPersistedSessions(PARALLEL_IMPLEMENTATION_MANIFEST, port.sessionRecords());
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

export async function runParallelImplementation(): Promise<ParallelImplementationArtifact> {
  assertBenchmarkSuiteIntegrity(PARALLEL_IMPLEMENTATION_MANIFEST);
  const sampleDirectory = mkdtempSync(join(tmpdir(), `pi-subagents-${PARALLEL_IMPLEMENTATION_SCENARIO_ID}-`));
  const port = new RealRunnerPort(sampleDirectory, PARALLEL_IMPLEMENTATION_MANIFEST);
  const result = await runScenario(scenarioContract(port), port);
  const { accounting, diagnostics: accountingDiagnostics } = accountingFor(port);
  const sample = createBenchmarkSample({
    manifest: PARALLEL_IMPLEMENTATION_MANIFEST,
    wallTimeMs: result.wallTimeMs,
    accounting,
    launchTrace: result.launchTrace,
    scenarios: [{
      id: PARALLEL_IMPLEMENTATION_SCENARIO_ID,
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
  const writerGates = result.qualityGates.filter((gate) => gate.id.startsWith("isolated-writer-") || gate.id.startsWith("integrated-writer-"));
  const artifact: ParallelImplementationArtifact = {
    schemaVersion: 1,
    suiteId: PARALLEL_IMPLEMENTATION_MANIFEST.id,
    suiteDigest: PARALLEL_IMPLEMENTATION_MANIFEST.suiteDigest,
    modelPolicyDigest: PARALLEL_IMPLEMENTATION_MANIFEST.modelPolicyDigest,
    activeManifest: PARALLEL_IMPLEMENTATION_MANIFEST,
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
      expectedRoles: PARALLEL_IMPLEMENTATION_REQUIREMENTS.expectedRoles.map((role) => role.title),
      observedRoles: result.evidence?.observedRoles.map((role) => role.title) ?? [],
      isolatedWriterWorktreesPassed: writerGates.length === 6 && writerGates.every((gate) => gate.passed),
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
      ...PARALLEL_IMPLEMENTATION_MANIFEST.child,
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
