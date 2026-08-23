/**
 * pi-subagents hub extension — entry point.
 * Registers the spawn_subagent tool, wires steering (user input + parent
 * assistant text), and delivers child lenses to the parent transcript via
 * appendEntry. Headless-safe: UI calls are gated on ctx.mode === "tui".
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Ground } from "./ground.ts";
import { Hub, type Delivery, type SpawnRequest } from "./hub.ts";
import { LivenessEngine } from "./liveness/engine.ts";
import { ring } from "./ring/store.ts";
import { routeSteers, stripSteers } from "./route.ts";
import { renderTicker } from "./ui/ticker.ts";
import { shouldConsumeEnter, type SessionEntryLike } from "./ui/inspect.ts";
import { openFleetOverlay, openInspectOverlay, openNavigateOverlay } from "./ui/overlay.ts";
import { readFileSync } from "node:fs";

function extractText(msg: Record<string, unknown>): string {
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const ground = new Ground();
  const hub = new Hub({ ground, deliver: (d: Delivery) => deliverToParent(pi, d) });
  const engine = new LivenessEngine(hub, ground.tombstones);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const poll = (): void => {
    hub.poll();
    engine.tick();
  };

  pi.on("session_start", () => {
    if (pollTimer === null) pollTimer = setInterval(poll, 1000);
  });

  pi.on("session_shutdown", () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    void hub.shutdownAll();
  });

  // Spawn tool — the parent LLM calls this to delegate background work.
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Spawn a background subagent (pi child process) to work on a task in parallel. " +
      "It reports back with DONE-PARENT when finished. Steer it later with @subagent-id <message>.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the child workstream" }),
      prompt: Type.String({ description: "Complete, self-contained instructions for the child" }),
      model: Type.Optional(Type.String({ description: "Model id; defaults to the registry/testing model" })),
      provider: Type.Optional(Type.String({ description: "Provider name; defaults to the model's registry provider" })),
      thinking: Type.Optional(Type.String({ description: "Thinking level (off/minimal/low/medium/high/xhigh/max)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      void toolCallId;
      if (typeof params.title !== "string" || params.title.trim().length === 0) {
        return {
          content: [{ type: "text", text: "spawn_subagent requires a non-empty title" }],
          details: {},
        };
      }
      if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
        return {
          content: [{ type: "text", text: "spawn_subagent requires a non-empty prompt" }],
          details: {},
        };
      }
      const spawnReq: SpawnRequest = {
        title: params.title.trim(),
        prompt: params.prompt.trim(),
        model: typeof params.model === "string" ? params.model : undefined,
        provider: typeof params.provider === "string" ? params.provider : undefined,
        thinking: typeof params.thinking === "string" ? params.thinking : undefined,
      };
      try {
        const id = await hub.spawn(spawnReq);
        return {
          content: [
            {
              type: "text",
              text: `Subagent spawned: ${id} (${params.title}). Steer with @${id} <message>.`,
            },
          ],
          details: { childId: id },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `spawn_subagent failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
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
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const text = extractText(event.message as unknown as Record<string, unknown>);
    for (const s of routeSteers(text)) {
      if (s.target === "user") continue;
      void hub.steer(s.target === "all" ? "*" : (s.childId ?? ""), s.text);
    }
  });

  // --- S-05 TUI wiring: live ticker + footer status + busy-stream enter ---
  let parentBusy = false;
  pi.on("agent_start", () => {
    parentBusy = true;
  });
  pi.on("agent_end", () => {
    parentBusy = false;
  });
  pi.on("agent_settled", () => {
    parentBusy = false;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let scheduled = false;
    const render = (): void => {
      const kids = ring.list();
      const lines = renderTicker(kids);
      ctx.ui.setWidget("subagents", lines.length > 0 ? lines : undefined);
      const active = kids.filter((k) => k.status === "working" || k.status === "asking").length;
      ctx.ui.setStatus("subagents", kids.length > 0 ? `subagents: ${active}/${kids.length}` : undefined);
    };
    // Ring events throttle to ≤1 render per 250ms; a 1s freshness tick keeps
    // elapsed fields moving while children exist (never blocks the parent).
    const throttled = (): void => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        render();
      }, 250);
    };
    ring.on("update", throttled);
    ring.on("remove", throttled);
    const tick = setInterval(() => {
      if (ring.list().length > 0) render();
    }, 1000);
    // Busy-stream enter: while the parent streams, enter opens the fleet
    // overlay instead of queuing editor text. Guarded against re-entry so
    // enter inside the open overlay reaches the overlay itself.
    let overlayOpen = false;
    const unsubInput = ctx.ui.onTerminalInput((data) => {
      if (overlayOpen) return undefined;
      if (!shouldConsumeEnter(data, parentBusy, ring.list().length)) return undefined;
      overlayOpen = true;
      void openFleetOverlay(ctx, ring.list(), (id) => loadEntriesFromFile(ring.get(id)?.sessionFile))
        .catch(() => ctx.ui.notify("overlay failed to open", "warning"))
        .finally(() => {
          overlayOpen = false;
        });
      return { consume: true };
    });
    render();
    pi.on("session_shutdown", () => {
      clearInterval(tick);
      ring.off("update", throttled);
      ring.off("remove", throttled);
      unsubInput();
    });
  });

  // `/subagent` user command.
  pi.registerCommand("subagent", {
    description: "Manage the subagent fleet: spawn|list|steer|kill|resume|inspect|navigate",
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

function deliverToParent(pi: ExtensionAPI, d: Delivery): void {
  switch (d.type) {
    case "lens":
      pi.appendEntry("subagent_lens", d.lens);
      break;
    case "ask":
      pi.sendUserMessage(`[subagent ${d.childId}] ASK: ${d.question}`, { deliverAs: "followUp" });
      break;
    case "control":
      if (d.token === "DONE-PARENT") {
        pi.appendEntry("subagent_done", { childId: d.childId, at: Date.now() });
      }
      break;
    case "crash":
      pi.appendEntry("subagent_crash", { childId: d.childId, reason: d.reason, at: Date.now() });
      break;
  }
}

/**
 * `/subagent <cmd> <args…>` — spawn|list|steer|kill|resume|inspect.
 */
async function subagentCommand(pi: ExtensionAPI, hub: Hub, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const restStr = rest.join(" ");
  switch (cmd) {
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
