import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  BenchmarkValidationError,
  createBenchmarkSample,
  type BenchmarkSample,
  type QualityGateResult,
  type UsageBreakdown,
} from "../harness/benchmark/contracts.ts";
import { createBenchmarkSuiteManifest } from "../harness/benchmark/profile.ts";
import {
  BENCHMARK_OUTPUT_SCHEMA_VERSION,
  assertBenchmarkOutput,
  createBenchmarkOutput,
  executeBenchmarkProfile,
  renderAutoresearchMetrics,
  renderBenchmarkOutput,
  writeBenchmarkOutputAtomically,
} from "../harness/benchmark/output.ts";

const manifest = createBenchmarkSuiteManifest({
  id: "output-fixture-suite",
  suiteDefinition: { scenarios: [{ id: "diagnosis" }, { id: "implementation" }, { id: "review" }] },
  parent: { provider: "parent-provider", model: "parent-model", thinking: "medium" },
  child: { provider: "child-provider", model: "child-model", thinking: "low" },
});

function usage(totalTokens: number): UsageBreakdown {
  return {
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    parentTokens: totalTokens,
    childTokens: 0,
  };
}

function sample(input: {
  wallTimeMs: number;
  totalTokens: number;
  toolFailures: number;
  failedGate?: QualityGateResult;
}): BenchmarkSample {
  const scenarioUsage = usage(input.totalTokens / 3);
  const scenarioGates = input.failedGate ? [input.failedGate] : [{ id: "scenario-hard-gate", passed: true }];
  return createBenchmarkSample({
    manifest,
    wallTimeMs: input.wallTimeMs,
    accounting: { usage: usage(input.totalTokens), toolFailures: input.toolFailures, diagnostics: [], diagnosticsDropped: 0 },
    scenarios: ["diagnosis", "implementation", "review"].map((id) => ({
      id,
      wallTimeMs: input.wallTimeMs / 3,
      usage: scenarioUsage,
      toolFailures: input.toolFailures / 3,
      qualityGates: scenarioGates,
    })),
    qualityGates: input.failedGate ? [input.failedGate] : [{ id: "sample-hard-gate", passed: true }],
  });
}

test("quick output aggregates one complete sample, validates finite JSON, and writes atomically", () => {
  const output = createBenchmarkOutput({
    manifest,
    profile: "quick",
    samples: [sample({ wallTimeMs: 123, totalTokens: 300, toolFailures: 6 })],
  });

  assert.equal(output.schemaVersion, BENCHMARK_OUTPUT_SCHEMA_VERSION);
  assert.equal(output.samples[0]?.schemaVersion, BENCHMARK_SAMPLE_SCHEMA_VERSION);
  assert.equal(output.aggregate.sampleCount, 1);
  assert.deepEqual(output.aggregate.kpis, {
    wall_time_ms: { median: 123, mad: 0 },
    total_tokens: { median: 300, mad: 0 },
    tool_failures: { median: 6, mad: 0 },
  });
  assert.equal(output.aggregate.quickTargetMet, true);
  assert.equal(output.qualityPassed, true);
  assertBenchmarkOutput(output);

  const renderedJson = renderBenchmarkOutput(output, "json");
  assert.equal(renderedJson.includes("Infinity"), false, "machine JSON contains finite values only");
  assert.equal(renderedJson.includes("NaN"), false, "machine JSON contains finite values only");
  assert.equal(JSON.parse(renderedJson).schemaVersion, BENCHMARK_OUTPUT_SCHEMA_VERSION);

  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-benchmark-output-"));
  const destination = join(directory, "artifact.json");
  writeFileSync(destination, "old artifact\n");
  writeBenchmarkOutputAtomically(destination, output);
  const persisted = JSON.parse(readFileSync(destination, "utf8"));
  assert.equal(persisted.schemaVersion, BENCHMARK_OUTPUT_SCHEMA_VERSION);
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false, "temporary output is renamed away atomically");
});

test("confirmation executes three fresh samples and reports raw KPI medians with MAD", async () => {
  const samples = [
    sample({ wallTimeMs: 100, totalTokens: 300, toolFailures: 3 }),
    sample({ wallTimeMs: 300, totalTokens: 100, toolFailures: 1 }),
    sample({ wallTimeMs: 200, totalTokens: 200, toolFailures: 2 }),
  ];
  const freshResets: string[] = [];
  const confirmation = await executeBenchmarkProfile({
    manifest,
    profile: "confirm",
    async runFreshSample({ sampleIndex }) {
      const reset = mkdtempSync(join(tmpdir(), `pi-subagents-confirm-${sampleIndex}-`));
      freshResets.push(reset);
      return samples[sampleIndex]!;
    },
  });
  assert.equal(confirmation.samples.length, 3);
  assert.equal(new Set(freshResets).size, 3, "confirmation invokes a distinct reset for each sample");
  assert.deepEqual(confirmation.aggregate.kpis, {
    wall_time_ms: { median: 200, mad: 100 },
    total_tokens: { median: 200, mad: 100 },
    tool_failures: { median: 2, mad: 1 },
  });
  assert.equal(confirmation.aggregate.quickTargetMet, false, "five-minute target applies to one quick suite sample");

  let quickRuns = 0;
  const quick = await executeBenchmarkProfile({
    manifest,
    profile: "quick",
    async runFreshSample() {
      quickRuns += 1;
      return samples[0]!;
    },
  });
  assert.equal(quickRuns, 1, "quick invokes exactly one complete sample");
  assert.equal(quick.samples.length, 1);
});

test("autoresearch emits exactly three finite raw KPI lines and suppresses all metrics on any hard-gate failure", () => {
  const passing = createBenchmarkOutput({
    manifest,
    profile: "quick",
    samples: [sample({ wallTimeMs: 10, totalTokens: 20, toolFailures: 0 })],
  });
  const metrics = renderAutoresearchMetrics(passing);
  assert.deepEqual(metrics.trim().split("\n"), [
    "METRIC wall_time_ms=10",
    "METRIC total_tokens=20",
    "METRIC tool_failures=0",
  ]);
  assert.equal(metrics.includes("composite"), false);
  assert.equal(metrics.includes("Infinity"), false);
  assert.equal(metrics.includes("NaN"), false);

  const failed = createBenchmarkOutput({
    manifest,
    profile: "quick",
    samples: [sample({
      wallTimeMs: 10,
      totalTokens: 20,
      toolFailures: 0,
      failedGate: { id: "fixture-verification", passed: false, detail: "verifier failed" },
    })],
  });
  assert.equal(failed.qualityPassed, false);
  assert.equal(failed.hardGateFailures.length > 0, true);
  assert.equal(renderAutoresearchMetrics(failed), "", "a single failed sample or scenario gate suppresses every KPI");
  assert.equal(renderBenchmarkOutput(failed, "autoresearch"), "");

  const nonFinite = {
    ...passing,
    aggregate: {
      ...passing.aggregate,
      kpis: {
        ...passing.aggregate.kpis,
        wall_time_ms: { median: Infinity, mad: 0 },
      },
    },
  };
  assert.throws(() => renderAutoresearchMetrics(nonFinite), BenchmarkValidationError);
});
