/** Resettable, bounded fixture and isolated-worktree lifecycle for benchmark scenarios. */
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  MAX_RUNNER_OUTPUT_LENGTH,
  type BoundedCommandResult,
  type FixtureLifecycle,
  type FixtureScopeResult,
  type FixtureWorktree,
  type FixtureWorktreeResult,
  type PreparedFixture,
} from "./runner.ts";

const MAX_FIXTURE_PATHS = 200;

export const PARALLEL_DIAGNOSIS_FIXTURE = resolve(import.meta.dirname, "fixtures/parallel-diagnosis");
export const PARALLEL_IMPLEMENTATION_FIXTURE = resolve(import.meta.dirname, "fixtures/parallel-implementation");
export const REVIEW_CONVERGENCE_FIXTURE = resolve(import.meta.dirname, "fixtures/review-convergence");
const VERIFIER_GUARD = resolve(import.meta.dirname, "verifier-guard.mjs");

export const PARALLEL_DIAGNOSIS_ALLOWED_PATHS = [
  "src/retry-after.mjs",
  "src/request-id.mjs",
] as const;
export const PARALLEL_IMPLEMENTATION_ALLOWED_PATHS = [
  "src/endpoint-port.mjs",
  "src/canonical-tags.mjs",
] as const;
export const REVIEW_CONVERGENCE_ALLOWED_PATHS = ["src/redact-headers.mjs"] as const;

interface FileDigest {
  bytes: number;
  text: string;
  kind: "file" | "symlink";
}

interface WorktreeDefinition {
  id: string;
  allowedPaths: readonly string[];
}

interface FixtureDefinition {
  template: string;
  allowedPaths: readonly string[];
  worktrees?: readonly WorktreeDefinition[];
}

interface LocalWorktree extends FixtureWorktree {
  baseline: ReadonlyMap<string, FileDigest>;
  metadataBaseline: readonly string[];
}

function filesUnder(root: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Git metadata changes as child worktrees are created and must never be
      // candidate scope evidence. The tracked fixture content remains visible.
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative(root, path));
    }
  };
  walk(root);
  return paths.sort().slice(0, MAX_FIXTURE_PATHS);
}

function metadataPaths(root: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.name === ".git") {
        paths.push(relativePath);
        if (entry.isDirectory()) walk(path);
        continue;
      }
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return paths.sort();
}

function protectedMetadataSnapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const metadataRoot = join(root, ".git");
  if (!existsSync(metadataRoot) || !lstatSync(metadataRoot).isDirectory()) return result;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isDirectory()) walk(path);
      else if (/^\.git\/(?:config|hooks\/|info\/(?:exclude|attributes))/.test(relativePath)) {
        result.set(relativePath, lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8"));
      }
    }
  };
  walk(metadataRoot);
  return result;
}

function snapshot(root: string): Map<string, FileDigest> {
  const contents = new Map<string, FileDigest>();
  for (const path of filesUnder(root)) {
    const fullPath = join(root, path);
    if (lstatSync(fullPath).isSymbolicLink()) {
      const text = readlinkSync(fullPath);
      contents.set(path, { bytes: Buffer.byteLength(text), text, kind: "symlink" });
    } else {
      const text = readFileSync(fullPath, "utf8");
      contents.set(path, { bytes: Buffer.byteLength(text), text, kind: "file" });
    }
  }
  return contents;
}

function changedPaths(root: string, baseline: ReadonlyMap<string, FileDigest>): string[] {
  const after = snapshot(root);
  const all = new Set([...baseline.keys(), ...after.keys()]);
  return [...all].filter((path) => {
    const beforeFile = baseline.get(path);
    const afterFile = after.get(path);
    return beforeFile?.bytes !== afterFile?.bytes || beforeFile?.text !== afterFile?.text || beforeFile?.kind !== afterFile?.kind;
  }).sort();
}

function symlinkPaths(root: string): string[] {
  return filesUnder(root).filter((path) => lstatSync(join(root, path)).isSymbolicLink());
}

function redactSecrets(text: string): string {
  let redacted = text;
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.length >= 8) redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function boundedOutput(stream: NodeJS.ReadableStream, limit: number): Promise<{ text: string; dropped: number }> {
  return new Promise((resolveOutput) => {
    let text = "";
    let dropped = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveOutput({ text, dropped });
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const remaining = Math.max(0, limit - Buffer.byteLength(text));
      if (remaining === 0) {
        dropped += Buffer.byteLength(chunk);
      } else {
        const kept = Buffer.from(chunk).subarray(0, remaining).toString("utf8");
        text += kept;
        dropped += Math.max(0, Buffer.byteLength(chunk) - Buffer.byteLength(kept));
      }
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

/** Execute the fixed fixture verifier directly -- never via a shell. */
export async function runFixtureVerifier(root: string, signal?: AbortSignal): Promise<BoundedCommandResult> {
  let child;
  try {
    child = spawn(process.execPath, [
      "--permission",
      "--frozen-intrinsics",
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${VERIFIER_GUARD}`,
      `--import=${VERIFIER_GUARD}`,
      "verifier.mjs",
    ], {
      cwd: root,
      // Fixture code is untrusted benchmark input; do not expose provider
      // credentials or arbitrary parent environment to its verifier.
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch {
    return { exitCode: null, stdout: "", stderr: "", stdoutDropped: 0, stderrDropped: 0 };
  }
  let exited = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  const processGroupSignal = (signalName: "SIGTERM" | "SIGKILL"): boolean => {
    const pid = child.pid;
    if (!pid || pid <= 1) return false;
    try {
      process.kill(-pid, signalName);
      return true;
    } catch {
      return false;
    }
  };
  const abortChild = (): void => {
    if (!processGroupSignal("SIGTERM")) {
      try { if (!child.killed) child.kill("SIGTERM"); } catch { /* already exited */ }
    }
    escalationTimer = setTimeout(() => {
      if (exited) return;
      if (!processGroupSignal("SIGKILL")) {
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, 100);
  };
  if (signal?.aborted) abortChild();
  else signal?.addEventListener("abort", abortChild, { once: true });
  const exitCodePromise = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => {
      exited = true;
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      resolveExit(code);
    });
    child.once("error", () => {
      exited = true;
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      resolveExit(null);
    });
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    boundedOutput(child.stdout, MAX_RUNNER_OUTPUT_LENGTH),
    boundedOutput(child.stderr, MAX_RUNNER_OUTPUT_LENGTH),
    exitCodePromise,
  ]);
  signal?.removeEventListener("abort", abortChild);
  // A verifier may detach descendants before exiting. The verifier owns a
  // dedicated process group, so reap the whole group even on a successful exit.
  if (processGroupSignal("SIGTERM")) {
    await new Promise<void>((resolveGroup) => setTimeout(resolveGroup, 50));
    processGroupSignal("SIGKILL");
  }
  // Do not retain verifier output: even a sanitised environment can expose
  // host data through /proc or candidate-controlled imports. Exit status is
  // the only verifier evidence persisted in benchmark artifacts.
  return {
    exitCode,
    stdout: "",
    stderr: "",
    stdoutDropped: stdout.dropped + Buffer.byteLength(redactSecrets(stdout.text)),
    stderrDropped: stderr.dropped + Buffer.byteLength(redactSecrets(stderr.text)),
  };
}

export class LocalFixture implements PreparedFixture {
  readonly root: string;
  readonly worktrees: readonly FixtureWorktree[];
  private readonly baseline: ReadonlyMap<string, FileDigest>;
  private readonly metadataBaseline: readonly string[];
  private readonly protectedMetadataBaseline: ReadonlyMap<string, string>;
  private readonly allowedPaths: readonly string[];
  private readonly localWorktrees: readonly LocalWorktree[];

  constructor(root: string, allowedPaths: readonly string[] = PARALLEL_DIAGNOSIS_ALLOWED_PATHS, worktrees: readonly LocalWorktree[] = []) {
    this.root = root;
    this.allowedPaths = allowedPaths;
    this.baseline = snapshot(root);
    this.metadataBaseline = metadataPaths(root);
    this.protectedMetadataBaseline = protectedMetadataSnapshot(root);
    this.localWorktrees = worktrees;
    this.worktrees = worktrees.map(({ id, root: worktreeRoot, allowedPaths: paths }) => ({
      id,
      root: worktreeRoot,
      allowedPaths: paths,
    }));
  }

  verify(signal?: AbortSignal): Promise<BoundedCommandResult> {
    if (symlinkPaths(this.root).length > 0) {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "fixture contains symlinked files", stdoutDropped: 0, stderrDropped: 0 });
    }
    return runFixtureVerifier(this.root, signal);
  }

  async scope(signal?: AbortSignal): Promise<FixtureScopeResult> {
    if (signal?.aborted) throw new Error("fixture scope cancelled");
    const changed = changedPaths(this.root, this.baseline);
    const symlinks = symlinkPaths(this.root);
    const unexpected = [...new Set([
      ...changed.filter((path) => !this.allowedPaths.includes(path)),
      ...symlinks,
      ...metadataPaths(this.root).filter((path) => !this.metadataBaseline.includes(path)),
      ...[...new Set([...this.protectedMetadataBaseline.keys(), ...protectedMetadataSnapshot(this.root).keys()])]
        .filter((path) => this.protectedMetadataBaseline.get(path) !== protectedMetadataSnapshot(this.root).get(path)),
    ])].sort();
    return { passed: unexpected.length === 0, changedPaths: changed, unexpectedPaths: unexpected };
  }

  async inspectWorktrees(signal?: AbortSignal): Promise<readonly FixtureWorktreeResult[]> {
    if (signal?.aborted) throw new Error("fixture worktree inspection cancelled");
    return this.localWorktrees.map((worktree) => {
      const changed = changedPaths(worktree.root, worktree.baseline);
      const unexpected = [...new Set([
        ...changed.filter((path) => !worktree.allowedPaths.includes(path)),
        ...symlinkPaths(worktree.root),
        ...metadataPaths(worktree.root).filter((path) => path !== ".git"),
      ])].sort();
      const contents: Record<string, string> = {};
      for (const path of changed) {
        const fullPath = join(worktree.root, path);
        if (existsSync(fullPath)) contents[path] = readFileSync(fullPath, "utf8").slice(0, MAX_RUNNER_OUTPUT_LENGTH);
      }
      return { id: worktree.id, passed: unexpected.length === 0, changedPaths: changed, unexpectedPaths: unexpected, contents };
    });
  }

  async cleanup(): Promise<boolean> {
    // All generated worktrees are siblings under this private directory. A
    // single removal proves none survive the sample, without touching source templates.
    const parent = dirname(this.root);
    rmSync(parent, { recursive: true, force: true });
    return !existsSync(parent);
  }
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("benchmark fixture git worktree setup failed");
}

function prepareFixture(definition: FixtureDefinition): PreparedFixture {
  const parent = mkdtempSync(join(tmpdir(), `pi-subagents-${basename(definition.template)}-`));
  const root = join(parent, basename(definition.template));
  try {
    cpSync(definition.template, root, { recursive: true, force: false });
    const requestedWorktrees = definition.worktrees ?? [];
    if (requestedWorktrees.length === 0) return new LocalFixture(root, definition.allowedPaths);

    // A committed base lets parallel writers have independent index/HEAD state.
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "benchmark@example.invalid"]);
    git(root, ["config", "user.name", "Benchmark Fixture"]);
    git(root, ["add", "--all"]);
    git(root, ["commit", "-q", "-m", "benchmark fixture base"]);

    const worktrees: LocalWorktree[] = [];
    for (const definitionWorktree of requestedWorktrees) {
      const worktreeRoot = join(parent, `${basename(definition.template)}-${definitionWorktree.id}`);
      git(root, ["worktree", "add", "-q", "-b", `benchmark-${definitionWorktree.id}`, worktreeRoot]);
      worktrees.push({
        id: definitionWorktree.id,
        root: worktreeRoot,
        allowedPaths: definitionWorktree.allowedPaths,
        baseline: snapshot(worktreeRoot),
        metadataBaseline: metadataPaths(worktreeRoot),
      });
    }
    return new LocalFixture(root, definition.allowedPaths, worktrees);
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

/** Copy the tracked template before every run; source templates are never writable benchmark cwd values. */
export function createParallelDiagnosisFixtureLifecycle(
  template = PARALLEL_DIAGNOSIS_FIXTURE,
): FixtureLifecycle {
  return { async prepare(): Promise<PreparedFixture> {
    return prepareFixture({ template, allowedPaths: PARALLEL_DIAGNOSIS_ALLOWED_PATHS });
  } };
}

/** Two sibling worktrees give the parallel writers independent cwd/index state. */
export function createParallelImplementationFixtureLifecycle(
  template = PARALLEL_IMPLEMENTATION_FIXTURE,
): FixtureLifecycle {
  return { async prepare(): Promise<PreparedFixture> {
    return prepareFixture({
      template,
      allowedPaths: PARALLEL_IMPLEMENTATION_ALLOWED_PATHS,
      worktrees: [
        { id: "endpoint-port", allowedPaths: ["src/endpoint-port.mjs"] },
        { id: "canonical-tags", allowedPaths: ["src/canonical-tags.mjs"] },
      ],
    });
  } };
}

/** The implementation starts isolated; reviewers inspect the parent integration checkout. */
export function createReviewConvergenceFixtureLifecycle(
  template = REVIEW_CONVERGENCE_FIXTURE,
): FixtureLifecycle {
  return { async prepare(): Promise<PreparedFixture> {
    return prepareFixture({
      template,
      allowedPaths: REVIEW_CONVERGENCE_ALLOWED_PATHS,
      worktrees: [{ id: "redaction-implementation", allowedPaths: ["src/redact-headers.mjs"] }],
    });
  } };
}
