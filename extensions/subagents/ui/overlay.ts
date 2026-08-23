/**
 * Overlay wiring — pi-tui components over the pure seams in inspect.ts.
 * Manual-smoke layer (plan, Testing Decisions): the conversation renderer is
 * a Markdown window driven by the unit-tested Pager; SelectList provides the
 * navigate/fleet pickers. Nothing here holds logic beyond key dispatch.
 */
import {
  Container,
  Markdown,
  SelectList,
  Text,
  matchesKey,
  Key,
  type SelectItem,
} from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  copyToClipboard,
  getMarkdownTheme,
  getSelectListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Pager,
  conversationSegments,
  segmentMarkdown,
  type Segment,
  type SessionEntryLike,
} from "./inspect.ts";
import type { ChildView } from "../ring/store.ts";

const HELP = "↑↓/j/k move • PgUp/PgDn page • g/G top/bottom • c copy entry • q/esc close";

function firstLine(s: string, max = 60): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Conversation renderer overlay: Markdown window over the child's session
 * entries with chrono/jump/entry-id navigation and per-entry copy.
 */
export async function openInspectOverlay(
  ctx: ExtensionContext,
  view: ChildView,
  entries: SessionEntryLike[],
  opts?: { startId?: string; window?: number },
): Promise<void> {
  const segments = conversationSegments(entries);
  if (segments.length === 0) {
    ctx.ui.notify(`${view.id}: no renderable entries in session`, "warning");
    return;
  }
  const pager = new Pager(segments, { window: opts?.window ?? 3, startId: opts?.startId });

  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const border = (s: string): string => theme.fg("accent", s);
      const container = new Container();
      const top = new DynamicBorder(border);
      const title = new Text("", 1, 0);
      const md = new Markdown("", 1, 0, getMarkdownTheme());
      const help = new Text(theme.fg("dim", HELP), 1, 0);
      const bottom = new DynamicBorder(border);
      container.addChild(top);
      container.addChild(title);
      container.addChild(md);
      container.addChild(help);
      container.addChild(bottom);

      const rebuild = (): void => {
        const cur = pager.current();
        title.setText(
          theme.fg(
            "accent",
            theme.bold(
              `${view.id.slice(0, 8)} ${view.title} — entry ${pager.cursor + 1}/${pager.size}` +
                (cur ? `  [${cur.entryId}]` : ""),
            ),
          ),
        );
        md.setText(pager.window().map(segmentMarkdown).join("\n\n---\n\n"));
      };
      rebuild();

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape) || data === "q") {
            done(null);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") pager.move("up");
          else if (matchesKey(data, Key.down) || data === "j") pager.move("down");
          else if (matchesKey(data, Key.pageUp)) pager.move("pageup");
          else if (matchesKey(data, Key.pageDown)) pager.move("pagedown");
          else if (data === "g" || matchesKey(data, Key.home)) pager.move("top");
          else if (data === "G" || matchesKey(data, Key.end)) pager.move("bottom");
          else if (data === "c") {
            const cur = pager.current();
            if (cur) {
              void copyToClipboard(cur.text).then(
                () => ctx.ui.notify(`copied entry ${cur.entryId}`, "info"),
                () => ctx.ui.notify("copy failed (no clipboard)", "warning"),
              );
            }
          } else {
            return; // unhandled — let the app see it
          }
          rebuild();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
    },
  );
}

/** Entry-id jump picker: SelectList of entries → inspect overlay at that id. */
export async function openNavigateOverlay(
  ctx: ExtensionContext,
  view: ChildView,
  entries: SessionEntryLike[],
): Promise<void> {
  const segments = conversationSegments(entries);
  if (segments.length === 0) {
    ctx.ui.notify(`${view.id}: no renderable entries in session`, "warning");
    return;
  }
  const items: SelectItem[] = segments.map((s: Segment, i: number) => ({
    value: s.entryId,
    label: `#${i + 1} ${s.role}: ${firstLine(s.text)}`,
    description: `entry ${s.entryId} • ${s.at}`,
  }));
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(`Navigate ${view.title}`)), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
      list.onSelect = (item) => {
        done(null);
        void openInspectOverlay(ctx, view, entries, { startId: item.value });
      };
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter jump • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "60%", anchor: "center" } },
  );
}

/**
 * Fleet picker (busy-stream enter target): one child goes straight to its
 * conversation; several show a SelectList first.
 */
export async function openFleetOverlay(
  ctx: ExtensionContext,
  views: ChildView[],
  loadEntries: (id: string) => SessionEntryLike[] | null,
): Promise<void> {
  const open = async (v: ChildView): Promise<void> => {
    const entries = loadEntries(v.id);
    if (!entries) {
      ctx.ui.notify(`${v.id}: no session file to inspect`, "warning");
      return;
    }
    await openInspectOverlay(ctx, v, entries);
  };
  const live = views.filter((v) => v.status !== "killed");
  if (live.length === 0) {
    ctx.ui.notify("no subagents", "info");
    return;
  }
  if (live.length === 1) {
    await open(live[0]);
    return;
  }
  const items: SelectItem[] = live.map((v) => ({
    value: v.id,
    label: `${v.id.slice(0, 8)} ${v.title}`,
    description: `${v.status} • ${v.model ?? "?"}::${v.thinking ?? "?"} • t${v.turnCount}`,
  }));
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
      list.onSelect = (item) => {
        done(null);
        const v = live.find((x) => x.id === item.value);
        if (v) void open(v);
      };
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter inspect • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "60%", maxHeight: "50%", anchor: "center" } },
  );
}
