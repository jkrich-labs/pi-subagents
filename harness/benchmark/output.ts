/** Pure suite aggregation, bounded rendering, and atomic benchmark artifact output. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  BenchmarkValidationError,
  assertBenchmarkSuiteManifest,
  assertComparableSampleDigests,
  modelPolicyDigestFor,
  scenarioIdsForSuite,
  validateFiniteNonNegativeMetrics,
  type BenchmarkLaunchTrace,
  type BenchmarkSample,
  type BenchmarkSuiteManifest,
  type ModelPolicy,
} from "./contracts.ts";

export const BENCHMARK_OUTPUT_SCHEMA_VERSION = 1 as const;
export const QUICK_SUITE_TARGET_MS = 5 * 60_000;

export type BenchmarkProfile = "quick" | "confirm";
export type BenchmarkOutputFormat = "json" | "autoresearch";
export type RawKpiName = "wall_time_ms" | "total_tokens" | "tool_failures";

export const BENCHMARK_PROFILE_SAMPLE_COUNTS: Readonly<Record<BenchmarkProfile, number>> = {
  quick: 1,
  confirm: 3,
};

export interface MedianMadSummary {
  median: number;
  mad: number;
}

export interface BenchmarkAggregate {
  sampleCount: number;
  kpis: Readonly<Record<RawKpiName, MedianMadSummary>>;
  /** Actual elapsed KPI time over every executed sample, never a score. */
  totalMeasuredRuntimeMs: number;
  /** The quick suite's operating target, not a correctness deadline. */
  quickTargetMs: number;
  quickTargetMet: boolean;
}

export interface BenchmarkHardGateFailure {
  sampleIndex: number;
  scenarioId?: string;
  gateId: string;
  detail?: string;
}

/** Complete versioned machine-readable suite artifact. */
export interface BenchmarkOutput {
  schemaVersion: typeof BENCHMARK_OUTPUT_SCHEMA_VERSION;
  artifactType: "pi-subagents-benchmark";
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  activeManifest: BenchmarkSuiteManifest;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    authenticated: boolean;
  };
  gitRevision: string;
  launchTrace: readonly BenchmarkLaunchTrace[];
  modelPolicy: {
    parent: ModelPolicy;
    child: ModelPolicy;
  };
  profile: BenchmarkProfile;
  samples: readonly BenchmarkSample[];
  aggregate: BenchmarkAggregate;
  qualityPassed: boolean;
  hardGateFailures: readonly BenchmarkHardGateFailure[];
}

function assertProfile(value: string): asserts value is BenchmarkProfile {
  if (value !== "quick" && value !== "confirm") {
    throw new BenchmarkValidationError(`unsupported benchmark profile: ${value}`);
  }
}

function assertKpiValues(values: readonly number[], label: string): void {
  if (values.length === 0) throw new BenchmarkValidationError(`${label} requires at least one sample`);
  values.forEach((value, index) => {
    validateFiniteNonNegativeMetrics({ [`${label}.${index + 1}`]: value });
  });
}

/** Statistical median with the conventional mean of the two central values. */
export function median(values: readonly number[]): number {
  assertKpiValues(values, "median");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const result = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  validateFiniteNonNegativeMetrics({ median: result });
  return result;
}

/** Median absolute deviation around the median, with no hidden scaling factor. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const center = median(values);
  const result = median(values.map((value) => Math.abs(value - center)));
  validateFiniteNonNegativeMetrics({ mad: result });
  return result;
}

function metricValues(samples: readonly BenchmarkSample[], name: RawKpiName): number[] {
  return samples.map((sample) => name === "wall_time_ms"
    ? sample.wallTimeMs
    : name === "total_tokens"
      ? sample.totalTokens
      : sample.toolFailures);
}

/** Aggregate raw independent KPIs; no weighting, normalization, or composite score exists here. */
export function aggregateBenchmarkSamples(samples: readonly BenchmarkSample[]): BenchmarkAggregate {
  if (samples.length === 0) throw new BenchmarkValidationError("benchmark aggregation requires at least one sample");
  assertComparableSampleDigests(samples);
  const kpis = Object.fromEntries(([
    "wall_time_ms",
    "total_tokens",
    "tool_failures",
  ] as const).map((name) => {
    const values = metricValues(samples, name);
    return [name, { median: median(values), mad: medianAbsoluteDeviation(values) }];
  })) as Record<RawKpiName, MedianMadSummary>;
  const totalMeasuredRuntimeMs = samples.reduce((total, sample) => total + sample.wallTimeMs, 0);
  validateFiniteNonNegativeMetrics({
    total_measured_runtime_ms: totalMeasuredRuntimeMs,
    wall_time_ms_median: kpis.wall_time_ms.median,
    wall_time_ms_mad: kpis.wall_time_ms.mad,
    total_tokens_median: kpis.total_tokens.median,
    total_tokens_mad: kpis.total_tokens.mad,
    tool_failures_median: kpis.tool_failures.median,
    tool_failures_mad: kpis.tool_failures.mad,
  });
  return {
    sampleCount: samples.length,
    kpis,
    totalMeasuredRuntimeMs,
    quickTargetMs: QUICK_SUITE_TARGET_MS,
    quickTargetMet: samples.length === 1 && totalMeasuredRuntimeMs <= QUICK_SUITE_TARGET_MS,
  };
}

/** Inspect every sample-level and scenario-level hard gate before exposing KPIs. */
export function hardGateFailuresFor(samples: readonly BenchmarkSample[]): BenchmarkHardGateFailure[] {
  const failures: BenchmarkHardGateFailure[] = [];
  samples.forEach((sample, sampleIndex) => {
    sample.qualityGates.forEach((gate) => {
      if (!gate.passed) failures.push({ sampleIndex, gateId: gate.id, ...(gate.detail ? { detail: gate.detail } : {}) });
    });
    sample.scenarios.forEach((scenario) => {
      scenario.qualityGates.forEach((gate) => {
        if (!gate.passed) {
          failures.push({
            sampleIndex,
            scenarioId: scenario.id,
            gateId: gate.id,
            ...(gate.detail ? { detail: gate.detail } : {}),
          });
        }
      });
    });
  });
  return failures;
}

function assertSampleMetrics(sample: BenchmarkSample): void {
  validateFiniteNonNegativeMetrics({
    wall_time_ms: sample.wallTimeMs,
    total_tokens: sample.totalTokens,
    tool_failures: sample.toolFailures,
  });
  sample.scenarios.forEach((scenario) => validateFiniteNonNegativeMetrics({
    [`scenario.${scenario.id}.wall_time_ms`]: scenario.wallTimeMs,
    [`scenario.${scenario.id}.total_tokens`]: scenario.usage.totalTokens,
    [`scenario.${scenario.id}.tool_failures`]: scenario.toolFailures,
  }));
}

export interface CreateBenchmarkOutputInput {
  manifest: BenchmarkSuiteManifest;
  profile: BenchmarkProfile;
  samples: readonly BenchmarkSample[];
  environment?: BenchmarkOutput["environment"];
  gitRevision?: string;
  launchTrace?: readonly BenchmarkLaunchTrace[];
}

function launchTraceForManifest(manifest: BenchmarkSuiteManifest): BenchmarkLaunchTrace[] {
  const scenarios = Array.isArray(manifest.suiteDefinition.scenarios) ? manifest.suiteDefinition.scenarios : [];
  return scenarios.flatMap((scenario) => {
    const id = typeof scenario === "object" && scenario !== null ? (scenario as Record<string, unknown>).id : undefined;
    if (typeof id !== "string") return [];
    return [
      { scenarioId: id, participant: "parent" as const, id: `${id}:parent`, pid: -1, startedAt: 0, ...manifest.parent },
      { scenarioId: id, participant: "child" as const, id: `${id}:child`, pid: -1, startedAt: 0, ...manifest.child },
    ];
  });
}

function launchTraceMatchesManifest(trace: readonly BenchmarkLaunchTrace[], manifest: BenchmarkSuiteManifest): boolean {
  const scenarios = launchTraceForManifest(manifest);
  return trace.length > 0 && trace.every((entry) => {
    const expected = scenarios.find((candidate) => candidate.scenarioId === entry.scenarioId && candidate.participant === entry.participant);
    return expected !== undefined && entry.provider === expected.provider && entry.model === expected.model && entry.thinking === expected.thinking &&
      typeof entry.id === "string" && entry.id !== "" && Number.isInteger(entry.pid) && entry.pid > 0 && Number.isFinite(entry.startedAt) && entry.startedAt > 0;
  }) && scenarios.every((expected) => trace.some((entry) => entry.scenarioId === expected.scenarioId && entry.participant === expected.participant));
}

function launchTracesEqual(left: readonly BenchmarkLaunchTrace[], right: readonly BenchmarkLaunchTrace[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const expected = right[index];
    return expected !== undefined && entry.scenarioId === expected.scenarioId && entry.participant === expected.participant &&
      entry.provider === expected.provider && entry.model === expected.model && entry.thinking === expected.thinking;
  });
}

function currentGitRevision(): string {
  try {
    const headPath = resolve(".git/HEAD");
    if (!existsSync(headPath)) return "unknown";
    const head = readFileSync(headPath, "utf8").trim();
    if (!head.startsWith("ref: ")) return head || "unknown";
    const refPath = resolve(".git", head.slice("ref: ".length));
    return existsSync(refPath) ? readFileSync(refPath, "utf8").trim() || "unknown" : head;
  } catch {
    return "unknown";
  }
}

/** Build a profile artifact only after the configured number of fresh samples completed. */
export function createBenchmarkOutput(input: CreateBenchmarkOutputInput): BenchmarkOutput {
  assertBenchmarkSuiteManifest(input.manifest);
  assertProfile(input.profile);
  const expectedSamples = BENCHMARK_PROFILE_SAMPLE_COUNTS[input.profile];
  if (input.samples.length !== expectedSamples) {
    throw new BenchmarkValidationError(`${input.profile} profile requires exactly ${expectedSamples} sample(s)`);
  }
  if (input.samples.some((sample) =>
    sample.suiteId !== input.manifest.id ||
    sample.suiteDigest !== input.manifest.suiteDigest ||
    sample.modelPolicyDigest !== input.manifest.modelPolicyDigest,
  )) {
    throw new BenchmarkValidationError("sample does not match the active suite manifest");
  }
  input.samples.forEach(assertSampleMetrics);
  const aggregate = aggregateBenchmarkSamples(input.samples);
  const hardGateFailures = hardGateFailuresFor(input.samples);
  const scenarios = Array.isArray(input.manifest.suiteDefinition.scenarios)
    ? input.manifest.suiteDefinition.scenarios
      .map((scenario) => typeof scenario === "object" && scenario !== null && typeof (scenario as Record<string, unknown>).id === "string" ? (scenario as Record<string, unknown>).id as string : undefined)
      .filter((id): id is string => id !== undefined)
    : [];
  const observedTrace = input.samples.flatMap((sample) => sample.launchTrace);
  const launchTrace = input.launchTrace ?? observedTrace;
  if (launchTrace.length === 0 || !launchTraceMatchesManifest(launchTrace, input.manifest) ||
      launchTrace.some((entry) => entry.pid <= 0 || entry.startedAt <= 0)) {
    throw new BenchmarkValidationError("benchmark launch trace does not match the active manifest");
  }
  return {
    schemaVersion: BENCHMARK_OUTPUT_SCHEMA_VERSION,
    artifactType: "pi-subagents-benchmark",
    suiteId: input.manifest.id,
    suiteDigest: input.manifest.suiteDigest,
    modelPolicyDigest: input.manifest.modelPolicyDigest,
    activeManifest: {
      ...input.manifest,
      suiteDefinition: structuredClone(input.manifest.suiteDefinition),
      parent: { ...input.manifest.parent },
      child: { ...input.manifest.child },
    },
    environment: input.environment ?? {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      authenticated: true,
    },
    gitRevision: input.gitRevision ?? currentGitRevision(),
    launchTrace,
    modelPolicy: {
      parent: { ...input.manifest.parent },
      child: { ...input.manifest.child },
    },
    profile: input.profile,
    samples: input.samples.map((sample) => ({
      ...sample,
      usage: { ...sample.usage },
      scenarios: sample.scenarios.map((scenario) => ({
        ...scenario,
        usage: { ...scenario.usage },
        qualityGates: [...scenario.qualityGates],
      })),
      qualityGates: [...sample.qualityGates],
      diagnostics: [...sample.diagnostics],
    })),
    aggregate,
    qualityPassed: hardGateFailures.length === 0,
    hardGateFailures,
  };
}

/** Validate untrusted/deserialized output before rendering its numbers to an evaluator. */
export function assertBenchmarkOutput(output: BenchmarkOutput): void {
  if (output.schemaVersion !== BENCHMARK_OUTPUT_SCHEMA_VERSION || output.artifactType !== "pi-subagents-benchmark") {
    throw new BenchmarkValidationError("unsupported benchmark output schema version");
  }
  assertProfile(output.profile);
  if (output.samples.length !== BENCHMARK_PROFILE_SAMPLE_COUNTS[output.profile]) {
    throw new BenchmarkValidationError(`${output.profile} output has an invalid sample count`);
  }
  if (typeof output.suiteId !== "string" || output.suiteId.trim() === "" ||
      typeof output.suiteDigest !== "string" || output.suiteDigest.trim() === "" ||
      typeof output.modelPolicyDigest !== "string" || output.modelPolicyDigest.trim() === "" ||
      typeof output.gitRevision !== "string" || output.gitRevision.trim() === "" ||
      typeof output.environment?.nodeVersion !== "string" || typeof output.environment?.platform !== "string" ||
      typeof output.environment?.arch !== "string" || typeof output.environment?.authenticated !== "boolean" ||
      !Array.isArray(output.launchTrace) || output.launchTrace.length === 0) {
    throw new BenchmarkValidationError("benchmark output has invalid suite metadata");
  }
  assertBenchmarkSuiteManifest(output.activeManifest);
  if (output.activeManifest.id !== output.suiteId || output.activeManifest.suiteDigest !== output.suiteDigest ||
      output.activeManifest.modelPolicyDigest !== output.modelPolicyDigest ||
      modelPolicyDigestFor(output.activeManifest.parent, output.activeManifest.child) !== output.modelPolicyDigest) {
    throw new BenchmarkValidationError("benchmark output active manifest does not match its metadata");
  }
  if (modelPolicyDigestFor(output.modelPolicy.parent, output.modelPolicy.child) !== output.modelPolicyDigest) {
    throw new BenchmarkValidationError("benchmark output model policy digest does not match its policy");
  }
  const expectedScenarioIds = scenarioIdsForSuite(output.activeManifest.suiteDefinition);
  if (output.samples.some((sample) => {
    const actualIds = sample.scenarios.map((scenario) => scenario.id);
    return actualIds.length !== expectedScenarioIds.length || expectedScenarioIds.some((id) => !actualIds.includes(id));
  }) || output.launchTrace.some((entry) =>
    typeof entry.scenarioId !== "string" || (entry.participant !== "parent" && entry.participant !== "child") ||
    typeof entry.provider !== "string" || typeof entry.model !== "string" || typeof entry.thinking !== "string") ||
      !launchTraceMatchesManifest(output.launchTrace, output.activeManifest) ||
      (!output.samples.some((sample) => sample.launchTrace.length > 0) && !launchTracesEqual(output.launchTrace, launchTraceForManifest(output.activeManifest)))) {
    throw new BenchmarkValidationError("benchmark output launch trace is invalid or not manifest-bound");
  }
  if (output.samples.some((sample) =>
    sample.suiteId !== output.suiteId ||
    sample.suiteDigest !== output.suiteDigest ||
    sample.modelPolicyDigest !== output.modelPolicyDigest,
  )) {
    throw new BenchmarkValidationError("benchmark output samples do not match output metadata");
  }
  output.samples.forEach(assertSampleMetrics);
  const aggregate = aggregateBenchmarkSamples(output.samples);
  if (output.aggregate.sampleCount !== aggregate.sampleCount ||
      output.aggregate.totalMeasuredRuntimeMs !== aggregate.totalMeasuredRuntimeMs ||
      output.aggregate.quickTargetMs !== QUICK_SUITE_TARGET_MS ||
      output.aggregate.quickTargetMet !== aggregate.quickTargetMet) {
    throw new BenchmarkValidationError("benchmark output aggregate does not match its samples");
  }
  (Object.keys(aggregate.kpis) as RawKpiName[]).forEach((name) => {
    const actual = output.aggregate.kpis[name];
    const expected = aggregate.kpis[name];
    if (!actual || actual.median !== expected.median || actual.mad !== expected.mad) {
      throw new BenchmarkValidationError(`benchmark output ${name} aggregate does not match its samples`);
    }
  });
  const failures = hardGateFailuresFor(output.samples);
  if (output.qualityPassed !== (failures.length === 0) ||
      output.hardGateFailures.length !== failures.length) {
    throw new BenchmarkValidationError("benchmark output quality summary does not match hard gates");
  }
}

export interface BenchmarkProfileExecutionInput {
  manifest: BenchmarkSuiteManifest;
  profile: BenchmarkProfile;
  /** Must create a new fixture/session reset for each invocation. */
  runFreshSample(input: { profile: BenchmarkProfile; sampleIndex: number }): Promise<BenchmarkSample>;
}

/** Run quick once or confirmation three times; calls are deliberately sequential and fresh. */
export async function executeBenchmarkProfile(input: BenchmarkProfileExecutionInput): Promise<BenchmarkOutput> {
  assertBenchmarkSuiteManifest(input.manifest);
  assertProfile(input.profile);
  const samples: BenchmarkSample[] = [];
  const sampleCount = BENCHMARK_PROFILE_SAMPLE_COUNTS[input.profile];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    samples.push(await input.runFreshSample({ profile: input.profile, sampleIndex }));
  }
  return createBenchmarkOutput({ manifest: input.manifest, profile: input.profile, samples });
}

function metricText(value: number): string {
  validateFiniteNonNegativeMetrics({ metric: value });
  return String(value);
}

/**
 * Print raw lower-is-better KPIs only after every hard gate passes.  Returning
 * an empty string on failure ensures a controller cannot score a bad sample.
 */
export function renderAutoresearchMetrics(output: BenchmarkOutput): string {
  assertBenchmarkOutput(output);
  if (hardGateFailuresFor(output.samples).length > 0) return "";
  return [
    `METRIC wall_time_ms=${metricText(output.aggregate.kpis.wall_time_ms.median)}`,
    `METRIC total_tokens=${metricText(output.aggregate.kpis.total_tokens.median)}`,
    `METRIC tool_failures=${metricText(output.aggregate.kpis.tool_failures.median)}`,
  ].join("\n") + "\n";
}

/** Render either the complete JSON artifact or the strict pi-autoresearch metric stream. */
export function renderBenchmarkOutput(output: BenchmarkOutput, format: BenchmarkOutputFormat): string {
  if (format === "autoresearch") return renderAutoresearchMetrics(output);
  if (format === "json") {
    assertBenchmarkOutput(output);
    return `${JSON.stringify(output, null, 2)}\n`;
  }
  throw new BenchmarkValidationError(`unsupported benchmark output format: ${String(format)}`);
}

/** Write any bounded JSON value through a same-directory temporary then atomic rename. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const destination = resolve(path);
  const directory = dirname(destination);
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Validate the complete machine-readable artifact before atomically publishing it. */
export function writeBenchmarkOutputAtomically(path: string, output: BenchmarkOutput): void {
  assertBenchmarkOutput(output);
  writeJsonAtomically(path, output);
}
