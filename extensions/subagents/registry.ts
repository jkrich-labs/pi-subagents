/**
 * Registry loader — models/registry.json is the single source of per-model
 * truth (provider, thinking map, temperature/top_p overrides). Never
 * hardcode a per-model value in the hub.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RegistryModel {
  id: string;
  provider: string;
  name: string;
  thinkingLevelMap?: Record<string, string | null>;
  defaultOverrides?: {
    temperature?: number;
    top_p?: number;
  };
}

/** Repo-root models/registry.json, overridable via SUBAGENT_REGISTRY. */
export function registryPath(): string {
  return process.env.SUBAGENT_REGISTRY ?? join(import.meta.dirname, "..", "..", "models", "registry.json");
}

export function loadRegistry(): RegistryModel[] {
  try {
    const raw = readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as { models?: RegistryModel[] };
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return []; // unknown ids fall back to explicit spawn args
  }
}

const loaded = loadRegistry();

/** Providers the registry names, plus pi's known-good built-ins. */
export function knownProviders(): Set<string> {
  const set = new Set<string>(["hyper"]);
  for (const m of loaded) {
    if (m.provider) set.add(m.provider);
  }
  return set;
}

export function findModel(id: string): RegistryModel | undefined {
  return loaded.find((m) => m.id === id);
}

/** Resolve spawn model info: explicit args win, then registry, then defaults.
 *  Sanity: junk verbatim tokens ("default", "testing", …) from an LLM are
 *  dropped to the registry defaults; thinking must be a real level. */
export function resolveSpawn(req: { model?: string; provider?: string; thinking?: string }): {
  model: string;
  provider: string;
  thinking: string;
} {
  const defaultModel = process.env.SUBAGENT_MODEL ?? process.env.SUBAGENT_DEFAULT_MODEL ?? "gpt-5.6-luna";
  const defaultProvider = process.env.SUBAGENT_PROVIDER ?? "opencode-go";

  let model = req.model?.trim() ?? "";
  if (model === "" || /^(default|testing|none|auto)$/i.test(model)) model = defaultModel;
  const reg = findModel(model);

  let provider = req.provider?.trim() ?? "";
  const DROP = /^(default|testing|none|auto)$/i;
  if (provider === "" || DROP.test(provider)) {
    provider = reg?.provider ?? defaultProvider;
  } else if (!knownProviders().has(provider)) {
    // Junk tokens from the LLM (e.g. "registry") must never reach spawn.
    provider = reg?.provider ?? defaultProvider;
  }

  const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  let thinking = req.thinking?.trim().toLowerCase() ?? "";
  if (!LEVELS.has(thinking)) thinking = process.env.SUBAGENT_THINKING ?? "low";

  return { model, provider, thinking };
}
