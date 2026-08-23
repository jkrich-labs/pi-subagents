/**
 * pi-subagents hub extension — entry point.
 * Registers the spawn_subagent tool, wires steering (user input + parent
 * assistant text), and delivers child lenses to the parent transcript via
 * appendEntry. Headless-safe: UI calls are gated on ctx.mode === "tui".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Ground } from "./ground.ts";
import { Hub, type Delivery, type SpawnRequest } from "./hub.ts";
import { ring } from "./ring/store.ts";
import { routeSteers, stripSteers } from "./route.ts";

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
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", () => {
    if (pollTimer === null) pollTimer = setInterval(() => hub.poll(), 1000);
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

  // Live ticker placeholder — S-05 renders ring state. Keep a stable key
  // so the footer/status slot exists from this slice on.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") {
      const kids = ring.list().length;
      ctx.ui.setStatus("subagents", kids > 0 ? `subagents: ${kids}` : undefined);
    }
  });
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
