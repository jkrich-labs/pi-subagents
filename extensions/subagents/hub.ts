/**
 * Hub controller — spawns, steers and finalizes child processes.
 * The hub never caps children (no turn/token/wall-clock bounds); "done"-ness
 * is the child's DONE-PARENT or the toy cancel. Termination based on
 * process/transport facts only (Regime A); semantic probes (Regime B) never
 * kill — S-08.
 */
import { Ground } from "./ground.ts";
import { RpcChild } from "./child.ts";
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
  child: RpcChild;
  model?: string;
  provider?: string;
  thinking?: string;
  sessionFile?: string;
  turnCount: number;
  compactions: number;
  finalizedEnds: number;
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

function stripControlTokens(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(DONE-PARENT|RESET-PARENT|INCR-PARENT|ASK:)\b/.test(line.trim()))
    .join("\n");
}

export class Hub {
  readonly ground: Ground;
  private readonly deliver: (d: Delivery) => void;
  private readonly kids = new Map<string, ChildState>();

  constructor(opts: { ground?: Ground; deliver: (d: Delivery) => void }) {
    this.ground = opts.ground ?? new Ground();
    this.deliver = opts.deliver;
  }

  async spawn(req: SpawnRequest): Promise<string> {
    const { model, provider, thinking } = resolveSpawn(req);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const child = await RpcChild.spawnChild({
      sessionDir: this.ground.sessions,
      sessionName: `subagent-${id}`,
      provider,
      model,
      thinking,
      systemPrompt: CHILD_SYSTEM_PROMPT,
    });

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
    };
    this.kids.set(id, state);
    child.setLineHandler((line) => this.onLine(id, line));

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
    const finalText = assistants.length > 0 ? assistantTextOf(assistants[assistants.length - 1]) : "";
    st.finalizedEnds = ends.length;

    const report = tokenReport(finalText);

    if (report.ask) {
      ring.upsert(st.id, { status: "asking", ask: report.ask });
      this.deliver({ type: "ask", childId: st.id, question: report.ask });
      return;
    }

    const clean = stripControlTokens(finalText).trim();
    if (clean.length > 0) {
      ring.upsert(st.id, { status: report.done ? "done" : "working", lastCompletionAt: Date.now() });
      this.deliver({
        type: "lens",
        lens: makeCompletionLens(st.id, clean, st.sessionFile),
      });
    }

    if (report.reset) ring.upsert(st.id, { lastCompletionAt: undefined, status: "working" });
    if (report.incr) ring.upsert(st.id, { scopeCount: (ring.get(st.id)?.scopeCount ?? 0) + 1 });
    if (report.done) this.deliver({ type: "control", childId: st.id, token: "DONE-PARENT" });
    if (report.reset) this.deliver({ type: "control", childId: st.id, token: "RESET-PARENT" });
    if (report.incr) this.deliver({ type: "control", childId: st.id, token: "INCR-PARENT" });
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

  /** Cursor poll slot (≤1s) — S-08 fills heartbeat; S-04 keeps it a no-op. */
  poll(): void {
    /* no-op at this slice */
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.kids.keys()];
    for (const id of ids) {
      const st = this.kids.get(id);
      if (!st) continue;
      st.child.setLineHandler(null);
      await st.child.shutdown();
      this.kids.delete(id);
      ring.upsert(id, { status: "killed" });
    }
  }
}
