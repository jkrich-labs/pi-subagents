import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  CHILD_CONTROL_PROTOCOL,
  bundledAgentsPath,
  loadAgentDefinitions,
} from "../extensions/subagents/agents.ts";

const EXPECTED = {
  explorer: ["openai-codex", "gpt-5.6-luna", "medium"],
  planner: ["kimi-coding", "k3", "max"],
  "mechanical-worker": ["openai-codex", "gpt-5.6-luna", "xhigh"],
  "general-purpose": ["cursor", "cursor-grok-4.6-fast", "high"],
  senior: ["openai-codex", "gpt-5.6-sol", "xhigh"],
  "visual-designer": ["hyper", "qwen3.8-max", "high"],
  "reviewer-standards": ["cursor", "cursor-grok-4.6-fast", "high"],
  "reviewer-spec": ["openai-codex", "gpt-5.6-terra", "xhigh"],
} as const;

function definition(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Test agent\nprovider: cursor\nmodel: test-model\nthinking: high\ntools: normal\n${extra}---\nAct as the test role.\n`;
}

test("agent registry discovers the exact shipped inventory", () => {
  const registry = new AgentRegistry(loadAgentDefinitions(bundledAgentsPath()));
  assert.deepEqual(registry.names(), Object.keys(EXPECTED).sort());

  for (const [name, [provider, model, thinking]] of Object.entries(EXPECTED)) {
    const resolved = registry.resolve(name);
    assert.equal(resolved.name, name);
    assert.equal(resolved.provider, provider, `${name} provider`);
    assert.equal(resolved.model, model, `${name} model`);
    assert.equal(resolved.thinking, thinking, `${name} thinking`);
    assert.equal(resolved.toolPolicy, "normal", `${name} receives normal built-in tools`);
    assert.ok(resolved.rolePrompt.trim().length > 0, `${name} role prompt`);
    assert.equal(
      resolved.systemPrompt.split(CHILD_CONTROL_PROTOCOL).length - 1,
      1,
      `${name} composes the hub protocol exactly once`,
    );
  }
});

test("agent registry rejects malformed and duplicate definitions", () => {
  const malformed = mkdtempSync(join(tmpdir(), "subagent-malformed-"));
  writeFileSync(join(malformed, "bad.md"), "---\nname: bad\n---\n");
  assert.throws(
    () => loadAgentDefinitions(malformed),
    /bad\.md.*missing.*description.*provider.*model.*thinking.*tools.*role prompt/i,
  );

  const unknownField = mkdtempSync(join(tmpdir(), "subagent-unknown-field-"));
  writeFileSync(join(unknownField, "extra.md"), definition("extra", "unexpected: value\n"));
  assert.throws(() => loadAgentDefinitions(unknownField), /extra\.md.*unknown field.*unexpected/i);

  const invalidValues = mkdtempSync(join(tmpdir(), "subagent-invalid-values-"));
  writeFileSync(join(invalidValues, "thinking.md"), definition("bad-thinking").replace("thinking: high", "thinking: enormous"));
  assert.throws(() => loadAgentDefinitions(invalidValues), /thinking\.md.*invalid thinking.*enormous/i);
  writeFileSync(join(invalidValues, "thinking.md"), definition("bad-tools").replace("tools: normal", "tools: none"));
  assert.throws(() => loadAgentDefinitions(invalidValues), /thinking\.md.*invalid tools.*none/i);

  const duplicate = mkdtempSync(join(tmpdir(), "subagent-duplicate-"));
  writeFileSync(join(duplicate, "one.md"), definition("same"));
  writeFileSync(join(duplicate, "two.md"), definition("same"));
  assert.throws(() => loadAgentDefinitions(duplicate), /duplicate agent.*same.*one\.md.*two\.md/i);
});

test("agent registry rejects unknown names with the available inventory", () => {
  const registry = new AgentRegistry(loadAgentDefinitions(bundledAgentsPath()));
  assert.throws(
    () => registry.resolve("not-real"),
    new RegExp(`unknown agent.*not-real.*${Object.keys(EXPECTED).sort().join(".*")}`, "i"),
  );
});

test("explicit named-agent dispatch overrides win independently", () => {
  const registry = new AgentRegistry(loadAgentDefinitions(bundledAgentsPath()));
  assert.deepEqual(
    registry.resolve("explorer", { model: "override-model" }),
    {
      ...registry.resolve("explorer"),
      model: "override-model",
    },
  );
  assert.deepEqual(
    registry.resolve("explorer", { provider: "override-provider" }),
    {
      ...registry.resolve("explorer"),
      provider: "override-provider",
    },
  );
  assert.deepEqual(
    registry.resolve("explorer", { thinking: "xhigh" }),
    {
      ...registry.resolve("explorer"),
      thinking: "xhigh",
    },
  );
});
