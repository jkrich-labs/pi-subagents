/**
 * Orphan reaper — pidfile per child + ppid check.
 * Boot-time sweep: a child pid whose ppid is dead (or 1/init) is reclaimed.
 * Children of a live parent are untouched. Regime A fact.
 */
import { readdirSync, readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PidfileEntry {
  childId: string;
  pid: number;
  ppid: number;
  sessionFile: string;
  spawnedAt: number;
}

export function pidPath(pidsDir: string, childId: string): string {
  return join(pidsDir, `${childId}.pid`);
}

export function writePidfile(pidsDir: string, e: PidfileEntry): void {
  writeFile(pidsDir, e);
}

export function readPidfile(path: string): PidfileEntry | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidfileEntry;
  } catch {
    return null;
  }
}

export function ppidAlive(ppid: number): boolean {
  if (ppid <= 1) return false; // reparented to init = orphan (for the reaper)
  try {
    return existsSync(`/proc/${ppid}`);
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

export interface SweepResult {
  reclaimed: string[]; // childIds
}

/**
 * Sweep pidfiles in dir; reclaim entries whose parent pid is dead AND whose
 * own process is still alive (stop orphan burning) or undead-or-stale
 * (pidfile garbage).
 */
export function sweep(pidsDir: string, onKill: (pid: number) => void): SweepResult {
  const out: SweepResult = { reclaimed: [] };
  let files: string[] = [];
  try {
    files = readdirSync(pidsDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".pid")) continue;
    const e = readPidfile(join(pidsDir, f));
    if (!e) continue;
    const parentDead = !ppidAlive(e.ppid);
    if (!parentDead) continue;
    if (pidAlive(e.pid)) onKill(e.pid);
    out.reclaimed.push(e.childId);
    try {
      unlinkSync(join(pidsDir, f));
    } catch { /* already gone */ }
  }
  return out;
}

function writeFile(pidsDir: string, e: PidfileEntry): void {
  mkdirSync(pidsDir, { recursive: true });
  writeFileSync(pidPath(pidsDir, e.childId), `${JSON.stringify(e)}\n`);
}
