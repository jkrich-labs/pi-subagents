import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  createParallelDiagnosisFixtureLifecycle,
  createParallelImplementationFixtureLifecycle,
  createReviewConvergenceFixtureLifecycle,
  PARALLEL_DIAGNOSIS_ALLOWED_PATHS,
  PARALLEL_IMPLEMENTATION_ALLOWED_PATHS,
  REVIEW_CONVERGENCE_ALLOWED_PATHS,
  runFixtureVerifier,
} from "../harness/benchmark/fixtures.ts";

const completeRetryAfter = `/** Return a retry delay in milliseconds from an HTTP Retry-After value. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (/^\\d+$/.test(text)) return Number(text) * 1_000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
`;

const completeRequestId = `/** Extract the upstream request id from a plain HTTP header object. */
export function requestId(headers) {
  if (!headers || typeof headers !== "object") return "";
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-request-id") return typeof value === "string" ? value : "";
  }
  return "";
}
`;

const completeEndpointPort = `export function endpointPort(endpoint) {
  if (typeof endpoint !== "string") return 0;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return 0;
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch { return 0; }
}
`;

const completeCanonicalTags = `export function canonicalTags(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tag = value.trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}
`;

const completeRedaction = `export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    /^(authorization|cookie|set-cookie)$/i.test(name) ? [name, "[redacted]"] : [name, value]));
}
`;

test("parallel diagnosis fixture is pristine-failing and accepts only the complete integrated outcome", async () => {
  const lifecycle = createParallelDiagnosisFixtureLifecycle();
  const fixture = await lifecycle.prepare();
  try {
    const pristine = await fixture.verify();
    assert.notEqual(pristine.exitCode, 0, "the committed fixture starts with both intended failures");
    assert.equal(pristine.stderr, "", "verifier transcript is not retained in artifacts");

    writeFileSync(`${fixture.root}/src/retry-after.mjs`, completeRetryAfter);
    const partial = await fixture.verify();
    assert.notEqual(partial.exitCode, 0, "fixing only one independently diagnosed behavior is insufficient");
    assert.equal(partial.stderr, "");

    writeFileSync(`${fixture.root}/src/request-id.mjs`, completeRequestId);
    const complete = await fixture.verify();
    assert.equal(complete.exitCode, 0, `complete outcome verifies: ${complete.stderr}`);
    assert.equal(complete.stdout, "", "verifier transcript is not retained in artifacts");

    const scope = await fixture.scope();
    assert.deepEqual(scope.changedPaths, [...PARALLEL_DIAGNOSIS_ALLOWED_PATHS].sort());
    assert.equal(scope.passed, true);

    writeFileSync(`${fixture.root}/verifier.mjs`, "process.exitCode = 0;\n");
    const outOfScope = await fixture.scope();
    assert.equal(outOfScope.passed, false, "the evaluator cannot be edited to game the fixture");
    assert.deepEqual(outOfScope.unexpectedPaths, ["verifier.mjs"]);
  } finally {
    const removed = await fixture.cleanup();
    assert.equal(removed, true);
    assert.equal(existsSync(fixture.root), false);
  }
});

test("parallel implementation fixture rejects skipped and partial integration, then accepts both writer outcomes", async () => {
  const fixture = await createParallelImplementationFixtureLifecycle().prepare();
  try {
    assert.equal(fixture.worktrees?.length, 2, "parallel writers receive pre-created sibling worktrees");
    const [portWriter, tagsWriter] = fixture.worktrees ?? [];
    assert.notEqual(portWriter?.root, fixture.root, "writer cwd is never the integration checkout");
    assert.notEqual(portWriter?.root, tagsWriter?.root, "parallel writers never share cwd/index state");
    assert.notEqual((await fixture.verify()).exitCode, 0, "pristine integration checkout fails");

    writeFileSync(`${portWriter?.root}/src/endpoint-port.mjs`, completeEndpointPort);
    const writerOnly = await fixture.inspectWorktrees?.();
    assert.deepEqual(writerOnly?.find((worktree) => worktree.id === "endpoint-port")?.changedPaths, ["src/endpoint-port.mjs"]);
    assert.notEqual((await fixture.verify()).exitCode, 0, "writer edits do not silently modify the integration checkout");

    writeFileSync(`${fixture.root}/src/endpoint-port.mjs`, completeEndpointPort);
    const partial = await fixture.verify();
    assert.notEqual(partial.exitCode, 0, "one writer outcome without integration of the other still fails");
    assert.equal(partial.stderr, "");

    writeFileSync(`${fixture.root}/src/canonical-tags.mjs`, completeCanonicalTags);
    const complete = await fixture.verify();
    assert.equal(complete.exitCode, 0, complete.stderr);
    assert.equal(complete.stdout, "");
    const scope = await fixture.scope();
    assert.deepEqual(scope.changedPaths, [...PARALLEL_IMPLEMENTATION_ALLOWED_PATHS].sort());
    assert.equal(scope.passed, true);

    writeFileSync(`${fixture.root}/verifier.mjs`, "process.exitCode = 0;\n");
    assert.equal((await fixture.scope()).passed, false, "integration cannot modify its verifier");
  } finally {
    assert.equal(await fixture.cleanup(), true);
    assert.equal(existsSync(fixture.root), false);
  }
});

test("review convergence fixture rejects skipped and baseline-only implementation, then accepts converged fix", async () => {
  const fixture = await createReviewConvergenceFixtureLifecycle().prepare();
  try {
    assert.equal(fixture.worktrees?.length, 1, "implementer receives an isolated preparation worktree");
    assert.notEqual((await fixture.verify()).exitCode, 0, "pristine review fixture fails");

    writeFileSync(`${fixture.root}/src/redact-headers.mjs`, `export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  for (const key of Object.keys(headers)) if (key === "authorization" || key === "cookie") headers[key] = "[redacted]";
  return headers;
}
`);
    const partial = await fixture.verify();
    assert.notEqual(partial.exitCode, 0, "baseline implementer output still requires review convergence");
    assert.equal(partial.stderr, "");

    writeFileSync(`${fixture.root}/src/redact-headers.mjs`, completeRedaction);
    const complete = await fixture.verify();
    assert.equal(complete.exitCode, 0, complete.stderr);
    assert.equal(complete.stdout, "");
    const scope = await fixture.scope();
    assert.deepEqual(scope.changedPaths, [...REVIEW_CONVERGENCE_ALLOWED_PATHS]);
    assert.equal(scope.passed, true);
  } finally {
    assert.equal(await fixture.cleanup(), true);
  }
});

test("fixture verifier converts spawn errors into bounded failed results", async () => {
  const result = await runFixtureVerifier("/definitely/missing/pi-subagents-fixture");
  assert.equal(result.exitCode, null);
  assert.ok(result.stdout.length <= 1_200);
  assert.ok(result.stderr.length <= 1_200);
});

test("fixture scope rejects symlink substitution even when the verifier passes", async () => {
  const fixture = await createParallelDiagnosisFixtureLifecycle().prepare();
  const external = `${mkdtempSync("/tmp/pi-subagents-external-")}/retry-after.mjs`;
  writeFileSync(external, readFileSync(`${fixture.root}/src/retry-after.mjs`, "utf8"));
  rmSync(`${fixture.root}/src/retry-after.mjs`);
  symlinkSync(external, `${fixture.root}/src/retry-after.mjs`);
  try {
    const scope = await fixture.scope();
    assert.equal(scope.passed, false);
    assert.ok(scope.unexpectedPaths.includes("src/retry-after.mjs"));
  } finally {
    await fixture.cleanup();
  }
});

test("parallel diagnosis fixture lifecycle always starts from the tracked template", async () => {
  const lifecycle = createParallelDiagnosisFixtureLifecycle();
  const first = await lifecycle.prepare();
  try {
    writeFileSync(`${first.root}/src/request-id.mjs`, "export const changed = true;\n");
  } finally {
    await first.cleanup();
  }
  const second = await lifecycle.prepare();
  try {
    assert.match(readFileSync(`${second.root}/src/request-id.mjs`, "utf8"), /x-request-id/);
    const pristine = await second.verify();
    assert.notEqual(pristine.exitCode, 0, "a fresh lifecycle never inherits prior parent edits");
  } finally {
    await second.cleanup();
  }
});
