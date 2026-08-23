# pi-subagents

Background subagent fleet for [pi](https://github.com/earendil-works/pi): a
hub extension that spawns `pi --mode rpc` children, forwards one
steer per settled turn, delivers child completions to the parent at its turn
boundaries, and shows live progress in the pi TUI — with no turn/token/
wall-clock caps anywhere.

- **[CONTEXT.md](CONTEXT.md)** — the vocabulary (parent/child/hub/ring and the naming invariants).
- **[docs/spike-results.md](docs/spike-results.md)** — verified pi 0.84.2 facts (same-process extensions, public API surface, spawn flags).
- **[docs/interop.md](docs/interop.md)** — provider interop (hyper / gateway / grok thinking + temperature maps).
- **[docs/provider-maps.md](docs/provider-maps.md)** — `models/registry.json` format reference.

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
```

## Install (when the hub ships)

```bash
pi install /path/to/pi-subagents
# or: ln -s …/pi-subagents/extensions/subagents ~/.pi/agent/extensions/subagents
```

## Status

Under construction — see the slice plan (`.scratch/pi-subagents/plan.md`). No
downloadable artifact yet.
