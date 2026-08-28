/**
 * Bundled named-agent registry. Markdown frontmatter owns stable dispatch
 * defaults; the body owns only the role prompt. Per-model wire facts remain in
 * models/registry.json.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeLaunchSelection } from "./registry.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentToolPolicy = "normal";

export interface AgentDefinition {
  name: string;
  description: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  toolPolicy: AgentToolPolicy;
  rolePrompt: string;
  source: string;
}

export interface AgentOverrides {
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface ResolvedAgent {
  name: string;
  description: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  toolPolicy: AgentToolPolicy;
  rolePrompt: string;
  systemPrompt: string;
}

export const CHILD_CONTROL_PROTOCOL = [
  "You are a background subagent spawned by a parent pi agent.",
  "Work autonomously on your assigned task. There are no turn, token or time limits.",
  "When your task is complete, write a final report and end it with the exact line: DONE-PARENT",
  "If you are blocked on a question only the parent can answer, ask it as a line of the form: ASK: <question>",
  "Never finish a turn without one of: the exact line DONE-PARENT, an ASK: line, or an explicit request to continue. A report alone is not a completion — the parent needs DONE-PARENT on its own line as the final line of your final message.",
  "Never write DONE-PARENT before your task is complete.",
].join("\n");

export function composeAgentSystemPrompt(rolePrompt: string): string {
  return `${CHILD_CONTROL_PROTOCOL}\n\nRole instructions:\n${rolePrompt.trim()}`;
}

export function bundledAgentsPath(): string {
  return join(import.meta.dirname, "agents");
}

function parseFrontmatter(file: string, raw: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`Malformed agent definition ${file}: expected --- frontmatter and a role prompt`);

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const pair = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!pair || pair[2] === "") {
      throw new Error(`Malformed agent definition ${file}: invalid frontmatter line ${JSON.stringify(line)}`);
    }
    if (fields.has(pair[1])) throw new Error(`Malformed agent definition ${file}: duplicate field ${pair[1]}`);
    fields.set(pair[1], pair[2]);
  }
  return { fields, body: match[2].trim() };
}

function parseDefinition(path: string): AgentDefinition {
  const file = basename(path);
  const { fields, body } = parseFrontmatter(file, readFileSync(path, "utf8"));
  const required = ["name", "description", "provider", "model", "thinking", "tools"];
  const unknown = [...fields.keys()].filter((key) => !required.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Malformed agent definition ${file}: unknown field ${unknown.join(", ")}`);
  }
  const missing = required.filter((key) => !fields.get(key));
  if (body.length === 0) missing.push("role prompt");
  if (missing.length > 0) {
    throw new Error(`Malformed agent definition ${file}: missing ${missing.join(", ")}`);
  }

  const thinking = fields.get("thinking")!;
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`Malformed agent definition ${file}: invalid thinking ${thinking}; expected ${THINKING_LEVELS.join(", ")}`);
  }
  const tools = fields.get("tools")!;
  if (tools !== "normal") {
    throw new Error(`Malformed agent definition ${file}: invalid tools ${tools}; expected normal`);
  }

  return {
    name: fields.get("name")!,
    description: fields.get("description")!,
    provider: fields.get("provider")!,
    model: fields.get("model")!,
    thinking: thinking as ThinkingLevel,
    toolPolicy: tools,
    rolePrompt: body,
    source: file,
  };
}

export function loadAgentDefinitions(directory = bundledAgentsPath()): AgentDefinition[] {
  const definitions: AgentDefinition[] = [];
  const byName = new Map<string, AgentDefinition>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".md")).sort()) {
    const definition = parseDefinition(join(directory, file));
    const previous = byName.get(definition.name);
    if (previous) {
      throw new Error(`Duplicate agent ${definition.name}: ${previous.source} and ${definition.source}`);
    }
    byName.set(definition.name, definition);
    definitions.push(definition);
  }
  return definitions;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class AgentRegistry {
  private readonly definitions: Map<string, AgentDefinition>;

  constructor(definitions: AgentDefinition[]) {
    this.definitions = new Map();
    for (const definition of definitions) {
      const previous = this.definitions.get(definition.name);
      if (previous) throw new Error(`Duplicate agent ${definition.name}: ${previous.source} and ${definition.source}`);
      this.definitions.set(definition.name, definition);
    }
  }

  names(): string[] {
    return [...this.definitions.keys()].sort();
  }

  list(): AgentDefinition[] {
    return this.names().map((name) => this.definitions.get(name)!);
  }

  resolve(name: string, overrides: AgentOverrides = {}): ResolvedAgent {
    const definition = this.definitions.get(name.trim());
    if (!definition) {
      throw new Error(`Unknown agent ${JSON.stringify(name)}. Available agents: ${this.names().join(", ")}`);
    }
    const explicitThinking = nonEmpty(overrides.thinking)?.toLowerCase();
    if (explicitThinking && !(THINKING_LEVELS as readonly string[]).includes(explicitThinking)) {
      throw new Error(`Invalid thinking ${JSON.stringify(overrides.thinking)}; expected ${THINKING_LEVELS.join(", ")}`);
    }

    const model = nonEmpty(overrides.model) ?? definition.model;
    const selection = normalizeLaunchSelection(
      model,
      nonEmpty(overrides.provider) ?? definition.provider,
      (explicitThinking as ThinkingLevel | undefined) ?? definition.thinking,
    );
    return {
      name: definition.name,
      description: definition.description,
      provider: selection.provider,
      model: selection.model,
      thinking: selection.thinking as ThinkingLevel,
      toolPolicy: definition.toolPolicy,
      rolePrompt: definition.rolePrompt,
      systemPrompt: composeAgentSystemPrompt(definition.rolePrompt),
    };
  }
}

export const agentRegistry = new AgentRegistry(loadAgentDefinitions());
