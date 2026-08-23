# Provider maps — registry format reference

`models/registry.json` is the single source of per-model truth that the hub
reads at spawn. The schema below is implemented by the registry loader
(S-04); nothing else in the hub may hardcode a per-model value.

## JSON schema

```json
{
  "$schema": "../docs/provider-maps.md",
  "version": 1,
  "models": [
    {
      "id": "gpt-5.6-luna",
      "provider": "openai-codex",
      "name": "GPT 5.6 Luna",
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      },
      "defaultOverrides": {
        "temperature": 0.7,
        "top_p": 1.0
      }
    }
  ]
}
```

## Field contract (verbatim names)

- `registryEntry.id` — exact model id string, as accepted by
  `pi --model <id>`.
- `.provider` — provider name the id lives under (hyper, openai-codex, …);
  must match a provider pi knows.
- `.name` — display name for the ticker/lens/UX.
- `.thinkingLevelMap` — maps each pi level to the provider token for that
  level, or `null` when that level does not exist on the model. Keys are
  fixed `off,minimal,low,medium,high,xhigh,max`. Omit the map for models
  without thinking → all levels map to `off`.
- `.defaultOverrides` — optional per-model `temperature` and `top_p` sent on
  spawn and on steer; the provider's default applies when omitted.

## Loading rules

1. Load once per hub boot; re-read after `/subagent reload-registry`.
2. Unknown id → refuse to spawn and tell the parent, rather than guessing a
   provider's params.
3. Ticker/lens display uses `.name`, conversations use `.id`.

## Example mapping table (partial — fill by verification)

| id | provider | thinking token scheme |
|---|---|---|
| gpt-5.6-luna | openai-codex | registry thinkingLevelMap |

Provider-token facts belong here after S-03 verification; interop prose lives
in `docs/interop.md`.
