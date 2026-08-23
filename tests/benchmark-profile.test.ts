import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ground } from "../extensions/subagents/ground.ts";
import { Hub, type Delivery } from "../extensions/subagents/hub.ts";
import type { CommandResponse, RpcChildHandle, RpcChildOptions } from "../extensions/subagents/child.ts";
import { ring } from "../extensions/subagents/ring/store.ts";
import {
  BUNDLED_COMPARISON_MANIFEST,
  createBenchmarkSuiteManifest,
} from "../harness/benchmark/profile.ts";
import { scenarioIdsForSuite } from "../harness/benchmark/contracts.ts";

function tmpGround(): Ground {
  return new Ground(mkdtempSync(join(tmpdir(), "subagent-benchmark-profile-")));
}

function recordingChildren(): { launches: RpcChildOptions[]; spawnChild: (opts: RpcChildOptions) => Promise<RpcChildHandle> } {
  const launches: RpcChildOptions[] = [];
  let nextPid = 20_000;
  return {
    launches,
    async spawnChild(options: RpcChildOptions): Promise<RpcChildHandle> {
      launches.push({ ...options });
      let running = true;
      return {
        proc: { pid: nextPid++ },
        lines: [],
        sessionFile: `/sessions/benchmark-${nextPid}.jsonl`,
        onExit: null,
        setLineHandler() {},
        async send(command: string): Promise<CommandResponse> { return { command, success: true }; },
        events() { return []; },
        isRunning() { return running; },
        kill() { running = false; },
        async shutdown() { running = false; },
      };
    },
  };
}

function policyOf(options: RpcChildOptions): [string | undefined, string | undefined, string | undefined] {
  return [options.provider, options.model, options.thinking];
}

test("framework policy is model agnostic at named and generic hub launch resolution", async () => {
  ring.reset();
  const manifest = createBenchmarkSuiteManifest({
    id: "arbitrary-policy",
    suiteDefinition: { scenarios: [{ id: "policy-probe" }] },
    parent: { provider: "parent-provider", model: "parent-model", thinking: "low" },
    child: { provider: "benchmark-provider", model: "benchmark-model", thinking: "high" },
  });
  const recorder = recordingChildren();
  const hub = new Hub({
    ground: tmpGround(),
    deliver: (_delivery: Delivery) => {},
    spawnChild: recorder.spawnChild,
    benchmarkChildPolicy: manifest.child,
  });

  try {
    const named = await hub.spawn({
      agent: "explorer",
      prompt: "Inspect the benchmark seam",
      provider: "ignored-provider",
      model: "ignored-model",
      thinking: "off",
    });
    const generic = await hub.spawn({
      title: "generic benchmark work",
      prompt: "Inspect the generic benchmark seam",
    });

    assert.deepEqual(policyOf(recorder.launches[0]), ["benchmark-provider", "benchmark-model", "high"]);
    assert.deepEqual(policyOf(recorder.launches[1]), ["benchmark-provider", "benchmark-model", "high"]);
    assert.deepEqual(
      [hub.getView(named)?.provider, hub.getView(named)?.model, hub.getView(named)?.thinking],
      ["benchmark-provider", "benchmark-model", "high"],
      "named presets retain their role prompt but receive the declared benchmark launch policy",
    );
    assert.deepEqual(
      [hub.getView(generic)?.provider, hub.getView(generic)?.model, hub.getView(generic)?.thinking],
      ["benchmark-provider", "benchmark-model", "high"],
      "generic launches receive the same declared benchmark launch policy",
    );
    assert.match(hub.getView(named)?.systemPrompt ?? "", /Read repository context/i);
    assert.match(hub.getView(generic)?.systemPrompt ?? "", /Own the assigned engineering slice/i);
  } finally {
    await hub.shutdownAll();
  }
});

test("bundled comparison suite is Luna medium for parent and both launch forms", async () => {
  ring.reset();
  assert.deepEqual(BUNDLED_COMPARISON_MANIFEST.parent, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "medium",
  });
  assert.deepEqual(BUNDLED_COMPARISON_MANIFEST.child, BUNDLED_COMPARISON_MANIFEST.parent);
  assert.ok(BUNDLED_COMPARISON_MANIFEST.suiteDigest.length > 0);
  assert.ok(BUNDLED_COMPARISON_MANIFEST.modelPolicyDigest.length > 0);
  assert.deepEqual(scenarioIdsForSuite(BUNDLED_COMPARISON_MANIFEST.suiteDefinition), [
    "parallel-diagnosis",
    "parallel-implementation",
    "review-convergence",
  ], "the public bundled profile is one three-scenario suite");

  const recorder = recordingChildren();
  const hub = new Hub({
    ground: tmpGround(),
    deliver: () => {},
    spawnChild: recorder.spawnChild,
    benchmarkChildPolicy: BUNDLED_COMPARISON_MANIFEST.child,
  });
  try {
    await hub.spawn({ agent: "explorer", prompt: "Named Luna smoke" });
    await hub.spawn({ title: "generic Luna smoke", prompt: "Generic Luna smoke" });
    assert.deepEqual(policyOf(recorder.launches[0]), ["openai-codex", "gpt-5.6-luna", "medium"]);
    assert.deepEqual(policyOf(recorder.launches[1]), ["openai-codex", "gpt-5.6-luna", "medium"]);
  } finally {
    await hub.shutdownAll();
  }
});

test("ordinary launches retain their bundled presets when no benchmark policy is supplied", async () => {
  ring.reset();
  const recorder = recordingChildren();
  const hub = new Hub({ ground: tmpGround(), deliver: () => {}, spawnChild: recorder.spawnChild });
  try {
    await hub.spawn({ agent: "explorer", prompt: "Normal named launch" });
    await hub.spawn({ title: "normal generic launch", prompt: "Normal generic launch" });
    assert.deepEqual(policyOf(recorder.launches[0]), ["openai-codex", "gpt-5.6-luna", "medium"]);
    assert.deepEqual(policyOf(recorder.launches[1]), ["openai-codex", "gpt-5.6-terra", "xhigh"]);
  } finally {
    await hub.shutdownAll();
  }
});
