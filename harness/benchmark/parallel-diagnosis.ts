/** Real S-03 parallel diagnosis scenario built on the generic runner port. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { accountPersistedSessions, type PersistedSession } from "./accounting.ts";
import { createBenchmarkSample, type BenchmarkDiagnostic, type BenchmarkSample, type BenchmarkSuiteManifest, type QualityGateResult } from "./contracts.ts";
import { createParallelDiagnosisFixtureLifecycle, PARALLEL_DIAGNOSIS_ALLOWED_PATHS } from "./fixtures.ts";
import { PARALLEL_DIAGNOSIS_MANIFEST } from "./profile.ts";
import {
  lineHasCompletionFollowUp,
  lineHasTerminalMarker,
  runScenario,
  type ChildLifetime,
  type RunnerChildSnapshot,
  type RunnerCleanupResult,
  type RunnerParentProcess,
  type RunnerProcessPort,
  type ScenarioContract,
  type ScenarioEvidence,
  type ScenarioRunResult,
} from "./runner.ts";
import { RpcChild, type WireLine } from "../rpc-child.ts";
import { BENCHMARK_CHILD_POLICY_ENV } from "../../extensions/subagents/benchmark-policy.ts";

export const PARALLEL_DIAGNOSIS_SCENARIO_ID = "parallel-diagnosis";
export const PARALLEL_DIAGNOSIS_TERMINAL_MARKER = "BENCHMARK_PARALLEL_DIAGNOSIS_DONE";
export const BENCHMARK_PARALLEL_DELEGATION_ENV = "PI_SUBAGENTS_BENCHMARK_PARALLEL_DELEGATION";
const SCENARIO_TIMEOUT_MS = 5 * 60_000;

interface Pidfile {
  childId?: unknown;
  pid?: unknown;
  ppid?: unknown;
  spawnedAt?: unknown;
}

interface ProcIdentity {
  ppid: number;
  pgrp: number;
  session: number;
  startedAt: number;
  command: string;
}

function procIdentity(pid: number): ProcIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const boot = readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m);
    const startTicks = Number(fields[19]);
    const bootSeconds = Number(boot?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) return undefined;
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return {
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      session: Number(fields[3]),
      startedAt: bootSeconds * 1_000 + startTicks * 10,
      command,
    };
  } catch {
    return undefined;
  }
}

function trustedChildProcess(pid: number, spawnedAt: number, parentPid: number, parentIdentity: ProcIdentity | undefined): boolean {
  const identity = procIdentity(pid);
  if (!identity || !parentIdentity) return false;
  // The pidfile's parent must still be the authenticated benchmark parent;
  // process-group membership alone is not an ownership proof.
  if (identity.ppid !== parentPid) return false;
  if (identity.pgrp !== parentIdentity.pgrp || identity.session !== parentIdentity.session) return false;
  const parentExecutable = parentIdentity.command.split(/\s+/)[0];
  if (!parentExecutable || !identity.command.startsWith(parentExecutable)) return false;
  return Math.abs(identity.startedAt - spawnedAt) <= 30_000;
}

export interface SpawnRecord {
  title: string;
  agent: string;
  childId: string;
  cwd?: string;
  /** Parent persisted tool-result time, used only for workflow ordering gates. */
  spawnedAt?: number;
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

function pidSnapshots(directory: string, parentPid: number | undefined): RunnerChildSnapshot[] {
  if (!existsSync(directory) || parentPid === undefined) return [];
  const parentIdentity = procIdentity(parentPid);
  if (!parentIdentity) return [];
  const found: RunnerChildSnapshot[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".pid")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as Pidfile;
      const validShape = typeof parsed.childId === "string" &&
        typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
        typeof parsed.ppid === "number" && parsed.ppid === parentPid &&
        typeof parsed.spawnedAt === "number" && Number.isFinite(parsed.spawnedAt);
      const trusted = validShape && trustedChildProcess(parsed.pid as number, parsed.spawnedAt as number, parentPid, parentIdentity);
      if (trusted) {
        const identity = procIdentity(parsed.pid as number);
        found.push({
          id: parsed.childId as string,
          pid: parsed.pid as number,
          startedAt: parsed.spawnedAt as number,
          parentPid: identity?.ppid,
          processGroup: identity?.pgrp,
          sessionId: identity?.session,
        });
      }
    } catch {
      // A partial liveness file cannot prove a benchmark child lifetime.
    }
  }
  return found.sort((left, right) => left.pid - right.pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Stop only child PIDs discovered in this sample's private hub ground. */
async function stopObservedChildren(observed: readonly RunnerChildSnapshot[]): Promise<RunnerCleanupResult> {
  const trusted = observed.filter((child) => {
    const identity = procIdentity(child.pid);
    return identity !== undefined &&
      Math.abs(identity.startedAt - child.startedAt) <= 30_000 &&
      (child.parentPid === undefined || identity.ppid === child.parentPid) &&
      (child.processGroup === undefined || identity.pgrp === child.processGroup) &&
      (child.sessionId === undefined || identity.session === child.sessionId);
  });
  const pids = [...new Set(trusted.map((child) => child.pid))].sort((left, right) => left - right);
  const groups = [...new Set(trusted.map((child) => child.processGroup).filter((group): group is number => group !== undefined && group > 1))];
  for (const group of groups) {
    try { process.kill(-group, "SIGTERM"); } catch { /* group already exited */ }
  }
  for (const pid of pids) {
    if (!processIsAlive(pid)) continue;
    try { process.kill(pid, "SIGTERM"); } catch { /* child already exited */ }
  }
  await delay(100);
  for (const group of groups) {
    try { process.kill(-group, "SIGKILL"); } catch { /* group already exited */ }
  }
  for (const child of trusted) {
    const identity = procIdentity(child.pid);
    if (!identity || Math.abs(identity.startedAt - child.startedAt) > 30_000 ||
        (child.parentPid !== undefined && identity.ppid !== child.parentPid) ||
        (child.processGroup !== undefined && identity.pgrp !== child.processGroup) ||
        (child.sessionId !== undefined && identity.session !== child.sessionId) ||
        !processIsAlive(child.pid)) continue;
    try { process.kill(child.pid, "SIGKILL"); } catch { /* child already exited */ }
  }
  await delay(25);
  const liveGroups = groups.filter((group) => {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }).map((group) => -group);
  return { childPids: pids, liveProcessPids: [...pids.filter(processIsAlive), ...liveGroups] };
}

class RealParent implements RunnerParentProcess {
  readonly pid: number | undefined;
  private readonly child: RpcChild;
  get lines(): readonly WireLine[] { return this.child.lines; }

  constructor(child: RpcChild) {
    this.child = child;
    this.pid = child.proc.pid;
  }

  async sendInitialPrompt(message: string): Promise<void> {
    const response = await this.child.send("prompt", { message }, 15_000);
    if (!response.success) throw new Error("parent rejected benchmark initial prompt");
  }

  subscribe(listener: (line: WireLine) => void): () => void {
    return this.child.onLine(listener);
  }

  shutdown(): Promise<void> {
    return this.child.shutdown(15_000);
  }

  isRunning(): boolean {
    return this.child.isRunning();
  }

  sessionFile(): string | undefined {
    return this.session;
  }

  setSessionFile(path: string): void {
    this.session = path;
  }

  private session: string | undefined;
}

export class RealRunnerPort implements RunnerProcessPort {
  private readonly sampleDirectory: string;
  private readonly parentSessions: string;
  private readonly subagentGround: string;
  private parent: RealParent | undefined;
  private parentPid: number | undefined;
  private readonly manifest: BenchmarkSuiteManifest;
  private readonly parallelDelegation: boolean;

  constructor(sampleDirectory: string, manifest: BenchmarkSuiteManifest = PARALLEL_DIAGNOSIS_MANIFEST, parallelDelegation = true) {
    this.sampleDirectory = sampleDirectory;
    this.parentSessions = join(sampleDirectory, "parent-sessions");
    this.subagentGround = join(sampleDirectory, "subagents");
    this.manifest = manifest;
    this.parallelDelegation = parallelDelegation;
    mkdirSync(this.parentSessions, { recursive: true });
    mkdirSync(this.subagentGround, { recursive: true });
  }

  async launchParent(input: {
    cwd: string;
    scenarioId: string;
    parentPolicy: { provider: string; model: string; thinking: string };
    signal: AbortSignal;
  }): Promise<RunnerParentProcess> {
    const extensionPath = resolve(import.meta.dirname, "../../extensions/subagents/index.ts");
    const child = await RpcChild.spawnAndWaitReady({
      sessionDir: this.parentSessions,
      name: `benchmark-${input.scenarioId}-parent`,
      provider: input.parentPolicy.provider,
      model: input.parentPolicy.model,
      thinking: input.parentPolicy.thinking,
      tools: "normal",
      cwd: input.cwd,
      env: {
        ...process.env,
        SUBAGENT_GROUND: this.subagentGround,
        [BENCHMARK_CHILD_POLICY_ENV]: JSON.stringify(this.manifest.child),
        ...(this.parallelDelegation ? { [BENCHMARK_PARALLEL_DELEGATION_ENV]: "1" } : {}),
      },
      extraArgs: ["-e", extensionPath],
      detached: true,
    }, input.signal);
    const abortChild = (): void => child.kill();
    input.signal.addEventListener("abort", abortChild, { once: true });
    try {
      const state = await child.send("get_state", {});
      const sessionFile = (state.data as { sessionFile?: unknown } | undefined)?.sessionFile;
      if (typeof sessionFile !== "string" || sessionFile === "") {
        throw new Error("parent did not expose a persisted session file");
      }
      this.parent = new RealParent(child);
      this.parentPid = this.parent.pid;
      this.parent.setSessionFile(sessionFile);
      return this.parent;
    } catch (error) {
      await child.shutdown(5_000);
      throw error;
    } finally {
      input.signal.removeEventListener("abort", abortChild);
    }
  }

  snapshotChildren(): readonly RunnerChildSnapshot[] {
    const direct = pidSnapshots(join(this.subagentGround, "pids"), this.parent?.pid);
    const known = new Set(direct.map((child) => child.pid));
    const escaped = new Map<number, RunnerChildSnapshot>();
    const identities = new Map<number, ProcIdentity>();
    try {
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (pid === process.pid || pid === this.parentPid || known.has(pid)) continue;
        const identity = procIdentity(pid);
        if (identity) identities.set(pid, identity);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, identity] of identities) {
          if (escaped.has(pid) || !known.has(identity.ppid)) continue;
          escaped.set(pid, { id: `escaped-${pid}`, pid, startedAt: identity.startedAt, parentPid: identity.ppid, processGroup: identity.pgrp, sessionId: identity.session });
          known.add(pid);
          changed = true;
        }
      }
      for (const [pid, identity] of identities) {
        if (escaped.has(pid)) continue;
        try {
          const cwd = realpathSync(`/proc/${pid}/cwd`);
          if (cwd === this.sampleDirectory || cwd.startsWith(`${this.sampleDirectory}/`)) {
            escaped.set(pid, { id: `escaped-${pid}`, pid, startedAt: identity.startedAt, parentPid: identity.ppid, processGroup: identity.pgrp, sessionId: identity.session });
          }
        } catch {
          continue;
        }
      }
    } catch {
      // A disappearing /proc entry is not evidence of a live process.
    }
    return [...direct, ...escaped.values()].sort((left, right) => left.pid - right.pid);
  }

  cleanupChildren(observed: readonly RunnerChildSnapshot[]): Promise<RunnerCleanupResult> {
    return stopObservedChildren([...observed, ...this.snapshotChildren()]);
  }

  hasChildFailure(): boolean {
    const directory = join(this.subagentGround, "tombstones");
    if (!existsSync(directory)) return false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const contents = readFileSync(join(directory, entry.name), "utf8");
        for (const raw of contents.split(/\r?\n/)) {
          if (!raw.trim()) continue;
          const tombstone = JSON.parse(raw) as { reason?: unknown };
          if (tombstone.reason !== "kill" && tombstone.reason !== "idle-reap") return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  sessionRecords(): PersistedSession[] {
    const parentSession = this.parent?.sessionFile();
    if (!parentSession || !existsSync(parentSession)) throw new Error("parent persisted session file is missing");
    const children = jsonlFiles(join(this.subagentGround, "sessions"));
    return [{
      path: parentSession,
      canonicalPath: realpathSync(parentSession),
      participant: "parent" as const,
      jsonl: readFileSync(parentSession, "utf8"),
    }, ...children.map((path) => ({
      path,
      canonicalPath: realpathSync(path),
      participant: "child" as const,
      jsonl: readFileSync(path, "utf8"),
    }))];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolArguments(part: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const candidate of [part.arguments, part.input, part.params]) {
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate);
        const record = asRecord(parsed);
        if (record) return record;
      } catch {
        continue;
      }
    }
    const record = asRecord(candidate);
    if (record) return record;
  }
  return undefined;
}

/** Read only successful spawn metadata, never persist prompt contents into the artifact. */
export function spawnRecordsFromParentSession(jsonl: string): SpawnRecord[] {
  const calls = new Map<string, Omit<SpawnRecord, "childId">>();
  const records: SpawnRecord[] = [];
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (!message) continue;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const rawPart of message.content) {
          const part = asRecord(rawPart);
          if (!part || part.type !== "toolCall" || part.name !== "spawn_subagent" || typeof part.id !== "string") continue;
          const args = toolArguments(part);
          if (typeof args?.title === "string" && typeof args.agent === "string") {
            calls.set(part.id, {
              title: args.title,
              agent: args.agent,
              ...(typeof args.cwd === "string" && args.cwd !== "" ? { cwd: args.cwd } : {}),
            });
          }
        }
        continue;
      }
      if (message.role !== "toolResult" || message.toolName !== "spawn_subagent" || message.isError === true) continue;
      const callId = message.toolCallId;
      const details = asRecord(message.details);
      const childId = details?.childId;
      const call = typeof callId === "string" && calls.get(callId);
      if (call && typeof childId === "string" && childId !== "") {
        const spawnedAt = messageTimestamp(entry);
        records.push({ ...call, childId, ...(spawnedAt !== undefined ? { spawnedAt } : {}) });
      }
    } catch {
      // Accounting produces the canonical malformed-session diagnosis.
    }
  }
  return records;
}

export function sessionChildId(jsonl: string): string | undefined {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      if (entry?.type !== "session_info") continue;
      const name = entry.name;
      if (typeof name === "string" && name.startsWith("subagent-")) return name.slice("subagent-".length);
    } catch {
      continue;
    }
  }
  return undefined;
}

function messageTimestamp(entry: Record<string, unknown>): number | undefined {
  const timestamp = entry.timestamp;
  if (typeof timestamp !== "string") return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function childDoneAt(jsonl: string): number | undefined {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (/\bDONE-PARENT\b/.test(assistantText(message))) {
        return entry ? messageTimestamp(entry) : undefined;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function sessionStartAt(jsonl: string): number | undefined {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      if (entry?.type === "session") return messageTimestamp(entry);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function childSessionsOverlap(sessions: readonly PersistedSession[]): boolean {
  const intervals = sessions.map((session) => ({ start: sessionStartAt(session.jsonl), end: childDoneAt(session.jsonl) }))
    .filter((interval): interval is { start: number; end: number } => interval.start !== undefined && interval.end !== undefined);
  for (let left = 0; left < intervals.length; left += 1) {
    for (let right = left + 1; right < intervals.length; right += 1) {
      if (Math.max(intervals[left].start, intervals[right].start) < Math.min(intervals[left].end, intervals[right].end)) return true;
    }
  }
  return false;
}

export interface ParentCompletionFollowUp {
  childId: string;
  at: number;
}

export function parentCompletionFollowUps(jsonl: string): ParentCompletionFollowUp[] {
  const followUps: ParentCompletionFollowUp[] = [];
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (message?.role !== "user" || !Array.isArray(message.content)) continue;
      const text = message.content.map(asRecord)
        .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string).join("\n");
      const match = /\[subagent ([^\]]+)\]\s+COMPLETED:/m.exec(text);
      const at = entry ? messageTimestamp(entry) : undefined;
      if (match && at !== undefined) followUps.push({ childId: match[1], at });
    } catch {
      continue;
    }
  }
  return followUps;
}

function parentToolCalls(jsonl: string): Array<{ name: string; at: number; mutation: boolean; paths: string[]; successful: boolean }> {
  const calls: Array<{ name: string; at: number; mutation: boolean; paths: string[]; successful: boolean; callId?: string }> = [];
  const results = new Map<string, boolean>();
  const lines = jsonl.split(/\r?\n/);
  for (const raw of lines) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        results.set(message.toolCallId, message.isError === false);
      }
    } catch {
      continue;
    }
  }
  for (const raw of lines) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      const at = entry ? messageTimestamp(entry) : undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content) || at === undefined) continue;
      for (const rawPart of message.content) {
        const part = asRecord(rawPart);
        if (typeof part?.name !== "string") continue;
        const args = toolArguments(part);
        const command = typeof args?.command === "string" ? args.command : typeof args?.input === "string" ? args.input : "";
        const argumentPath = [args?.path, args?.filePath, args?.file, args?.target]
          .find((value): value is string => typeof value === "string");
        const gitIntegration = part.name === "bash" && /\bgit\s+(?:merge|cherry-pick)\b/i.test(command);
        const paths = argumentPath ? [argumentPath] : [
          ...[...command.matchAll(/((?:src|lib|harness|extensions)\/[A-Za-z0-9_./-]+)/g)].map((match) => match[1]),
          ...[...command.matchAll(/([A-Za-z0-9_.-]+\.mjs)/g)].map((match) => match[1]),
          ...(gitIntegration ? ["__git_integration__"] : []),
        ];
        const mutation = ["edit", "write", "apply_patch", "cursorPiEdit", "cursor_pi_edit"].includes(part.name) ||
          gitIntegration ||
          (part.name === "bash" && /(?:>|>>|\b(?:sed\s+-i|perl\s+-i|tee|cp|mv|python(?:3)?|node\s+-e)\b)/i.test(command));
        const callId = typeof part.id === "string" ? part.id : undefined;
        calls.push({ name: part.name, at, mutation, paths, successful: callId !== undefined && results.get(callId) === true, ...(callId ? { callId } : {}) });
      }
    } catch {
      continue;
    }
  }
  return calls.map(({ callId, ...call }) => ({ ...call, successful: callId === undefined ? call.successful : call.successful }));
}

export function integrationAfterReports(jsonl: string, requiredChildIds: readonly string[], marker: string, allowedPaths: readonly string[]): boolean {
  const reports = new Map(parentCompletionFollowUps(jsonl).map((followUp) => [followUp.childId, followUp.at]));
  const terminal = parentTerminalAt(jsonl, marker);
  if (requiredChildIds.length === 0 || new Set(requiredChildIds).size !== requiredChildIds.length ||
      requiredChildIds.some((childId) => !reports.has(childId)) || terminal === undefined) return false;
  const reportTimes = requiredChildIds.map((childId) => reports.get(childId) as number);
  const firstReport = Math.min(...reportTimes);
  const lastReport = Math.max(...reportTimes);
  const calls = parentToolCalls(jsonl);
  const allowedMutation = (call: typeof calls[number]): boolean => call.successful && call.mutation &&
    (call.paths.includes("__git_integration__") || call.paths.some((path) => allowedPaths.some((allowed) => path === allowed || path.endsWith(`/${allowed}`))));
  if (calls.some((call) => allowedMutation(call) && call.at < firstReport)) return false;
  const result = calls.some((call) => allowedMutation(call) && call.at > lastReport && call.at < terminal &&
    (call.paths.includes("__git_integration__") || call.paths.some((path) => allowedPaths.some((allowed) => path === allowed || path.endsWith(`/${allowed}`)))));
  return result;
}

export function reviewIntegrationOrdering(jsonl: string, implementerId: string, reviewerIds: readonly string[], marker: string, allowedPaths: readonly string[]): boolean {
  const spawns = spawnRecordsFromParentSession(jsonl);
  const implementer = spawns.find((spawn) => spawn.childId === implementerId);
  const reviewers = reviewerIds.map((id) => spawns.find((spawn) => spawn.childId === id));
  const followUps = new Map(parentCompletionFollowUps(jsonl).map((followUp) => [followUp.childId, followUp.at]));
  const implementationReport = followUps.get(implementerId);
  const reviewerSpawnTimes = reviewers.map((reviewer) => reviewer?.spawnedAt);
  if (!implementer || implementationReport === undefined || reviewerSpawnTimes.some((at) => at === undefined) ||
      new Set([implementerId, ...reviewerIds]).size !== reviewerIds.length + 1) return false;
  const firstReviewerSpawn = Math.min(...reviewerSpawnTimes as number[]);
  const lastReviewerReport = Math.max(...reviewerIds.map((id) => followUps.get(id) ?? -1));
  const terminal = parentTerminalAt(jsonl, marker);
  if (lastReviewerReport < 0 || terminal === undefined || lastReviewerReport >= terminal) return false;
  const calls = parentToolCalls(jsonl).filter((call) => call.successful && call.mutation);
  const hasAllowedPath = (call: { paths: string[] }): boolean => call.paths.includes("__git_integration__") || call.paths.some((path) =>
    allowedPaths.some((allowed) => path === allowed || path.endsWith(`/${allowed}`)));
  if (calls.some((call) => call.at > (implementer.spawnedAt ?? implementationReport) && call.at < implementationReport && hasAllowedPath(call))) return false;
  const integratedBeforeReview = calls.some((call) => call.at > implementationReport && call.at < firstReviewerSpawn && hasAllowedPath(call));
  const integratedAfterReview = calls.some((call) => call.at > lastReviewerReport && call.at < terminal && hasAllowedPath(call));
  return integratedBeforeReview && integratedAfterReview && reviewerIds.every((id) => {
    const report = followUps.get(id);
    const spawn = spawns.find((item) => item.childId === id)?.spawnedAt;
    return report !== undefined && spawn !== undefined && report >= spawn;
  });
}

export function parentTerminalAt(jsonl: string, marker = PARALLEL_DIAGNOSIS_TERMINAL_MARKER): number | undefined {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (assistantText(message).includes(marker)) {
        return entry ? messageTimestamp(entry) : undefined;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function assistantText(message: unknown): string {
  const record = asRecord(message);
  if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return "";
  return record.content.map(asRecord)
    .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export function childHasDoneReport(jsonl: string): boolean {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (/\bDONE-PARENT\b/.test(assistantText(message))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function childHasFailure(jsonl: string): boolean {
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      if (message && message.role === "assistant" &&
          (entry?.stopReason === "error" || typeof entry?.errorMessage === "string" ||
           message.stopReason === "error" || typeof message.errorMessage === "string")) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function persistedAutonomousCompletion(jsonl: string, marker = PARALLEL_DIAGNOSIS_TERMINAL_MARKER): boolean {
  let completionIndex = -1;
  let terminalIndex = -1;
  let index = 0;
  for (const raw of jsonl.split(/\r?\n/)) {
    try {
      const entry = asRecord(JSON.parse(raw));
      const message = entry && asRecord(entry.message);
      const content = message?.content;
      const text = Array.isArray(content)
        ? content.map(asRecord)
          .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
        : "";
      if (message?.role === "user" && text.includes("] COMPLETED:") && completionIndex < 0) completionIndex = index;
      if (message?.role === "assistant" && text.includes(marker) && terminalIndex < 0) terminalIndex = index;
      index += 1;
    } catch {
      continue;
    }
  }
  return completionIndex >= 0 && terminalIndex >= 0 && completionIndex < terminalIndex;
}

function brief(fixtureRoot: string): string {
  return [
    "Complete the parallel diagnosis and integration benchmark autonomously.",
    `Your working directory is the isolated fixture: ${fixtureRoot}`,
    "The fixture's verifier currently fails for two independent production behaviors. First issue TWO spawn_subagent tool calls for the following exact workstreams, using agent explorer and these exact titles: retry-after-explorer and request-id-explorer.",
    "Give retry-after-explorer a read-only investigation of src/retry-after.mjs and the Retry-After failure. Give request-id-explorer a read-only investigation of src/request-id.mjs and the request-id failure. Each must inspect the fixture, run node verifier.mjs if useful, report evidence and a recommendation, and end with DONE-PARENT. Do not ask either child to edit files.",
    "Launch both explorers before doing integration work. Do not use shell sleep, process inspection, raw nested pi, or continuation prompts. Wait for the automatic model-visible child completion reports.",
    "After both reports arrive, integrate the two fixes yourself. You may change only src/retry-after.mjs and src/request-id.mjs. Do not modify verifier.mjs, package.json, or add files.",
    "Run node verifier.mjs from the fixture root. Only after it passes and both child reports have arrived, reply with this exact standalone terminal marker:",
    PARALLEL_DIAGNOSIS_TERMINAL_MARKER,
  ].join("\n");
}

interface ParallelScenarioArtifact {
  schemaVersion: 1;
  suiteId: string;
  suiteDigest: string;
  modelPolicyDigest: string;
  activeManifest: typeof PARALLEL_DIAGNOSIS_MANIFEST;
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
    expectedExplorerRoles: readonly string[];
    observedExplorerRoles: readonly string[];
    childLifetimes: readonly ChildLifetime[];
    overlapIntervals: readonly { leftPid: number; rightPid: number; observedAt: number }[];
    fixtureVerification: { passed: boolean; exitCode: number | null; stdout: string; stderr: string; outputDropped: number };
    scope: { passed: boolean; changedPaths: readonly string[]; unexpectedPaths: readonly string[] };
  };
  children: readonly { provider: string; model: string; thinking: string; policyVerified: boolean }[];
  cleanup: ScenarioRunResult["cleanup"];
  qualityGates: readonly QualityGateResult[];
  diagnostics: readonly BenchmarkDiagnostic[];
  diagnosticsDropped: number;
  kpis: { wall_time_ms: number; total_tokens: number; tool_failures: number };
  sample: BenchmarkSample;
}

function scenarioContract(port: RealRunnerPort): ScenarioContract {
  return {
    id: PARALLEL_DIAGNOSIS_SCENARIO_ID,
    terminalMarker: PARALLEL_DIAGNOSIS_TERMINAL_MARKER,
    initialBrief: brief,
    fixture: createParallelDiagnosisFixtureLifecycle(),
    parentPolicy: PARALLEL_DIAGNOSIS_MANIFEST.parent,
    childPolicy: PARALLEL_DIAGNOSIS_MANIFEST.child,
    deadlineMs: SCENARIO_TIMEOUT_MS,
    minimumChildren: 2,
    expectedRoles: [
      { title: "retry-after-explorer", agent: "explorer" },
      { title: "request-id-explorer", agent: "explorer" },
    ],
    async collectEvidence(): Promise<ScenarioEvidence> {
      const sessions = port.sessionRecords();
      const parent = sessions.find((session) => session.participant === "parent");
      const children = sessions.filter((session) => session.participant === "child");
      const successfulSpawns = parent ? spawnRecordsFromParentSession(parent.jsonl) : [];
      const childById = new Map(children.map((child) => [sessionChildId(child.jsonl), child] as const));
      const requiredSpawns = PARALLEL_DIAGNOSIS_REQUIREMENTS.expectedRoles.map((role) =>
        successfulSpawns.find((spawn) => spawn.title === role.title && spawn.agent === role.agent),
      );
      const requiredChildren = requiredSpawns
        .map((spawn) => spawn ? childById.get(spawn.childId) : undefined)
        .filter((child): child is PersistedSession => child !== undefined);
      const terminalAt = parent ? parentTerminalAt(parent.jsonl) : undefined;
      const reportTimes = requiredChildren.map((child) => childDoneAt(child.jsonl));
      const childReportsBeforeTerminal = requiredChildren.length === PARALLEL_DIAGNOSIS_REQUIREMENTS.expectedRoles.length &&
        reportTimes.every((at) => at !== undefined && terminalAt !== undefined && at <= terminalAt);
      let modelPolicyPassed = false;
      try {
        const accounting = accountPersistedSessions(PARALLEL_DIAGNOSIS_MANIFEST, sessions);
        modelPolicyPassed = accounting.diagnostics.length === 0 && accounting.diagnosticsDropped === 0;
      } catch {
        modelPolicyPassed = false;
      }
      return {
        observedRoles: successfulSpawns
          .filter((spawn) => childById.has(spawn.childId))
          .map(({ title, agent }) => ({ title, agent })),
        childFailure: port.hasChildFailure() || children.some((child) => childHasFailure(child.jsonl)),
        modelPolicyPassed,
        requiredChildCount: requiredChildren.length,
        completedChildReports: requiredChildren.filter((child) => childHasDoneReport(child.jsonl)).length,
        childReportsBeforeTerminal,
        integrationAfterReports: parent ? integrationAfterReports(
          parent.jsonl,
          requiredSpawns.map((spawn) => spawn?.childId).filter((id): id is string => id !== undefined),
          PARALLEL_DIAGNOSIS_TERMINAL_MARKER,
          PARALLEL_DIAGNOSIS_ALLOWED_PATHS,
        ) : false,
        requiredOverlap: childSessionsOverlap(requiredChildren),
        autonomousCompletion: parent ? persistedAutonomousCompletion(parent.jsonl) : false,
      };
    },
  };
}

function accountingFor(port: RealRunnerPort): { accounting: ReturnType<typeof accountPersistedSessions>; diagnostics: BenchmarkDiagnostic[] } {
  try {
    const accounting = accountPersistedSessions(PARALLEL_DIAGNOSIS_MANIFEST, port.sessionRecords());
    return { accounting, diagnostics: [...accounting.diagnostics] };
  } catch {
    // A policy/session failure is already a hard quality gate. Keep failure artifacts finite.
    const zero = {
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, parentTokens: 0, childTokens: 0 },
      toolFailures: 0,
      diagnostics: [{ code: "session-accounting", message: "persisted session accounting rejected" }],
      diagnosticsDropped: 0,
    };
    return { accounting: zero, diagnostics: [...zero.diagnostics] };
  }
}

export async function runParallelDiagnosis(): Promise<ParallelScenarioArtifact> {
  const sampleDirectory = mkdtempSync(join(tmpdir(), `pi-subagents-${PARALLEL_DIAGNOSIS_SCENARIO_ID}-`));
  const port = new RealRunnerPort(sampleDirectory, PARALLEL_DIAGNOSIS_MANIFEST);
  const result = await runScenario(scenarioContract(port), port);
  const { accounting, diagnostics: accountingDiagnostics } = accountingFor(port);
  const scenarioGates = result.qualityGates;
  const sample = createBenchmarkSample({
    manifest: PARALLEL_DIAGNOSIS_MANIFEST,
    wallTimeMs: result.wallTimeMs,
    accounting,
    launchTrace: result.launchTrace,
    scenarios: [{
      id: PARALLEL_DIAGNOSIS_SCENARIO_ID,
      wallTimeMs: result.wallTimeMs,
      usage: accounting.usage,
      toolFailures: accounting.toolFailures,
      qualityGates: scenarioGates,
    }],
    qualityGates: scenarioGates,
  });
  const verification = result.fixtureVerification;
  const scope = result.scope;
  const allDiagnostics: BenchmarkDiagnostic[] = [
    ...accountingDiagnostics,
    ...result.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
  ].slice(0, 20);
  const diagnosticsDropped = accounting.diagnosticsDropped + result.diagnosticsDropped +
    Math.max(0, accountingDiagnostics.length + result.diagnostics.length - allDiagnostics.length);
  const artifact: ParallelScenarioArtifact = {
    schemaVersion: 1,
    suiteId: PARALLEL_DIAGNOSIS_MANIFEST.id,
    suiteDigest: PARALLEL_DIAGNOSIS_MANIFEST.suiteDigest,
    modelPolicyDigest: PARALLEL_DIAGNOSIS_MANIFEST.modelPolicyDigest,
    activeManifest: PARALLEL_DIAGNOSIS_MANIFEST,
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
      expectedExplorerRoles: ["retry-after-explorer", "request-id-explorer"],
      observedExplorerRoles: result.evidence?.observedRoles
        .filter((role) => role.agent === "explorer")
        .map((role) => role.title) ?? [],
      childLifetimes: result.childLifetimes,
      overlapIntervals: result.overlapIntervals,
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
      ...PARALLEL_DIAGNOSIS_MANIFEST.child,
      policyVerified: result.evidence?.modelPolicyPassed === true,
    })),
    cleanup: result.cleanup,
    qualityGates: sample.qualityGates,
    diagnostics: allDiagnostics,
    diagnosticsDropped,
    kpis: {
      wall_time_ms: sample.wallTimeMs,
      total_tokens: sample.totalTokens,
      tool_failures: sample.toolFailures,
    },
    sample,
  };
  // Return failed artifacts too: the CLI writes bounded diagnostics before it
  // exits non-zero, while deterministic callers can inspect each hard gate.
  rmSync(sampleDirectory, { recursive: true, force: true });
  return artifact;
}

/** Exported for runner tests without exposing a real provider/process requirement. */
export const PARALLEL_DIAGNOSIS_REQUIREMENTS = {
  id: PARALLEL_DIAGNOSIS_SCENARIO_ID,
  terminalMarker: PARALLEL_DIAGNOSIS_TERMINAL_MARKER,
  minimumChildren: 2,
  expectedRoles: [
    { title: "retry-after-explorer", agent: "explorer" },
    { title: "request-id-explorer", agent: "explorer" },
  ],
} as const;

export { lineHasCompletionFollowUp, lineHasTerminalMarker };
