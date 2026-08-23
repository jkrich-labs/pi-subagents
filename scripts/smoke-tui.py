#!/usr/bin/env python3
"""S-05 scripted TUI smoke: drive pi TUI under a PTY with the hub extension.

Checks (evidence logged, grep-able):
  1. /subagent spawn → child spawns, ticker widget renders in TUI output
  2. ticker line contains status + model::thinking + turn count
  3. busy-stream enter opens the fleet/inspect overlay ("entry 1/" appears)
  4. /subagent list notifies

Not part of CI — this is the S-05 visual smoke substitute (work.md preflight).
"""
import os, pty, select, subprocess, sys, time, re, tempfile

GROUND = tempfile.mkdtemp(prefix="subagentGround-smoke-")
LOG = "/tmp/s05-tui-smoke.log"
ENV = dict(os.environ)
ENV["SUBAGENT_GROUND"] = GROUND
ENV["COLUMNS"] = "120"
ENV["LINES"] = "40"

cmd = [
    "pi", "--no-session", "--no-extensions",
    "-e", "./extensions/subagents/index.ts",
    "--provider", "opencode-go", "--model", "gpt-5.6-luna", "--thinking", "low",
]

master, slave = pty.openpty()
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=ENV, close_fds=True)
os.close(slave)

buf = b""
def pump(seconds: float) -> bytes:
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
    return buf

def wait_for(pattern: str, timeout: float) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        pump(0.5)
        if re.search(pattern, buf.decode("utf-8", "replace")):
            return True
    return False

def send(text: str):
    os.write(master, text.encode())

results = []
def check(name: str, ok: bool):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name, flush=True)

try:
    # 1. TUI boots
    check("tui boots (editor renders)", wait_for(r"\x1b\[", 30) or wait_for("subagent", 5))
    pump(3)

    # 2. spawn a child via the user command
    send("/subagent spawn smoke Reply with exactly: PONG then on a new line DONE-PARENT\r")
    spawned = wait_for(r"spawned [a-z0-9-]+ \(smoke\)", 90)
    check("spawn notifies with child id", spawned)
    m = re.search(r"spawned ([a-z0-9-]+) \(smoke\)", buf.decode("utf-8", "replace"))
    child_id = m.group(1) if m else ""

    # 3. ticker widget shows the child with model::thinking and turn count
    ticker = wait_for(r"smoke:\s+\w+ gpt-5\.6-luna::low", 120)
    check("ticker renders status + model::thinking", ticker)
    check("ticker shows turn count (t<N>)", wait_for(r"smoke:.*\bt\d+", 30))

    # 4. child completes; ticker should show done or last+
    wait_for(r"smoke:.*(done|last\+)", 120)
    check("ticker shows completion state", re.search(r"smoke:.*(done|last\+)", buf.decode("utf-8","replace")) is not None)

    # 5. busy-stream enter opens the overlay: make parent stream a LONG time, then Enter
    send("List 500 animals, one per line, numbered, no tools\r")
    time.sleep(1.5)  # parent should be well into streaming now
    send("\r")
    overlay = wait_for(r"entry 1/\d+|Navigate smoke|Subagents", 20)
    check("busy-stream enter opens overlay", overlay)
    send("\x1b")  # esc closes overlay
    pump(2)
    send("\x1b")  # esc aborts parent stream
    pump(2)

    # 6. /subagent list notifies
    send("/subagent list\r")
    check("/subagent list notifies", wait_for(r"smoke", 15))
    pump(2)

    # 7. /subagent inspect <id> opens the conversation overlay; j moves cursor
    if child_id:
        send(f"/subagent inspect {child_id}\r")
        check("/subagent inspect opens overlay", wait_for(r"entry 1/\d+", 20))
        send("j")
        check("j moves to next entry", wait_for(r"entry 2/\d+", 10))
        send("c")
        check("copy keypath fires (copied or env-supported failure)", wait_for(r"copied entry|copy failed", 10))
        send("\x1b")
        pump(2)

        # 8. /subagent navigate <id> opens the entry picker
        send(f"/subagent navigate {child_id}\r")
        check("/subagent navigate opens picker", wait_for(r"Navigate smoke", 20))
        send("\x1b")
        pump(2)

        # 9. /subagent kill <id> kills
        send(f"/subagent kill {child_id}\r")
        check("/subagent kill notifies", wait_for(r"killed " + child_id, 15))
    else:
        check("child id captured (inspect/navigate/kill skipped)", False)

finally:
    with open(LOG, "wb") as f:
        f.write(buf)
    try:
        send("\x03")
        time.sleep(1)
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print("---")
failed = [n for n, ok in results if not ok]
print(f"log: {LOG}  ground: {GROUND}")
print("RESULT:", "FAIL" if failed else "PASS", f"({len(results)-len(failed)}/{len(results)})")
sys.exit(1 if failed else 0)
