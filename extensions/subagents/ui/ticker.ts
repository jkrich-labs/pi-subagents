/**
 * Ticker render factory — pure function ring-state → display lines.
 * The TUI widget layer calls this on every ring event (throttled 250ms);
 * the pure function is the unit-tested seam.
 */
import type { ChildView } from "../ring/store.ts";

export interface TickerLine {
  id: string;
  text: string;
  badge: string;
}

export function formatElapsed(spawnedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - spawnedAt) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function renderTickerLine(v: ChildView, now = Date.now()): TickerLine {
  const modelThinking = `${v.model ?? "?"}::${v.thinking ?? "?"}`;
  const turns = `t${v.turnCount}`;
  const compacts = v.compactions > 0 ? `c${v.compactions}` : "";
  const elapsed = formatElapsed(v.spawnedAt, now);
  const parts = [v.status, modelThinking, turns, compacts, elapsed].filter(Boolean);

  if (v.lastCompletionAt) {
    parts.push(`last+${formatElapsed(v.lastCompletionAt, now)}`);
  }

  const badges: string[] = [];
  if (v.ask) badges.push("ASK");
  if (v.loopHits > 0) badges.push(`LOOP×${v.loopHits}`);
  if (v.stallCount > 0) badges.push(`STALL×${v.stallCount}`);

  return {
    id: v.id,
    text: `${v.id.slice(0, 8)} ${v.title}: ${parts.join(" ")}`,
    badge: badges.length > 0 ? `[${badges.join("|")}]` : "",
  };
}

export function renderTicker(views: ChildView[], now = Date.now()): string[] {
  if (views.length === 0) return [];
  return views.map((v) => {
    const line = renderTickerLine(v, now);
    return `${line.text}${line.badge ? ` ${line.badge}` : ""}`;
  });
}
