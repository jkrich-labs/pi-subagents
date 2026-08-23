/**
 * S-05 UI seam tests — pure render factories (state → lines), conversation
 * segments, pager navigation, and editor-to-fleet focus navigation.
 * Integration of ctx.ui.setWidget / ctx.ui.custom stays manual-smoke (plan,
 * Testing Decisions); these tests pin the pure logic the TUI layer renders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, renderTicker, renderTickerLine } from "../extensions/subagents/ui/ticker.ts";
import {
  conversationSegments,
  navigator,
  segmentOf,
  segmentMarkdown,
  Pager,
  type SessionEntryLike,
} from "../extensions/subagents/ui/inspect.ts";
import { blankView, ring, type ChildView } from "../extensions/subagents/ring/store.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openFleetOverlay } from "../extensions/subagents/ui/overlay.ts";
import subagentsExtension from "../extensions/subagents/index.ts";
import { attachFleetEditorNavigation, FleetWidget } from "../extensions/subagents/ui/focus.ts";

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

// ---------- editor ↔ fleet focus navigation ----------

test("Down enters the fleet only after native editor navigation is exhausted", () => {
  let focused: unknown;
  let cursor = { line: 0, col: 3 };
  const fleet = { hasRows: () => true };
  const editor = {
    getText: () => "abc",
    getCursor: () => cursor,
    isShowingAutocomplete: () => false,
    handleInput(data: string) {
      if (data === "down" && cursor.col < 3) cursor = { line: 0, col: 3 };
    },
  };
  const tui = { setFocus(component: unknown) { focused = component; } };
  const keys = { matches: (data: string, action: string) => data === "down" && action === "tui.editor.cursorDown" };
  attachFleetEditorNavigation(editor, tui, keys, fleet);

  cursor = { line: 0, col: 1 };
  editor.handleInput("down");
  assert.equal(focused, undefined, "native cursor movement wins");
  editor.handleInput("down");
  assert.equal(focused, fleet, "an exhausted Down moves focus below the editor");
});

test("fleet ticker truncates long rows to the available terminal width", () => {
  const tui = { setFocus() {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
  const widget = new FleetWidget(
    tui,
    theme,
    () => [view({ title: "x".repeat(200), model: "model-with-a-very-long-name" })],
    async () => {},
  );
  assert.ok(widget.render(24).every((line) => visibleWidth(line) <= 24));
});

test("Down does not enter the fleet when editor history state changes invisibly", () => {
  let focused: unknown;
  const editor = {
    historyIndex: 0,
    getText: () => "same draft",
    getCursor: () => ({ line: 0, col: 10 }),
    isShowingAutocomplete: () => false,
    handleInput(_data: string) { editor.historyIndex = -1; },
  };
  attachFleetEditorNavigation(
    editor,
    { setFocus(component: unknown) { focused = component; } },
    { matches: (_data: string, action: string) => action === "tui.editor.cursorDown" },
    { hasRows: () => true },
  );

  editor.handleInput("down");
  assert.equal(focused, undefined, "restoring an identical history draft still consumes Down natively");
});

test("native editor boundary hands off on one Down without mutating hidden state", () => {
  let focused: unknown;
  let nativeInputs = 0;
  const editor = {
    historyIndex: -1,
    actionHandlers: new Map(),
    isOnLastVisualLine: () => true,
    getText: () => "ready",
    getCursor: () => ({ line: 0, col: 5 }),
    isShowingAutocomplete: () => false,
    handleInput(_data: string) { nativeInputs += 1; },
  };
  const fleet = { hasRows: () => true };
  attachFleetEditorNavigation(
    editor,
    { setFocus(component: unknown) { focused = component; } },
    { matches: (_data: string, action: string) => action === "tui.editor.cursorDown" },
    fleet,
  );

  editor.handleInput("down");
  assert.equal(focused, fleet);
  assert.equal(nativeInputs, 0, "boundary handoff does not rely on native hidden-state mutations");
});

test("Down does not enter the fleet while autocomplete is pending", () => {
  let focused: unknown;
  const editor = {
    autocompleteDebounceTimer: {},
    getText: () => "@file",
    getCursor: () => ({ line: 0, col: 5 }),
    isShowingAutocomplete: () => false,
    handleInput(_data: string) {},
  };
  attachFleetEditorNavigation(
    editor,
    { setFocus(component: unknown) { focused = component; } },
    { matches: (_data: string, action: string) => action === "tui.editor.cursorDown" },
    { hasRows: () => true },
  );

  editor.handleInput("down");
  assert.equal(focused, undefined, "a delayed autocomplete result must retain editor ownership");
});

test("queued autocomplete requests retain editor ownership until settled", async () => {
  let focused: unknown;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const editor = {
    getText: () => "@file",
    getCursor: () => ({ line: 0, col: 5 }),
    isShowingAutocomplete: () => false,
    async startAutocompleteRequest() { await pending; },
    handleInput(_data: string) {},
  };
  attachFleetEditorNavigation(
    editor,
    { setFocus(component: unknown) { focused = component; } },
    { matches: (_data: string, action: string) => action === "tui.editor.cursorDown" },
    { hasRows: () => true },
  );

  const request = editor.startAutocompleteRequest();
  editor.handleInput("down");
  assert.equal(focused, undefined);
  release();
  await request;
  editor.handleInput("down");
  assert.notEqual(focused, undefined, "handoff resumes after queued completion work settles");
});

test("rejected autocomplete requests release fleet handoff", async () => {
  let focused: unknown;
  const editor = {
    autocompleteAbort: {},
    getText: () => "@file",
    getCursor: () => ({ line: 0, col: 5 }),
    isShowingAutocomplete: () => false,
    async startAutocompleteRequest() { throw new Error("provider failed"); },
    handleInput(_data: string) {},
  };
  attachFleetEditorNavigation(
    editor,
    { setFocus(component: unknown) { focused = component; } },
    { matches: (_data: string, action: string) => action === "tui.editor.cursorDown" },
    { hasRows: () => true },
  );

  await assert.rejects(editor.startAutocompleteRequest(), /provider failed/);
  editor.handleInput("down");
  assert.notEqual(focused, undefined, "stale native abort state cannot permanently block navigation");
});

test("fleet Up returns to the editor and Enter inspects the selected child", async () => {
  let focused: unknown;
  const inspected: string[] = [];
  const editor = {};
  const tui = { setFocus(component: unknown) { focused = component; }, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
  const widget = new FleetWidget(tui, theme, () => [
    view({ id: "one", title: "one" }),
    view({ id: "two", title: "two" }),
  ], async (id) => { inspected.push(id); });
  widget.setEditor(editor as any);
  widget.focused = true;

  widget.handleInput("\x1b[B");
  assert.ok(widget.render(100)[1].startsWith("› "), "Down selects the next fleet row");
  widget.handleInput("\r");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(inspected, ["two"]);
  widget.handleInput("\x1b[A");
  widget.handleInput("\x1b[A");
  assert.equal(focused, editor, "Up above the first row restores editor focus");
});

test("fleet navigation honors configured editor/select keybindings", () => {
  let focused: unknown;
  const editor = {};
  const tui = { setFocus(component: unknown) { focused = component; }, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
  const widget = new FleetWidget(
    tui,
    theme,
    () => [view({ id: "one" }), view({ id: "two" })],
    async () => {},
  );
  widget.setEditor(editor as any, {
    matches: (data, action) =>
      (data === "j" && action === "tui.select.down") ||
      (data === "k" && action === "tui.select.up"),
  });
  widget.focused = true;

  widget.handleInput("j");
  assert.ok(widget.render(80)[1].startsWith("› "));
  widget.handleInput("k");
  widget.handleInput("k");
  assert.equal(focused, editor);
});

test("extension installs focus navigation without a raw terminal listener", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let terminalInputListeners = 0;
  let editorFactories = 0;
  let previousFactoryCalls = 0;
  let installedEditor: unknown;
  let statusUpdates = 0;
  const previousEditor = {
    render: () => [],
    handleInput(_data: string) {},
    getText: () => "",
    setText(_text: string) {},
    getCursor: () => ({ line: 0, col: 0 }),
  };
  const previousHandleInput = previousEditor.handleInput;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
    sendUserMessage() {},
  } as any;
  subagentsExtension(pi);
  const ctx = {
    mode: "tui",
    ui: {
      setWidget(_id: string, content: unknown) {
        if (typeof content === "function") {
          content(
            { setFocus() {}, requestRender() {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          );
        }
      },
      setStatus() { statusUpdates += 1; },
      notify() {},
      getEditorComponent() {
        return () => {
          previousFactoryCalls += 1;
          return previousEditor;
        };
      },
      setEditorComponent(factory: (...args: any[]) => unknown) {
        editorFactories += 1;
        installedEditor = factory(
          { setFocus() {}, requestRender() {} },
          { borderColor: (text: string) => text, selectList: {} },
          { matches: () => false },
        );
      },
      onTerminalInput() {
        terminalInputListeners += 1;
        return () => {};
      },
    },
  };

  for (const handler of [...(handlers.get("session_start") ?? [])]) await handler({}, ctx);
  assert.equal(terminalInputListeners, 0, "focused questions and dialogs retain Enter and arrow keys");
  assert.equal(editorFactories, 1, "the editor owns the Down handoff instead");
  assert.equal(previousFactoryCalls, 1, "an existing custom editor factory is preserved");
  assert.equal(installedEditor, previousEditor, "the existing custom editor instance is retained");
  assert.equal(previousEditor.handleInput, previousHandleInput, "an arbitrary custom editor's Down handling is not overridden");

  ring.upsert("cleanup-test", { title: "cleanup", status: "working" });
  const updatesBeforeShutdown = statusUpdates;
  for (const handler of [...(handlers.get("session_shutdown") ?? [])]) await handler({}, ctx);
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.equal(statusUpdates, updatesBeforeShutdown, "queued renders are cancelled before session context becomes stale");
  ring.reset();
});

test("fleet overlay stays active through a selected child inspection", async () => {
  let customCalls = 0;
  let closeInspect!: () => void;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    ui: {
      notify() {},
      custom(factory: (...args: any[]) => any) {
        customCalls += 1;
        if (customCalls === 2) {
          return new Promise<null>((resolve) => { closeInspect = () => resolve(null); });
        }
        return new Promise<null>((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          component.handleInput("\r");
        });
      },
    },
  } as unknown as Parameters<typeof openFleetOverlay>[0];
  const views = [
    view({ id: "one", title: "one", status: "working" }),
    view({ id: "two", title: "two", status: "working" }),
  ];
  const entries = [msg("entry", "assistant", "child report")];
  const loadedIds: string[] = [];

  let fleetOverlayActive = true;
  const fleet = openFleetOverlay(ctx, views, (id) => {
    loadedIds.push(id);
    return entries;
  }).finally(() => { fleetOverlayActive = false; });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(customCalls, 2, "selection opened the child conversation");
  assert.deepEqual(loadedIds, ["one"], "selected child identity reaches the inspect overlay");
  assert.equal(fleetOverlayActive, true, "fleet interaction remains active while child overlay is visible");
  closeInspect();
  await fleet;
  assert.equal(fleetOverlayActive, false);
});
