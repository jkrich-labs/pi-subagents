# pi-subagents

Background subagent fleet for [pi](https://github.com/earendil-works/pi): a
hub extension that spawns `pi --mode rpc` children, forwards one
steer per settled turn, delivers child completions to the parent at its turn
boundaries, and shows live progress in the pi TUI — with no turn/token/
wall-clock caps anywhere.

- **[CONTEXT.md](CONTEXT.md)** — the vocabulary (parent/child/hub/ring and the naming invariants).
- **[docs/spike-results.md](docs/spike-results.md)** — verified pi 0.84.2 facts (same-process extensions, public API surface, spawn flags).
- **[docs/interop.md](docs/interop.md)** — provider interop (hyper / openai-codex thinking and temperature maps).
- **[docs/provider-maps.md](docs/provider-maps.md)** — `models/registry.json` format reference.

## Quickstart

Prerequisites:

- **pi 0.84.2** on `PATH` (`npm install -g @earendil-works/pi-coding-agent@0.84.2`)
- **Node 24+** (tests run on `node --test` with native TypeScript stripping)
- Provider auth for the child model, same as an interactive pi run
  (tests and the registry default pin `gpt-5.6-luna` via `openai-codex`)

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

- The parent calls `spawn_subagent` with a named `agent`, or uses the Cursor-compatible `Task` alias. Calls without `agent` remain supported and use the `general-purpose` preset.
- List presets with `/subagent agents`. Start one manually with `/subagent spawn-agent <agent> <prompt>`; use `/subagent spawn <title> <prompt>` for a generic child.
- Named presets keep these defaults unless the caller explicitly overrides them. OpenAI-family models always use the subscription-backed `openai-codex` provider:

  | Agent | Provider/model | Thinking |
  |---|---|---|
  | `explorer` | `openai-codex/gpt-5.6-luna` | `medium` |
  | `planner` | `kimi-coding/k3` | `max` |
  | `mechanical-worker` | `openai-codex/gpt-5.6-luna` | `xhigh` |
  | `general-purpose` | `openai-codex/gpt-5.6-terra` | `xhigh` |
  | `senior` | `openai-codex/gpt-5.6-sol` | `xhigh` |
  | `visual-designer` | `hyper/qwen3.8-max` | `high` |
  | `reviewer-standards` | `openai-codex/gpt-5.6-terra` | `xhigh` |
  | `reviewer-spec` | `openai-codex/gpt-5.6-terra` | `xhigh` |

- Pass `cwd` to `spawn_subagent` or `Task` when a child must work in an isolated worktree.
- After spawning, continue only genuinely independent work. Otherwise, end your turn immediately. Never launch `pi` through bash, create PID/exit files, poll, sleep, inspect child processes, or manufacture busywork while waiting.
- Parent models steer with `steer_subagent`; this keeps control messages out of assistant output and reports a failed child immediately. Humans may still type `@<child-id> <message>` (`@all` broadcasts, `@user` returns to the parent).
- Child failures are delivered as model-visible follow-up messages. An unsupported provider/model pair trips a session-local circuit breaker so retries cannot create a fleet of identical failures.
- Children have pi's normal built-in tools enabled; unrelated extensions and
  skills remain disabled for isolation.
- The focusable **fleet ticker** below the editor shows each child: status,
  model::thinking, turns, compactions, elapsed, last completion, and badges.
  Press **Down** when editor navigation is exhausted to enter it, use Up/Down
  to select a child, **Enter** to inspect, and **Up** above the first row to
  return to the editor. Focused dialogs keep their own Enter and arrow keys.
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
