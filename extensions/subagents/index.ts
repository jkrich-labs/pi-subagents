/**
 * pi-subagents hub extension — entry point.
 * Registers the spawn_subagent tool, wires steering (user input + parent
 * assistant text), and delivers child lenses to the parent transcript via
 * appendEntry. Headless-safe: UI calls are gated on ctx.mode === "tui".
 */
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Ground } from "./ground.ts";
import { Hub, type ChildStatusSnapshot, type Delivery, type SpawnRequest } from "./hub.ts";
import { boundLensText } from "./lenses.ts";
import { benchmarkChildPolicyFromEnvironment } from "./benchmark-policy.ts";
import { LivenessEngine } from "./liveness/engine.ts";
import { ring } from "./ring/store.ts";
import { routeSteers, stripSteers } from "./route.ts";
import { type SessionEntryLike } from "./ui/inspect.ts";
import { openInspectOverlay, openNavigateOverlay } from "./ui/overlay.ts";
import { attachFleetEditorNavigation, FleetWidget, supportsFleetEditorNavigation } from "./ui/focus.ts";
import { readFileSync } from "node:fs";
import { agentRegistry } from "./agents.ts";

const POLLING_BLOCK_REASON =
  "A subagent is still working in the background. Do not poll with shell sleeps; end this turn instead.";
const CHILD_KILL_BLOCK_REASON =
  "Child processes are owned by the subagent hub. Do not shell-kill them or spawn duplicate retries; end this turn instead.";
const RAW_PI_BLOCK_REASON =
  "Do not launch nested pi agents through bash or manage their PID files. Use Task/spawn_subagent with cwd instead.";
const RAW_POLLING_BLOCK_REASON =
  "Do not poll background work with shell sleeps or PID checks. Delegate through Task/spawn_subagent instead.";

export interface ParentBashGuardDecision {
  block: true;
  reason: string;
  /** End only when a live hub child can wake the parent with a later event. */
  terminate?: true;
}

export interface SpawnToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { childId?: string; agent?: string };
  terminate?: boolean;
}

function isPollingSleep(command: string): boolean {
  const match = /^\s*sleep\s+\d+(?:\.\d+)?(?:[smhd])?\s*(.*)$/is.exec(command);
  if (!match) return false;
  const remainder = match[1].replace(/^\s*(?:;|&&)\s*/, "").trim();
  if (!remainder) return true;
  return /^(?:echo\s+(?:wait|waiting|done)\b|ps\b|pgrep\b|jobs\b)/i.test(remainder);
}

function killTargets(command: string): number[] {
  const targets: number[] = [];
  for (const match of command.matchAll(/(?:^|[;&|]\s*)kill\s+([^;&|\n]+)/g)) {
    for (const token of match[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) targets.push(Number(token));
    }
  }
  return targets;
}

/**
 * Strip quoted heredoc bodies (<<'EOF' … EOF / <<-"EOF" … EOF) before
 * analysis. Their contents are inert data — no shell expansion happens — so
 * prose inside them (e.g. a git commit message that mentions `pi`, `echo`,
 * `sleep`, or `kill`) must not be read as commands. Unquoted heredocs stay in
 * scope: their bodies can expand `$PI` etc., so they are analyzed as-is.
 */
function stripQuotedHeredocs(command: string): string {
  return command.replace(/<<-?\s*(["'])([A-Za-z0-9_]+)\1[^\n]*\n[^]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "");
}

function launchesNestedPi(command: string): boolean {
  const raw = stripQuotedHeredocs(command);
  const normalized = raw.replace(/["']/g, " ");
  const direct = /(?:^|[;&|()\n]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|command|exec|nohup|env)\s+)*(?:\S*\/)?pi(?:\s+|$)(.*)$/is.exec(normalized);
  if (direct) {
    return !/^(?:--help|-h|--version|-v|--list-models)(?:\s|$)/.test(direct[1].trim());
  }
  // Shell wrappers (`bash -c`, `env`, `sh -c 'exec pi …'`) hide the
  // executable from the direct-command expression above. Treat any wrapped
  // pi invocation as nested delegation rather than letting it escape policy.
  // Command substitution alone is not suspicious — `$(cat <<'EOF' … EOF)` in
  // a commit message is data, not a wrapper. Only flag substitutions that
  // invoke a launcher (pi, bash, sh, env, exec, nohup).
  return /\$\([^)]*\b(?:pi|bash|sh|env|exec|nohup)\b/i.test(raw) ||
    /\b[A-Za-z_]\w*\$[A-Za-z_]\w*/.test(raw) ||
    /(?:^|[;&|])[^\n;|]*\b[A-Za-z_]\w*=\S+\s*;[^\n;|]*\$[A-Za-z_]/.test(raw) ||
    /(?:^|[\s;&|()])(?:\S*\/)?pi(?=\s|$)/i.test(normalized) ||
    /\$\{[^}]*\bpi\b[^}]*\}/i.test(normalized) ||
    /\$\([^)]*\bpi\b[^)]*\)/i.test(normalized) ||
    /\$\([^)]*\b(?:printf|echo)\b/i.test(normalized) ||
    /\$'[^']*(?:\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\[0-7]{3})/i.test(raw) ||
    /(?:^|[\s;&|()])p["'\\\s]*i(?=\s|$)/i.test(raw) ||
    /\b[A-Za-z_]\w*\s*=\s*(?:["']?)(?:\S*\/)?pi(?:["']?)(?=\s|;|$)/i.test(raw) ||
    /(?:^|[;&|])\s*\$\{?[A-Za-z_]\w*/.test(raw) ||
    /\$(?:\{)?PI(?:_BIN)?\}?\b/i.test(raw) ||
    /(?:printf|echo)[^|]*(?:\\[0-7]{3}|\\x[0-9a-f]{2})[^|]*\|\s*(?:sh|bash)\b/i.test(raw) ||
    /\\pi\b/i.test(normalized) ||
    /p\$\([^)]*(?:printf|echo)\s+i\b/i.test(normalized);
}

export function parentBashGuard(
  command: string,
  hasActiveChildren: boolean,
  ownsProcess: (pid: number) => boolean,
): ParentBashGuardDecision | undefined {
  if (launchesNestedPi(command)) {
    return { block: true, reason: RAW_PI_BLOCK_REASON };
  }
  if (killTargets(command).some(ownsProcess)) {
    return { block: true, reason: CHILD_KILL_BLOCK_REASON, terminate: true };
  }
  if (isPollingSleep(command)) {
    return hasActiveChildren
      ? { block: true, reason: POLLING_BLOCK_REASON, terminate: true }
      : { block: true, reason: RAW_POLLING_BLOCK_REASON };
  }
  return undefined;
}

export function mapTaskRequest(params: { subagent_type: string; prompt: string; description?: string; cwd?: string }): SpawnRequest {
  const request: SpawnRequest = {
    agent: params.subagent_type.trim(),
    prompt: params.prompt.trim(),
  };
  const title = params.description?.trim();
  if (title) request.title = title;
  const cwd = params.cwd?.trim();
  if (cwd) request.cwd = cwd;
  return request;
}

export function spawnSuccessText(id: string, label: string): string {
  return [
    `Subagent spawned: ${id} (${label}).`,
    `Steer with steer_subagent(child_id=${JSON.stringify(id)}, message=...).`,
    "If no genuinely independent work remains, end your turn immediately.",
    "Never poll, sleep, inspect child processes, or manufacture busywork while waiting.",
  ].join(" ");
}

function statusLine(status: ChildStatusSnapshot): string {
  const activity = status.isStreaming ? "streaming" : "idle";
  const tool = status.currentTool ? ` tool=${status.currentTool}` : "";
  const attention = status.attentionKind
    ? ` attention=${status.attentionKind} ${status.attentionMessage ?? ""}`
    : "";
  const steer = status.steerState ? ` steer=${status.steerState}` : "";
  const error = status.error ? ` error=${status.error}` : "";
  return `${status.id} ${status.status} ${activity} alive=${status.alive}${tool}${steer}${attention}${error}`.trim();
}

export function spawnToolResult(id: string, label: string, agent?: string, terminate = true): SpawnToolResult {
  return {
    content: [{ type: "text", text: spawnSuccessText(id, label) }],
    details: { childId: id, agent },
    ...(terminate ? { terminate: true } : {}),
  };
}

function extractText(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string") return msg.content;
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const ground = new Ground();
  const deliveryQueue = new ParentDeliveryQueue(pi);
  const hub = new Hub({
    ground,
    deliver: (d: Delivery) => deliveryQueue.enqueue(d),
    benchmarkChildPolicy: benchmarkChildPolicyFromEnvironment(),
  });
  const engine = new LivenessEngine(hub, ground.tombstones);
  // The authenticated parallel benchmark is opt-in. Normal interactive and
  // autonomous-smoke launches retain the terminate-after-spawn behavior.
  const benchmarkParallelDelegation = process.env.PI_SUBAGENTS_BENCHMARK_PARALLEL_DELEGATION === "1";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopTui: (() => void) | null = null;

  const poll = (): void => {
    hub.poll();
    engine.tick();
  };

  pi.on("session_start", (_event, ctx) => {
    const entries = (ctx as ExtensionCommandContext).sessionManager?.getEntries?.() ?? [];
    deliveryQueue.restore(entries);
    if (pollTimer === null) pollTimer = setInterval(poll, 1000);
  });

  pi.on("session_shutdown", async () => {
    deliveryQueue.dispose();
    stopTui?.();
    stopTui = null;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    await hub.shutdownAll();
  });

  const spawn = async (request: SpawnRequest, toolName: string): Promise<SpawnToolResult> => {
    try {
      const id = await hub.spawn(request);
      const view = hub.getView(id);
      const label = request.title?.trim() || view?.agent || "subagent";
      return spawnToolResult(id, label, view?.agent, !benchmarkParallelDelegation);
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        details: {},
      };
    }
  };

  // Native pi delegation tool. Named engineering agents use their pinned
  // presets; calls without an agent use the general-purpose preset.
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Spawn a background pi subagent. Select a named agent for engineering roles so its pinned " +
      "provider, model, thinking level, tools, and role prompt are used. Generic calls use general-purpose. Completion is delivered automatically.",
    promptSnippet: "Spawn a named or generic background subagent; completion is delivered automatically",
    promptGuidelines: [
      "When an engineering skill names a bundled agent, pass that name in spawn_subagent.agent instead of inventing model settings.",
      "After spawn_subagent succeeds, do not poll or sleep; end your turn immediately unless genuinely independent useful work remains.",
      "Never launch pi through bash, write child PID files, inspect child processes, or shell-kill children; the subagent hub owns their lifecycle.",
      "Use cwd when a child must work in a specific worktree or directory.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String({
        description: `Bundled agent preset: ${agentRegistry.names().join(", ")}`,
      })),
      title: Type.Optional(Type.String({ description: "Short workstream title; required only for generic spawns" })),
      prompt: Type.String({ description: "Complete, self-contained instructions for the child" }),
      model: Type.Optional(Type.String({ description: "Explicit model override" })),
      provider: Type.Optional(Type.String({ description: "Explicit provider override" })),
      thinking: Type.Optional(Type.String({ description: "Explicit thinking override: off/minimal/low/medium/high/xhigh/max" })),
      cwd: Type.Optional(Type.String({ description: "Worktree or directory in which the child process starts" })),
    }),
    async execute(_toolCallId, params) {
      const request: SpawnRequest = {
        agent: typeof params.agent === "string" ? params.agent.trim() : undefined,
        title: typeof params.title === "string" ? params.title.trim() : undefined,
        prompt: typeof params.prompt === "string" ? params.prompt.trim() : "",
        model: typeof params.model === "string" ? params.model.trim() : undefined,
        provider: typeof params.provider === "string" ? params.provider.trim() : undefined,
        thinking: typeof params.thinking === "string" ? params.thinking.trim() : undefined,
        cwd: typeof params.cwd === "string" ? params.cwd.trim() : undefined,
      };
      if (!request.prompt) {
        return { content: [{ type: "text", text: "spawn_subagent requires a non-empty prompt" }], details: {} };
      }
      if (!request.agent && !request.title) {
        return { content: [{ type: "text", text: "A generic spawn_subagent call requires a non-empty title" }], details: {} };
      }
      return spawn(request, "spawn_subagent");
    },
  });

  // Keep the Cursor-shaped Task affordance narrow and route it through the
  // same named-agent resolver.
  pi.registerTool({
    name: "Task",
    label: "Task",
    description:
      "Launch a bundled subagent by type in the background. Cursor-compatible delegation alias; completion is delivered automatically.",
    promptSnippet: "Delegate work to a named bundled subagent",
    promptGuidelines: [
      "Use Task with subagent_type and prompt for Cursor-shaped delegation.",
      "Pass cwd when the child must work in a specific worktree or directory.",
      "After Task succeeds, do not call shell sleeps or poll; end your turn unless independent useful work remains.",
    ],
    parameters: Type.Object({
      subagent_type: Type.String({ description: `Named agent: ${agentRegistry.names().join(", ")}` }),
      prompt: Type.String({ description: "Complete, self-contained task for the subagent" }),
      description: Type.Optional(Type.String({ description: "Short workstream title" })),
      cwd: Type.Optional(Type.String({ description: "Worktree or directory in which the child process starts" })),
    }),
    async execute(_toolCallId, params) {
      return spawn(mapTaskRequest(params), "Task");
    },
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Subagent",
    description: "Send follow-up guidance to one live subagent without exposing control text in assistant output.",
    promptSnippet: "Steer a live subagent through the hub",
    promptGuidelines: [
      "Use steer_subagent for child guidance; never emit @child-id control lines as assistant output.",
      "If the tool reports that a child failed, do not keep steering or blindly spawn retries.",
    ],
    parameters: Type.Object({
      child_id: Type.String({ description: "Exact child id from spawn_subagent/Task" }),
      message: Type.String({ description: "Follow-up guidance for the child" }),
    }),
    async execute(_toolCallId, params) {
      const childId = typeof params.child_id === "string" ? params.child_id.trim() : "";
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!childId || !message) {
        return {
          content: [{ type: "text" as const, text: "steer_subagent requires child_id and message" }],
          details: { childId },
        };
      }
      const view = hub.getView(childId);
      if (!view || view.status === "failed" || view.status === "crashed" || view.status === "killed") {
        const status = view?.status ?? "unknown";
        const reason = view?.error ? `: ${view.error}` : "";
        return {
          content: [{ type: "text" as const, text: `steer_subagent failed: ${childId} is ${status}${reason}` }],
          details: { childId },
        };
      }
      const sent = await hub.steer(childId, message);
      return {
        content: [{
          type: "text" as const,
          text: sent ? `Guidance sent to ${childId}.` : `steer_subagent failed: ${childId} is not live`,
        }],
        details: { childId },
      };
    },
  });

  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Read bounded hub-owned status for one child or the current fleet. Use for explicit recovery and diagnostics; never poll it in a loop.",
    promptSnippet: "Inspect bounded subagent status after an alert or when the user asks",
    promptGuidelines: [
      "Use get_subagent_status after a subagent attention/failure message or when the user explicitly asks for status.",
      "Do not poll get_subagent_status repeatedly; the hub proactively delivers completions, failures, and attention events.",
    ],
    parameters: Type.Object({
      child_id: Type.Optional(Type.String({ description: "Exact child id; omit for the fleet" })),
    }),
    async execute(_toolCallId, params) {
      const childId = typeof params.child_id === "string" ? params.child_id.trim() : undefined;
      const children = hub.statuses(childId || undefined).slice(0, 20);
      const text = children.length > 0
        ? children.map(statusLine).join("\n")
        : childId
          ? `Unknown subagent: ${childId}`
          : "No subagents recorded in this session.";
      return {
        content: [{ type: "text" as const, text }],
        details: { children },
      };
    },
  });

  // Cursor's AwaitShell schema is not public or stable. This permissive shim
  // preserves the learned control-flow affordance without introducing polling.
  pi.registerTool({
    name: "AwaitShell",
    label: "Await Shell",
    description: "Yield after launching background tasks. Does not poll or wait; completion is delivered automatically.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      shell_id: Type.Optional(Type.String()),
    }),
    async execute() {
      return {
        content: [{
          type: "text" as const,
          text: "Background tasks report completion automatically. End this turn now; do not poll or sleep.",
        }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return;
    const active = ring.list().some((child) =>
      child.status === "spawning" || child.status === "working" || child.status === "asking");
    return parentBashGuard(command, active, (pid) => hub.ownsProcess(pid));
  });

  // User → child routing. `@user <text>` strips the prefix and continues as a
  // normal user message to the parent; `@all` / `@<id>` hand off to the hub.
  pi.on("input", (event) => {
    const steers = routeSteers(event.text);
    if (steers.length === 0) return;

    const forwards = steers.filter((s) => s.target !== "user");
    if (forwards.length > 0) {
      for (const s of forwards) {
        void hub.steer(s.target === "all" ? "*" : (s.childId ?? ""), s.text);
      }
      return { action: "handled" as const };
    }

    // Only @user lines → strip prefixes, hand back to the parent.
    return { action: "transform" as const, text: stripSteers(event.text) };
  });

  // Parent assistant text → child routing (parent steering while working).
  // Synthetic user-message completion also acknowledges durable delivery.
  pi.on("message_end", (event) => {
    if (event.message.role === "user") {
      deliveryQueue.acknowledgeMessage(event.message as unknown as Record<string, unknown>);
      return;
    }
    if (event.message.role !== "assistant") return;
    const text = extractText(event.message as unknown as Record<string, unknown>);
    for (const s of routeSteers(text)) {
      if (s.target === "user") continue;
      void hub.steer(s.target === "all" ? "*" : (s.childId ?? ""), s.text);
    }
  });

  // --- TUI wiring: focusable fleet immediately below the active editor ---
  pi.on("session_start", (_event, ctx) => {
    stopTui?.();
    stopTui = null;
    if (ctx.mode !== "tui") return;
    let scheduled = false;
    let disposed = false;
    let pendingRender: ReturnType<typeof setTimeout> | null = null;
    const previousEditorFactory = ctx.ui.getEditorComponent();
    let fleet!: FleetWidget;

    ctx.ui.setWidget("subagents", (tui, theme) => {
      fleet = new FleetWidget(
        tui,
        theme,
        () => ring.list(),
        async (id) => {
          const child = ring.get(id);
          const entries = loadEntriesFromFile(child?.sessionFile);
          if (!child || !entries) {
            ctx.ui.notify(`${id}: no session file to inspect`, "warning");
            return;
          }
          await openInspectOverlay(ctx, child, entries);
        },
        () => ctx.ui.notify("child conversation failed to open", "warning"),
      );
      return fleet;
    }, { placement: "belowEditor" });

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previousEditorFactory
        ? previousEditorFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      fleet.setEditor(editor, keybindings);
      if (!previousEditorFactory || supportsFleetEditorNavigation(editor)) {
        attachFleetEditorNavigation(editor, tui, keybindings, fleet);
      }
      return editor;
    });

    const render = (): void => {
      const kids = ring.list();
      fleet.refresh();
      const active = kids.filter((k) => k.status === "working" || k.status === "asking").length;
      ctx.ui.setStatus("subagents", kids.length > 0 ? `subagents: ${active}/${kids.length}` : undefined);
    };
    // Ring events throttle to ≤1 render per 250ms; a 1s freshness tick keeps
    // elapsed fields moving while children exist (never blocks the parent).
    const throttled = (): void => {
      if (scheduled || disposed) return;
      scheduled = true;
      pendingRender = setTimeout(() => {
        pendingRender = null;
        scheduled = false;
        if (!disposed) render();
      }, 250);
    };
    ring.on("update", throttled);
    ring.on("remove", throttled);
    const tick = setInterval(() => {
      if (ring.list().length > 0) render();
    }, 1000);
    render();
    stopTui = () => {
      disposed = true;
      clearInterval(tick);
      if (pendingRender !== null) clearTimeout(pendingRender);
      pendingRender = null;
      scheduled = false;
      ring.off("update", throttled);
      ring.off("remove", throttled);
    };
  });

  // `/subagent` user command.
  pi.registerCommand("subagent", {
    description: "Manage subagents: agents|spawn|spawn-agent|list|steer|kill|resume|inspect|navigate",
    handler: async (args, ctx) => {
      await subagentCommand(pi, hub, ctx, args);
    },
  });
}

/** Read a child's session file (JSONL) into renderable entries. */
function loadEntriesFromFile(sessionFile: string | undefined): SessionEntryLike[] | null {
  if (!sessionFile) return null;
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const out: SessionEntryLike[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        out.push(JSON.parse(t) as SessionEntryLike);
      } catch {
        /* tolerate a partial tail line on a live file */
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parentMessageFor(d: Delivery): string | undefined {
  switch (d.type) {
    case "lens":
      return d.final && d.lens.type === "completion"
        ? `[subagent ${d.lens.childId}] COMPLETED:\n${d.lens.digest}`
        : undefined;
    case "ask":
      return `[subagent ${d.childId}] ASK: ${d.question}`;
    case "attention":
      return `[subagent ${d.childId}] NEEDS ATTENTION (${d.kind}):\n${boundLensText(d.summary)}\nInspect with get_subagent_status before deciding whether to steer, stop, or resume.`;
    case "control":
      return d.token === "DONE-PARENT" && !d.reportDelivered
        ? `[subagent ${d.childId}] COMPLETED with no textual report.`
        : undefined;
    case "crash": {
      const retryGuidance = d.reason === "model is not supported by provider"
        ? " Do not retry this provider/model selection; use a supported named preset."
        : " Inspect the failure before deciding whether to resume or replace it.";
      return `[subagent ${d.childId}] FAILED: ${d.reason}.${retryGuidance}`;
    }
  }
}

function recordParentDelivery(pi: ExtensionAPI, d: Delivery): void {
  switch (d.type) {
    case "lens":
      pi.appendEntry("subagent_lens", d.lens);
      break;
    case "ask":
      pi.appendEntry("subagent_ask", { childId: d.childId, question: d.question, at: Date.now() });
      break;
    case "attention":
      pi.appendEntry("subagent_attention", {
        childId: d.childId,
        kind: d.kind,
        summary: boundLensText(d.summary),
        at: Date.now(),
      });
      break;
    case "control":
      if (d.token === "DONE-PARENT") pi.appendEntry("subagent_done", { childId: d.childId, at: Date.now() });
      break;
    case "crash":
      pi.appendEntry("subagent_crash", { childId: d.childId, reason: d.reason, at: Date.now() });
      break;
  }
}

export function deliverToParent(pi: ExtensionAPI, d: Delivery): void {
  const message = parentMessageFor(d);
  recordParentDelivery(pi, d);
  if (message) pi.sendUserMessage(message, { deliverAs: "steer" });
}

interface PendingParentDelivery {
  id: string;
  message: string;
  attempts: number;
}

/**
 * Durable, micro-batched fresh-turn delivery. Semantic records are persisted
 * before model wake-up; an interrupted session replays unacknowledged entries.
 */
const DELIVERY_MARKER = /^\[subagent-deliveries:([^\]]+)\](?:\n|$)/;

export class ParentDeliveryQueue {
  private readonly pi: ExtensionAPI;
  private readonly delayMs: number;
  private pending: PendingParentDelivery[] = [];
  private known = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(pi: ExtensionAPI, delayMs = 10) {
    this.pi = pi;
    this.delayMs = delayMs;
  }

  enqueue(delivery: Delivery): void {
    const message = parentMessageFor(delivery);
    if (message) {
      const id = `${Date.now().toString(36)}-${++this.sequence}`;
      // Journal the wake-up before any other side effect: restart recovery may
      // duplicate a tiny send/ack race, but it cannot silently lose delivery.
      this.pi.appendEntry("subagent_delivery_pending", { id, message, at: Date.now() });
      this.enqueuePending({ id, message, attempts: 0 });
    }
    recordParentDelivery(this.pi, delivery);
  }

  restore(entries: readonly unknown[]): void {
    const delivered = new Set<string>();
    const pending: PendingParentDelivery[] = [];
    for (const raw of entries) {
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown; message?: unknown };
      if (entry.type === "message" && typeof entry.message === "object" && entry.message !== null) {
        for (const id of this.deliveryIds(extractText(entry.message as Record<string, unknown>))) delivered.add(id);
        continue;
      }
      if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
      const data = entry.data as { id?: unknown; message?: unknown };
      if (typeof data.id !== "string") continue;
      if (entry.customType === "subagent_delivery_delivered") delivered.add(data.id);
      if (entry.customType === "subagent_delivery_pending" && typeof data.message === "string") {
        pending.push({ id: data.id, message: data.message, attempts: 0 });
      }
    }
    for (const item of pending) {
      if (!delivered.has(item.id)) this.enqueuePending(item);
    }
  }

  acknowledgeMessage(message: Record<string, unknown>): void {
    for (const id of this.deliveryIds(extractText(message))) {
      if (!this.known.delete(id)) continue;
      this.pi.appendEntry("subagent_delivery_delivered", { id, at: Date.now() });
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.known.clear();
  }

  private deliveryIds(text: string): string[] {
    const match = DELIVERY_MARKER.exec(text);
    return match ? match[1].split(",").map((id) => id.trim()).filter(Boolean) : [];
  }

  private enqueuePending(item: PendingParentDelivery): void {
    if (this.known.has(item.id)) return;
    this.known.add(item.id);
    this.pending.push(item);
    this.schedule();
  }

  private schedule(delay = this.delayMs): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, 8);
    const marker = `[subagent-deliveries:${batch.map((item) => item.id).join(",")}]`;
    try {
      this.pi.sendUserMessage(`${marker}\n${batch.map((item) => item.message).join("\n\n---\n\n")}`, { deliverAs: "steer" });
    } catch {
      for (const item of batch) {
        item.attempts += 1;
        this.pending.push(item);
      }
      const attempts = Math.max(...batch.map((item) => item.attempts));
      if (attempts <= 3) this.schedule(100 * (2 ** (attempts - 1)));
      return;
    }
    if (this.pending.length > 0) this.schedule();
  }
}

/**
 * `/subagent <cmd> <args…>` — spawn|list|steer|kill|resume|inspect.
 */
export async function subagentCommand(pi: ExtensionAPI, hub: Hub, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const restStr = rest.join(" ");
  switch (cmd) {
    case "agents": {
      const list = agentRegistry.list().map(
        (agent) => `${agent.name} ${agent.provider}/${agent.model} ${agent.thinking}`,
      );
      ctx.ui.notify(list.join("\n"), "info");
      return;
    }
    case "spawn-agent": {
      const agent = rest[0];
      const prompt = rest.slice(1).join(" ");
      if (!agent || !prompt) {
        ctx.ui.notify("/subagent spawn-agent <agent> <prompt>", "warning");
        return;
      }
      try {
        const id = await hub.spawn({ agent, prompt });
        ctx.ui.notify(`spawned ${id} (${agent})`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      return;
    }
    case "spawn": {
      const title = rest[0] ?? "untitled";
      const prompt = rest.slice(1).join(" ");
      if (prompt.length === 0) {
        ctx.ui.notify("/subagent spawn <title> <prompt>", "warning");
        return;
      }
      const id = await hub.spawn({ title, prompt });
      ctx.ui.notify(`spawned ${id} (${title})`, "info");
      return;
    }
    case "list": {
      const list = ring.list().map((v) => `${v.id} ${v.status} ${v.title}`);
      ctx.ui.notify(list.length > 0 ? list.join("\n") : "no subagents", "info");
      return;
    }
    case "steer": {
      const [id, ...msg] = restStr.split(/\s+/);
      const ok = await hub.steer(id, msg.join(" "));
      ctx.ui.notify(ok ? `steered ${id}` : `unknown child: ${id}`, ok ? "info" : "warning");
      return;
    }
    case "kill": {
      await hub.kill(rest[0]);
      ctx.ui.notify(`killed ${rest[0]}`, "info");
      return;
    }
    case "resume": {
      const ok = await hub.resume(rest[0], "You are being resumed by the parent. State your situation.");
      ctx.ui.notify(ok ? `resumed ${rest[0]}` : `cannot resume ${rest[0]} (no session file)`, ok ? "info" : "warning");
      return;
    }
    case "inspect": {
      const v = ring.get(rest[0]);
      if (!v) {
        ctx.ui.notify(`unknown child ${rest[0]}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`${v.id}: ${v.status} session ${v.sessionFile ?? "?"}`, "info");
        return;
      }
      const entries = loadEntriesFromFile(v.sessionFile);
      if (!entries) {
        ctx.ui.notify(`${v.id}: no session file to inspect`, "warning");
        return;
      }
      await openInspectOverlay(ctx, v, entries);
      return;
    }
    case "navigate": {
      const v = ring.get(rest[0]);
      if (!v) {
        ctx.ui.notify(`unknown child ${rest[0]}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("navigate requires the TUI", "warning");
        return;
      }
      const entries = loadEntriesFromFile(v.sessionFile);
      if (!entries) {
        ctx.ui.notify(`${v.id}: no session file to navigate`, "warning");
        return;
      }
      await openNavigateOverlay(ctx, v, entries);
      return;
    }
    default:
      ctx.ui.notify("/subagent spawn|list|steer|kill|resume|inspect|navigate", "warning");
      return;
  }
}
