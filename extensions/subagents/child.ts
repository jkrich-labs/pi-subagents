/**
 * RPC child process — the hub's per-subagent process handle.
 * Same seam as the S-03 harness (framing: split on `\n` only),
 * trimmed for hub needs: spawn with system prompt, event scan, immune
 * command correlation, graceful exit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type WireLine = Record<string, unknown>;

export interface RpcChildOptions {
  sessionDir: string;
  sessionName?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  /** The child's own system prompt (never re-enters parent context). */
  systemPrompt?: string;
}

export function buildChildArgs(opts: RpcChildOptions): string[] {
  const args = [
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
  if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  if (opts.sessionName) args.push("--name", opts.sessionName);
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  return args;
}

export interface RpcChildHandle {
  readonly proc: { readonly pid?: number };
  readonly lines: WireLine[];
  sessionFile?: string;
  onExit: (() => void) | null;
  setLineHandler(fn: ((line: WireLine) => void) | null): void;
  send(cmd: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<CommandResponse>;
  events(type: string): WireLine[];
  isRunning(): boolean;
  kill(): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

export class RpcChild implements RpcChildHandle {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: WireLine[] = [];
  /** Session file captured from the spawn-time get_state (never --no-session). */
  sessionFile?: string;
  private stderrBuf = "";
  private pending = new Map<string, { resolve: (r: CommandResponse) => void; reject: (e: Error) => void }>();
  private buffered = "";
  private exited = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  onExit: (() => void) | null = null;
  private idSeq = 0;
  private onLine: ((line: WireLine) => void) | null = null;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.feed(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (chunk.trim().length > 0) this.lines.push({ type: "stderr", text: chunk });
    });    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      const tail = this.stderrBuf.slice(-300);
      const err = new Error(`child exited (code=${code}, signal=${signal}) stderr: ${tail}`);
      for (const [, { reject }] of this.pending) reject(err);
      this.pending.clear();
      this.onExit?.();
    });
  }

  static async spawnChild(opts: RpcChildOptions): Promise<RpcChild> {
    const proc = spawn("pi", buildChildArgs(opts), { stdio: ["pipe", "pipe", "pipe"] });
    const child = new RpcChild(proc);
    child.captureStderr();
    const ok = await child.send("get_state", {}, 8000);
    if (!ok.success) {
      const errTail = child.stderrText().slice(-400);
      proc.kill("SIGKILL");
      throw new Error(`child get_state at spawn failed: ${ok.error} ${errTail}`);
    }    child.sessionFile = (ok.data as { sessionFile?: string } | undefined)?.sessionFile;
    return child;
  }

  /** Retain raw stderr for crash diagnostics. */
  captureStderr(): void {
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
    });
  }

  stderrText(): string {
    return this.stderrBuf;
  }

  setLineHandler(fn: ((line: WireLine) => void) | null): void {
    this.onLine = fn;
  }

  private feed(chunk: string): void {
    this.buffered += chunk;
    let i = this.buffered.indexOf("\n");
    while (i !== -1) {
      let line = this.buffered.slice(0, i);
      this.buffered = this.buffered.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        try {
          const parsed: WireLine = JSON.parse(line);
          this.lines.push(parsed);
          this.onLine?.(parsed);
          if (parsed.type === "response" && parsed.id) {
            const p = this.pending.get(String(parsed.id));
            if (p) {
              this.pending.delete(String(parsed.id));
              p.resolve(parsed as unknown as CommandResponse);
            }
          }
        } catch {
          /* non-JSON startup chatter */
        }
      }
      i = this.buffered.indexOf("\n");
    }
  }

  send(cmd: string, body: Record<string, unknown> = {}, timeoutMs = 8000): Promise<CommandResponse> {
    const id = `h${++this.idSeq}`;
    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, type: cmd, ...body })}\n`);
    });
  }

  /** Lines of a given event type. */
  events(type: string): WireLine[] {
    return this.lines.filter((l) => l.type === type);
  }

  isRunning(): boolean {
    return !this.exited && this.proc.exitCode === null && !this.proc.killed;
  }

  kill(): void {
    if (this.isRunning()) this.proc.kill("SIGTERM");
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning()) return;
    try {
      this.proc.stdin.end();
    } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.isRunning()) this.proc.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface CommandResponse {
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}
