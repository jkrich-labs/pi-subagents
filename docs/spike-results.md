# S-02 spike results

Verified 2026-08-23 against **pi 0.84.2** / `@earendil-works/pi-coding-agent@0.84.2`.
Disposable extension: `spike.ts`. Logs: `.scratch/pi-subagents/spike-logs/`.

## Commands run

```text
npx tsc --noEmit -p tsconfig.json          # exit 0
# RPC (piped get_state):
pi --mode rpc -e ./spike.ts --no-session --no-extensions --offline ...
# TUI under a PTY (not a redirected stdin — that forces print mode):
python pty → pi -e ./spike.ts --no-session --no-extensions --offline ...
```

## A1 — same process as the TUI?

**Confirmed true.** The extension's `process.pid` equals the spawned `pi` pid in every mode:

| mode | `pi` pid | `extensionPid` | `ctx.mode` | `ctx.hasUI` |
|---|---|---|---|---|
| rpc | 5820 | 5820 | `rpc` | true |
| print (stdin not a TTY) | 5864 | 5864 | `print` | false |
| tui (PTY) | 5910 | 5910 | `tui` | true |

There is no separate TUI process. **Hub placement: in-process.** `ctx.ui.*` is usable directly. A companion ring HTTP server is **not** required for A1. `ring/store.ts` (S-04) can stay an in-process module.

## A2 — public package surface

**Confirmed true.** `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` compiles (`tsc --noEmit` exit 0). Runtime factory + `session_start` see:

- `ctx.mode`: `"tui" | "rpc" | "json" | "print"`
- `ctx.hasUI`: true in tui/rpc, false in print
- `ctx.ui.setWidget` / `ctx.ui.setStatus` / `ctx.ui.onTerminalInput` — functions, no throw
- `ctx.ui.onTerminalInput` (not `ctx.onTerminalInput`); handler must return `{consume?, data?} | undefined`
- `pi.sendUserMessage`, `pi.sendMessage`, `pi.appendEntry`, `pi.registerTool`, `pi.registerCommand` — functions
- Types export `deliverAs: "steer" | "followUp"` on `sendUserMessage`

## setWidget

- TUI: PTY capture contains the widget line `spike-ok pid=5910` (rendered above the editor). Pixel-level live updates still belong to S-05 smoke.
- RPC: stdout emits `extension_ui_request` with `method: "setWidget"` and `widgetLines: ["spike-ok pid=5820"]`, plus a matching `setStatus` request.
- Print: calls do not throw; they are no-ops (`hasUI: false`).

## A12 — spawn flags (partial)

| Plan name | pi 0.84.2 | Result |
|---|---|---|
| `--name` | `--name` / `-n` | works (`get_state.sessionName === "spike-child"`) |
| `--provider` | `--provider` | parses |
| `--model` | `--model` | parses |
| `--thinking-level` | **`--thinking`** | `--thinking-level` → `Unknown option` |
| `--models-scoped` | **`--models`** | `--models-scoped` → `Unknown option`; `--models cursor/*` parsed (warning if no match) |
| `--session-dir` | `--session-dir` | parses |

Use `--thinking` and `--models` in S-03 spawn. Do not pass `--thinking-level` or `--models-scoped`.

## Other facts useful to later slices

- RPC `get_state` works immediately (idle). Default `steeringMode` / `followUpMode` are already `"one-at-a-time"`.
- `--no-session` ⇒ `sessionFile: null` (expected). Children must **not** use `--no-session`.
- Redirected stdin makes `pi -e` run **print** mode, not TUI. TUI requires a real TTY/PTY.
