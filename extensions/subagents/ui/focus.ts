import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ChildView } from "../ring/store.ts";
import { renderTickerLine } from "./ticker.ts";

interface NavigableEditor {
  handleInput(data: string): void;
  getText(): string;
  getCursor?(): { line: number; col: number };
  isShowingAutocomplete?(): boolean;
}

/** pi's Editor keeps these as TS-private (not JS-private) fields. */
function historyIndexOf(editor: NavigableEditor): unknown {
  return (editor as unknown as { historyIndex?: unknown }).historyIndex;
}

function autocompletePending(editor: NavigableEditor): boolean {
  const state = editor as unknown as NativeEditorInternals;
  return Boolean(
    state.autocompleteDebounceTimer ||
    (state[AUTOCOMPLETE_TRACKER]?.pending ?? 0) > 0
  );
}

function trackAutocompleteRequests(editor: NavigableEditor): void {
  const state = editor as unknown as NativeEditorInternals;
  if (state[AUTOCOMPLETE_TRACKER] || !state.startAutocompleteRequest) return;
  const tracker = { pending: 0 };
  const start = state.startAutocompleteRequest.bind(editor);
  state[AUTOCOMPLETE_TRACKER] = tracker;
  state.startAutocompleteRequest = async (...args: unknown[]): Promise<void> => {
    tracker.pending += 1;
    try {
      await start(...args);
    } finally {
      tracker.pending -= 1;
    }
  };
}

interface KeyMatcher {
  matches(data: string, action: string): boolean;
}

interface FleetFocusTarget {
  hasRows(): boolean;
}

const ATTACHED = Symbol("subagent-fleet-navigation");
const AUTOCOMPLETE_TRACKER = Symbol("subagent-autocomplete-tracker");

interface NativeEditorInternals {
  historyIndex?: number;
  autocompleteDebounceTimer?: unknown;
  isOnLastVisualLine?: () => boolean;
  startAutocompleteRequest?: (...args: unknown[]) => Promise<void>;
  [AUTOCOMPLETE_TRACKER]?: { pending: number };
}

/** Only pi's native CustomEditor semantics expose enough state for a safe handoff. */
export function supportsFleetEditorNavigation(editor: NavigableEditor): boolean {
  const candidate = editor as NavigableEditor & { actionHandlers?: unknown };
  return (
    typeof candidate.getCursor === "function" &&
    typeof candidate.isShowingAutocomplete === "function" &&
    candidate.actionHandlers instanceof Map &&
    "historyIndex" in candidate &&
    typeof (candidate as unknown as NativeEditorInternals).isOnLastVisualLine === "function"
  );
}

/**
 * Decorate the active editor rather than listening to raw terminal input.
 * At pi's known native bottom boundary, hand off directly; otherwise native
 * cursor, history, and autocomplete behavior runs before the fallback check.
 */
export function attachFleetEditorNavigation(
  editor: NavigableEditor,
  tui: Pick<TUI, "setFocus">,
  keybindings: KeyMatcher,
  fleet: FleetFocusTarget,
): void {
  const tagged = editor as NavigableEditor & { [ATTACHED]?: true };
  if (tagged[ATTACHED] || !editor.getCursor) return;
  tagged[ATTACHED] = true;

  const getCursor = editor.getCursor.bind(editor);
  const handleInput = editor.handleInput.bind(editor);
  trackAutocompleteRequests(editor);
  editor.handleInput = (data: string): void => {
    const isDown = keybindings.matches(data, "tui.editor.cursorDown");
    const canHandoff =
      isDown &&
      fleet.hasRows() &&
      !editor.isShowingAutocomplete?.() &&
      !autocompletePending(editor);
    const native = editor as unknown as NativeEditorInternals;
    const beforeCursor = canHandoff ? getCursor() : null;
    const beforeText = canHandoff ? editor.getText() : "";
    const beforeHistory = historyIndexOf(editor);
    const lines = canHandoff ? beforeText.split("\n") : [];
    const atNativeBoundary = Boolean(
      canHandoff &&
      native.historyIndex === -1 &&
      native.isOnLastVisualLine?.() &&
      beforeCursor &&
      beforeCursor.line === lines.length - 1 &&
      beforeCursor.col === (lines[beforeCursor.line]?.length ?? 0)
    );
    if (atNativeBoundary) {
      tui.setFocus(fleet as unknown as Component);
      return;
    }

    handleInput(data);

    if (!canHandoff || !beforeCursor) return;
    const afterCursor = getCursor();
    if (
      editor.getText() === beforeText &&
      afterCursor.line === beforeCursor.line &&
      afterCursor.col === beforeCursor.col &&
      Object.is(historyIndexOf(editor), beforeHistory)
    ) {
      tui.setFocus(fleet as unknown as Component);
    }
  };
}

/** Focusable fleet widget mounted immediately below the editor. */
export class FleetWidget implements Component, Focusable, FleetFocusTarget {
  focused = false;
  private selected = 0;
  private editor: Component | null = null;
  private keybindings: KeyMatcher | null = null;
  private readonly maxVisible = 8;
  private readonly tui: Pick<TUI, "setFocus" | "requestRender">;
  private readonly theme: Theme;
  private readonly getViews: () => ChildView[];
  private readonly inspect: (id: string) => Promise<void>;
  private readonly onError: () => void;

  constructor(
    tui: Pick<TUI, "setFocus" | "requestRender">,
    theme: Theme,
    getViews: () => ChildView[],
    inspect: (id: string) => Promise<void>,
    onError: () => void = () => {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.getViews = getViews;
    this.inspect = inspect;
    this.onError = onError;
  }

  setEditor(editor: Component, keybindings?: KeyMatcher): void {
    this.editor = editor;
    this.keybindings = keybindings ?? null;
  }

  hasRows(): boolean {
    return this.getViews().length > 0;
  }

  invalidate(): void {}

  refresh(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const views = this.getViews();
    this.clampSelection(views.length);
    if (views.length === 0) return [];

    const start = Math.max(0, Math.min(this.selected, views.length - this.maxVisible));
    const end = Math.min(views.length, start + this.maxVisible);
    return views.slice(start, end).map((view, offset) => {
      const index = start + offset;
      const line = renderTickerLine(view);
      const text = `${line.text}${line.badge ? ` ${line.badge}` : ""}`;
      const rendered = this.focused && index === this.selected
        ? `${this.theme.fg("accent", "›")} ${this.theme.bold(text)}`
        : `  ${this.theme.fg("muted", text)}`;
      return truncateToWidth(rendered, width, "…");
    });
  }

  handleInput(data: string): void {
    const views = this.getViews();
    this.clampSelection(views.length);
    if (views.length === 0) {
      this.focusEditor();
      return;
    }

    if (this.matches(data, "tui.select.up", "up")) {
      if (this.selected === 0) this.focusEditor();
      else this.selected -= 1;
      this.tui.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.down", "down")) {
      this.selected = Math.min(views.length - 1, this.selected + 1);
      this.tui.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.cancel", "escape")) {
      this.focusEditor();
      return;
    }
    if (this.matches(data, "tui.select.confirm", "enter")) {
      const id = views[this.selected]?.id;
      if (id) void this.inspect(id).catch(this.onError);
    }
  }

  private matches(data: string, action: string, fallback: KeyId): boolean {
    return this.keybindings
      ? this.keybindings.matches(data, action)
      : matchesKey(data, fallback);
  }

  private clampSelection(length: number): void {
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, length - 1)));
  }

  private focusEditor(): void {
    if (this.editor) this.tui.setFocus(this.editor);
  }
}
