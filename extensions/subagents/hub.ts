/**
 * Hub controller — spawns, steers and finalizes child processes.
 * The hub never caps children (no turn/token/wall-clock bounds); "done"-ness
 * is the child's DONE-PARENT or the toy cancel. Termination based on
 * process/transport facts only (Regime A); semantic probes (Regime B) never
 * kill — S-08.
 */
import { Ground } from "./ground.ts";
import { RpcChild, type RpcChildHandle, type RpcChildOptions } from "./child.ts";
import { ring, type ChildView } from "./ring/store.ts";
import { reportFrom as tokenReport } from "./tokens.ts";
import { makeAskLens, makeCompletionLens, type Lens } from "./lenses.ts";
import { resolveSpawn } from "./registry.ts";

export interface SpawnRequest {
  title: string;
  prompt: string;
  model?: string;
  provider?: string;
  thinking?: string;
}

export type Delivery =
  | { type: "lens"; lens: Lens }
  | { type: "ask"; childId: string; question: string }
  | { type: "control"; childId: string; token: string }
  | { type: "crash"; childId: string; reason: string };

interface ChildState {
  id: string;
  title: string;
  child: RpcChildHandle;
  model?: string;
  provider?: string;
  thinking?: string;
  sessionFile?: string;
  turnCount: number;
  compactions: number;
  finalizedEnds: number;
  generation: number;
  pendingTurnError?: string;
  pendingTurnMessage?: Record<string, unknown>;
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
    .filter((line) => !/^(DONE-PARENT|RESET-PARENT|INCR-PARENT|ASK:)\b/.test(line.trim()))
    .join("\n");
}

export class Hub {
  readonly ground: Ground;
  private readonly deliver: (d: Delivery) => void;
  private readonly spawnChild: (options: RpcChildOptions) => Promise<RpcChildHandle>;
  private readonly kids = new Map<string, ChildState>();
  private generation = 0;

  /** Liveness engine hooks (S-08) */
  onSpawn: ((id: string) => void) | null = null;
  onExit: ((id: string, reason: string) => void) | null = null;
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
  }) {
    this.ground = opts.ground ?? new Ground();
    this.deliver = opts.deliver;
    this.spawnChild = opts.spawnChild ?? RpcChild.spawnChild;
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

  async spawn(req: SpawnRequest): Promise<string> {
    const generation = this.generation;
    const { model, provider, thinking } = resolveSpawn(req);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const child = await this.spawnChild({
      sessionDir: this.ground.sessions,
      sessionName: `subagent-${id}`,
      provider,
      model,
      thinking,
      systemPrompt: CHILD_SYSTEM_PROMPT,
    });
    await this.rejectReplacedSessionChild(generation, child, "spawn");

    const state: ChildState = {
      id,
      title: req.title,
      child,
      model,
      provider,
      thinking,
      sessionFile: child.sessionFile,
      turnCount: 0,
      compactions: 0,
      finalizedEnds: 0,
      generation,
    };
    this.kids.set(id, state);
    child.setLineHandler((line) => this.onLine(id, line));
    child.onExit = () => {
      if (!this.kids.has(id)) return;
      this.kids.delete(id);
      const alreadyFailed = ring.get(id)?.status === "failed";
      if (!alreadyFailed) ring.upsert(id, { status: "crashed" });
      this.onExit?.(id, "crash");
      if (!alreadyFailed) {
        this.deliverFor(state.generation, { type: "crash", childId: id, reason: "process exited" });
      }
    };
    this.onSpawn?.(id);

    ring.upsert(id, {
      id,
      title: req.title,
      status: "working",
      model,
      provider,
      thinking,
      spawnedAt: Date.now(),
      sessionFile: state.sessionFile,
    });

    void child.send("prompt", { message: req.prompt }, 10_000).catch(() => {
      /* crash path handles a dead child */
    });
    return id;
  }

  private onLine(id: string, line: Record<string, unknown>): void {
    const st = this.kids.get(id);
    if (!st) return;
    switch (line.type) {
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
      case "agent_settled":
        this.finalize(st);
        break;
      default:
        break;
    }
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
      ring.upsert(st.id, {
        status: "failed",
        error: reason,
        ask: undefined,
        lastCompletionAt: Date.now(),
      });
      this.deliverFor(st.generation, { type: "crash", childId: st.id, reason });
      return;
    }

    const report = tokenReport(finalText);

    if (report.ask) {
      ring.upsert(st.id, { status: "asking", ask: report.ask, error: undefined });
      this.deliverFor(st.generation, { type: "ask", childId: st.id, question: report.ask });
      return;
    }

    const clean = stripControlTokens(finalText).trim();
    if (clean.length > 0) {
      ring.upsert(st.id, {
        status: report.done ? "done" : "working",
        ask: undefined,
        error: undefined,
        lastCompletionAt: Date.now(),
      });
      this.deliverFor(st.generation, {
        type: "lens",
        lens: makeCompletionLens(st.id, clean, st.sessionFile),
      });
    }

    if (report.reset) ring.upsert(st.id, { lastCompletionAt: undefined, status: "working", error: undefined });
    if (report.incr) ring.upsert(st.id, { scopeCount: (ring.get(st.id)?.scopeCount ?? 0) + 1 });
    if (report.done) this.deliverFor(st.generation, { type: "control", childId: st.id, token: "DONE-PARENT" });
    if (report.reset) this.deliverFor(st.generation, { type: "control", childId: st.id, token: "RESET-PARENT" });
    if (report.incr) this.deliverFor(st.generation, { type: "control", childId: st.id, token: "INCR-PARENT" });
  }

  /**
   * Steer one child ("*" = broadcast). Streaming → steer; settled → prompt
   * (measured S-03 fact: follow_up on an idle child never starts a run).
   */
  async steer(idOrAll: string, text: string): Promise<boolean> {
    const targets = idOrAll === "*" ? [...this.kids.keys()] : [idOrAll];
    let any = false;
    for (const id of targets) {
      const st = this.kids.get(id);
      if (!st || !st.child.isRunning()) continue;
      any = true;
      const busy = st.child.events("agent_end").length > st.child.events("agent_settled").length;
      const accepted = await st.child.send(busy ? "steer" : "prompt", { message: text }, 10_000);
      if (!accepted.success && accepted.error) {
        throw new Error(`steer ${id} failed: ${accepted.error}`);
      }
    }
    return any;
  }

  async kill(id: string): Promise<void> {
    const st = this.kids.get(id);
    if (!st) return;
    try {
      st.child.kill();
      await st.child.shutdown();
    } finally {
      this.kids.delete(id);
      ring.upsert(id, { status: "killed" });
      this.onExit?.(id, "kill");
    }
  }

  list(): string[] {
    return [...this.kids.keys()];
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

  /**
   * Resume a killed/crashed child: re-spawn on its persisted session file
   * and switch_session back, preserving context/cache.
   */
  async resume(id: string, prompt: string): Promise<boolean> {
    const view = ring.get(id);
    if (!view) return false;
    const sessionFile = view.sessionFile;
    if (!sessionFile) return false;

    // Delete tombstones? The tombstone stays as a historical fact; the new
    // incarnation is the resumed session.
    const { model, provider, thinking } = resolveSpawn({});
    const state = this.kids.get(id);
    if (state?.child.isRunning()) {
      // already live — do nothing
      return true;
    }

    const generation = this.generation;
    const child = await this.spawnChild({
      sessionDir: this.ground.sessions,
      sessionName: `subagent-${id}-resume`,
      provider,
      model,
      thinking,
      systemPrompt: CHILD_SYSTEM_PROMPT,
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
      model,
      provider,
      thinking,
      sessionFile,
      turnCount: view.turnCount,
      compactions: view.compactions,
      finalizedEnds: 0,
      generation,
    };
    this.kids.set(id, st);
    child.setLineHandler((line) => this.onLine(id, line));
    child.onExit = () => {
      if (!this.kids.has(id)) return;
      this.kids.delete(id);
      const alreadyFailed = ring.get(id)?.status === "failed";
      if (!alreadyFailed) ring.upsert(id, { status: "crashed" });
      this.onExit?.(id, "crash");
      if (!alreadyFailed) {
        this.deliverFor(st.generation, { type: "crash", childId: id, reason: "process exited" });
      }
    };
    ring.upsert(id, { status: "working", ask: undefined, error: undefined });
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
