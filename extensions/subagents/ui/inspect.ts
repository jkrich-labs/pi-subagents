/**
 * Inspect overlay seam — pure function: session entries → display segments
 * for the conversation renderer. Copiable/navigable pieces carry their entry
 * id; the TUI layer (S-05 wiring) renders Markdown and jump cues.
 */
export interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  role?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
  message?: { role?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
}

export interface Segment {
  entryId: string;
  role: string;
  text: string;
  at: string;
}

export function segmentOf(entry: SessionEntryLike): Segment | null {
  const msg = entry.message ?? entry;
  const role = (msg.role ?? entry.type ?? "unknown").toString();
  const content = msg.content ?? [];
  const text = content
    .filter((c) => c && (c.type === "text" || c.type === "thinking"))
    .map((c) => (c.type === "text" ? c.text : `(thinking) ${c.thinking}`))
    .join("\n")
    .trim();
  if (text.length === 0) return null;
  return {
    entryId: entry.id ?? "",
    role,
    text,
    at: entry.timestamp ?? "",
  };
}

/** Whole conversation in chronological order, only renderable entries. */
export function conversationSegments(entries: SessionEntryLike[], opts?: { sinceId?: string }): Segment[] {
  const out: Segment[] = [];
  for (const e of entries) {
    if (opts?.sinceId && e.id === opts.sinceId) {
      out.length = 0; // jump: restart segment list at the entry (inclusive)
    }
    const seg = segmentOf(e);
    if (seg) out.push(seg);
  }
  return out;
}

/** Navigation cursor factory: previous/next entries relative to an entry id. */
export function navigator(entries: SessionEntryLike[]) {
  const ids = entries.map((e) => e.id ?? "");
  return {
    indexOf(id: string): number {
      return ids.indexOf(id);
    },
    next(id: string): string | null {
      const i = ids.indexOf(id);
      return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
    },
    prev(id: string): string | null {
      const i = ids.indexOf(id);
      return i > 0 ? ids[i - 1] : null;
    },
    ids,
  };
}

/** Markdown assembly for one segment: role header + entry id + body. */
export function segmentMarkdown(seg: Segment): string {
  return `### ${seg.role}  \`${seg.entryId}\`\n\n${seg.text}`;
}

export type PagerMove = "up" | "down" | "pageup" | "pagedown" | "top" | "bottom";

/**
 * Pager — the overlay's pure navigation state machine. Cursor is an index
 * into the segment list; the rendered window starts at the cursor and shows
 * up to `windowSize` segments. All movement clamps; jump resolves entry ids.
 */
export class Pager {
  cursor = 0;
  private readonly segments: Segment[];
  private readonly windowSize: number;

  constructor(segments: Segment[], opts?: { window?: number; startId?: string }) {
    this.segments = segments;
    this.windowSize = Math.max(1, opts?.window ?? 3);
    if (opts?.startId) this.jump(opts.startId);
  }

  get size(): number {
    return this.segments.length;
  }

  current(): Segment | null {
    return this.segments[this.cursor] ?? null;
  }

  move(m: PagerMove): void {
    const last = Math.max(0, this.segments.length - 1);
    switch (m) {
      case "up":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "down":
        this.cursor = Math.min(last, this.cursor + 1);
        break;
      case "pageup":
        this.cursor = Math.max(0, this.cursor - this.windowSize);
        break;
      case "pagedown":
        this.cursor = Math.min(last, this.cursor + this.windowSize);
        break;
      case "top":
        this.cursor = 0;
        break;
      case "bottom":
        this.cursor = last;
        break;
    }
  }

  jump(entryId: string): boolean {
    const i = this.segments.findIndex((s) => s.entryId === entryId);
    if (i < 0) return false;
    this.cursor = i;
    return true;
  }

  /** Visible window: segments from the cursor, up to the window size. */
  window(): Segment[] {
    return this.segments.slice(this.cursor, this.cursor + this.windowSize);
  }
}

/**
 * Busy-stream enter decision — the pure core of the ctx.ui.onTerminalInput
 * passthrough. Consume enter only while the parent agent is streaming AND a
 * fleet exists to inspect; everything else passes through to the editor.
 */
export function shouldConsumeEnter(data: string, parentBusy: boolean, childCount: number): boolean {
  if (!parentBusy || childCount === 0) return false;
  return data === "\r" || data === "\n" || data === "\r\n";
}
