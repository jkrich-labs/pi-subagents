/**
 * RPC child process harness — spawns `pi --mode rpc`, frames JSONL,
 * correlates command responses by id, and exposes event/wait helpers.
 *
 * Seam: the RPC protocol boundary (framing, event ordering, lifecycle).
 * Framing policy per rpc.md: split records on `\n` only (strip trailing `\r`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A parsed line off the child's stdout. */
export type WireLine = Record<string, unknown>;

export interface EntryId extends WireLine {
  id: string;
}

export interface CommandResponse {
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface RpcChildOptions {
  /** Session directory (children must never use `--no-session`). */
  sessionDir: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  /** Harness probes default to no tools; a benchmark parent needs extension tools. */
  tools?: "none" | "normal";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  /** Give authenticated benchmark parents their own process group for cleanup. */
  detached?: boolean;
}

export class RpcChild {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly sessionDir: string;
  /** Full JSONL lines received on stdout, in arrival order. */
  readonly lines: WireLine[] = [];
  private pending = new Map<string, { resolve: (r: CommandResponse) => void; reject: (e: Error) => void }>();
  private buffered = "";
  private procExited = false;
  private idSeq = 0;
  private readonly lineListeners = new Set<(line: WireLine) => void>();

  private constructor(proc: ChildProcessWithoutNullStreams, sessionDir: string) {
    this.proc = proc;
    this.sessionDir = sessionDir;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.feed(chunk));
    proc.on("exit", () => {
      this.procExited = true;
      for (const [, { reject }] of this.pending) {
        reject(new Error("child exited"));
      }
      this.pending.clear();
    });
  }

  static async spawnAndWaitReady(opts: RpcChildOptions, signal?: AbortSignal): Promise<RpcChild> {
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ];
    if (opts.tools !== "normal") args.splice(2, 0, "--no-tools");
    if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
    if (opts.name) args.push("--name", opts.name);
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    const proc = spawn("pi", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: opts.detached ?? false,
    });
    const child = new RpcChild(proc, opts.sessionDir);
    child.attachDiagnostics();
    const abortChild = (): void => {
      try { if (!proc.killed) proc.kill("SIGTERM"); } catch { /* already gone */ }
    };
    signal?.addEventListener("abort", abortChild, { once: true });
    try {
      if (signal?.aborted) throw new Error("rpc child launch cancelled");
      const r = await child.send("get_state", {}, 8000);
      if (!r.success) throw new Error(`get_state at spawn failed: ${r.error}`);
    } catch (e) {
      try {
        proc.kill("SIGKILL");
      } catch { /* already gone */ }
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      signal?.removeEventListener("abort", abortChild);
    }
    return child;
  }

  private attachDiagnostics(): void {
    this.proc.stderr.setEncoding("utf8");
    // keep stderr from being a hang risk: drain but retain in lines for debugging
    this.proc.stderr.on("data", (chunk: string) => {
      if (chunk.trim().length === 0) return;
      this.lines.push({ type: "stderr", text: chunk });
    });
  }

  private feed(chunk: string): void {
    this.buffered += chunk;
    // rpc.md framing: split on \n only; strip a trailing \r.
    let i = this.buffered.indexOf("\n");
    while (i !== -1) {
      let line = this.buffered.slice(0, i);
      this.buffered = this.buffered.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        try {
          const parsed: WireLine = JSON.parse(line);
          this.lines.push(parsed);
          for (const listener of this.lineListeners) listener(parsed);
          if (parsed.type === "response" && parsed.id) {
            const p = this.pending.get(String(parsed.id));
            if (p) {
              this.pending.delete(String(parsed.id));
              p.resolve(parsed as unknown as CommandResponse);
            }
          }
        } catch {
          // non-JSON startup chatter — ignore
        }
      }
      i = this.buffered.indexOf("\n");
    }
  }

  /** Send an RPC command; resolves when its response line arrives. */
  send(cmd: string, body: Record<string, unknown> = {}, timeoutMs = 8000): Promise<CommandResponse> {
    const id = `h${++this.idSeq}`;
    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r: CommandResponse) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, type: cmd, ...body })}\n`);
    });
  }

  /** Wait until a predicate matches some stdout line (whole-line scan). */
  waitFor(pred: (line: WireLine) => boolean, label: string, timeoutMs = 30000): Promise<WireLine> {
    return new Promise<WireLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waitFor ${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const scan = (): WireLine | null => {
        for (const line of this.lines) {
          if (pred(line)) return line;
        }
        return null;
      };
      const first = scan();
      if (first !== null) {
        clearTimeout(timer);
        return void resolve(first);
      }
      const handler = (): void => {
        const found = scan();
        if (found !== null) {
          clearTimeout(timer);
          this.proc.stdout.off("data", handler);
          return void resolve(found);
        }
      };
      this.proc.stdout.on("data", handler);
    });
  }

  /** Subscribe to parsed protocol lines without retaining transcript data elsewhere. */
  onLine(listener: (line: WireLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  /** Count lines matching a predicate. */
  countLines(pred: (line: WireLine) => boolean): number {
    return this.lines.filter(pred).length;
  }

  /** Lines of a particular event type. */
  events(type: string): WireLine[] {
    return this.lines.filter((l) => l.type === type);
  }

  /** The latest get_entries payload this child has seen. */
  async entries(since?: string, timeoutMs = 30000): Promise<{ entries: EntryId[]; leafId: string | null }> {
    const r = await this.send("get_entries", since ? { since } : {}, timeoutMs);
    if (!r.success) throw new Error(`get_entries failed: ${r.error}`);
    const data = (r.data ?? {}) as { entries?: EntryId[]; leafId?: string | null };
    return { entries: data.entries ?? [], leafId: data.leafId ?? null };
  }

  isRunning(): boolean {
    return !this.procExited && this.proc.exitCode === null && !this.proc.killed;
  }

  kill(): void {
    if (this.isRunning()) this.proc.kill("SIGTERM");
  }

  /** Graceful: ask the child to exit, then wait for process close. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.proc.killed || this.procExited || this.proc.exitCode !== null) return;
    try {
      this.proc.stdin.end();
    } catch { /* already ended */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (this.isRunning()) this.proc.kill("SIGKILL");
        } catch { /* already gone */ }
        resolve();
      }, timeoutMs);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
