/** Versioned, provider-independent benchmark artifact contracts. */
import { createHash } from "node:crypto";

export const BENCHMARK_SAMPLE_SCHEMA_VERSION = 1 as const;

export type BenchmarkParticipant = "parent" | "child";

/** The exact model configuration one benchmark participant is allowed to use. */
export interface ModelPolicy {
  provider: string;
  model: string;
  thinking: string;
}

/** The active suite declaration supplied by the runner, not inferred from a session. */
export interface BenchmarkSuiteManifest {
  schemaVersion: 1;
  id: string;
  /** Structured suite definition; the digest is derived canonically from it. */
  suiteDefinition: Readonly<Record<string, unknown>>;
  suiteDigest: string;
  modelPolicyDigest: string;
  parent: ModelPolicy;
  child: ModelPolicy;
}

export interface UsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  parentTokens: number;
  childTokens: number;
}

export interface BenchmarkDiagnostic {
  code: string;
  message: string;
}

/** The parser deliberately retains a bounded count rather than session transcript data. */
export interface SessionAccounting {
  usage: UsageBreakdown;
  toolFailures: number;
  diagnostics: readonly BenchmarkDiagnostic[];
  diagnosticsDropped: number;
}

export interface QualityGateResult {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioInput {
  id: string;
  wallTimeMs: number;
  usage: UsageBreakdown;
  toolFailures: number;
  qualityGates: readonly QualityGateResult[];
}

export interface ScenarioResult extends ScenarioInput {
  cacheHitRate: number;
}

export interface BenchmarkSample {
  schemaVersion: typeof BENCHMARK_SAMPLE_SCHEMA_VERSION;
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  wallTimeMs: number;
  totalTokens: number;
  toolFailures: number;
  usage: UsageBreakdown;
  cacheHitRate: number;
  scenarios: readonly ScenarioResult[];
  qualityGates: readonly QualityGateResult[];
  diagnostics: readonly BenchmarkDiagnostic[];
  diagnosticsDropped: number;
}

export class BenchmarkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkValidationError";
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BenchmarkValidationError(`${label} must be a non-empty string`);
  }
}

function assertModelPolicy(policy: ModelPolicy, label: string): void {
  assertNonEmptyString(policy.provider, `${label}.provider`);
  assertNonEmptyString(policy.model, `${label}.model`);
  assertNonEmptyString(policy.thinking, `${label}.thinking`);
}

function assertSuiteDefinition(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BenchmarkValidationError("suite definition must be an object");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new BenchmarkValidationError("suite definition must contain JSON values");
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new BenchmarkValidationError("suite definition must contain JSON values");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new BenchmarkValidationError("suite definition must contain JSON values");
  return encoded;
}

/** Hash only explicit participant policy fields, excluding the digest field itself. */
export function modelPolicyDigestFor(
  parent: ModelPolicy,
  child: ModelPolicy,
): string {
  const canonical = JSON.stringify({
    parent: { provider: parent.provider, model: parent.model, thinking: parent.thinking },
    child: { provider: child.provider, model: child.model, thinking: child.thinking },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function suiteDigestFor(suiteDefinition: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(suiteDefinition)).digest("hex");
}

export function scenarioIdsForSuite(suiteDefinition: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = suiteDefinition.scenarios;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BenchmarkValidationError("suite definition must declare at least one scenario");
  }
  const ids: string[] = [];
  raw.forEach((scenario, index) => {
    let id: unknown;
    if (typeof scenario === "string") id = scenario;
    else if (typeof scenario === "object" && scenario !== null && !Array.isArray(scenario)) {
      id = (scenario as Record<string, unknown>).id;
    } else {
      throw new BenchmarkValidationError(`suite scenario ${index + 1} must declare an id`);
    }
    assertNonEmptyString(id, `suite scenario ${index + 1} id`);
    ids.push(id);
  });
  if (new Set(ids).size !== ids.length) {
    throw new BenchmarkValidationError("suite definition contains duplicate scenario ids");
  }
  return ids;
}

/** Fraction of all input tokens served from the provider cache. */
export function cacheHitRateFor(usage: UsageBreakdown): number {
  const totalInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return totalInputTokens === 0 ? 0 : usage.cacheReadTokens / totalInputTokens;
}

function assertScenarioAccountingReconciles(
  scenarios: readonly ScenarioInput[],
  accounting: SessionAccounting,
): void {
  const totals: UsageBreakdown = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    parentTokens: 0,
    childTokens: 0,
  };
  let toolFailures = 0;
  for (const scenario of scenarios) {
    totals.totalTokens += scenario.usage.totalTokens;
    totals.inputTokens += scenario.usage.inputTokens;
    totals.outputTokens += scenario.usage.outputTokens;
    totals.cacheReadTokens += scenario.usage.cacheReadTokens;
    totals.cacheWriteTokens += scenario.usage.cacheWriteTokens;
    totals.parentTokens += scenario.usage.parentTokens;
    totals.childTokens += scenario.usage.childTokens;
    toolFailures += scenario.toolFailures;
  }
  const usageMatches = Object.keys(totals).every((key) =>
    totals[key as keyof UsageBreakdown] === accounting.usage[key as keyof UsageBreakdown]);
  if (!usageMatches || toolFailures !== accounting.toolFailures) {
    throw new BenchmarkValidationError("scenario accounting does not reconcile with sample accounting");
  }
}

/** Reject a malformed active policy before inspecting untrusted persisted records. */
export function assertBenchmarkSuiteManifest(manifest: BenchmarkSuiteManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new BenchmarkValidationError(`unsupported benchmark suite manifest schema version: ${String(manifest.schemaVersion)}`);
  }
  assertNonEmptyString(manifest.id, "suite id");
  assertSuiteDefinition(manifest.suiteDefinition);
  assertNonEmptyString(manifest.suiteDigest, "suite digest");
  assertNonEmptyString(manifest.modelPolicyDigest, "model-policy digest");
  assertModelPolicy(manifest.parent, "parent policy");
  assertModelPolicy(manifest.child, "child policy");
  if (manifest.suiteDigest !== suiteDigestFor(manifest.suiteDefinition)) {
    throw new BenchmarkValidationError("suite digest does not match the declared suite definition");
  }
  if (manifest.modelPolicyDigest !== modelPolicyDigestFor(manifest.parent, manifest.child)) {
    throw new BenchmarkValidationError("model-policy digest does not match the declared parent/child policy");
  }
  scenarioIdsForSuite(manifest.suiteDefinition);
}

/** KPI values are valid only when finite and non-negative. */
export function validateFiniteNonNegativeMetrics(metrics: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new BenchmarkValidationError(`${name} must be a finite, non-negative number`);
    }
  }
}

export interface CreateBenchmarkSampleInput {
  manifest: BenchmarkSuiteManifest;
  wallTimeMs: number;
  accounting: SessionAccounting;
  scenarios: readonly ScenarioInput[];
  qualityGates?: readonly QualityGateResult[];
}

/**
 * Build the versioned per-sample artifact after parser accounting has completed.
 * A parser diagnostic is a hard quality-gate failure, while metrics remain available
 * for diagnosis and are never silently coerced.
 */
export function createBenchmarkSample(input: CreateBenchmarkSampleInput): BenchmarkSample {
  assertBenchmarkSuiteManifest(input.manifest);
  const sampleCacheHitRate = cacheHitRateFor(input.accounting.usage);
  validateFiniteNonNegativeMetrics({
    wall_time_ms: input.wallTimeMs,
    total_tokens: input.accounting.usage.totalTokens,
    tool_failures: input.accounting.toolFailures,
    input_tokens: input.accounting.usage.inputTokens,
    output_tokens: input.accounting.usage.outputTokens,
    cache_read_tokens: input.accounting.usage.cacheReadTokens,
    cache_write_tokens: input.accounting.usage.cacheWriteTokens,
    parent_tokens: input.accounting.usage.parentTokens,
    child_tokens: input.accounting.usage.childTokens,
    cache_hit_rate: sampleCacheHitRate,
    diagnostics_dropped: input.accounting.diagnosticsDropped,
  });

  for (const scenario of input.scenarios) {
    assertNonEmptyString(scenario.id, "scenario id");
    validateFiniteNonNegativeMetrics({
      [`scenario.${scenario.id}.wall_time_ms`]: scenario.wallTimeMs,
      [`scenario.${scenario.id}.tool_failures`]: scenario.toolFailures,
      [`scenario.${scenario.id}.total_tokens`]: scenario.usage.totalTokens,
      [`scenario.${scenario.id}.input_tokens`]: scenario.usage.inputTokens,
      [`scenario.${scenario.id}.output_tokens`]: scenario.usage.outputTokens,
      [`scenario.${scenario.id}.cache_read_tokens`]: scenario.usage.cacheReadTokens,
      [`scenario.${scenario.id}.cache_write_tokens`]: scenario.usage.cacheWriteTokens,
      [`scenario.${scenario.id}.parent_tokens`]: scenario.usage.parentTokens,
      [`scenario.${scenario.id}.child_tokens`]: scenario.usage.childTokens,
      [`scenario.${scenario.id}.cache_hit_rate`]: cacheHitRateFor(scenario.usage),
    });
  }

  const expectedScenarioIds = scenarioIdsForSuite(input.manifest.suiteDefinition);
  const actualScenarioIds = input.scenarios.map((scenario) => scenario.id);
  if (new Set(actualScenarioIds).size !== actualScenarioIds.length ||
      expectedScenarioIds.length !== actualScenarioIds.length ||
      expectedScenarioIds.some((id) => !actualScenarioIds.includes(id))) {
    throw new BenchmarkValidationError("sample scenarios do not match the active suite definition");
  }
  assertScenarioAccountingReconciles(input.scenarios, input.accounting);

  const accountingGate: QualityGateResult = {
    id: "session-accounting",
    passed: input.accounting.diagnostics.length === 0 && input.accounting.diagnosticsDropped === 0,
    detail: input.accounting.diagnostics.length === 0 && input.accounting.diagnosticsDropped === 0
      ? undefined
      : `${input.accounting.diagnostics.length + input.accounting.diagnosticsDropped} bounded session-accounting diagnostic(s)`,
  };

  return {
    schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
    suiteId: input.manifest.id,
    suiteDigest: input.manifest.suiteDigest,
    modelPolicyDigest: input.manifest.modelPolicyDigest,
    wallTimeMs: input.wallTimeMs,
    totalTokens: input.accounting.usage.totalTokens,
    toolFailures: input.accounting.toolFailures,
    usage: { ...input.accounting.usage },
    cacheHitRate: sampleCacheHitRate,
    scenarios: input.scenarios.map((scenario) => ({
      ...scenario,
      cacheHitRate: cacheHitRateFor(scenario.usage),
      usage: { ...scenario.usage },
      qualityGates: [...scenario.qualityGates],
    })),
    qualityGates: [...(input.qualityGates ?? []), accountingGate],
    diagnostics: [...input.accounting.diagnostics],
    diagnosticsDropped: input.accounting.diagnosticsDropped,
  };
}

/** Samples with different suite or model-policy digests are not comparable. */
export function assertComparableSampleDigests(samples: readonly BenchmarkSample[]): void {
  if (samples.length < 2) return;
  const [first, ...rest] = samples;
  for (const sample of rest) {
    if (sample.suiteDigest !== first.suiteDigest) {
      throw new BenchmarkValidationError("cannot combine samples with mixed suite digests");
    }
    if (sample.modelPolicyDigest !== first.modelPolicyDigest) {
      throw new BenchmarkValidationError("cannot combine samples with mixed model-policy digests");
    }
  }
}
