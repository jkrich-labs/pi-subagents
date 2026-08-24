/**
 * Hub controller — spawns, steers and finalizes child processes.
 * The hub never caps children (no turn/token/wall-clock bounds); "done"-ness
 * is the child's DONE-PARENT or the toy cancel. Termination based on
 * process/transport facts only (Regime A); semantic probes (Regime B) never
 * kill — S-08.
 */
import { Ground } from "./ground.ts";
import { RpcChild, type CommandResponse, type RpcChildHandle, type RpcChildOptions } from "./child.ts";
import { ring, type AttentionKind, type ChildView } from "./ring/store.ts";
import { reportFrom as tokenReport } from "./tokens.ts";
import { boundLensText, makeAskLens, makeCompletionLens, type Lens } from "./lenses.ts";
import { resolveSpawn } from "./registry.ts";
import { agentRegistry, type AgentToolPolicy } from "./agents.ts";

export interface SpawnRequest {
  title?: string;
  prompt: string;
  agent?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  /** Optional worktree/directory in which the child process starts. */
  cwd?: string;
}

/**
 * Runner-supplied child settings for an opt-in benchmark only. They bypass
 * interactive preset resolution after the preset has supplied its role prompt.
 */
export interface BenchmarkChildLaunchPolicy {
  provider: string;
  model: string;
  thinking: string;
}

function validateBenchmarkChildPolicy(policy: BenchmarkChildLaunchPolicy): BenchmarkChildLaunchPolicy {
  const provider = policy.provider?.trim();
  const model = policy.model?.trim();
  const thinking = policy.thinking?.trim();
  if (!provider || !model || !thinking) {
    throw new Error("benchmark child policy requires non-empty provider, model, and thinking values");
  }
  return { provider, model, thinking };
}

export type Delivery =
  | { type: "lens"; lens: Lens; final: boolean }
  | { type: "ask"; childId: string; question: string }
  | { type: "attention"; childId: string; kind: AttentionKind; summary: string }
  | { type: "control"; childId: string; token: string; reportDelivered?: boolean }
  | { type: "crash"; childId: string; reason: string };

export interface ChildStatusSnapshot {
  id: string;
  title: string;
  status: ChildView["status"];
  agent?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  alive: boolean;
  isStreaming: boolean;
  currentTool?: string;
  spawnedAt: number;
  turnCount: number;
  compactions: number;
  lastActivityAt?: number;
  lastEventAt?: number;
  lastHeartbeatAt?: number;
  lastCompletionAt?: number;
  ask?: string;
  error?: string;
  attentionKind?: AttentionKind;
  attentionMessage?: string;
  attentionAt?: number;
  steerState?: ChildView["steerState"];
  steerQueuedAt?: number;
  lastSteerAt?: number;
}

const ACTIVE_STATUSES = new Set<ChildView["status"]>(["spawning", "working", "asking"]);
const REAPABLE_STATUSES = new Set<ChildView["status"]>(["settled", "done", "failed"]);
const DEFAULT_IDLE_REAP_MS = 5 * 60_000;

interface ChildState {
  id: string;
  title: string;
  child: RpcChildHandle;
  agent?: string;
  cwd?: string;
  model: string;
  provider: string;
  thinking: string;
  systemPrompt: string;
  toolPolicy: AgentToolPolicy;
  sessionFile?: string;
  turnCount: number;
  compactions: number;
  finalizedEnds: number;
  generation: number;
  pendingTurnError?: string;
  pendingTurnMessage?: Record<string, unknown>;
  busy: boolean;
  steerQueued: boolean;
  pendingSteerText?: string;
  idleReapTimer?: ReturnType<typeof setTimeout>;
  reaping?: boolean;
  terminating?: boolean;
  transportFailing?: boolean;
}

export const CHILD_SYSTEM_PROMPT = [
  "You are a background subagent spawned by a parent pi agent.",
  "Work autonomously on your assigned task. There are no turn, token or time limits.",
  "When your task is complete, write a final report and end it with the exact line: DONE-PARENT",
  "If you are blocked on a question only the parent can answer, ask it as a line of the form: ASK: <question>",
  "Never write DONE-PARENT before your task is complete.",
].join("\n");

function assistantTextOf(msg: Record<string, unknown> | undefined): string {
  if (!msg) return "";
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function safeErrorDetail(raw: string): string {
  if (/model[\s\S]{0,120}not supported|unsupported[\s\S]{0,120}model/i.test(raw)) {
    return "model is not supported by provider";
  }
  if (/rate[ _-]?limit|\b429\b/i.test(raw)) return "provider rate limit reached";
  if (/context[ _-]?(window|limit)|too many tokens|maximum context/i.test(raw)) {
    return "model context limit exceeded";
  }
  if (/timed? out|timeout/i.test(raw)) return "provider request timed out";
  if (/unauthori[sz]ed|forbidden|authentication|\b401\b|\b403\b/i.test(raw)) {
    return "provider authentication failed";
  }
  return "child provider request failed";
}

function terminalErrorOf(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (message.stopReason === "error" || errorMessage.length > 0) {
    return errorMessage ? safeErrorDetail(errorMessage) : "child turn failed";
  }
  return undefined;
}

function stripControlTokens(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(DONE-PARENT|RESET-PARENT|INCR-PARENT|KEEP-GOING|ASK:)\b/.test(line.trim()))
    .join("\n");
}

interface ResolvedLaunch {
  title: string;
  agent?: string;
  cwd?: string;
  model: string;
  provider: string;
  thinking: string;
  systemPrompt: string;
  toolPolicy: AgentToolPolicy;
}

function resolveLaunch(req: SpawnRequest, benchmarkChildPolicy?: BenchmarkChildLaunchPolicy): ResolvedLaunch {
  const applyBenchmarkPolicy = (launch: ResolvedLaunch): ResolvedLaunch => benchmarkChildPolicy
    ? {
      ...launch,
      provider: benchmarkChildPolicy.provider,
      model: benchmarkChildPolicy.model,
      thinking: benchmarkChildPolicy.thinking,
    }
    : launch;

  if (req.agent?.trim()) {
    const named = agentRegistry.resolve(req.agent, req);
    return applyBenchmarkPolicy({
      title: req.title?.trim() || named.name,
      agent: named.name,
      cwd: req.cwd,
      model: named.model,
      provider: named.provider,
      thinking: named.thinking,
      systemPrompt: named.systemPrompt,
      toolPolicy: named.toolPolicy,
    });
  }

  const title = req.title?.trim();
  if (!title) throw new Error("generic subagent spawn requires a non-empty title");
  const general = agentRegistry.resolve("general-purpose", req);
  return applyBenchmarkPolicy({
    title,
    agent: general.name,
    cwd: req.cwd,
    model: general.model,
    provider: general.provider,
    thinking: general.thinking,
    systemPrompt: general.systemPrompt,
    toolPolicy: general.toolPolicy,
  });
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/\s+retry(?:\s+\d+)?\s*$/i, "").replace(/\s+/g, " ").trim();
}

function launchKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export class Hub {
  readonly ground: Ground;
  private readonly deliver: (d: Delivery) => void;
  private readonly spawnChild: (options: RpcChildOptions) => Promise<RpcChildHandle>;
  private readonly idleReapMs: number;
  private readonly benchmarkChildPolicy?: BenchmarkChildLaunchPolicy;
  private readonly kids = new Map<string, ChildState>();
  private readonly unsupportedSelections = new Set<string>();
  private generation = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();

  /** Liveness engine hooks (S-08) */
  onSpawn: ((id: string) => void) | null = null;
  onExit: ((id: string, reason: string) => void) | null = null;
  onEvent: ((id: string, line: Record<string, unknown>) => void) | null = null;
  onTurn:
    | ((id: string, rec: {
        toolCallCount: number;
        thinkingText: string;
        reportText: string;
        toolNames: string[];
        toolArgsHash: string;
        toolResultsHash: string;
        assistantText: string;
      }) => void)
    | null = null;

  constructor(opts: {
    ground?: Ground;
    deliver: (d: Delivery) => void;
    spawnChild?: (options: RpcChildOptions) => Promise<RpcChildHandle>;
    /** Explicit runner policy; absent for all ordinary interactive launches. */
    benchmarkChildPolicy?: BenchmarkChildLaunchPolicy;
    /** Grace period during which a completed child can receive a follow-up. */
    idleReapMs?: number;
  }) {
    this.ground = opts.ground ?? new Ground();
    this.deliver = opts.deliver;
    this.spawnChild = opts.spawnChild ?? RpcChild.spawnChild;
    this.benchmarkChildPolicy = opts.benchmarkChildPolicy && validateBenchmarkChildPolicy(opts.benchmarkChildPolicy);
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    if (!Number.isFinite(this.idleReapMs) || this.idleReapMs < 0) {
      throw new Error("idleReapMs must be a finite, non-negative number");
    }
  }

  private deliverFor(generation: number, delivery: Delivery): void {
    if (generation === this.generation) this.deliver(delivery);
  }

  private async shutdownUnregisteredChild(child: RpcChildHandle): Promise<void> {
    child.setLineHandler(null);
    child.onExit = null;
    await child.shutdown();
  }

  private async rejectReplacedSessionChild(
    generation: number,
    child: RpcChildHandle,
    operation: "spawn" | "resume",
  ): Promise<void> {
    if (generation === this.generation) return;
    await this.shutdownUnregisteredChild(child);
    throw new Error(`subagent ${operation} cancelled by session replacement`);
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async spawn(req: SpawnRequest): Promise<string> {
    const generation = this.generation;
    return this.withLifecycleLock(() => this.spawnUnlocked(req, generation));
  }

  private async spawnUnlocked(req: SpawnRequest, generation: number): Promise<string> {
    if (generation !== this.generation) {
      throw new Error("subagent spawn cancelled by session replacement");
    }
    const prompt = req.prompt.trim();
    if (!prompt) throw new Error("subagent spawn requires a non-empty prompt");
    const launch = resolveLaunch({ ...req, prompt }, this.benchmarkChildPolicy);
    if (this.unsupportedSelections.has(launchKey(launch.provider, launch.model))) {
      throw new Error(
        `subagent launch blocked: ${launch.provider}/${launch.model} already failed as unsupported; choose a supported preset instead of retrying`,
      );
    }
    const duplicate = [...this.kids.values()].find((state) => {
      const status = ring.get(state.id)?.status;
      return state.child.isRunning() &&
        (status === undefined || ACTIVE_STATUSES.has(status)) &&
        titleKey(state.title) === titleKey(launch.title);
    });
    if (duplicate) {
      throw new Error(`subagent already working: ${duplicate.id} (${duplicate.title})`);
    }
    const superseded = [...this.kids.values()].filter((state) => {
      const status = ring.get(state.id)?.status;
      return state.child.isRunning() &&
        REAPABLE_STATUSES.has(status ?? "working") &&
        titleKey(state.title) === titleKey(launch.title);
    });
    for (const state of superseded) await this.reapState(state, true);

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const child = await this.spawnChild({
      sessionDir: this.ground.sessions,
      sessionName: `subagent-${id}`,
      cwd: launch.cwd,
      provider: launch.provider,
      model: launch.model,
      thinking: launch.thinking,
      systemPrompt: launch.systemPrompt,
    });
    await this.rejectReplacedSessionChild(generation, child, "spawn");

    const state: ChildState = {
      id,
      title: launch.title,
      child,
      agent: launch.agent,
      cwd: launch.cwd,
      model: launch.model,
      provider: launch.provider,
      thinking: launch.thinking,
      systemPrompt: launch.systemPrompt,
      toolPolicy: launch.toolPolicy,
      sessionFile: child.sessionFile,
      turnCount: 0,
      compactions: 0,
      finalizedEnds: 0,
      generation,
      busy: true,
      steerQueued: false,
    };
    this.kids.set(id, state);
    child.setLineHandler((line) => this.onLine(id, line));
    child.onExit = () => {
      if (this.kids.get(id)?.child !== child) return;
      if (state.terminating) {
        this.kids.delete(id);
        return;
      }
      if (state.reaping) {
        this.kids.delete(id);
        this.onExit?.(id, "idle-reap");
        return;
      }
      this.kids.delete(id);
      const alreadyFailed = ring.get(id)?.status === "failed";
      if (!alreadyFailed) ring.upsert(id, { status: "crashed" });
      this.onExit?.(id, "crash");
      if (!alreadyFailed) {
        this.deliverFor(state.generation, { type: "crash", childId: id, reason: "process exited" });
      }
    };
    ring.upsert(id, {
      id,
      title: launch.title,
      status: "working",
      agent: launch.agent,
      cwd: launch.cwd,
      model: launch.model,
      provider: launch.provider,
      thinking: launch.thinking,
      systemPrompt: launch.systemPrompt,
      toolPolicy: launch.toolPolicy,
      spawnedAt: Date.now(),
      sessionFile: state.sessionFile,
      isStreaming: true,
      lastActivityAt: Date.now(),
      lastEventAt: Date.now(),
    });
    this.onSpawn?.(id);

    void child.send("prompt", { message: prompt }, 10_000).catch(() => {
      /* crash path handles a dead child */
    });
    return id;
  }

  private onLine(id: string, line: Record<string, unknown>): void {
    const st = this.kids.get(id);
    if (!st) return;
    const type = typeof line.type === "string" ? line.type : "";
    const now = Date.now();
    const meaningful = type !== "response" && type !== "stderr" && type !== "queue_update";
    const activityPatch: Partial<ChildView> = meaningful ? { lastEventAt: now, lastActivityAt: now } : {};
    if (type === "agent_start") {
      st.busy = true;
      Object.assign(activityPatch, {
        status: "working" as const,
        isStreaming: true,
        ask: undefined,
        error: undefined,
        attentionKind: undefined,
        attentionMessage: undefined,
        attentionAt: undefined,
      });
    } else if (type === "agent_settled") {
      Object.assign(activityPatch, { isStreaming: false, currentTool: undefined });
    } else if (type === "tool_execution_start") {
      Object.assign(activityPatch, {
        isStreaming: true,
        currentTool: typeof line.toolName === "string" ? line.toolName : "unknown",
      });
    } else if (type === "tool_execution_end") {
      Object.assign(activityPatch, { currentTool: undefined });
    } else if (type.startsWith("message_") || type === "turn_start" || type === "turn_end") {
      Object.assign(activityPatch, { isStreaming: true });
      if (type === "turn_start" && st.steerQueued && ring.get(id)?.steerState === "queued") {
        st.pendingSteerText = undefined;
        Object.assign(activityPatch, { steerState: "delivered" as const, lastSteerAt: now });
      }
    }
    if (Object.keys(activityPatch).length > 0) ring.upsert(id, activityPatch);
    this.onEvent?.(id, line);

    switch (type) {
      case "turn_end":
        st.turnCount += 1;
        ring.upsert(id, { turnCount: st.turnCount });
        // Build a liveness turn record from the last turn_end message.
        {
          const msg = line.message as Record<string, unknown> | undefined;
          const turnFailure = terminalErrorOf(msg);
          st.pendingTurnMessage = turnFailure ? undefined : msg;
          st.pendingTurnError = turnFailure;
          const content = (turnFailure ? [] : (msg?.content ?? [])) as Array<Record<string, unknown>>;
          const toolCalls = content.filter((c) => c.type === "toolCall").length;
          const thinkingText = content
            .filter((c) => c.type === "thinking")
            .map((c) => String(c.thinking ?? ""))
            .join("\n");
          const reportText = content
            .filter((c) => c.type === "text")
            .map((c) => String(c.text ?? ""))
            .join("\n");
          const toolNames = content
            .filter((c) => c.type === "toolCall")
            .map((c) => String((c as { name?: string }).name ?? ""));
          const results = (line.toolResults ?? []) as Array<Record<string, unknown>>;
          this.onTurn?.(id, {
            toolCallCount: toolCalls,
            thinkingText,
            reportText,
            toolNames,
            toolArgsHash: JSON.stringify(toolNames),
            toolResultsHash: JSON.stringify(results),
            assistantText: [thinkingText, reportText].join("\n"),
          });
        }
        break;
      case "compaction_end":
        st.compactions += 1;
        ring.upsert(id, { compactions: st.compactions });
        break;
      case "agent_settled": {
        const missedSteer = st.steerQueued && ring.get(id)?.steerState === "queued";
        const missedSteerText = st.pendingSteerText;
        st.busy = false;
        st.steerQueued = false;
        st.pendingSteerText = undefined;
        this.finalize(st);
        if (missedSteer) {
          ring.upsert(id, { steerState: "missed" });
          this.reportAttention(
            id,
            "missed-steer",
            `The child accepted guidance but settled before a subsequent turn could consume it. Its final report may reflect the previous instructions. Missed guidance: ${boundLensText(missedSteerText ?? "(unavailable)")}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  private cancelIdleReap(st: ChildState): void {
    if (st.idleReapTimer === undefined) return;
    clearTimeout(st.idleReapTimer);
    st.idleReapTimer = undefined;
  }

  private async reapState(st: ChildState, required = false): Promise<void> {
    if (this.kids.get(st.id) !== st) return;
    this.cancelIdleReap(st);
    st.reaping = true;
    try {
      await st.child.shutdown();
    } catch (error) {
      st.reaping = false;
      if (this.kids.get(st.id) === st) this.scheduleIdleReap(st);
      throw error;
    }
    if (this.kids.get(st.id) !== st) return;
    if (st.child.isRunning()) {
      st.reaping = false;
      this.scheduleIdleReap(st);
      throw new Error(`subagent ${st.id} did not stop during idle reap`);
    }
    this.kids.delete(st.id);
    st.child.setLineHandler(null);
    st.child.onExit = null;
    this.onExit?.(st.id, "idle-reap");
  }

  private scheduleIdleReap(st: ChildState): void {
    this.cancelIdleReap(st);
    if (this.idleReapMs === 0) return;
    st.idleReapTimer = setTimeout(() => {
      st.idleReapTimer = undefined;
      if (this.kids.get(st.id) !== st || !REAPABLE_STATUSES.has(ring.get(st.id)?.status ?? "working")) return;
      void this.withLifecycleLock(() => this.reapState(st)).catch(() => {
        /* a failed reap remains live and is retried after another grace period */
      });
    }, this.idleReapMs);
    st.idleReapTimer.unref?.();
  }

  reportAttention(id: string, kind: AttentionKind, summary: string): boolean {
    const st = this.kids.get(id);
    const view = ring.get(id);
    if (!st || !view || view.attentionKind === kind) return false;
    const bounded = boundLensText(summary || "No diagnostic was provided.");
    ring.upsert(id, {
      attentionKind: kind,
      attentionMessage: bounded,
      attentionAt: Date.now(),
    });
    this.deliverFor(st.generation, { type: "attention", childId: id, kind, summary: bounded });
    return true;
  }

  clearAttention(id: string, kinds?: readonly AttentionKind[]): void {
    const view = ring.get(id);
    if (!view?.attentionKind || (kinds && !kinds.includes(view.attentionKind))) return;
    ring.upsert(id, { attentionKind: undefined, attentionMessage: undefined, attentionAt: undefined });
  }

  /** Finalize a settled run into a lens (idempotent per agent_end cursor). */
  private finalize(st: ChildState): void {
    const ends = st.child.events("agent_end");
    if (ends.length <= st.finalizedEnds) return; // reject duplicate finalization

    const last = ends[ends.length - 1];
    const messages = (last.messages ?? []) as Array<Record<string, unknown>>;
    const assistants = messages.filter((m) => m.role === "assistant");
    const lastAssistant = assistants.length > 0 ? assistants[assistants.length - 1] : undefined;
    const finalMessage = lastAssistant ?? st.pendingTurnMessage;
    const finalText = assistantTextOf(finalMessage);
    st.finalizedEnds = ends.length;

    const messageFailure = [...messages].reverse().map(terminalErrorOf).find((value) => value !== undefined);
    const failure = messageFailure ?? terminalErrorOf(last) ?? terminalErrorOf(finalMessage) ?? st.pendingTurnError;
    st.pendingTurnError = undefined;
    st.pendingTurnMessage = undefined;
    if (failure) {
      const reason = failure;
      if (reason === "model is not supported by provider") {
        this.unsupportedSelections.add(launchKey(st.provider, st.model));
      }
      ring.upsert(st.id, {
        status: "failed",
        error: reason,
        ask: undefined,
        isStreaming: false,
        currentTool: undefined,
        lastCompletionAt: Date.now(),
        attentionKind: undefined,
        attentionMessage: undefined,
        attentionAt: undefined,
      });
      this.scheduleIdleReap(st);
      this.deliverFor(st.generation, { type: "crash", childId: st.id, reason });
      return;
    }

    const report = tokenReport(finalText);

    if (report.ask) {
      ring.upsert(st.id, {
        status: "asking",
        ask: report.ask,
        error: undefined,
        isStreaming: false,
        currentTool: undefined,
        attentionKind: undefined,
        attentionMessage: undefined,
        attentionAt: undefined,
      });
      this.deliverFor(st.generation, {
        type: "ask",
        childId: st.id,
        question: makeAskLens(st.id, report.ask, st.sessionFile).question,
      });
      return;
    }

    const clean = stripControlTokens(finalText).trim();
    if (clean.length > 0) {
      this.deliverFor(st.generation, {
        type: "lens",
        lens: makeCompletionLens(st.id, clean, st.sessionFile),
        final: report.done,
      });
    }
    if (report.incr) ring.upsert(st.id, { scopeCount: (ring.get(st.id)?.scopeCount ?? 0) + 1 });

    if (report.done) {
      ring.upsert(st.id, {
        status: "done",
        ask: undefined,
        error: undefined,
        lastCompletionAt: Date.now(),
        attentionKind: undefined,
        attentionMessage: undefined,
        attentionAt: undefined,
      });
      this.scheduleIdleReap(st);
      this.deliverFor(st.generation, {
        type: "control",
        childId: st.id,
        token: "DONE-PARENT",
        reportDelivered: clean.length > 0,
      });
    } else if (report.keepGoing) {
      ring.upsert(st.id, {
        status: "working",
        ask: undefined,
        error: undefined,
        attentionKind: undefined,
        attentionMessage: undefined,
        attentionAt: undefined,
      });
      void this.steer(st.id, "Continue your assigned work. Report only when complete or blocked.").catch((error) => {
        this.reportAttention(st.id, "semantic-stall", `KEEP-GOING was accepted but continuation failed: ${safeErrorDetail(String(error))}`);
      });
    } else {
      ring.upsert(st.id, {
        status: "settled",
        ask: undefined,
        error: undefined,
        lastCompletionAt: clean.length > 0 ? Date.now() : undefined,
      });
      this.scheduleIdleReap(st);
      this.reportAttention(
        st.id,
        "settled-without-completion",
        clean.length > 0
          ? clean
          : "The child settled without DONE-PARENT, an ASK, or a textual report.",
      );
    }

    if (report.reset) this.deliverFor(st.generation, { type: "control", childId: st.id, token: "RESET-PARENT" });
    if (report.incr) this.deliverFor(st.generation, { type: "control", childId: st.id, token: "INCR-PARENT" });
  }

  /**
   * Steer one child ("*" = broadcast). Streaming → steer; settled → prompt
   * (measured S-03 fact: follow_up on an idle child never starts a run).
   */
  async steer(idOrAll: string, text: string): Promise<boolean> {
    return this.withLifecycleLock(() => this.steerUnlocked(idOrAll, text));
  }

  private async steerUnlocked(idOrAll: string, text: string): Promise<boolean> {
    const targets = idOrAll === "*" ? [...this.kids.keys()] : [idOrAll];
    let any = false;
    for (const id of targets) {
      const st = this.kids.get(id);
      if (!st || !st.child.isRunning()) continue;
      const status = ring.get(id)?.status;
      if (status !== undefined && !ACTIVE_STATUSES.has(status) && status !== "done" && status !== "settled") continue;
      const wasIdle = status === "done" || status === "settled";
      const busy = st.busy;
      if (busy && st.steerQueued) continue;
      any = true;
      const finalizedBefore = st.finalizedEnds;
      if (wasIdle) this.cancelIdleReap(st);
      let accepted: CommandResponse;
      try {
        accepted = await st.child.send(busy ? "steer" : "prompt", { message: text }, 10_000);
      } catch (error) {
        if (wasIdle && this.kids.get(id) === st) this.scheduleIdleReap(st);
        throw error;
      }
      if (!accepted.success) {
        if (wasIdle && this.kids.get(id) === st) this.scheduleIdleReap(st);
        if (accepted.error) throw new Error(`steer ${id} failed: ${accepted.error}`);
        continue;
      }
      if (this.kids.get(id) === st && st.finalizedEnds === finalizedBefore) {
        st.busy = true;
        if (busy) {
          st.steerQueued = true;
          st.pendingSteerText = text;
        } else {
          st.pendingSteerText = undefined;
        }
        ring.upsert(id, {
          status: "working",
          ask: undefined,
          error: undefined,
          isStreaming: true,
          lastActivityAt: Date.now(),
          attentionKind: undefined,
          attentionMessage: undefined,
          attentionAt: undefined,
          steerState: busy ? "queued" : "delivered",
          steerQueuedAt: busy ? Date.now() : undefined,
          lastSteerAt: busy ? undefined : Date.now(),
        });
      } else if (wasIdle && this.kids.get(id) === st) {
        this.scheduleIdleReap(st);
      }
    }
    return any;
  }

  async kill(id: string): Promise<void> {
    return this.withLifecycleLock(() => this.killUnlocked(id));
  }

  private async killUnlocked(id: string): Promise<void> {
    const generation = this.generation;
    const st = this.kids.get(id);
    if (!st) return;
    this.cancelIdleReap(st);
    // A killed handle may still flush buffered lines after SIGTERM. Detach
    // both callbacks before a same-id resume can install its replacement.
    st.child.setLineHandler(() => {});
    st.child.onExit = null;
    try {
      st.terminating = true;
      st.child.kill();
      await st.child.shutdown();
    } finally {
      this.kids.delete(id);
      if (generation === this.generation) {
        ring.upsert(id, { status: "killed" });
        this.onExit?.(id, "kill");
      }
    }
  }

  async failTransport(id: string, reason: string): Promise<void> {
    return this.withLifecycleLock(async () => {
      const st = this.kids.get(id);
      if (!st || st.transportFailing) return;
      st.transportFailing = true;
      this.cancelIdleReap(st);
      st.child.setLineHandler(() => {});
      st.child.onExit = null;
      ring.upsert(id, {
        status: "crashed",
        error: reason,
        isStreaming: false,
        currentTool: undefined,
      });
      this.deliverFor(st.generation, { type: "crash", childId: id, reason });
      try {
        st.terminating = true;
        st.child.kill();
        await st.child.shutdown();
      } finally {
        this.kids.delete(id);
        this.onExit?.(id, reason);
      }
    });
  }

  list(): string[] {
    return [...this.kids.keys()];
  }

  statuses(id?: string): ChildStatusSnapshot[] {
    const views = id ? [ring.get(id)].filter((view): view is ChildView => view !== undefined) : ring.list();
    return views.map((view) => ({
      id: view.id,
      title: view.title,
      status: view.status,
      agent: view.agent,
      cwd: view.cwd,
      provider: view.provider,
      model: view.model,
      thinking: view.thinking,
      alive: this.isAlive(view.id),
      isStreaming: view.isStreaming ?? false,
      currentTool: view.currentTool,
      spawnedAt: view.spawnedAt,
      turnCount: view.turnCount,
      compactions: view.compactions,
      lastActivityAt: view.lastActivityAt,
      lastEventAt: view.lastEventAt,
      lastHeartbeatAt: view.lastHeartbeatAt,
      lastCompletionAt: view.lastCompletionAt,
      ask: view.ask,
      error: view.error,
      attentionKind: view.attentionKind,
      attentionMessage: view.attentionMessage,
      attentionAt: view.attentionAt,
      steerState: view.steerState,
      steerQueuedAt: view.steerQueuedAt,
      lastSteerAt: view.lastSteerAt,
    }));
  }

  isAlive(id: string): boolean {
    const st = this.kids.get(id);
    return !!st && st.child.isRunning();
  }

  getView(id: string): ChildView | undefined {
    return ring.get(id);
  }

  getChild(id: string): RpcChildHandle | undefined {
    return this.kids.get(id)?.child;
  }

  ownsProcess(pid: number): boolean {
    return [...this.kids.values()].some((state) => state.child.isRunning() && state.child.proc.pid === pid);
  }

  /**
   * Resume a killed/crashed child: re-spawn on its persisted session file
   * and switch_session back, preserving context/cache.
   */
  async resume(id: string, prompt: string): Promise<boolean> {
    return this.withLifecycleLock(() => this.resumeUnlocked(id, prompt));
  }

  private async resumeUnlocked(id: string, prompt: string): Promise<boolean> {
    const view = ring.get(id);
    if (!view) return false;
    const sessionFile = view.sessionFile;
    if (!sessionFile) return false;

    // Delete tombstones? The tombstone stays as a historical fact; the new
    // incarnation is the resumed session.
    const selection = this.benchmarkChildPolicy ?? resolveSpawn({
      model: view.model,
      provider: view.provider,
      thinking: view.thinking,
    });
    const { model, provider, thinking } = selection;
    const systemPrompt = view.systemPrompt ?? CHILD_SYSTEM_PROMPT;
    const toolPolicy = view.toolPolicy ?? "normal";
    const state = this.kids.get(id);
    if (state?.child.isRunning()) {
      // A settled child is an idle, reusable thread. A follow-up must wake it.
      if ((view.status === "done" || view.status === "settled") && prompt) return this.steerUnlocked(id, prompt);
      if (view.status === "failed") await this.reapState(state, true);
      else return true;
    }

    const generation = this.generation;
    const child = await this.spawnChild({
      sessionDir: this.ground.sessions,
      sessionName: `subagent-${id}-resume`,
      cwd: view.cwd,
      provider,
      model,
      thinking,
      systemPrompt,
    });
    await this.rejectReplacedSessionChild(generation, child, "resume");
    let sw;
    try {
      sw = await child.send("switch_session", { sessionPath: sessionFile }, 10_000);
    } catch {
      if (generation !== this.generation) {
        await this.rejectReplacedSessionChild(generation, child, "resume");
      }
      await this.shutdownUnregisteredChild(child);
      throw new Error("subagent resume switch failed");
    }
    await this.rejectReplacedSessionChild(generation, child, "resume");
    if (!sw.success) {
      await this.shutdownUnregisteredChild(child);
      throw new Error("subagent resume switch failed");
    }
    const st: ChildState = {
      id,
      title: view.title,
      child,
      agent: view.agent,
      cwd: view.cwd,
      model,
      provider,
      thinking,
      systemPrompt,
      toolPolicy,
      sessionFile,
      turnCount: view.turnCount,
      compactions: view.compactions,
      finalizedEnds: 0,
      generation,
      busy: Boolean(prompt),
      steerQueued: false,
    };
    this.kids.set(id, st);
    child.setLineHandler((line) => this.onLine(id, line));
    child.onExit = () => {
      if (this.kids.get(id)?.child !== child) return;
      if (st.terminating) {
        this.kids.delete(id);
        return;
      }
      if (st.reaping) {
        this.kids.delete(id);
        this.onExit?.(id, "idle-reap");
        return;
      }
      this.kids.delete(id);
      const alreadyFailed = ring.get(id)?.status === "failed";
      if (!alreadyFailed) ring.upsert(id, { status: "crashed" });
      this.onExit?.(id, "crash");
      if (!alreadyFailed) {
        this.deliverFor(st.generation, { type: "crash", childId: id, reason: "process exited" });
      }
    };
    ring.upsert(id, {
      status: "working",
      ask: undefined,
      error: undefined,
      isStreaming: Boolean(prompt),
      lastActivityAt: Date.now(),
      lastEventAt: Date.now(),
      attentionKind: undefined,
      attentionMessage: undefined,
      attentionAt: undefined,
    });
    this.onSpawn?.(id);
    if (prompt) void child.send("prompt", { message: prompt }, 10_000).catch(() => {});
    return true;
  }

  /** Cursor poll slot (≤1s) — S-08 fills heartbeat; S-04 keeps it a no-op. */
  poll(): void {
    /* no-op at this slice */
  }

  async shutdownAll(): Promise<void> {
    const states = [...this.kids.values()];
    this.generation += 1;
    for (const state of states) {
      this.cancelIdleReap(state);
      state.child.setLineHandler(null);
      state.child.onExit = null;
    }
    this.kids.clear();
    ring.reset();
    await Promise.all(states.map(async (state) => {
      try {
        await state.child.shutdown();
      } finally {
        this.onExit?.(state.id, "kill");
      }
    }));
  }
}
