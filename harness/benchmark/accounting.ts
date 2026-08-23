/** Pure, bounded accounting over persisted pi v3 JSONL session records. */
import { resolve } from "node:path";
import {
  BenchmarkValidationError,
  assertBenchmarkSuiteManifest,
  validateFiniteNonNegativeMetrics,
  type BenchmarkDiagnostic,
  type BenchmarkParticipant,
  type BenchmarkSuiteManifest,
  type ModelPolicy,
  type SessionAccounting,
  type UsageBreakdown,
} from "./contracts.ts";

export const MAX_BENCHMARK_DIAGNOSTICS = 20;
export const MAX_BENCHMARK_DIAGNOSTIC_MESSAGE_LENGTH = 240;

export interface PersistedSession {
  /** Original session path retained for diagnostics and artifact provenance. */
  path: string;
  /** Runner-supplied realpath used to deduplicate symlink and relative aliases. */
  canonicalPath: string;
  participant: BenchmarkParticipant;
  /** The file contents are supplied by the runner so this seam remains pure. */
  jsonl: string;
}

export interface SessionAccountingOptions {
  /** Further reduce the hard diagnostic cap for a caller's artifact budget. */
  maxDiagnostics?: number;
}

type JsonRecord = Record<string, unknown>;

interface ParsedUsage {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticLimit(requested: number | undefined): number {
  if (requested === undefined) return MAX_BENCHMARK_DIAGNOSTICS;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new BenchmarkValidationError("maxDiagnostics must be a non-negative integer");
  }
  return Math.min(requested, MAX_BENCHMARK_DIAGNOSTICS);
}

function boundedMessage(message: string): string {
  return message.slice(0, MAX_BENCHMARK_DIAGNOSTIC_MESSAGE_LENGTH);
}

function policyFor(manifest: BenchmarkSuiteManifest, participant: BenchmarkParticipant): ModelPolicy {
  return participant === "parent" ? manifest.parent : manifest.child;
}

function assertPolicyField(field: "provider" | "model" | "thinking", actual: unknown, expected: string): void {
  if (actual !== expected) {
    throw new BenchmarkValidationError(`${field} drift from active suite manifest`);
  }
}

function parseUsage(value: unknown): ParsedUsage {
  if (!isRecord(value)) {
    throw new BenchmarkValidationError("persisted usage must be an object");
  }
  const fields = ["totalTokens", "input", "output", "cacheRead", "cacheWrite"] as const;
  const usage = {} as Record<(typeof fields)[number], number>;
  for (const field of fields) {
    const metric = value[field];
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      throw new BenchmarkValidationError(`persisted usage.${field} must be a finite, non-negative number`);
    }
    usage[field] = metric;
  }
  const componentTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (usage.totalTokens !== componentTotal) {
    throw new BenchmarkValidationError("persisted usage.totalTokens must equal its input/output/cache components");
  }
  return usage as ParsedUsage;
}

function emptyUsage(): UsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    parentTokens: 0,
    childTokens: 0,
  };
}

function addUsage(target: UsageBreakdown, participant: BenchmarkParticipant, rawUsage: unknown): void {
  const usage = parseUsage(rawUsage);
  target.totalTokens += usage.totalTokens;
  target.inputTokens += usage.input;
  target.outputTokens += usage.output;
  target.cacheReadTokens += usage.cacheRead;
  target.cacheWriteTokens += usage.cacheWrite;
  if (participant === "parent") target.parentTokens += usage.totalTokens;
  else target.childTokens += usage.totalTokens;
}

/**
 * Count only persisted usage-bearing pi records: assistant messages, nested tool
 * results, compactions, and branch summaries. Retained compaction tails are snapshots
 * of already persisted messages and intentionally are not counted a second time.
 */
export function accountPersistedSessions(
  manifest: BenchmarkSuiteManifest,
  sessions: readonly PersistedSession[],
  options: SessionAccountingOptions = {},
): SessionAccounting {
  assertBenchmarkSuiteManifest(manifest);
  const maxDiagnostics = diagnosticLimit(options.maxDiagnostics);
  const diagnostics: BenchmarkDiagnostic[] = [];
  let diagnosticsDropped = 0;
  const addDiagnostic = (code: string, message: string): void => {
    if (diagnostics.length < maxDiagnostics) diagnostics.push({ code, message: boundedMessage(message) });
    else diagnosticsDropped += 1;
  };

  if (sessions.length === 0) {
    throw new BenchmarkValidationError("benchmark accounting requires at least one persisted session");
  }
  const usage = emptyUsage();
  let toolFailures = 0;
  const seenPaths = new Set<string>();
  const seenSessionIds = new Set<string>();

  for (const session of sessions) {
    if (typeof session.path !== "string" || session.path.trim() === "") {
      throw new BenchmarkValidationError("persisted session path must be a non-empty string");
    }
    if (typeof session.canonicalPath !== "string" || session.canonicalPath.trim() === "") {
      throw new BenchmarkValidationError("persisted session canonicalPath must be a non-empty realpath");
    }
    if (session.participant !== "parent" && session.participant !== "child") {
      throw new BenchmarkValidationError("persisted session participant must be parent or child");
    }
    if (typeof session.jsonl !== "string") {
      throw new BenchmarkValidationError("persisted session JSONL must be a string");
    }

    const canonicalPath = resolve(session.canonicalPath);
    if (seenPaths.has(canonicalPath)) {
      addDiagnostic("duplicate-session-file", "duplicate persisted session file ignored");
      continue;
    }
    seenPaths.add(canonicalPath);

    const policy = policyFor(manifest, session.participant);
    const sessionUsage = emptyUsage();
    let sessionToolFailures = 0;
    const seenEntries = new Set<string>();
    let sessionHeaderCount = 0;
    let firstRecordSeen = false;
    let validSessionHeaderSeen = false;
    let duplicateSessionId = false;
    let thinkingPolicyEvidenceSeen = false;
    let modelPolicyEvidenceSeen = false;
    const lines = session.jsonl.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const sourceLine = lines[index].trim();
      if (sourceLine === "") continue;
      if (duplicateSessionId) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(sourceLine);
      } catch {
        addDiagnostic("malformed-jsonl", `malformed persisted JSONL record at line ${index + 1}`);
        continue;
      }
      if (!isRecord(entry) || typeof entry.type !== "string") {
        addDiagnostic("invalid-session-entry", `invalid persisted session entry at line ${index + 1}`);
        continue;
      }
      if (entry.type === "session") {
        sessionHeaderCount += 1;
        if (sessionHeaderCount > 1) {
          addDiagnostic("duplicate-session-header", "persisted session has more than one v3 session header");
        }
        if (firstRecordSeen) {
          addDiagnostic("misplaced-session-header", "persisted v3 session header must be the first record");
        }
        firstRecordSeen = true;
        const headerId = typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined;
        if (headerId !== undefined) {
          if (seenSessionIds.has(headerId)) {
            duplicateSessionId = true;
            addDiagnostic("duplicate-session-id", "persisted session id was already accounted");
          } else {
            seenSessionIds.add(headerId);
          }
        }
        if (entry.version !== 3) {
          addDiagnostic("unsupported-session-version", "persisted session is not version 3");
        } else if (headerId === undefined) {
          addDiagnostic("invalid-session-header", "persisted v3 session header has no id");
        } else if (typeof entry.timestamp !== "string" || entry.timestamp.trim() === "") {
          addDiagnostic("invalid-session-header", "persisted v3 session header has no timestamp");
        } else if (typeof entry.cwd !== "string" || entry.cwd.trim() === "") {
          addDiagnostic("invalid-session-header", "persisted v3 session header has no cwd");
        } else if (!duplicateSessionId) {
          validSessionHeaderSeen = true;
        }
        continue;
      }
      if (duplicateSessionId) continue;
      if (!firstRecordSeen) firstRecordSeen = true;
      if (typeof entry.id !== "string" || entry.id === "") {
        addDiagnostic("invalid-session-entry", `persisted session entry without an id at line ${index + 1}`);
        continue;
      }
      if (seenEntries.has(entry.id)) {
        addDiagnostic("duplicate-session-entry", "duplicate persisted session entry ignored");
        continue;
      }
      seenEntries.add(entry.id);

      if (entry.type === "model_change") {
        assertPolicyField("provider", entry.provider, policy.provider);
        assertPolicyField("model", entry.modelId, policy.model);
        modelPolicyEvidenceSeen = true;
        continue;
      }
      if (entry.type === "thinking_level_change") {
        assertPolicyField("thinking", entry.thinkingLevel, policy.thinking);
        thinkingPolicyEvidenceSeen = true;
        continue;
      }
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        if (entry.usage !== undefined) addUsage(sessionUsage, session.participant, entry.usage);
        continue;
      }
      if (entry.type !== "message" || !isRecord(entry.message)) continue;

      const message = entry.message;
      if (message.role === "assistant") {
        assertPolicyField("provider", message.provider, policy.provider);
        assertPolicyField("model", message.model, policy.model);
        modelPolicyEvidenceSeen = true;
        if (message.usage !== undefined) addUsage(sessionUsage, session.participant, message.usage);
        continue;
      }
      if (message.role === "toolResult") {
        if (typeof message.isError !== "boolean") {
          addDiagnostic("malformed-tool-result", "tool result is missing a boolean isError field");
        } else if (message.isError) {
          sessionToolFailures += 1;
        }
        if (message.usage !== undefined) addUsage(sessionUsage, session.participant, message.usage);
      }
    }

    if (!validSessionHeaderSeen && !duplicateSessionId) {
      addDiagnostic("missing-session-header", "persisted stream is missing a valid pi v3 session header");
    }
    if (!duplicateSessionId && !modelPolicyEvidenceSeen) {
      addDiagnostic("missing-model-policy", "persisted stream has no provider/model policy evidence");
    }
    if (!duplicateSessionId && !thinkingPolicyEvidenceSeen) {
      addDiagnostic("missing-thinking-policy", "persisted stream has no thinking-level policy evidence");
    }
    if (!duplicateSessionId && validSessionHeaderSeen) {
      usage.totalTokens += sessionUsage.totalTokens;
      usage.inputTokens += sessionUsage.inputTokens;
      usage.outputTokens += sessionUsage.outputTokens;
      usage.cacheReadTokens += sessionUsage.cacheReadTokens;
      usage.cacheWriteTokens += sessionUsage.cacheWriteTokens;
      usage.parentTokens += sessionUsage.parentTokens;
      usage.childTokens += sessionUsage.childTokens;
      toolFailures += sessionToolFailures;
    }
  }

  validateFiniteNonNegativeMetrics({
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    parent_tokens: usage.parentTokens,
    child_tokens: usage.childTokens,
    tool_failures: toolFailures,
    diagnostics_dropped: diagnosticsDropped,
  });

  return { usage, toolFailures, diagnostics, diagnosticsDropped };
}
