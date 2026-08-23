# pi-subagents

Background subagent fleet for [pi](https://github.com/earendil-works/pi): a
hub extension that spawns `pi --mode rpc` children, forwards one
steer per settled turn, delivers child completions to the parent at its turn
boundaries, and shows live progress in the pi TUI — with no turn/token/
wall-clock caps anywhere.

- **[CONTEXT.md](CONTEXT.md)** — the vocabulary (parent/child/hub/ring and the naming invariants).
- **[docs/spike-results.md](docs/spike-results.md)** — verified pi 0.84.2 facts (same-process extensions, public API surface, spawn flags).
- **[docs/interop.md](docs/interop.md)** — provider interop (hyper / opencode-go / grok thinking + temperature maps).
- **[docs/provider-maps.md](docs/provider-maps.md)** — `models/registry.json` format reference.

## Quickstart

Prerequisites:

- **pi 0.84.2** on `PATH` (`npm install -g @earendil-works/pi-coding-agent@0.84.2`)
- **Node 24+** (tests run on `node --test` with native TypeScript stripping)
- Provider auth for the child model, same as an interactive pi run
  (tests and the registry default pin `gpt-5.6-luna` via `opencode-go`)

Then:

```bash
npm install
make verify        # tsc typecheck + all test suites (spawns real pi children)
make unit          # pure unit tests only — no children, no provider auth
make smoke         # scripted PTY smoke of the TUI (scripts/smoke-tui.py)
```

## Install the hub

```bash
ln -s "$PWD/extensions/subagents" ~/.pi/agent/extensions/subagents
# or run pi from this repo: package.json's "pi.extensions" loads ./extensions/subagents
```

## Use

- The parent agent calls the `spawn_subagent` tool, or you run
  `/subagent spawn <title> <prompt>`.
- Steer from the parent with `@<child-id> <message>` (`@all` broadcasts,
  `@user` strips back to a normal parent message).
- The **ticker** above the editor shows each child: status, model::thinking,
  turns, compactions, elapsed, last completion, ask/loop/stall badges.
  While the parent is streaming, **Enter** opens the fleet overlay.
- `/subagent list | inspect <id> | navigate <id> | kill <id> | resume <id>` —
  inspect/navigate open the Markdown conversation overlay over the child's own
  session file (chrono/jump/entry-id navigation, `c` copies an entry).
- Children end only on their own `DONE-PARENT` or your cancel; crashes and
  transport-dead children get tombstones under the subagent ground and are
  resumable (`/subagent resume <id>`).

## Status

All planned slices implemented (spike → harness → hub/ring → liveness → TUI →
verify). See `.scratch/pi-subagents/plan.md` for the spec and acceptance
evidence per slice.
