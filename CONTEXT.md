# Context Glossary — pi-subagents

Terms used across planning/implementation/skills. Update as they crystallize.

## Definitions

- **Parent** — the main pi session that a user is talking to. Runs the hub extension's `sendUserMessage`/steer handling.
- **Child / subagent** — a separate `pi --mode rpc` process spawned by the hub, with its own session file. Not directed unless the parent's steer reaches it.
- **Hub** — the child manager: spawn, poll via `get_entries` cursor (≤1s), steering queue, finalize, events. Runs where the pi TUI process runs.
- **Ring / data ring** — the live state shared between hub and UI widgets/overlays. Single in-process object (no companion HTTP server — confirmed by S-02 spike): hub writes, UI reads.
- **Command routing** — a steer from parent → hub → child, preserving schema.
- **Interop** — child uses the same model abstraction as the parent (hyper, opencode-go alias routes like provider directly). No custom binary/middleware.
- **subagentGround** — the hub's ground directory for child session files, pidfiles, and tombstones.

## Naming invariants (never change)

- `@skill:subagents` — skill command name for user-facing subagent ops.
- `spawn_subagent` — hub's registered custom tool that the parent LLM can call.
- `agent_end` / `agent_settled` — pi event names.
- `DONE-PARENT`, `RESET-PARENT`, `INCR-PARENT` — hub-control codes (verbatim).
- `@all`, `@<child>`, `@user` — steer routing prefixes.

## Verified facts (S-02 spike, pi 0.84.2)

- Extensions run **in the same process** as pi (`extensionPid === pi pid`), so the hub can use `ctx.ui.*` directly.
- Spawn flags: use `--thinking` (not `--thinking-level`) and `--models` (not `--models-scoped`).
- API names: `ctx.mode` is `"tui" | "rpc" | "json" | "print"`; terminal input hook is `ctx.ui.onTerminalInput` (not `ctx.onTerminalInput`); handler returns `{consume?, data?} | undefined`.
