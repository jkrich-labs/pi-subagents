/**
 * Orphan reaper — pidfile per child + ppid check.
 * Boot-time sweep: a child pid whose ppid is dead (or 1/init) is reclaimed.
 * Children of a live parent are untouched. Regime A fact.
 */
import { readdirSync, readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface PidfileEntry {
  childId: string;
  pid: number;
  ppid: number;
  sessionFile: string;
  spawnedAt: number;
  /** Linux process identity captured at launch; never trust a pid alone. */
  processStartTime?: string;
  processGroup?: number;
  executable?: string;
  parentStartTime?: string;
  parentExecutable?: string;
}

export function pidPath(pidsDir: string, childId: string): string {
  return join(pidsDir, `${childId}.pid`);
}

export function writePidfile(pidsDir: string, e: PidfileEntry): void {
  writeFile(pidsDir, e);
}

export function removePidfile(pidsDir: string, childId: string): void {
  try {
    unlinkSync(pidPath(pidsDir, childId));
  } catch {
    /* the process may have exited before its pidfile was written */
  }
}

export function readPidfile(path: string): PidfileEntry | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidfileEntry;
  } catch {
    return null;
  }
}

export interface ProcessIdentity {
  parentPid: number;
  processGroup: number;
  processStartTime: string;
  executable: string;
}

export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const processGroup = Number(fields[2]);
    const processStartTime = fields[19];
    const executable = readlinkSync(`/proc/${pid}/exe`);
    if (!Number.isInteger(parentPid) || !Number.isInteger(processGroup) || !processStartTime || !executable) return null;
    return { parentPid, processGroup, processStartTime, executable };
  } catch {
    return null;
  }
}

export function ppidAlive(ppid: number): boolean {
  return ppid > 1 && processIdentity(ppid) !== null;
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
    const identity = processIdentity(e.pid);
    if (!identity) {
      // Legacy/stale records may be deleted when the recorded pid is absent,
      // but a writable record can never authorize a signal without identity.
      if (!ppidAlive(e.ppid)) {
        out.reclaimed.push(e.childId);
        try { unlinkSync(join(pidsDir, f)); } catch { /* already gone */ }
      }
      continue;
    }
    if (e.processStartTime === undefined || e.processGroup === undefined || e.executable === undefined ||
        e.parentStartTime === undefined || e.parentExecutable === undefined ||
        identity.processGroup !== e.processGroup || identity.processStartTime !== e.processStartTime || identity.executable !== e.executable) continue;
    const originalParent = processIdentity(e.ppid);
    const parentStillOwner = identity.parentPid === e.ppid && originalParent !== null &&
      originalParent.processStartTime === e.parentStartTime && originalParent.executable === e.parentExecutable;
    // A validated child whose original authenticated parent is gone is an
    // orphan even when a subreaper adopted it with a new live PPID.
    if (parentStillOwner) continue;
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
