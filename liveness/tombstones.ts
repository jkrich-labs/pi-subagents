/**
 * Tombstones — written on EVERY crash and kill (reason, last cursor, ts).
 * Regime A facts. The boot-time reaper and resume command consult them.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Tombstone {
  childId: string;
  reason: string;
  lastCursor: string | null;
  at: string;
}

export interface TombstoneWriter {
  write(t: Tombstone): void;
  fileName(childId: string): string;
}

export class JsonlTombstones implements TombstoneWriter {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  fileName(childId: string): string {
    return join(this.dir, `${childId}.tombstone.jsonl`);
  }

  write(t: Tombstone): void {
    appendFileSync(this.fileName(t.childId), `${JSON.stringify(t)}\n`);
  }
}
