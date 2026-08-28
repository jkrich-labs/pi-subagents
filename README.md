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

## Benchmark suite and pi-autoresearch

The opt-in authenticated suite uses the bundled manifest policy and runs
parallel diagnosis, isolated parallel implementation, and review convergence
from clean fixtures. It can incur provider cost; it is not part of ordinary unit CI.

```bash
# One complete, approximately five-minute target sample and strict raw KPI output.
npm run benchmark:subagents -- --profile quick --format autoresearch \
  --output /tmp/pi-subagents-benchmark.json

# Three independently reset samples; JSON contains per-sample records, medians, and MADs.
npm run benchmark:subagents -- --profile confirm --format json \
  --output /tmp/pi-subagents-benchmark-confirm.json
```

`wall_time_ms`, `total_tokens`, and `tool_failures` are independent,
lower-is-better KPIs. Autoresearch output has exactly one finite `METRIC` line
for each only after every correctness, policy, autonomous-completion, scope,
fixture, and cleanup hard gate passes; it never produces a composite score.
JSON artifacts are atomically written and contain the active manifest,
suite/model-policy digests, observed process launch trace, all scenario gates,
raw sample values, and median/MAD summaries. Fixture verification runs with
Node permissions, frozen intrinsics, and a separate verifier guard; fixture
and scoring paths are protected from candidate edits.

Protect benchmark inputs and scoring from candidate edits in a pi-autoresearch
run specification, for example:

```json
{
  "protectedPaths": [
    "harness/benchmark/**",
    "harness/rpc-child.ts",
    "extensions/subagents/**",
    "tests/benchmark-*.test.ts",
    "package.json",
    ".npmrc"
  ],
  "evaluator": "npm run benchmark:subagents -- --profile quick --format autoresearch --output /tmp/pi-subagents-benchmark.json"
}
```

Use `npm run benchmark:subagents -- --help` for profiles, diagnostic
single-scenario commands, output paths, cost, and hard-gate details.

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
  | `planner` | `hyper/qwen3.8-max` | `max` |
  | `mechanical-worker` | `openai-codex/gpt-5.6-luna` | `xhigh` |
  | `general-purpose` | `openai-codex/gpt-5.6-terra` | `xhigh` |
  | `senior` | `openai-codex/gpt-5.6-sol` | `xhigh` |
  | `visual-designer` | `hyper/qwen3.8-max` | `high` |
  | `reviewer-standards` | `openai-codex/gpt-5.6-terra` | `xhigh` |
  | `reviewer-spec` | `openai-codex/gpt-5.6-terra` | `xhigh` |

- Pass `cwd` to `spawn_subagent` or `Task` when a child must work in an isolated worktree.
- After spawning, continue only genuinely independent work. Otherwise, end your turn immediately. Never launch `pi` through bash, create PID/exit files, poll, sleep, inspect child processes, or manufacture busywork while waiting.
- Parent models steer with `steer_subagent`; this keeps control messages out of assistant output and reports a failed child immediately. A busy child receives guidance after its current tool batch and before its next model call; an idle child starts a fresh turn. The hub records steering as queued, delivered, or missed and alerts the parent when a child finishes before accepted guidance lands. Humans may still type `@<child-id> <message>` (`@all` broadcasts, `@user` returns to the parent).
- `get_subagent_status` provides bounded read-only fleet status for explicit diagnosis after an alert. It is not a polling primitive.
- Completions, asks, failures, and attention events are micro-batched at the same safe parent turn boundary. Wake-ups are journalled before send and acknowledged afterward, so an unacknowledged delivery is restored after session reload instead of disappearing.
- Child failures are delivered as model-visible follow-up messages. A child that settles without `DONE-PARENT` becomes `settled` and wakes the parent rather than remaining falsely `working`. An unsupported provider/model pair trips a session-local circuit breaker so retries cannot create a fleet of identical failures.
- Children inherit pi's full environment/resources — including project-local
  extensions, skills, prompts, themes, and context files — plus normal tools.
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
  resumable (`/subagent resume <id>`). One heartbeat may be in flight per
  child. Three transport misses terminate a non-tool child with one exact
  failure; misses during a known running tool are non-fatal. Responsive but
  progress-frozen children raise attention after 450s between model/tool
  events or 1200s inside a tool, without semantic auto-kill.

## Status

All planned slices implemented (spike → harness → hub/ring → liveness → TUI →
verify). See `.scratch/pi-subagents/plan.md` for the spec and acceptance
evidence per slice.
