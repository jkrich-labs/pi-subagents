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

export function findModel(id: string): RegistryModel | undefined {
  return loaded.find((m) => m.id === id);
}

const RETIRED_GROK_46 = /(?:^|[\/_-])grok-?4[.-]6(?:$|[\/_-])/i;

export function normalizeLaunchSelection(model: string, provider: string, thinking: string): {
  model: string;
  provider: string;
  thinking: string;
} {
  if (RETIRED_GROK_46.test(model)) {
    return {
      model: "gpt-5.6-terra",
      provider: "openai-codex",
      thinking: "xhigh",
    };
  }
  const id = model.toLowerCase().split("/").at(-1) ?? "";
  const isOpenAI = model.toLowerCase().startsWith("openai/") || /^(?:gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/.test(id);
  return { model, provider: isOpenAI ? "openai-codex" : provider, thinking };
}

export function providerForModel(model: string, provider: string): string {
  return normalizeLaunchSelection(model, provider, "low").provider;
}

/** Resolve legacy/default launch settings for old persisted children.
 * Placeholder tokens from an LLM are dropped; a real explicit provider passes through unchanged. */
export function resolveSpawn(req: { model?: string; provider?: string; thinking?: string }): {
  model: string;
  provider: string;
  thinking: string;
} {
  const defaultModel = process.env.SUBAGENT_MODEL ?? process.env.SUBAGENT_DEFAULT_MODEL ?? "gpt-5.6-luna";
  const defaultProvider = process.env.SUBAGENT_PROVIDER ?? "openai-codex";

  let model = req.model?.trim() ?? "";
  if (model === "" || /^(default|testing|none|auto)$/i.test(model)) model = defaultModel;
  const reg = findModel(model);

  let provider = req.provider?.trim() ?? "";
  const DROP = /^(default|testing|none|auto|registry)$/i;
  if (provider === "" || DROP.test(provider)) {
    provider = reg?.provider ?? defaultProvider;
  }
  provider = providerForModel(model, provider);

  const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  let thinking = req.thinking?.trim().toLowerCase() ?? "";
  if (!LEVELS.has(thinking)) thinking = process.env.SUBAGENT_THINKING ?? "low";

  return normalizeLaunchSelection(model, provider, thinking);
}
