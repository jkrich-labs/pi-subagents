/**
 * S-05 UI seam tests — pure render factories (state → lines), conversation
 * segments, pager navigation, and the busy-stream enter decision.
 * Integration of ctx.ui.setWidget / ctx.ui.custom stays manual-smoke (plan,
 * Testing Decisions); these tests pin the pure logic the TUI layer renders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, renderTicker, renderTickerLine } from "../ui/ticker.ts";
import {
  conversationSegments,
  navigator,
  segmentOf,
  segmentMarkdown,
  Pager,
  shouldConsumeEnter,
  type SessionEntryLike,
} from "../ui/inspect.ts";
import { blankView, type ChildView } from "../extensions/subagents/ring/store.ts";

function view(patch: Partial<ChildView>): ChildView {
  return { ...blankView(), id: "abc123def456", title: "demo", ...patch };
}

// ---------- ticker ----------

test("ticker line shows status, model::thinking, turns, compactions, elapsed, last completion, badges", () => {
  const now = 1_000_000_000;
  const line = renderTickerLine(
    view({
      status: "working",
      model: "gpt-5.6-luna",
      thinking: "low",
      spawnedAt: now - 65_000,
      turnCount: 7,
      compactions: 2,
      lastCompletionAt: now - 5_000,
      ask: "which file?",
      loopHits: 3,
      stallCount: 1,
    }),
    now,
  );
  assert.ok(line.text.includes("working"), "status");
  assert.ok(line.text.includes("gpt-5.6-luna::low"), "model::thinking");
  assert.ok(line.text.includes("t7"), "turn count");
  assert.ok(line.text.includes("c2"), "compactions");
  assert.ok(line.text.includes("1m05s"), "elapsed");
  assert.ok(line.text.includes("last+5s"), "last completion");
  assert.ok(line.badge.includes("ASK"), "ask badge");
  assert.ok(line.badge.includes("LOOP×3"), "loop badge");
  assert.ok(line.badge.includes("STALL×1"), "stall badge");
});

test("ticker: no compactions/badges omitted; empty fleet renders nothing", () => {
  const now = 1_000_000_000;
  const line = renderTickerLine(view({ status: "done", spawnedAt: now - 9_000 }), now);
  assert.ok(!line.text.includes("c0"), "no compaction segment");
  assert.equal(line.badge, "");
  assert.deepEqual(renderTicker([], now), []);
  const lines = renderTicker([view({ status: "working", spawnedAt: now - 9_000 })], now);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("working"));
});

test("formatElapsed: seconds, minutes, hours", () => {
  const t0 = 1_000_000;
  assert.equal(formatElapsed(t0, t0 + 42_000), "42s");
  assert.equal(formatElapsed(t0, t0 + 60_000), "1m00s");
  assert.equal(formatElapsed(t0, t0 + 3_661_000), "1h01m");
  assert.equal(formatElapsed(t0, t0 - 5_000), "0s", "clamps negative");
});

// ---------- segments ----------

function msg(id: string, role: string, text: string, thinking?: string): SessionEntryLike {
  const content: Array<{ type: string; text?: string; thinking?: string }> = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  return { type: "message", id, timestamp: `t-${id}`, message: { role, content } };
}

test("segmentOf: message entries render, thinking prefixed, empties dropped", () => {
  const seg = segmentOf(msg("e1", "assistant", "hello", "ponder"))!;
  assert.equal(seg.role, "assistant");
  assert.equal(seg.entryId, "e1");
  assert.ok(seg.text.includes("(thinking) ponder"));
  assert.ok(seg.text.includes("hello"));
  assert.equal(segmentOf(msg("e2", "assistant", "")), null);
  const nonMessage = segmentOf({ type: "session", id: "s0" });
  assert.equal(nonMessage, null, "no content → no segment");
});

test("conversationSegments: chronological; sinceId jumps (restarts at entry)", () => {
  const entries = [msg("a", "user", "one"), msg("b", "assistant", "two"), msg("c", "user", "three")];
  const all = conversationSegments(entries);
  assert.deepEqual(all.map((s) => s.entryId), ["a", "b", "c"]);
  const jumped = conversationSegments(entries, { sinceId: "b" });
  assert.deepEqual(jumped.map((s) => s.entryId), ["b", "c"]);
});

test("navigator: indexOf/next/prev by entry id", () => {
  const nav = navigator([msg("a", "user", "1"), msg("b", "assistant", "2"), msg("c", "user", "3")]);
  assert.equal(nav.indexOf("b"), 1);
  assert.equal(nav.next("b"), "c");
  assert.equal(nav.prev("b"), "a");
  assert.equal(nav.next("c"), null);
  assert.equal(nav.prev("a"), null);
});

// ---------- markdown assembly ----------

test("segmentMarkdown: role header, entry id, and body text", () => {
  const md = segmentMarkdown({ entryId: "e9", role: "assistant", text: "the **report**", at: "t" });
  assert.ok(md.includes("assistant"), "role present");
  assert.ok(md.includes("e9"), "entry id present (copiable)");
  assert.ok(md.includes("the **report**"), "body preserved as markdown");
});

// ---------- pager ----------

function segs(n: number) {
  return Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, role: "assistant", text: `m${i}`, at: "" }));
}

test("pager: cursor moves clamp at edges; page moves by window", () => {
  const p = new Pager(segs(10), { window: 3 });
  assert.equal(p.cursor, 0);
  p.move("up");
  assert.equal(p.cursor, 0, "clamped at top");
  p.move("down");
  assert.equal(p.cursor, 1);
  p.move("pagedown");
  assert.equal(p.cursor, 4);
  p.move("pagedown");
  assert.equal(p.cursor, 7);
  p.move("pagedown");
  assert.equal(p.cursor, 9, "clamped at bottom");
  p.move("pageup");
  assert.equal(p.cursor, 6);
  p.move("top");
  assert.equal(p.cursor, 0);
  p.move("bottom");
  assert.equal(p.cursor, 9);
});

test("pager: jump to entry id; window covers cursor", () => {
  const p = new Pager(segs(10), { window: 3 });
  assert.equal(p.jump("e7"), true);
  assert.equal(p.cursor, 7);
  const win = p.window();
  assert.ok(win.some((s) => s.entryId === "e7"), "window shows cursor entry");
  assert.equal(p.jump("nope"), false, "unknown id rejected");
  assert.equal(p.cursor, 7, "cursor unchanged on failed jump");
  const w = p.window();
  assert.ok(w.length <= 3, "window bounded");
  assert.equal(w[0].entryId, "e7", "window starts at cursor after jump");
});

test("pager: current entry is the copiable one", () => {
  const p = new Pager(segs(5), { window: 2 });
  p.move("down");
  assert.equal(p.current()?.entryId, "e1");
});

// ---------- busy-stream enter passthrough ----------

test("shouldConsumeEnter: only busy + enter + children", () => {
  assert.equal(shouldConsumeEnter("\r", true, 2), true);
  assert.equal(shouldConsumeEnter("\r", false, 2), false, "idle → editor keeps enter");
  assert.equal(shouldConsumeEnter("\r", true, 0), false, "no children → nothing to open");
  assert.equal(shouldConsumeEnter("x", true, 2), false, "other keys pass through");
  assert.equal(shouldConsumeEnter("\r\n", true, 1), true, "CRLF enter accepted");
});
