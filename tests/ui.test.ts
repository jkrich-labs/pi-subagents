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
import { makeAskLens, makeCompletionLens } from "../extensions/subagents/lenses.ts";
import subagentsExtension, {
  mapTaskRequest,
  parentBashGuard,
  spawnSuccessText,
  spawnToolResult,
  subagentCommand,
  deliverToParent,
} from "../extensions/subagents/index.ts";
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

test("extension prevents parent polling and exposes Cursor-compatible delegation tools", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, any>();
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
    sendUserMessage() {},
  } as any;

  subagentsExtension(pi);
  const spawnTool = tools.get("spawn_subagent");
  assert.ok(
    spawnTool.promptGuidelines?.some((line: string) => /do not.*(?:sleep|poll).*end.*turn/i.test(line)),
    "the model-visible spawn contract tells the parent to end its turn rather than poll",
  );
  assert.ok(tools.has("Task"), "Cursor-trained models receive the Task delegation affordance");
  assert.ok(tools.has("AwaitShell"), "Cursor-trained models receive a safe AwaitShell compatibility affordance");
  assert.ok(tools.has("steer_subagent"), "parents can steer without leaking @child control text into assistant output");
  assert.ok(
    tools.get("steer_subagent").promptGuidelines?.some((line: string) => /never emit.*@child/i.test(line)),
    "the model-visible steering contract forbids assistant-text control messages",
  );
  assert.deepEqual(mapTaskRequest({ subagent_type: "reviewer-spec", prompt: "Review it", cwd: "/tmp/review-wt" }), {
    agent: "reviewer-spec",
    prompt: "Review it",
    cwd: "/tmp/review-wt",
  });
  assert.match(spawnSuccessText("child-1", "reviewer-spec"), /end (?:the |your )?turn.*(?:never|do not).*(?:poll|sleep)/i);
  assert.match(spawnSuccessText("child-1", "reviewer-spec"), /steer_subagent\(child_id="child-1"/);
  assert.equal(spawnToolResult("child-1", "reviewer-spec", "reviewer-spec").terminate, true);
  ring.upsert("failed-child", { title: "review", status: "failed", error: "model is not supported by provider" });
  assert.match(
    (await tools.get("steer_subagent").execute("call", { child_id: "failed-child", message: "report now" })).content[0].text,
    /failed.*model is not supported by provider/i,
    "steering a failed child reports the failure to the parent immediately",
  );
  ring.upsert("done-child", { title: "reusable", status: "done" });
  assert.match(
    (await tools.get("steer_subagent").execute("call", { child_id: "done-child", message: "continue" })).content[0].text,
    /not live/i,
    "a done child is sent to the hub for reuse instead of being rejected as done",
  );
  ring.reset();
  assert.deepEqual(await tools.get("AwaitShell").execute(), {
    content: [{ type: "text", text: "Background tasks report completion automatically. End this turn now; do not poll or sleep." }],
    details: {},
    terminate: true,
  });

  ring.reset();
  ring.upsert("working-child", { title: "background work", status: "working" });
  const guard = (handlers.get("tool_call") ?? [])[0];
  assert.ok(guard, "the extension registers a tool-call polling guard");
  const decision = await guard(
    { toolName: "bash", toolCallId: "wait-1", input: { command: "sleep 8; echo waiting" } },
    {},
  );
  assert.deepEqual(decision, {
    block: true,
    reason: "A subagent is still working in the background. Do not poll with shell sleeps; end this turn instead.",
    terminate: true,
  });
  ring.reset();
});

test("final child reports become one bounded model-visible wake-up without a retry loop", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ text: string; options: unknown }> = [];
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
  } as any;
  const lens = makeCompletionLens(
    "review-child",
    Array.from({ length: 220 }, (_, index) => `report-${index}`).join(" "),
    "/sessions/review.jsonl",
    123,
  );

  assert.ok(lens.digest.split(/\s+/).length <= 151, "display/history lenses retain the bounded digest rather than a transcript");
  assert.ok(makeCompletionLens("long-child", "x".repeat(1_000_000), "/sessions/long.jsonl").digest.length <= 4002, "a no-whitespace report is bounded by bytes as well as words");
  deliverToParent(pi, { type: "lens", lens, final: false });
  assert.equal(messages.length, 0, "progress lenses do not wake the parent");
  deliverToParent(pi, { type: "lens", lens, final: true });
  deliverToParent(pi, {
    type: "control",
    childId: "review-child",
    token: "DONE-PARENT",
    reportDelivered: true,
  });
  assert.equal(entries.filter((entry) => entry.type === "subagent_lens").length, 2, "display history retains only bounded lens records");
  assert.equal(entries.filter((entry) => entry.type === "subagent_done").length, 1, "DONE history remains a small control record");
  assert.equal(messages.length, 1, "DONE report is delivered once as a model-visible follow-up");
  assert.match(messages[0].text, /review-child.*COMPLETED.*report-0/is);
  assert.ok(messages[0].text.split(/\s+/).length <= 155, "the waking follow-up remains bounded");
  assert.doesNotMatch(messages[0].text, /retry|spawn/i, "completion delivery cannot start a retry loop");
  assert.deepEqual(messages[0].options, { deliverAs: "steer" }, "a steer wakes an idle parent");

  deliverToParent(pi, {
    type: "control",
    childId: "empty-report-child",
    token: "DONE-PARENT",
    reportDelivered: false,
  });
  assert.equal(messages.length, 2, "token-only completion wakes the parent");
  assert.match(messages[1].text, /empty-report-child.*COMPLETED.*no textual report/i);
  assert.deepEqual(messages[1].options, { deliverAs: "steer" });
});

test("ASK follow-ups use the same bounded digest policy", () => {
  const messages: Array<{ text: string; options: unknown }> = [];
  const pi = {
    appendEntry() {},
    sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
  } as any;
  const ask = makeAskLens("ask-child", "x".repeat(1_000_000), "/sessions/ask.jsonl");
  deliverToParent(pi, { type: "ask", childId: "ask-child", question: ask.question });
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.length <= 4100, "ASK follow-ups do not forward an unbounded child line");
  assert.deepEqual(messages[0].options, { deliverAs: "steer" });
});

test("child failures become model-visible follow-up messages", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ text: string; options: unknown }> = [];
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
  } as any;

  deliverToParent(pi, {
    type: "crash",
    childId: "failed-child",
    reason: "model is not supported by provider",
  });
  assert.equal(entries[0].type, "subagent_crash");
  assert.match(messages[0].text, /failed-child.*FAILED.*model is not supported.*do not retry/i);
  assert.deepEqual(messages[0].options, { deliverAs: "steer" });
});

test("manual commands list presets and launch a named agent", async () => {
  const notices: string[] = [];
  const spawns: any[] = [];
  const ctx = { ui: { notify(message: string) { notices.push(message); } } } as any;
  const hub = { async spawn(request: unknown) { spawns.push(request); return "child-1"; } } as any;

  await subagentCommand({} as any, hub, ctx, "agents");
  assert.ok(notices[0].includes("explorer openai-codex/gpt-5.6-luna medium"));
  assert.ok(notices[0].includes("reviewer-spec openai-codex/gpt-5.6-terra xhigh"));

  await subagentCommand({} as any, hub, ctx, "spawn-agent reviewer-spec Review S-01");
  assert.deepEqual(spawns, [{ agent: "reviewer-spec", prompt: "Review S-01" }]);
  assert.equal(notices.at(-1), "spawned child-1 (reviewer-spec)");
});

test("parent bash guard blocks raw delegation, polling, and hub-owned kills", () => {
  const reason = "A subagent is still working in the background. Do not poll with shell sleeps; end this turn instead.";
  assert.deepEqual(parentBashGuard("sleep 20; ps -ef", true, () => false), {
    block: true,
    reason,
    terminate: true,
  });
  assert.deepEqual(parentBashGuard("kill 90838 90839; sleep 1", true, (pid) => pid === 90839), {
    block: true,
    reason: "Child processes are owned by the subagent hub. Do not shell-kill them or spawn duplicate retries; end this turn instead.",
    terminate: true,
  });
  assert.equal(parentBashGuard("kill 123", true, () => false), undefined, "unrelated process control is untouched");
  assert.equal(parentBashGuard("sleep 1; npm test", true, () => false), undefined, "a test command containing sleep is not polling");
  assert.deepEqual(parentBashGuard("sleep 20; ps -ef", false, () => false), {
    block: true,
    reason: "Do not poll background work with shell sleeps or PID checks. Delegate through Task/spawn_subagent instead.",
  }, "polling without a hub child stays recoverable because nothing can wake a terminated parent");
  assert.deepEqual(parentBashGuard("(cd /tmp/wt && pi -p --no-session --model gpt-5.6-sol 'fix') > report 2>&1 & echo $! > child-pid", false, () => false), {
    block: true,
    reason: "Do not launch nested pi agents through bash or manage their PID files. Use Task/spawn_subagent with cwd instead.",
  }, "a blocked raw launch returns control so the parent can delegate correctly");
  assert.equal(parentBashGuard("pi --list-models", false, () => false), undefined, "non-agent pi diagnostics remain available");
  for (const command of ["bash -c 'pi --mode rpc'", "env pi --mode rpc", "sh -c 'exec pi --mode rpc'", "bash -c \"$(which pi) --mode rpc\"", "${PI_BIN:-pi} --mode rpc", "p$(printf i) --mode rpc", "$(printf '\\160\\151') --mode rpc", "$'\\x70\\x69' --mode rpc", "p$'\\u0069' --mode rpc", "$(printf p)$(printf i) --mode rpc", "printf '\\160\\151 --mode rpc' | sh", "P=pi;$P --mode rpc", "command \\pi --mode rpc"]) {
    assert.equal(parentBashGuard(command, false, () => false)?.block, true, `wrapped nested pi is blocked: ${command}`);
  }
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
