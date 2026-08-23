/** Authenticated benchmark CLI: standalone diagnostic scenarios plus bundled profiles. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { accountPersistedSessions, type PersistedSession } from "./accounting.ts";
import {
  createBenchmarkSample,
  type BenchmarkDiagnostic,
  type BenchmarkSample,
  type QualityGateResult,
  type UsageBreakdown,
} from "./contracts.ts";
import {
  executeBenchmarkProfile,
  renderBenchmarkOutput,
  writeBenchmarkOutputAtomically,
  writeJsonAtomically,
  type BenchmarkOutputFormat,
  type BenchmarkProfile,
} from "./output.ts";
import {
  AUTONOMOUS_SMOKE_MANIFEST,
  BUNDLED_COMPARISON_MANIFEST,
} from "./profile.ts";
import {
  parentCompletionFollowUps,
  runParallelDiagnosis,
  sessionChildId,
  spawnRecordsFromParentSession,
} from "./parallel-diagnosis.ts";
import { runParallelImplementation } from "./parallel-implementation.ts";
import { runReviewConvergence } from "./review-convergence.ts";
import { RpcChild } from "../rpc-child.ts";
import { BENCHMARK_CHILD_POLICY_ENV } from "../../extensions/subagents/benchmark-policy.ts";

const TERMINAL_MARKER = "BENCHMARK_AUTONOMOUS_SMOKE_DONE";
const SMOKE_SCENARIO_ID = "autonomous-smoke";
const PARALLEL_DIAGNOSIS_SCENARIO = "parallel-diagnosis";
const PARALLEL_IMPLEMENTATION_SCENARIO = "parallel-implementation";
const REVIEW_CONVERGENCE_SCENARIO = "review-convergence";
const SMOKE_TIMEOUT_MS = 5 * 60_000;
const MAX_SUITE_DIAGNOSTICS = 20;

type DiagnosticScenario =
  | typeof SMOKE_SCENARIO_ID
  | typeof PARALLEL_DIAGNOSIS_SCENARIO
  | typeof PARALLEL_IMPLEMENTATION_SCENARIO
  | typeof REVIEW_CONVERGENCE_SCENARIO;

interface CliArguments {
  scenario?: DiagnosticScenario;
  profile: BenchmarkProfile;
  format: BenchmarkOutputFormat;
  output: string;
}

interface SmokeArtifact {
  schemaVersion: 1;
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  profile: "quick";
  scenario: {
    id: string;
    terminalMarker: string;
    terminalReached: boolean;
    completionFollowUpBeforeTerminal: boolean;
    childReportDelivered: boolean;
    runnerInjectedContinuationPrompts: number;
    spawnSubagentCalls: number;
  };
  parent: {
    provider: string;
    model: string;
    thinking: string;
    policyVerified: boolean;
  };
  children: Array<{
    provider: string;
    model: string;
    thinking: string;
    policyVerified: boolean;
  }>;
  qualityGates: readonly QualityGateResult[];
  kpis: {
    wall_time_ms: number;
    total_tokens: number;
    tool_failures: number;
  };
  noLeakedProcesses: boolean;
  liveProcessPids: readonly number[];
  sample: BenchmarkSample;
}

function usage(): void {
  console.log([
    "Usage: npm run benchmark:subagents -- --profile <quick|confirm> --format <json|autoresearch> --output <artifact.json>",
    "",
    "The default command runs the bundled three-scenario suite: parallel diagnosis, isolated parallel implementation, and review convergence.",
    "Profiles: quick runs one independently reset suite sample and targets about five minutes; confirm runs three independently reset samples and reports median plus MAD.",
    "This is authenticated provider work and may incur cost. --output is required and receives an atomically written complete JSON artifact.",
    "KPIs are independent lower-is-better raw values: wall_time_ms is measured suite runtime, total_tokens sums persisted pi usage.totalTokens, and tool_failures counts persisted toolResult isError records. No composite score exists.",
    "Hard gates require all three fixtures and verifiers, expected roles and overlap, model-visible autonomous completion, the manifest policy/digest, clean scope, and process/worktree cleanup.",
    "--format autoresearch prints exactly the three finite raw METRIC lines only when every hard gate passes; it is suitable for pi-autoresearch. Protect harness/benchmark, its fixtures, tests/benchmark-*.test.ts, and the verifier/scoring paths with pi-autoresearch protectedPaths.",
    "Diagnostic commands remain available with --scenario <autonomous-smoke|parallel-diagnosis|parallel-implementation|review-convergence> --profile quick --format json --output <artifact.json>.",
  ].join("\n"));
}

function isProfile(value: string): value is BenchmarkProfile {
  return value === "quick" || value === "confirm";
}

function isFormat(value: string): value is BenchmarkOutputFormat {
  return value === "json" || value === "autoresearch";
}

function isDiagnosticScenario(value: string): value is DiagnosticScenario {
  return value === SMOKE_SCENARIO_ID || value === PARALLEL_DIAGNOSIS_SCENARIO ||
    value === PARALLEL_IMPLEMENTATION_SCENARIO || value === REVIEW_CONVERGENCE_SCENARIO;
}

function parseArguments(argv: readonly string[]): CliArguments | undefined {
  let scenario: string | undefined;
  let profile = "quick";
  let format = "json";
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return undefined;
    if (arg === "--scenario" || arg === "--profile" || arg === "--format" || arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--scenario") scenario = value;
      else if (arg === "--profile") profile = value;
      else if (arg === "--format") format = value;
      else output = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!isProfile(profile)) throw new Error("--profile must be quick or confirm");
  if (!isFormat(format)) throw new Error("--format must be json or autoresearch");
  if (scenario !== undefined && !isDiagnosticScenario(scenario)) {
    throw new Error(`supported scenarios: ${SMOKE_SCENARIO_ID}, ${PARALLEL_DIAGNOSIS_SCENARIO}, ${PARALLEL_IMPLEMENTATION_SCENARIO}, ${REVIEW_CONVERGENCE_SCENARIO}`);
  }
  if (scenario !== undefined && profile !== "quick") {
    throw new Error("--scenario diagnostic commands support only --profile quick; omit --scenario for the three-scenario confirm suite");
  }
  if (scenario !== undefined && format !== "json") {
    throw new Error("--format autoresearch requires the complete bundled suite; omit --scenario");
  }
  if (!output) throw new Error("--output is required");
  return { scenario: scenario as DiagnosticScenario | undefined, profile, format, output: resolve(output) };
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

function lineHasTerminalMarker(line: Record<string, unknown>): boolean {
  if (line.type === "turn_end") return assistantText(line.message).includes(TERMINAL_MARKER);
  if (line.type !== "agent_end" || !Array.isArray(line.messages)) return false;
  return line.messages.some((message) => assistantText(message).includes(TERMINAL_MARKER));
}

function lineHasCompletionFollowUp(line: Record<string, unknown>): boolean {
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

function childHasDoneParent(jsonl: string): boolean {
  for (const rawLine of jsonl.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(rawLine) as { message?: { role?: unknown; content?: unknown } };
      const message = entry.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (/\bDONE-PARENT\b/.test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** RPC may compact parent follow-up events; persisted session order is authoritative. */
function persistedCompletionFollowUpBeforeTerminal(jsonl: string): boolean {
  let completionIndex = -1;
  let terminalIndex = -1;
  let index = 0;
  for (const rawLine of jsonl.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(rawLine) as { message?: unknown };
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (message.role === "user" && text.includes("] COMPLETED:") && completionIndex < 0) completionIndex = index;
      if (message.role === "assistant" && text.includes(TERMINAL_MARKER) && terminalIndex < 0) terminalIndex = index;
      index += 1;
    } catch {
      // Accounting owns malformed stream diagnostics.
    }
  }
  return completionIndex >= 0 && terminalIndex >= 0 && completionIndex < terminalIndex;
}

function jsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
  }
  return paths.sort();
}

function childPids(directory: string): number[] {
  if (!existsSync(directory)) return [];
  const pids = new Set<number>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".pid")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) pids.add(parsed.pid);
    } catch {
      // A partially written liveness record cannot establish process ownership.
    }
  }
  return [...pids].sort((left, right) => left - right);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function countToolCalls(sessionJsonl: string, toolName: string): number {
  let total = 0;
  for (const rawLine of sessionJsonl.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const entry = JSON.parse(rawLine) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      total += entry.message.content.filter((part) =>
        typeof part === "object" && part !== null &&
        (part as { type?: unknown }).type === "toolCall" &&
        (part as { name?: unknown }).name === toolName,
      ).length;
    } catch {
      // Accounting owns malformed-session diagnostics; this gate only counts calls.
    }
  }
  return total;
}

function smokeBrief(): string {
  return [
    "Run the autonomous completion smoke exactly as specified.",
    "First, call spawn_subagent exactly once with agent explorer and a self-contained request to reply with a short report ending in DONE-PARENT.",
    "After that tool succeeds, end your current turn. Do not poll, sleep, inspect processes, launch pi through shell, or spawn/retry another child.",
    `When the child completion arrives as the automatic follow-up, reply with the exact standalone terminal marker: ${TERMINAL_MARKER}`,
    "Do not emit that terminal marker before the child completion follow-up.",
  ].join("\n");
}

async function runSmoke(): Promise<SmokeArtifact> {
  const startedAt = performance.now();
  const sampleDirectory = mkdtempSync(join(tmpdir(), `pi-subagents-${SMOKE_SCENARIO_ID}-`));
  const parentSessions = join(sampleDirectory, "parent-sessions");
  const subagentGround = join(sampleDirectory, "subagents");
  mkdirSync(parentSessions, { recursive: true });
  mkdirSync(subagentGround, { recursive: true });

  const extensionPath = resolve(import.meta.dirname, "../../extensions/subagents/index.ts");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SUBAGENT_GROUND: subagentGround,
    [BENCHMARK_CHILD_POLICY_ENV]: JSON.stringify(AUTONOMOUS_SMOKE_MANIFEST.child),
  };
  try {
    let parent: RpcChild | undefined;
    let parentSessionFile = "";
  let capturedChildPids: number[] = [];
  let terminalReached = false;
  let acceptedInitialPrompt = false;
  try {
    parent = await RpcChild.spawnAndWaitReady({
      sessionDir: parentSessions,
      name: "benchmark-autonomous-smoke-parent",
      provider: AUTONOMOUS_SMOKE_MANIFEST.parent.provider,
      model: AUTONOMOUS_SMOKE_MANIFEST.parent.model,
      thinking: AUTONOMOUS_SMOKE_MANIFEST.parent.thinking,
      tools: "normal",
      cwd: process.cwd(),
      env: environment,
      extraArgs: ["-e", extensionPath],
      detached: true,
    });
    const state = await parent.send("get_state", {});
    parentSessionFile = (state.data as { sessionFile?: unknown } | undefined)?.sessionFile as string;
    if (!parentSessionFile) throw new Error("parent did not expose a persisted session file");

    const accepted = await parent.send("prompt", { message: smokeBrief() }, 15_000);
    if (!accepted.success) throw new Error("parent rejected the initial smoke prompt");
    acceptedInitialPrompt = true;
    await parent.waitFor(lineHasTerminalMarker, "autonomous terminal marker", SMOKE_TIMEOUT_MS);
    terminalReached = true;
    capturedChildPids = childPids(join(subagentGround, "pids"));
  } finally {
    const pid = parent?.proc.pid;
    if (pid && pid > 1) {
      try { process.kill(-pid, "SIGTERM"); } catch { /* group already exited */ }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
      try { process.kill(-pid, "SIGKILL"); } catch { /* group already exited */ }
    }
    await parent?.shutdown(15_000);
  }

  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  const parentPid = parent?.proc.pid;
  const ownedPids = [...new Set([parentPid, ...capturedChildPids].filter((pid): pid is number => typeof pid === "number" && pid > 0))];
  const liveProcessPids = ownedPids.filter(processIsAlive);
  const childSessionFiles = jsonlFiles(join(subagentGround, "sessions"));
  if (!parentSessionFile || !existsSync(parentSessionFile)) throw new Error("parent persisted session file is missing after completion");

  const parentJsonl = readFileSync(parentSessionFile, "utf8");
  const terminalLineIndex = parent?.lines.findIndex(lineHasTerminalMarker) ?? -1;
  const completionFollowUpLineIndex = parent?.lines.findIndex(lineHasCompletionFollowUp) ?? -1;
  const completionFollowUpBeforeTerminal = completionFollowUpLineIndex >= 0 &&
    terminalLineIndex >= 0 && completionFollowUpLineIndex < terminalLineIndex ||
    persistedCompletionFollowUpBeforeTerminal(parentJsonl);
  const childSessionRecords = childSessionFiles.map((path) => ({
    path,
    canonicalPath: realpathSync(path),
    participant: "child" as const,
    jsonl: readFileSync(path, "utf8"),
  }));
  const spawnRecords = spawnRecordsFromParentSession(parentJsonl);
  const spawnedChildId = spawnRecords.length === 1 ? spawnRecords[0].childId : undefined;
  const childReportDelivered = spawnedChildId !== undefined && childSessionRecords.some((session) =>
    sessionChildId(session.jsonl) === spawnedChildId && childHasDoneParent(session.jsonl));
  const parentReceivedSpawnedChildReport = spawnedChildId !== undefined && parentCompletionFollowUps(parentJsonl)
    .some((followUp) => followUp.childId === spawnedChildId);
  const sessions: PersistedSession[] = [{
    path: parentSessionFile,
    canonicalPath: realpathSync(parentSessionFile),
    participant: "parent",
    jsonl: parentJsonl,
  }, ...childSessionRecords];
  const accounting = accountPersistedSessions(AUTONOMOUS_SMOKE_MANIFEST, sessions);
  const spawnSubagentCalls = countToolCalls(parentJsonl, "spawn_subagent");
  const policyVerified = accounting.diagnostics.length === 0 && accounting.diagnosticsDropped === 0;
  const qualityGates: QualityGateResult[] = [
    { id: "initial-prompt-accepted", passed: acceptedInitialPrompt },
    { id: "autonomous-terminal-marker", passed: terminalReached },
    { id: "child-completion-report", passed: childReportDelivered },
    { id: "required-child-report-delivered", passed: parentReceivedSpawnedChildReport },
    { id: "model-visible-completion-before-terminal", passed: completionFollowUpBeforeTerminal && parentReceivedSpawnedChildReport },
    { id: "no-runner-continuation", passed: true, detail: "one initial parent prompt only" },
    { id: "one-parent-session", passed: true },
    { id: "child-session", passed: childSessionFiles.length >= 1 },
    { id: "single-delegation", passed: spawnSubagentCalls === 1 },
    { id: "suite-model-policy", passed: policyVerified },
    { id: "no-leaked-processes", passed: liveProcessPids.length === 0 },
  ];
  const wallTimeMs = performance.now() - startedAt;
  const sample = createBenchmarkSample({
    manifest: AUTONOMOUS_SMOKE_MANIFEST,
    wallTimeMs,
    accounting,
    launchTrace: [
      {
        scenarioId: SMOKE_SCENARIO_ID,
        participant: "parent",
        id: "parent",
        pid: parentPid ?? -1,
        startedAt,
        ...AUTONOMOUS_SMOKE_MANIFEST.parent,
      },
      ...(spawnedChildId ? [{
        scenarioId: SMOKE_SCENARIO_ID,
        participant: "child" as const,
        id: spawnedChildId,
        pid: capturedChildPids[0] ?? -1,
        startedAt,
        ...AUTONOMOUS_SMOKE_MANIFEST.child,
      }] : []),
    ],
    scenarios: [{
      id: SMOKE_SCENARIO_ID,
      wallTimeMs,
      usage: accounting.usage,
      toolFailures: accounting.toolFailures,
      qualityGates,
    }],
    qualityGates,
  });
  const artifact: SmokeArtifact = {
    schemaVersion: 1,
    suiteId: AUTONOMOUS_SMOKE_MANIFEST.id,
    suiteDigest: AUTONOMOUS_SMOKE_MANIFEST.suiteDigest,
    modelPolicyDigest: AUTONOMOUS_SMOKE_MANIFEST.modelPolicyDigest,
    profile: "quick",
    scenario: {
      id: SMOKE_SCENARIO_ID,
      terminalMarker: TERMINAL_MARKER,
      terminalReached,
      completionFollowUpBeforeTerminal,
      childReportDelivered,
      runnerInjectedContinuationPrompts: 0,
      spawnSubagentCalls,
    },
    parent: { ...AUTONOMOUS_SMOKE_MANIFEST.parent, policyVerified },
    children: childSessionFiles.map(() => ({ ...AUTONOMOUS_SMOKE_MANIFEST.child, policyVerified })),
    qualityGates: sample.qualityGates,
    kpis: {
      wall_time_ms: sample.wallTimeMs,
      total_tokens: sample.totalTokens,
      tool_failures: sample.toolFailures,
    },
    noLeakedProcesses: liveProcessPids.length === 0,
    liveProcessPids,
    sample,
  };
    return artifact;
  } finally {
    rmSync(sampleDirectory, { recursive: true, force: true });
  }
}

interface ScenarioArtifactForSuite {
  sample: BenchmarkSample;
  launchTrace: readonly import("./contracts.ts").BenchmarkLaunchTrace[];
  benchmarkStartedAt: number;
  benchmarkFinishedAt: number;
}

function addUsage(left: UsageBreakdown, right: UsageBreakdown): UsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    parentTokens: left.parentTokens + right.parentTokens,
    childTokens: left.childTokens + right.childTokens,
  };
}

const EMPTY_USAGE: UsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  parentTokens: 0,
  childTokens: 0,
};

/** Combine the three independently reset scenario samples into one suite sample. */
export async function runBundledSuiteSample(): Promise<BenchmarkSample> {
  // Keep this explicit sequence: every scenario function prepares its own clean
  // fixture/worktrees and owns only its initial parent prompt.
  const scenarios: readonly ScenarioArtifactForSuite[] = [
    await runParallelDiagnosis(),
    await runParallelImplementation(),
    await runReviewConvergence(),
  ];
  const usage = scenarios.reduce((total, artifact) => addUsage(total, artifact.sample.usage), EMPTY_USAGE);
  const toolFailures = scenarios.reduce((total, artifact) => total + artifact.sample.toolFailures, 0);
  const allDiagnostics = scenarios.flatMap((artifact) => artifact.sample.diagnostics);
  const diagnostics: BenchmarkDiagnostic[] = allDiagnostics.slice(0, MAX_SUITE_DIAGNOSTICS);
  const diagnosticsDropped = scenarios.reduce((total, artifact) => total + artifact.sample.diagnosticsDropped, 0) +
    Math.max(0, allDiagnostics.length - diagnostics.length);
  const scenarioInputs = scenarios.flatMap((artifact) => artifact.sample.scenarios).map((scenario) => ({
    id: scenario.id,
    wallTimeMs: scenario.wallTimeMs,
    usage: scenario.usage,
    toolFailures: scenario.toolFailures,
    qualityGates: scenario.qualityGates,
  }));
  const suiteGates = scenarios.flatMap((artifact) => artifact.sample.qualityGates.map((gate) => ({
    ...gate,
    id: `${artifact.sample.scenarios[0]?.id ?? "scenario"}:${gate.id}`,
  })));
  return createBenchmarkSample({
    manifest: BUNDLED_COMPARISON_MANIFEST,
    wallTimeMs: Math.max(...scenarios.map((artifact) => artifact.benchmarkFinishedAt)) -
      Math.min(...scenarios.map((artifact) => artifact.benchmarkStartedAt)),
    accounting: { usage, toolFailures, diagnostics, diagnosticsDropped },
    launchTrace: scenarios.flatMap((artifact) => artifact.launchTrace),
    scenarios: scenarioInputs,
    qualityGates: suiteGates,
  });
}

function diagnosticArtifactFailed(artifact: { qualityGates: readonly QualityGateResult[] }): boolean {
  return artifact.qualityGates.some((gate) => !gate.passed);
}

async function runDiagnosticScenario(scenario: DiagnosticScenario): Promise<SmokeArtifact | Awaited<ReturnType<typeof runParallelDiagnosis>> | Awaited<ReturnType<typeof runParallelImplementation>> | Awaited<ReturnType<typeof runReviewConvergence>>> {
  if (scenario === SMOKE_SCENARIO_ID) return runSmoke();
  if (scenario === PARALLEL_DIAGNOSIS_SCENARIO) return runParallelDiagnosis();
  if (scenario === PARALLEL_IMPLEMENTATION_SCENARIO) return runParallelImplementation();
  return runReviewConvergence();
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    usage();
    return;
  }
  if (args.scenario) {
    const artifact = await runDiagnosticScenario(args.scenario);
    writeJsonAtomically(args.output, artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    if (diagnosticArtifactFailed(artifact)) throw new Error("benchmark quality gate failed");
    return;
  }

  const output = await executeBenchmarkProfile({
    manifest: BUNDLED_COMPARISON_MANIFEST,
    profile: args.profile,
    runFreshSample: async () => runBundledSuiteSample(),
  });
  writeBenchmarkOutputAtomically(args.output, output);
  const rendered = renderBenchmarkOutput(output, args.format);
  if (rendered) process.stdout.write(rendered);
  if (!output.qualityPassed) throw new Error("benchmark quality gate failed");
}

void main().catch((error: unknown) => {
  // Provider/RPC errors can contain request details. Keep CLI diagnostics bounded.
  const message = error instanceof Error && /^(supported scenarios:|--output is required|unknown argument|--(?:scenario|profile|format|output) requires|--profile must|--format must|--scenario diagnostic|--format autoresearch)/.test(error.message)
    ? error.message
    : "authenticated benchmark failed";
  console.error(`benchmark: ${message}`);
  process.exitCode = 1;
});
