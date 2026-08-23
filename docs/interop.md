# Interop — model & provider mapping

How the subagent hub achieves "provider interop exact" without any vendor
binaries. The authority is pi's own provider abstraction (`hyper`, `gateway`,
custom) — `models/registry.json` records anything that is per-model.

## Ground rules

- Never import, exec, or spawn codex/cursor/other vendor binaries.
- All per-model parameters (temperature / top_p / thinking-level mapping) come
  from the repo's `models/registry.json`, never from foreign binaries.
- Child processes inherit the parent's environment and pi config, so
  `HYPER_API_KEY` / `OPENAI_API_KEY`-style credentials resolve the same way as
  the parent's provider stack. Set them explicitly in spawn opts if a provider
  needs non-default env.

## Thinking-level mapping

pi normalizes thinking into one of `off | minimal | low | medium | high |
xhigh | max`. Providers disagree on what that means:

- **Hyper (deepseek/openai-completions shape)** — pass the reasoning level
  per-request. Hyper's accepted effort/level tokens map to the pi levels in
  the registry's `thinkingLevelMap`.
- **Vercel AI gateway (GPT/Grok family)** — OpenAI-style `high`|`low` effort.
  Map pi's `medium`-and-below bucket to `low`, `high`-and-above to `high`, or
  however the target model's documented effort tokens say. Recorded in the
  registry, not guessed in code.
- **Grok / Composer-style models** — parameterized temperature + effort; the
  registry holds `defaultOverrides` (`temperature`, `top_p`) plus the thinking
  map, so spawning `--thinking <level>` never requires per-model client logic.

## Spawn-time facts (verified S-02, pi 0.84.2)

- `--name`, `--provider`, `--model`, `--thinking`, `--models`,
  `--session-dir` all parse at spawn.
- `--thinking-level` and `--models-scoped` **do not exist**; using them fails
  with `Unknown option`.
- The `:<thinking>` shorthand in a model pattern (e.g. `cursor/grok:high`)
  also pins a level; prefer the registry + `--thinking` so one path holds.

## Cache discipline

- One steer per settled turn = single appended user message per turn = a
  stable prefix between sends. Multi-steer would fragment the message list and
  cost cache hits on hyper-style openai-completions providers.
- Always keep steering messages single-line (from-plan fact: multi-line
  message breaks cache-prefix shape on fragmented providers).

## Provider notes (fill as verified)

| Provider | thinking | temperature/top_p | notes |
|---|---|---|---|
| hyper | reasoning level per request | `defaultOverrides` | deepseek-style on/off |
| vercel-ai-gateway | `high`\|`low` effort | `defaultOverrides` | GPT-5.x/Grok models |
