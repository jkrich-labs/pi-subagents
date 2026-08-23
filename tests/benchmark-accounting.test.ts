import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  BenchmarkValidationError,
  assertBenchmarkSuiteManifest,
  assertComparableSampleDigests,
  createBenchmarkSample,
  modelPolicyDigestFor,
  suiteDigestFor,
  validateFiniteNonNegativeMetrics,
  type BenchmarkSuiteManifest,
} from "../harness/benchmark/contracts.ts";
import { accountPersistedSessions, type PersistedSession } from "../harness/benchmark/accounting.ts";

const parentPolicy = { provider: "openai-codex", model: "parent-model", thinking: "medium" };
const childPolicy = { provider: "openai-codex", model: "child-model", thinking: "low" };
const suiteDefinition = { id: "accounting-fixture", version: 1, scenarios: ["accounting"] };
const manifest: BenchmarkSuiteManifest = {
  schemaVersion: 1,
  id: "accounting-fixture",
  suiteDefinition,
  suiteDigest: suiteDigestFor(suiteDefinition),
  modelPolicyDigest: modelPolicyDigestFor(parentPolicy, childPolicy),
  parent: parentPolicy,
  child: childPolicy,
};

function usage(totalTokens: number, input: number, output: number, cacheRead: number, cacheWrite: number): Record<string, number> {
  return { totalTokens, input, output, cacheRead, cacheWrite };
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

function header(id: string): string {
  return line({ type: "session", version: 3, id, timestamp: "2026-08-23T00:00:00.000Z", cwd: "/fixture" });
}

function message(id: string, role: string, extra: Record<string, unknown>): string {
  return line({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-23T00:00:01.000Z",
    message: { role, ...extra },
  });
}

function policyDriftEntry(type: "provider" | "model" | "thinking"): string {
  if (type === "thinking") {
    return line({
      type: "thinking_level_change",
      id: "thinking-drift",
      parentId: null,
      timestamp: "2026-08-23T00:00:01.000Z",
      thinkingLevel: "xhigh",
    });
  }
  if (type === "model") {
    return line({
      type: "model_change",
      id: "model-drift",
      parentId: null,
      timestamp: "2026-08-23T00:00:01.000Z",
      provider: manifest.parent.provider,
      modelId: "other-model",
    });
  }
  return message("provider-drift", "assistant", {
    provider: "other-provider",
    model: manifest.parent.model,
    usage: usage(1, 1, 0, 0, 0),
  });
}

test("benchmark accounting trusts each persisted record once and rejects invalid benchmark data", () => {
  const parentAssistant = message("parent-assistant", "assistant", {
    provider: manifest.parent.provider,
    model: manifest.parent.model,
    usage: usage(100, 50, 30, 15, 5),
  });
  const parentSession = [
    header("parent-session"),
    line({ type: "model_change", id: "parent-model", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", provider: manifest.parent.provider, modelId: manifest.parent.model }),
    line({ type: "thinking_level_change", id: "parent-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking }),
    parentAssistant,
    message("parent-nested-tool", "toolResult", { isError: false, usage: usage(13, 2, 3, 7, 1) }),
    line({ type: "compaction", id: "parent-compaction", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", summary: "summary", tokensBefore: 1, usage: usage(11, 4, 2, 4, 1) }),
    message("parent-tool-ok", "toolResult", { isError: false }),
    parentAssistant,
    "{malformed-jsonl",
  ].join("\n");
  const childSession = [
    header("child-session"),
    line({ type: "model_change", id: "child-model", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", provider: manifest.child.provider, modelId: manifest.child.model }),
    line({ type: "thinking_level_change", id: "child-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.child.thinking }),
    message("child-assistant", "assistant", {
      provider: manifest.child.provider,
      model: manifest.child.model,
      usage: usage(40, 20, 10, 10, 0),
    }),
    message("child-tool-error", "toolResult", { isError: true, usage: usage(5, 1, 2, 2, 0) }),
    message("child-tool-ok", "toolResult", { isError: false }),
    message("not-a-tool-result", "user", { isError: true }),
    line({ type: "branch_summary", id: "child-branch", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", fromId: "root", summary: "branch", usage: usage(7, 3, 1, 3, 0) }),
  ].join("\n");
  const sessions: PersistedSession[] = [
    { path: "/sessions/parent.jsonl", canonicalPath: "/sessions/parent.jsonl", participant: "parent", jsonl: parentSession },
    { path: "/sessions/children/child.jsonl", canonicalPath: "/sessions/children/child.jsonl", participant: "child", jsonl: childSession },
    { path: "/sessions/symlink/parent.jsonl", canonicalPath: "/sessions/parent.jsonl", participant: "parent", jsonl: parentSession },
    { path: "/sessions/alias/parent.jsonl", canonicalPath: "/sessions/alias/parent.jsonl", participant: "parent", jsonl: parentSession },
  ];

  const accounting = accountPersistedSessions(manifest, sessions);
  const uniquePersistedTotalTokens = 100 + 13 + 11 + 40 + 5 + 7;
  assert.equal(accounting.usage.totalTokens, uniquePersistedTotalTokens, "total_tokens sums each unique persisted usage.totalTokens");
  assert.deepEqual(accounting.usage, {
    totalTokens: 176,
    inputTokens: 80,
    outputTokens: 48,
    cacheReadTokens: 41,
    cacheWriteTokens: 7,
    parentTokens: 124,
    childTokens: 52,
  });
  assert.equal(accounting.toolFailures, 1, "only persisted toolResult isError values count");
  assert.equal(accounting.diagnostics.length, 4);
  assert.deepEqual(accounting.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    "duplicate-session-entry",
    "duplicate-session-file",
    "duplicate-session-id",
    "malformed-jsonl",
  ]);
  assert.ok(accounting.diagnostics.every((diagnostic) => diagnostic.message.length <= 240));

  assert.throws(
    () => accountPersistedSessions(manifest, []),
    /requires at least one persisted session/i,
  );

  const bounded = accountPersistedSessions(manifest, [{
    path: "/sessions/noisy.jsonl",
    canonicalPath: "/sessions/noisy.jsonl",
    participant: "parent",
    jsonl: Array.from({ length: 5 }, () => "not json").join("\n"),
  }], { maxDiagnostics: 2 });
  assert.equal(bounded.diagnostics.length, 2, "diagnostics remain bounded");
  assert.equal(bounded.diagnosticsDropped, 6, "dropped diagnostics are counted without retaining transcript data");

  const headerless = accountPersistedSessions(manifest, [{
    path: "/sessions/headerless.jsonl",
    canonicalPath: "/sessions/headerless.jsonl",
    participant: "parent",
    jsonl: parentAssistant,
  }]);
  assert.ok(headerless.diagnostics.some((diagnostic) => diagnostic.code === "missing-session-header"));
  assert.ok(headerless.diagnostics.some((diagnostic) => diagnostic.code === "missing-thinking-policy"));
  assert.equal(createBenchmarkSample({
    manifest,
    wallTimeMs: 1,
    accounting: headerless,
    scenarios: [{
      id: "accounting",
      wallTimeMs: 1,
      usage: headerless.usage,
      toolFailures: headerless.toolFailures,
      qualityGates: [],
    }],
  }).qualityGates.find((gate) => gate.id === "session-accounting")?.passed, false);

  const missingThinking = accountPersistedSessions(manifest, [{
    path: "/sessions/missing-thinking.jsonl",
    canonicalPath: "/sessions/missing-thinking.jsonl",
    participant: "parent",
    jsonl: `${header("missing-thinking")}\n${parentAssistant}`,
  }]);
  assert.deepEqual(missingThinking.diagnostics.map((diagnostic) => diagnostic.code), ["missing-thinking-policy"]);

  const incompleteHeader = accountPersistedSessions(manifest, [{
    path: "/sessions/incomplete-header.jsonl",
    canonicalPath: "/sessions/incomplete-header.jsonl",
    participant: "parent",
    jsonl: `${line({ type: "session", version: 3, id: "incomplete-header", timestamp: "2026-08-23T00:00:00.000Z" })}\n${line({ type: "thinking_level_change", id: "incomplete-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking })}\n${parentAssistant}`,
  }]);
  assert.ok(incompleteHeader.diagnostics.some((diagnostic) => diagnostic.code === "invalid-session-header"));

  const misplacedHeader = accountPersistedSessions(manifest, [{
    path: "/sessions/misplaced-header.jsonl",
    canonicalPath: "/sessions/misplaced-header.jsonl",
    participant: "parent",
    jsonl: `${parentAssistant}\n${header("misplaced-header")}\n${line({ type: "thinking_level_change", id: "misplaced-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking })}`,
  }]);
  assert.ok(misplacedHeader.diagnostics.some((diagnostic) => diagnostic.code === "misplaced-session-header"));

  const duplicateHeader = accountPersistedSessions(manifest, [{
    path: "/sessions/duplicate-header.jsonl",
    canonicalPath: "/sessions/duplicate-header.jsonl",
    participant: "parent",
    jsonl: `${header("duplicate-header-a")}\n${header("duplicate-header-b")}\n${line({ type: "thinking_level_change", id: "duplicate-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking })}\n${parentAssistant}`,
  }]);
  assert.ok(duplicateHeader.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-session-header"));

  const duplicateAfterUsage = accountPersistedSessions(manifest, [{
    path: "/sessions/duplicate-after-usage.jsonl",
    canonicalPath: "/sessions/duplicate-after-usage.jsonl",
    participant: "parent",
    jsonl: `${header("duplicate-after-usage")}\n${parentAssistant}\n${header("duplicate-after-usage")}\n${parentAssistant}`,
  }]);
  assert.equal(duplicateAfterUsage.usage.totalTokens, 0, "records from a duplicate session are discarded as one unit");
  assert.ok(duplicateAfterUsage.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-session-id"));

  const malformedDuplicate = accountPersistedSessions(manifest, [
    {
      path: "/sessions/valid-first.jsonl",
      canonicalPath: "/sessions/valid-first.jsonl",
      participant: "parent",
      jsonl: `${header("malformed-duplicate")}\n${line({ type: "thinking_level_change", id: "malformed-first-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking })}\n${parentAssistant}`,
    },
    {
      path: "/sessions/malformed-duplicate.jsonl",
      canonicalPath: "/sessions/malformed-duplicate.jsonl",
      participant: "parent",
      jsonl: `${line({ type: "session", version: 3, id: "malformed-duplicate", timestamp: "2026-08-23T00:00:00.000Z" })}\n${parentAssistant}`,
    },
  ]);
  assert.equal(malformedDuplicate.usage.totalTokens, 100, "an invalid duplicate header cannot reopen a counted session");
  assert.ok(malformedDuplicate.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-session-id"));

  const badVersionDuplicate = accountPersistedSessions(manifest, [{
    path: "/sessions/bad-version.jsonl",
    canonicalPath: "/sessions/bad-version.jsonl",
    participant: "parent",
    jsonl: `${line({ type: "session", version: 2, id: "bad-version", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/fixture" })}\n${parentAssistant}`,
  }, {
    path: "/sessions/bad-version-valid-copy.jsonl",
    canonicalPath: "/sessions/bad-version-valid-copy.jsonl",
    participant: "parent",
    jsonl: `${header("bad-version")}\n${line({ type: "thinking_level_change", id: "bad-version-thinking", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", thinkingLevel: manifest.parent.thinking })}\n${parentAssistant}`,
  }]);
  assert.equal(badVersionDuplicate.usage.totalTokens, 0, "an invalid v3 version cannot be duplicated by a valid copy");

  const sample = createBenchmarkSample({
    manifest,
    wallTimeMs: 1234,
    accounting,
    scenarios: [{
      id: "accounting",
      wallTimeMs: 1234,
      usage: accounting.usage,
      toolFailures: accounting.toolFailures,
      qualityGates: [],
    }],
  });
  assert.equal(sample.schemaVersion, BENCHMARK_SAMPLE_SCHEMA_VERSION);
  assert.equal(sample.totalTokens, 176);
  assert.equal(sample.toolFailures, 1);
  assert.deepEqual(sample.scenarios[0]?.usage, accounting.usage, "per-scenario usage is retained in the artifact");
  assert.equal(sample.scenarios[0]?.toolFailures, accounting.toolFailures);
  assert.equal(sample.cacheHitRate, 41 / (80 + 41 + 7));
  assert.equal(sample.scenarios[0]?.cacheHitRate, 41 / (80 + 41 + 7));
  assert.equal(sample.qualityGates.find((gate) => gate.id === "session-accounting")?.passed, false);
  assert.throws(() => createBenchmarkSample({
    manifest,
    wallTimeMs: 1234,
    accounting,
    scenarios: [{
      id: "accounting",
      wallTimeMs: 1234,
      usage: { ...accounting.usage, totalTokens: accounting.usage.totalTokens - 1 },
      toolFailures: accounting.toolFailures,
      qualityGates: [],
    }],
  }), /does not reconcile/i);

  assert.throws(() => validateFiniteNonNegativeMetrics({ wall_time_ms: Infinity }), BenchmarkValidationError);
  assert.throws(() => validateFiniteNonNegativeMetrics({ total_tokens: -1 }), BenchmarkValidationError);
  const nonFiniteUsageRecord = message("bad-usage", "assistant", {
    provider: manifest.parent.provider,
    model: manifest.parent.model,
    usage: usage(1, 0, 0, 0, 0),
  }).replace("\"totalTokens\":1,", "\"totalTokens\":1e999,");
  assert.throws(() => accountPersistedSessions(manifest, [{
    path: "/sessions/non-finite.jsonl",
    canonicalPath: "/sessions/non-finite.jsonl",
    participant: "parent",
    jsonl: `${header("bad-usage")}\n${nonFiniteUsageRecord}`,
  }]), BenchmarkValidationError);
  assert.throws(() => accountPersistedSessions(manifest, [{
    path: "/sessions/inconsistent-usage.jsonl",
    canonicalPath: "/sessions/inconsistent-usage.jsonl",
    participant: "parent",
    jsonl: `${header("inconsistent-usage")}\n${message("inconsistent", "assistant", {
      provider: manifest.parent.provider,
      model: manifest.parent.model,
      usage: usage(1, 50, 60, 40, 5),
    })}`,
  }]), /must equal its input\/output\/cache components/i);

  assert.throws(() => assertComparableSampleDigests([
    sample,
    { ...sample, suiteDigest: "suite-digest-b" },
  ]), /suite digest/i);
  assert.throws(() => assertComparableSampleDigests([
    sample,
    { ...sample, modelPolicyDigest: "policy-digest-b" },
  ]), /model-policy digest/i);
  assert.throws(() => assertBenchmarkSuiteManifest({
    ...manifest,
    parent: { ...manifest.parent, model: "different-parent-model" },
    modelPolicyDigest: manifest.modelPolicyDigest,
  }), /model-policy digest/i);
  assert.throws(() => assertBenchmarkSuiteManifest({
    ...manifest,
    suiteDefinition: { ...suiteDefinition, version: 2 },
  }), /suite digest/i);
  assert.equal(
    suiteDigestFor({ scenarios: ["accounting"], version: 1, id: "accounting-fixture" }),
    manifest.suiteDigest,
    "suite digest canonicalization ignores object insertion order",
  );

  for (const type of ["provider", "model", "thinking"] as const) {
    assert.throws(() => accountPersistedSessions(manifest, [{
      path: `/sessions/${type}-drift.jsonl`,
      canonicalPath: `/sessions/${type}-drift.jsonl`,
      participant: "parent",
      jsonl: `${header(`${type}-drift-session`)}\n${policyDriftEntry(type)}`,
    }]), new RegExp(`${type} drift`, "i"));
  }
});
