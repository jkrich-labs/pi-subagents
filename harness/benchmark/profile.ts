/** Explicit benchmark suite policies. The runner never contains model-specific pins. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  modelPolicyDigestFor,
  suiteDigestFor,
  type BenchmarkSuiteManifest,
  type ModelPolicy,
} from "./contracts.ts";

export interface CreateBenchmarkSuiteManifestInput {
  id: string;
  suiteDefinition: Readonly<Record<string, unknown>>;
  parent: ModelPolicy;
  child: ModelPolicy;
}

/** Build a digest-bound suite declaration from any explicit parent/child policy. */
export function assertBenchmarkSuiteIntegrity(manifest: BenchmarkSuiteManifest): void {
  const integrity = (manifest.suiteDefinition as { integrity?: typeof BUNDLED_INTEGRITY }).integrity;
  if (!integrity) return;
  const actual = {
    fixtureTemplates: {
      parallelDiagnosis: digestTree(resolve(FIXTURE_ROOT, "parallel-diagnosis")),
      parallelImplementation: digestTree(resolve(FIXTURE_ROOT, "parallel-implementation")),
      reviewConvergence: digestTree(resolve(FIXTURE_ROOT, "review-convergence")),
    },
    verifierGuard: digestFile(resolve(BENCHMARK_ROOT, "verifier-guard.mjs")),
    allowedPaths: integrity.allowedPaths,
    scenarioSources: {
      extensionsSubagents: digestTree(resolve(REPOSITORY_ROOT, "extensions/subagents")),
      rpcChild: digestFile(resolve(REPOSITORY_ROOT, "harness/rpc-child.ts")),
      parallelDiagnosis: digestFile(resolve(BENCHMARK_ROOT, "parallel-diagnosis.ts")),
      parallelImplementation: digestFile(resolve(BENCHMARK_ROOT, "parallel-implementation.ts")),
      reviewConvergence: digestFile(resolve(BENCHMARK_ROOT, "review-convergence.ts")),
    },
  };
  if (JSON.stringify(actual) !== JSON.stringify(integrity)) {
    throw new Error("benchmark evaluator integrity does not match the active manifest");
  }
}

export function createBenchmarkSuiteManifest(input: CreateBenchmarkSuiteManifestInput): BenchmarkSuiteManifest {
  return {
    schemaVersion: 1,
    id: input.id,
    suiteDefinition: input.suiteDefinition,
    suiteDigest: suiteDigestFor(input.suiteDefinition),
    modelPolicyDigest: modelPolicyDigestFor(input.parent, input.child),
    parent: { ...input.parent },
    child: { ...input.child },
  };
}

/** The bundled policy is configuration; benchmark execution never pins these values itself. */
function digestTree(root: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  for (const path of files.sort()) hash.update(`${relative(root, path)}\0`).update(readFileSync(path));
  return hash.digest("hex");
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const BENCHMARK_ROOT = resolve(import.meta.dirname);
const REPOSITORY_ROOT = resolve(BENCHMARK_ROOT, "../..");
const FIXTURE_ROOT = resolve(BENCHMARK_ROOT, "fixtures");
const BUNDLED_INTEGRITY = {
  fixtureTemplates: {
    parallelDiagnosis: digestTree(resolve(FIXTURE_ROOT, "parallel-diagnosis")),
    parallelImplementation: digestTree(resolve(FIXTURE_ROOT, "parallel-implementation")),
    reviewConvergence: digestTree(resolve(FIXTURE_ROOT, "review-convergence")),
  },
  verifierGuard: digestFile(resolve(BENCHMARK_ROOT, "verifier-guard.mjs")),
  allowedPaths: {
    parallelDiagnosis: ["src/retry-after.mjs", "src/request-id.mjs"],
    parallelImplementation: ["src/endpoint-port.mjs", "src/canonical-tags.mjs"],
    reviewConvergence: ["src/redact-headers.mjs"],
  },
  scenarioSources: {
    extensionsSubagents: digestTree(resolve(REPOSITORY_ROOT, "extensions/subagents")),
    rpcChild: digestFile(resolve(REPOSITORY_ROOT, "harness/rpc-child.ts")),
    parallelDiagnosis: digestFile(resolve(BENCHMARK_ROOT, "parallel-diagnosis.ts")),
    parallelImplementation: digestFile(resolve(BENCHMARK_ROOT, "parallel-implementation.ts")),
    reviewConvergence: digestFile(resolve(BENCHMARK_ROOT, "review-convergence.ts")),
  },
} as const;

export const BUNDLED_COMPARISON_POLICY: Readonly<{ parent: ModelPolicy; child: ModelPolicy }> = {
  parent: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "medium",
  },
  child: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "medium",
  },
};

/** The public quick/confirm suite always runs these three balanced workflows. */
export const BUNDLED_COMPARISON_SUITE_DEFINITION = {
  version: 1,
  scenarios: [{
    id: "parallel-diagnosis",
    minimumChildren: 2,
    expectedRoles: ["retry-after-explorer", "request-id-explorer"],
  }, {
    id: "parallel-implementation",
    minimumChildren: 2,
    expectedRoles: ["endpoint-port-implementer", "canonical-tags-implementer"],
    isolatedWriterWorktrees: 2,
  }, {
    id: "review-convergence",
    minimumChildren: 3,
    expectedRoles: [
      "redaction-implementer",
      "redaction-spec-reviewer",
      "redaction-standards-reviewer",
    ],
    parallelReviewers: 2,
  }],
  integrity: BUNDLED_INTEGRITY,
} as const;

/** One digest-bound bundled declaration is the source of truth for suite evaluation. */
export const BUNDLED_COMPARISON_MANIFEST = createBenchmarkSuiteManifest({
  id: "pi-subagents-luna-medium-comparison",
  suiteDefinition: BUNDLED_COMPARISON_SUITE_DEFINITION,
  ...BUNDLED_COMPARISON_POLICY,
});

type BundledScenarioId = typeof BUNDLED_COMPARISON_SUITE_DEFINITION.scenarios[number]["id"];

/**
 * Single-workflow commands remain useful for diagnosis. They derive their
 * policy and scenario declaration from the public bundled suite rather than
 * introducing another model-specific policy.
 */
function bundledScenarioManifest(id: BundledScenarioId): BenchmarkSuiteManifest {
  const scenario = BUNDLED_COMPARISON_SUITE_DEFINITION.scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`unknown bundled scenario: ${id}`);
  return createBenchmarkSuiteManifest({
    id: `${BUNDLED_COMPARISON_MANIFEST.id}-${id}`,
    suiteDefinition: { ...BUNDLED_COMPARISON_SUITE_DEFINITION, scenarios: [scenario] },
    ...BUNDLED_COMPARISON_POLICY,
  });
}

export const PARALLEL_DIAGNOSIS_MANIFEST = bundledScenarioManifest("parallel-diagnosis");
export const PARALLEL_IMPLEMENTATION_MANIFEST = bundledScenarioManifest("parallel-implementation");
export const REVIEW_CONVERGENCE_MANIFEST = bundledScenarioManifest("review-convergence");

/** S-02's authenticated completion probe is intentionally outside the three-scenario suite. */
export const AUTONOMOUS_SMOKE_MANIFEST = createBenchmarkSuiteManifest({
  id: "pi-subagents-luna-medium-autonomous-smoke",
  suiteDefinition: { version: 1, scenarios: [{ id: "autonomous-smoke" }] },
  ...BUNDLED_COMPARISON_POLICY,
});
