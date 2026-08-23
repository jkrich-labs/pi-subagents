/**
 * subagentGround — the hub's ground directory (child sessions, pidfiles,
 * tombstones). Overridable via SUBAGENT_GROUND for tests.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function defaultGround(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return join(home, ".pi", "agent", "subagents");
}

export class Ground {
  readonly root: string;
  readonly sessions: string;
  readonly tombstones: string;
  readonly pids: string;

  constructor(root = process.env.SUBAGENT_GROUND ?? defaultGround()) {
    this.root = root;
    this.sessions = join(root, "sessions");
    this.tombstones = join(root, "tombstones");
    this.pids = join(root, "pids");
    for (const d of [this.sessions, this.tombstones, this.pids]) {
      mkdirSync(d, { recursive: true });
    }
  }
}
