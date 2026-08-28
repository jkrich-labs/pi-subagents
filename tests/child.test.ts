import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildArgs } from "../extensions/subagents/child.ts";

test("child RPC processes inherit pi resources and normal tools", () => {
  const args = buildChildArgs({ sessionDir: "/tmp/subagents" });
  assert.ok(args.includes("--approve"), "noninteractive children approve project resources");

  for (const flag of [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    "--exclude-tools",
    "--no-tools",
    "--no-builtin-tools",
  ]) {
    assert.equal(args.includes(flag), false, `child arguments must not restrict ${flag}`);
  }
});
