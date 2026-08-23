/**
 * S-04 hub controller tests — the same protocol seam as S-03, driven through
 * the real hub (extension core) with a recording delivery sink.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ground } from "../extensions/subagents/ground.ts";
import { Hub, type Delivery } from "../extensions/subagents/hub.ts";
import { ring } from "../extensions/subagents/ring/store.ts";
import { parseSteerLine, routeSteers, stripSteers } from "../extensions/subagents/route.ts";
import { reportFrom } from "../extensions/subagents/tokens.ts";
import { findModel, resolveSpawn } from "../extensions/subagents/registry.ts";
import { TESTING_MODEL, TESTING_PROVIDER, TESTING_THINKING } from "../harness/testing-models.ts";

function tmpGround(): Ground {
  return new Ground(mkdtempSync(join(tmpdir(), "subagentGround-hub-")));
}

test("routeSteers: parse, route and strip", () => {
  assert.deepEqual(parseSteerLine("@all everyone please"), { target: "all", text: "everyone please" });
  assert.deepEqual(parseSteerLine("@abc123 do the thing"), { target: "child", childId: "abc123", text: "do the thing" });
  assert.deepEqual(parseSteerLine("@user hello human"), { target: "user", text: "hello human" });
  assert.equal(parseSteerLine("no prefix here"), null);

  const routed = routeSteers("thinking out loud\n@abc123 steer this\n@all everyone\nplain line");
  assert.deepEqual(routed.map((r) => r.target), ["child", "all"]);
  assert.equal(routed[0].childId, "abc123");

  const stripped = stripSteers("keep me\n@all drop me\n@user drop me too");
  assert.equal(stripped.trim(), "keep me");
});

test("reportFrom: DONE/RESET/INCR/ASK tokens", () => {
  assert.deepEqual(reportFrom("work complete\nDONE-PARENT"), {
    done: true,
    reset: false,
    incr: false,
    ask: undefined,
  });
  assert.deepEqual(reportFrom("ASK: shall I proceed?\nRESET-PARENT"), {
    done: false,
    reset: true,
    incr: false,
    ask: "shall I proceed?",
  });
  assert.equal(reportFrom("INCR-PARENT").incr, true);
  assert.equal(reportFrom("plain report").done, false);
});

test("registry: model resolution falls back to testing model", () => {
  const luna = findModel(TESTING_MODEL);
  assert.ok(luna, "registry carries the testing model");
  assert.equal(luna.provider, TESTING_PROVIDER);

  const resolved = resolveSpawn({});
  assert.equal(resolved.model, TESTING_MODEL);
  assert.equal(resolved.provider, TESTING_PROVIDER);
  assert.equal(resolved.thinking, TESTING_THINKING);

  // sanity token + junk provider must drop to defaults
  const patched = resolveSpawn({ model: "testing", provider: "registry", thinking: "bogus" });
  assert.equal(patched.model, TESTING_MODEL);
  assert.equal(patched.provider, TESTING_PROVIDER);
  assert.equal(patched.thinking, TESTING_THINKING);
});

test("hub: spawn → completion lens → DONE-PARENT → done status", { timeout: 240_000, concurrency: 1 }, async () => {
  const deliveries: Delivery[] = [];
  const hub = new Hub({ ground: tmpGround(), deliver: (d) => deliveries.push(d) });
  ring.reset();
  try {
    const id = await hub.spawn({
      title: "probe",
      prompt: "Reply with exactly: PONG, then on the next line write exactly: DONE-PARENT",
      thinking: "off",
    });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const view = hub.getView(id);
      if (view?.status === "done") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const view = hub.getView(id);
    assert.ok(view, "ring has the child");
    assert.equal(view.status, "done", "DONE-PARENT finalizes the child");
    assert.equal(view.turnCount, 1, "one child turn to complete");
    assert.ok(view.sessionFile, "session file referenced");

    const lensDeliveries = deliveries.filter((d) => d.type === "lens");
    assert.equal(lensDeliveries.length, 1, "exactly one lens per settled run (no duplicate finalization)");
    assert.ok(
      lensDeliveries[0].type === "lens" && lensDeliveries[0].lens.digest.includes("PONG"),
      "completion digest carries the child's answer",
    );

    const controls = deliveries.filter((d) => d.type === "control");
    assert.ok(controls.some((c) => c.type === "control" && c.token === "DONE-PARENT"), "DONE-PARENT control delivered");
  } finally {
    await hub.shutdownAll();
  }
});
