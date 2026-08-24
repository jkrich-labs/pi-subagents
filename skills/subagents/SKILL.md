---
name: subagents
description: Run and steer a fleet of background child pi agents from the parent session. Use to spawn a child, steer/ask/finalize via routing codes, and inspect/kill/resume, so that in-progress work continues in children while the parent proceeds.
---

# Subagents — background child fleet

Skills that require long-running, parallel, or interruptible work can use this
skill to control a fleet of background children. Each child is a separate
`pi --mode rpc` process with its own session file. The parent steers a child
exactly once per settled turn; work ends only when the child states done or the
user cancels.

You are reading this as the parent. Follow the rules below when
delegating/steering children through the hub.

## Invariants - never violate

- One steering message per settled turn per child. Never double-send. The hub
  enforces this — a second steer is refused until the child settles.
- No caps of any kind. Don't assign turn/token/wall-clock budgets. Done-ness is
  the child's own `DONE-PARENT` or the user's cancel.
- Child outputs are mail-in, not polled. Read completions, questions, failures, or attention events when the hub surfaces them. Wake-ups are durable and micro-batched at a safe parent turn boundary.
- After spawning, continue only genuinely independent useful work. If the remaining work depends on a child, end your turn immediately.
- While waiting, never poll, sleep, or manufacture busywork. Do not inspect or kill child processes; the hub owns their lifecycle and delivers completion automatically.
- Child sessions always persist (`--session-dir`, no `--no-session`), so
  resume rewinds exactly.

## Commands seen by the parent

- `spawn_subagent` (tool) — prefer a bundled `agent` name plus a complete prompt. A named call uses its pinned provider, model, thinking level, tools, and role prompt. Explicit `model`, `provider`, or `thinking` values override the preset independently, except OpenAI-family models always use the subscription-backed `openai-codex` provider. Calls without `agent` require `title` and use the `general-purpose` preset. Pass `cwd` for an isolated worktree.
- `Task` (tool) — Cursor-compatible alias. Pass `subagent_type` and `prompt`; it routes through the same named-agent resolver and accepts `cwd` for an isolated worktree.
- `steer_subagent` (tool) — send guidance to one live child. Parent models use this instead of emitting visible `@child-id` assistant text; steering a failed child returns its failure immediately. Busy-child guidance lands after the current tool batch and before the next model call. The hub records queued/delivered/missed state and alerts on a missed steer.
- `get_subagent_status` (tool) — bounded read-only status for one child or the fleet. Use after an attention/failure message or an explicit user request; never loop on it.
- `AwaitShell` (tool) — compatibility yield only. It ends the parent turn and never polls.
- Bundled agents:
  - `explorer` — `openai-codex/gpt-5.6-luna`, `medium`
  - `planner` — `kimi-coding/k3`, `max`
  - `mechanical-worker` — `openai-codex/gpt-5.6-luna`, `xhigh`
  - `general-purpose` — `openai-codex/gpt-5.6-terra`, `xhigh`
  - `senior` — `openai-codex/gpt-5.6-sol`, `xhigh`
  - `visual-designer` — `hyper/qwen3.8-max`, `high`
  - `reviewer-standards` — `openai-codex/gpt-5.6-terra`, `xhigh`
  - `reviewer-spec` — `openai-codex/gpt-5.6-terra`, `xhigh`.
- On a child, pipe routing awaits on the parent's message stream. Anything the
  parent replies with a routing prefix reaches the dispatcher. Judge routing
  the same way the hub would:
  - `@all` — steer every live child (broadcast).
  - `@<child>` — steer only the named child.
  - `@user` — route to the human user.
  - anything else (after capture) is child-less chit-chat — there is no
    "recover from the wrong child".

## Child→parent codes and how to answer them

Children speak codes in their completion. The routing table:

| Child says | Meaning | Parent must do |
|---|---|---|
| `DONE-PARENT` | Child finished; completion lens delivered. | Acknowledge only if the deliverable needs a post-step. |
| `RESET-PARENT` | Child's session was reset/resumed with clean state. | Treat prior partial lens as stale; expect a fresh completion. |
| `INCR-PARENT` | Child's `@all` scope was incremented. | No reply needed unless the increment changed your dependency. |
| `ASK <q>` (or ask-prefix lens) | Child is blocked on a question. | Answer once in the same steering lane, or explicitly defer. |
| `STALL` / `LOOP` probe lens | Hub probed the child for stall/loop; child was asked to state its situation or reply `KEEP-GOING`. | Escalation to the user — never an auto-kill. |

## Failure/liveness you rely on

- Crashed/transport-dead children are tombstoned; the tombstone names the
  session file. Killing a child loses no work — `/subagent resume <id>`
  re-links the same session file.
- A child that settles without `DONE-PARENT` is marked `settled` and wakes the parent with a bounded diagnostic; it is never left silently `working`.
- Responsive children with no model/tool progress raise attention after the progress threshold. These semantic warnings never auto-kill the child.
- Orphans from dead parents are reaped at next hub startup via pidfile + ppid
  check.
- Loop/stall probes ask the child to reply `KEEP-GOING`; probes never auto-kill.

## User commands (TUI)

- `/subagent agents` — list bundled agents and their provider/model/thinking defaults.
- `/subagent spawn-agent <agent> <prompt>` — spawn a named agent.
- `/subagent spawn <title> <prompt>` — spawn a generic child.
- `/subagent list` — live list with model::thinking, turns, elapsed, badge.
- `/subagent steer <id> <text>` — parent-less direct steer.
- `/subagent ask <id> <text>` — answer a pending ask.
- `/subagent inspect <id>` — overlay on that child's session file.
- `/subagent kill <id>` / `/subagent resume <id>` — murder / resurrect.

## Examples

```
User: "spawn a research child on the pi RPC protocol"
Parent: spawn_subagent(title="rpc research", prompt="read the pi docs …", model=...)

Parent: steer_subagent(child_id="…", message="focus on the RPC framing seam")

Child work continues while parent keeps working. The parent must not launch `pi`
through bash, create PID/exit files, or poll with shell sleeps.
Child: DONE-PARENT — "summary lens …"
Parent: uses the lens in its own next turn.
```
