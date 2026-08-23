# Context Glossary — pi-subagents

Terms used across planning/implementation/skills. Update as they crystallize.

## Definitions

- **Parent** — the main pi session that a user is talking to. Runs the hub extension's `sendUserMessage`/steer handling.
- **Child / subagent** — a separate `pi --mode rpc` process spawned by the hub, with its own session file. Not directed unless the parent's steer reaches it.
- **Hub** — the child manager: spawn, poll via `get_entries` cursor (≤1s), steering queue, finalize, events. Runs where the pi TUI process runs.
- **Ring / data ring** — the live state shared between hub and UI widgets/overlays. Single in-process object (no companion HTTP server — confirmed by S-02 spike): hub writes, UI reads.
- **Command routing** — a steer from parent → hub → child, preserving schema.
- **Interop** — child uses pi's provider abstraction directly. OpenAI-family models route through the subscription-backed `openai-codex` provider; no custom binary or middleware.
- **subagentGround** — the hub's ground directory for child session files, pidfiles, and tombstones.
- **Request probe** — a test-only capture extension (`probe/`, loaded into children via `pi -e`) that records `before_provider_request` payloads to NDJSON. The payload-truth seam for provider verification. Never shipped in the hub.
- **Named agent / agent preset** — a bundled Markdown definition that gives a child a stable role prompt and default provider, model, thinking level, and tool policy. Explicit spawn arguments override its defaults.
- **Generic spawn** — a backward-compatible call with no `agent`; it keeps the caller's title and prompt but resolves through the `general-purpose` preset.

## Naming invariants (never change)

- `@skill:subagents` — skill command name for user-facing subagent ops.
- `spawn_subagent` — hub's registered custom tool that the parent LLM can call.
- `steer_subagent` — model-facing parent → child guidance tool; unlike human `@<child>` input, it does not leak routing text into assistant output.
- `agent_end` / `agent_settled` — pi event names.
- `DONE-PARENT`, `RESET-PARENT`, `INCR-PARENT` — hub-control codes (verbatim).
- `@all`, `@<child>`, `@user` — human-input steer routing prefixes. Multiple child prefixes on one line target each child.

## Verified facts (S-02 spike, pi 0.84.2)

- Extensions run **in the same process** as pi (`extensionPid === pi pid`), so the hub can use `ctx.ui.*` directly.
- Spawn flags: use `--thinking` (not `--thinking-level`) and `--models` (not `--models-scoped`).
- API names: `ctx.mode` is `"tui" | "rpc" | "json" | "print"`; terminal input hook is `ctx.ui.onTerminalInput` (not `ctx.onTerminalInput`); handler returns `{consume?, data?} | undefined`.
