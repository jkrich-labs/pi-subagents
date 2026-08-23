/**
 * Orphan-parent fixture: spawns a pi RPC child, streams its stdout to our stdout,
 * and writes the child pid to a file. The harness SIGKILLs THIS process; the
 * child must then either die with it or survive as an orphan (measured fact).
 */
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [sessionDirArg, pidFileArg] = process.argv.slice(2);
const sessionDir = sessionDirArg || "/tmp/orphan-fixture";
const pidFile = pidFileArg || "/tmp/orphan-fixture/child.pid";

const child = spawn(
  "pi",
  [
    "--mode", "rpc", "--no-tools", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--provider", "openai-codex", "--model", "gpt-5.6-luna",
    "--session-dir", sessionDir,
  ],
  { stdio: ["pipe", "pipe", "inherit"] }
);

writeFileSync(pidFile, String(child.pid));
child.stdout.pipe(process.stdout);
child.stdin.write(
  JSON.stringify({
    id: "1",
    type: "prompt",
    message: "Write a 300-word essay about mountains. End with the exact line END-MOUNTAIN.",
  }) + "\n"
);
setInterval(() => {}, 1000); // keep the fixture parent alive until SIGKILLed
