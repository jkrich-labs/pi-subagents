/**
 * Ring store — the live, in-process state shared between the hub (writes)
 * and UI widgets/overlays (read). Single object per pi process; paired by
 * that process only. No companion HTTP server (A1 verified in S-02).
 */
import { EventEmitter } from "node:events";
import type { AgentToolPolicy } from "../agents.ts";
export interface ChildUsage {
  /** Total tokens across all runs of this child session (incl. cache reads). */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export function blankUsage(): ChildUsage {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

/** Add one turn's provider-reported usage to the running child total. */
export function accumulateUsage(total: ChildUsage, raw: Record<string, unknown> | undefined): ChildUsage {
  if (!raw || typeof raw !== "object") return total;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const tokens = num(raw.totalTokens);
  const cost = raw.cost as Record<string, unknown> | undefined;
  return {
    totalTokens: total.totalTokens + tokens,
    inputTokens: total.inputTokens + num(raw.input),
    outputTokens: total.outputTokens + num(raw.output),
    cacheReadTokens: total.cacheReadTokens + num(raw.cacheRead),
    cacheWriteTokens: total.cacheWriteTokens + num(raw.cacheWrite),
    costUsd: total.costUsd + num(cost?.total),
  };
}

export type ChildStatus =
  | "spawning"
  | "working"
  | "asking"
  | "settled"
  | "done"
  | "failed"
  | "crashed"
  | "killed";

export type AttentionKind =
  | "settled-without-completion"
  | "provider-stall"
  | "tool-stall"
  | "semantic-stall"
  | "semantic-loop"
  | "missed-steer"
  | "long-turn";
export type SteerDeliveryState = "queued" | "delivered" | "missed";

export interface ChildView {
  id: string;
  title: string;
  status: ChildStatus;
  agent?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt?: string;
  toolPolicy?: AgentToolPolicy;
  spawnedAt: number;
  turnCount: number;
  compactions: number;
  lastCompletionAt?: number;
  ask?: string;
  error?: string;
  scopeCount: number;
  sessionFile?: string;
  stallCount: number;
  loopHits: number;
  usage: ChildUsage;
  /** Confirmations asked after a settle without DONE-PARENT (see hub finalize). */
  completionConfirmations: number;
  isStreaming?: boolean;
  currentTool?: string;
  lastActivityAt?: number;
  lastEventAt?: number;
  lastHeartbeatAt?: number;
  attentionKind?: AttentionKind;
  attentionMessage?: string;
  attentionAt?: number;
  steerState?: SteerDeliveryState;
  steerQueuedAt?: number;
  lastSteerAt?: number;
}

export function blankView(): ChildView {
  return {
    id: "",
    title: "",
    status: "spawning",
    spawnedAt: Date.now(),
    turnCount: 0,
    compactions: 0,
    scopeCount: 0,
    stallCount: 0,
    loopHits: 0,
    usage: blankUsage(),
    completionConfirmations: 0,
  };
}

export class RingStore extends EventEmitter {
  private children = new Map<string, ChildView>();

  upsert(id: string, patch: Partial<ChildView>): ChildView {
    const existing = this.children.get(id) ?? { ...blankView(), id };
    const next: ChildView = { ...existing, ...patch, id };
    this.children.set(id, next);
    this.emit("update", id, next);
    return next;
  }

  get(id: string): ChildView | undefined {
    return this.children.get(id);
  }

  list(): ChildView[] {
    return [...this.children.values()];
  }

  remove(id: string): void {
    this.children.delete(id);
    this.emit("remove", id);
  }

  /** Clear the fleet, notifying UI subscribers for session replacement. */
  reset(): void {
    const ids = [...this.children.keys()];
    this.children.clear();
    for (const id of ids) this.emit("remove", id);
  }
}

/** Process-wide singleton: hub writes, UI reads. */
export const ring = new RingStore();
