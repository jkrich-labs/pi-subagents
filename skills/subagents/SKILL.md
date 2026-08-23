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
- Child outputs are mail-in, not polled. Read completions / questions when
  the hub surfaces them in your turn; never make "are you done yet?" calls.
- Child sessions always persist (`--session-dir`, no `--no-session`), so
  resume rewinds exactly.

## Commands seen by the parent

- `spawn_subagent` (tool) — call the hub tool when delegating. Provide a title,
  a complete prompt, optional `model`, `provider`, `thinking`, and whether the
  child may call `@all`.
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
- Orphans from dead parents are reaped at next hub startup via pidfile + ppid
  check.
- Loop/stall probes ask the child to reply `KEEP-GOING`; probes never auto-kill.

## User commands (TUI)

- `/subagent spawn <title>` — spawn with prompt from the user.
- `/subagent list` — live list with model::thinking, turns, elapsed, badge.
- `/subagent steer <id> <text>` — parent-less direct steer.
- `/subagent ask <id> <text>` — answer a pending ask.
- `/subagent inspect <id>` — overlay on that child's session file.
- `/subagent kill <id>` / `/subagent resume <id>` — murder / resurrect.

## Examples

```
User: "spawn a research child on the pi RPC protocol"
Parent: spawn_subagent(title="rpc research", prompt="read the pi docs …", model=...)

Child work continues while parent keeps working.
Child: DONE-PARENT — "summary lens …"
Parent: uses the lens in its own next turn.
```
