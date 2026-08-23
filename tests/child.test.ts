import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildArgs } from "../extensions/subagents/child.ts";

test("child RPC processes enable normal built-in tools by default", () => {
  const args = buildChildArgs({ sessionDir: "/tmp/subagents" });
  assert.equal(args.includes("--no-tools"), false);
  assert.ok(args.includes("--no-extensions"), "child isolation still disables unrelated extensions");
  assert.ok(args.includes("--no-skills"), "child isolation still disables unrelated skills");
});
