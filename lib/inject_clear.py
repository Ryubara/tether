"""Type `/clear`, then `Continue from HANDOFF.md.`, into the Claude Code session that checkpointed (Windows).

Two halves in one file:

- `start(key, session_id)` runs inside the Stop hook. The hook process and everything above it are alive, so it
  walks its own parent chain (a Toolhelp32 snapshot), picks ONE Claude Code process -- $CLAUDE_PID when that is an
  ancestor, else the nearest `claude.exe`, else the nearest `node.exe`/`bun.exe` -- and starts this file again,
  detached, with that target. One process only: a claude started from inside another session has the outer one
  above it too, and the outer one must never receive the inner one's /clear. The walk happens in the hook because
  once the hook exits, the detached injector's own parent chain is broken; so "the target is an ancestor" is
  established there, and the injector re-checks that the pid still runs the same program.
- `main()` is the detached injector. It waits $TETHER_CLEAR_DELAY seconds (default 2) for the turn to finish
  rendering, takes the claimed flag and refuses unless it names this session, then: FreeConsole,
  AttachConsole(target), open CONIN$, and WriteConsoleInputW one key-down/key-up pair per UTF-16 unit; Enter after
  the text. After `/clear` it waits for SessionStart (source clear) to record a new session id, and only then (4 s
  later) types the continue prompt: if a background agent's notice starts a turn just before the keys arrive,
  Claude Code holds the /clear until that turn ends but would deliver a prompt typed meanwhile into the old
  session (seen live in an earlier prototype's checks).

It logs to the state dir only (inject-<key>.log): anything printed while attached to the session's console lands
in its TUI and corrupts the screen. A failure is also written to failed-<key>-<session>.json, which that
session's next Stop reports to the user once. Ported from an earlier prototype's injector, which was checked live on
Claude Code 2.1.289 in Windows Terminal.
"""

from __future__ import annotations

import argparse
import ctypes
import math
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tether as t  # noqa: E402

CONTINUE = "Continue from HANDOFF.md."
CHAR_DELAY = 0.015  # seconds between characters (faster risked dropped keys in the TUI)
ENTER_DELAY = 0.3  # seconds between the text and its Enter
CLEAR_WAIT = 4.0  # seconds after the clear is confirmed, before the continue prompt
CLEAR_CONFIRM = 600.0  # seconds to wait for SessionStart (source clear) before giving up
CONFIRM_POLL = 0.5
DEFAULT_DELAY = 2.0
MAX_DELAY = 60.0
CLAUDE_NAMES = ("claude.exe",)
RUNTIME_NAMES = ("node.exe", "bun.exe")

KEY_EVENT = 0x0001
VK_RETURN = 0x0D
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ_WRITE = 0x3
OPEN_EXISTING = 3
TH32CS_SNAPPROCESS = 0x2


# ---------- pure parts ----------


class KEY_EVENT_RECORD(ctypes.Structure):
    # fixed-width fields (never c_wchar, 4 bytes off Windows): the same 16-byte layout everywhere the tests run
    _fields_ = [
        ("bKeyDown", ctypes.c_int32),
        ("wRepeatCount", ctypes.c_uint16),
        ("wVirtualKeyCode", ctypes.c_uint16),
        ("wVirtualScanCode", ctypes.c_uint16),
        ("uChar", ctypes.c_uint16),
        ("dwControlKeyState", ctypes.c_uint32),
    ]


class _EVENT(ctypes.Union):
    _fields_ = [("KeyEvent", KEY_EVENT_RECORD), ("_size", ctypes.c_byte * 16)]


class INPUT_RECORD(ctypes.Structure):
    _fields_ = [("EventType", ctypes.c_uint16), ("Event", _EVENT)]  # 20 bytes


def key_events(text: str, enter: bool = False) -> list:
    """(key down?, virtual key, UTF-16 unit), down then up, per UTF-16 unit of `text`; Enter's pair when `enter`.
    Typed characters carry virtual key 0: the TUI reads the character."""
    data = text.encode("utf-16-le")
    events = []
    for i in range(0, len(data), 2):
        u = int.from_bytes(data[i : i + 2], "little")
        events += [(True, 0, u), (False, 0, u)]
    return events + (enter_events() if enter else [])


def enter_events() -> list:
    return [(True, VK_RETURN, 13), (False, VK_RETURN, 13)]


def records(events: list):
    arr = (INPUT_RECORD * len(events))()
    for rec, (down, vk, unit) in zip(arr, events, strict=True):
        rec.EventType = KEY_EVENT
        k = rec.Event.KeyEvent
        k.bKeyDown, k.wRepeatCount, k.wVirtualKeyCode, k.uChar = (1 if down else 0), 1, vk, unit
    return arr


def ancestors(table: dict, pid: int) -> list:
    """[(pid, exe)] of `pid`'s parent, grandparent, ... from {pid: (parent pid, exe)}. Stops at pid 0, a parent
    missing from the table, and a cycle (Windows reuses pids)."""
    chain, seen = [], {pid}
    cur = table.get(pid)
    while cur is not None:
        parent = cur[0]
        if parent == 0 or parent in seen or parent not in table:
            break
        seen.add(parent)
        chain.append((parent, table[parent][1]))
        cur = table[parent]
    return chain


def candidates(chain: list, claude_pid=None) -> list:
    """The one process to type into, as a list ([] when none): the ancestor named by $CLAUDE_PID, else the nearest
    claude.exe, else the nearest node.exe/bun.exe (an npm install). Never a process that is not in `chain`."""
    try:
        preferred = int(claude_pid) if claude_pid is not None else None
    except ValueError:
        preferred = None
    tests = (
        lambda p, n: p == preferred,
        lambda p, n: n.lower() in CLAUDE_NAMES,
        lambda p, n: n.lower() in RUNTIME_NAMES,
    )
    for wanted in tests:
        found = [(p, n) for p, n in chain if wanted(p, n)]
        if found:
            return found[:1]
    return []


def target_arg(target) -> str:
    return f"{target[0]}:{target[1]}"


def parse_target(arg: str):
    pid, sep, name = arg.partition(":")
    if not sep or not name or not pid.isdigit():
        raise ValueError(f"not a pid:name target: {arg!r}")
    return int(pid), name


def clear_delay() -> float:
    try:
        v = float(os.environ.get("TETHER_CLEAR_DELAY", DEFAULT_DELAY))
    except ValueError:
        return DEFAULT_DELAY
    return v if math.isfinite(v) and 0 <= v <= MAX_DELAY else DEFAULT_DELAY


# ---------- Windows ----------


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_int32),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_uint16 * 260),
    ]


INVALID_HANDLE = ctypes.c_void_p(-1).value


def _kernel32():
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.AttachConsole.argtypes = [wintypes.DWORD]
    k.CreateFileW.restype = wintypes.HANDLE
    k.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    k.WriteConsoleInputW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    return k


def process_table() -> dict:
    """{pid: (parent pid, exe)} for every running process; {} when the snapshot fails."""
    k = _kernel32()
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE:
        return {}
    table = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            raw = bytes(entry.szExeFile).decode("utf-16-le")
            table[entry.th32ProcessID] = (entry.th32ParentProcessID, raw.split("\0", 1)[0])
            ok = k.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k.CloseHandle(snap)
    return table


class WinConsole:
    """The console calls the injector needs (the tests use a fake of the same shape)."""

    def __init__(self):
        self.k = _kernel32()

    def free(self):
        self.k.FreeConsole()

    def attach(self, pid: int):
        ok = bool(self.k.AttachConsole(pid))
        return ok, (0 if ok else ctypes.get_last_error())

    def open_input(self):
        h = self.k.CreateFileW(
            "CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ_WRITE, None, OPEN_EXISTING, 0, None
        )
        if not h or h == INVALID_HANDLE:
            return None, ctypes.get_last_error()
        return h, 0

    def write(self, handle, events: list):
        from ctypes import wintypes

        written = wintypes.DWORD(0)
        ok = bool(self.k.WriteConsoleInputW(handle, records(events), len(events), ctypes.byref(written)))
        return ok, (0 if ok else ctypes.get_last_error())

    def close(self, handle):
        self.k.CloseHandle(handle)


# ---------- the injector ----------


def log(key: str, msg: str) -> None:
    try:
        with t.log_path(key).open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='milliseconds')} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def type_line(console, handle, text: str, sleep) -> None:
    ev = key_events(text)
    for i in range(0, len(ev), 2):
        ok, err = console.write(handle, ev[i : i + 2])
        if not ok:
            raise OSError(f"WriteConsoleInputW failed (error {err})")
        sleep(CHAR_DELAY)
    sleep(ENTER_DELAY)
    ok, err = console.write(handle, enter_events())
    if not ok:
        raise OSError(f"WriteConsoleInputW failed on Enter (error {err})")


def _cleared_by_other(key: str, old_session: str) -> bool:
    rec = t.read_json(t.cleared_path(key))
    return rec is not None and isinstance(rec.get("session_id"), str) and rec["session_id"] not in ("", old_session)


def wait_cleared(key: str, old_session: str, sleep) -> bool:
    waited = 0.0
    while not _cleared_by_other(key, old_session):
        if waited >= CLEAR_CONFIRM:
            return False
        sleep(CONFIRM_POLL)
        waited += CONFIRM_POLL
    log(key, f"SessionStart (clear) seen after {waited:.1f} s")
    return True


def _fail(key: str, session_id: str, reason: str) -> int:
    log(key, f"FAILED: {reason}")
    try:
        t.write_json(t.failed_path(key, session_id), {"reason": reason, "at": t.utc_now()})
    except OSError:
        pass
    return 1


def inject(key: str, session_id: str, targets: list, console=None, table=process_table, sleep=time.sleep) -> int:
    """The injector's sequence; 0 when both lines were typed, else 1 (with the reason in the log)."""
    log(key, f"start: session {session_id}, targets {', '.join(target_arg(x) for x in targets) or 'none'}")
    sleep(clear_delay())
    claim = t.take_claim(key, session_id)
    if claim is None:
        return _fail(key, session_id, "no claimed clear request for this session")
    if claim.get("session_id") != session_id:
        return _fail(key, session_id, f"the clear request is for session {claim.get('session_id')!r}, not {session_id}")
    running = table()
    live = [x for x in targets if x[0] in running and running[x[0]][1].lower() == x[1].lower()]
    if not live:
        return _fail(key, session_id, "the target process is no longer running under the same name")
    console = console if console is not None else WinConsole()
    reasons = []
    for pid, name in live:
        console.free()
        ok, err = console.attach(pid)
        if not ok:
            reasons.append(f"AttachConsole({pid}) failed (error {err})")
            log(key, reasons[-1])
            continue
        handle, err = console.open_input()
        if handle is None:
            console.free()
            reasons.append(f"opening CONIN$ of {pid} failed (error {err})")
            log(key, reasons[-1])
            continue
        try:
            try:
                t.cleared_path(key).unlink()  # a record left by an earlier clear proves nothing now
            except FileNotFoundError:
                pass
            type_line(console, handle, "/clear", sleep)
            log(key, f"typed /clear into {pid} ({name})")
            if not wait_cleared(key, session_id, sleep):
                return _fail(
                    key, session_id, f"no SessionStart (clear) within {CLEAR_CONFIRM:.0f} s; continue prompt not typed"
                )
            sleep(CLEAR_WAIT)
            type_line(console, handle, CONTINUE, sleep)
            log(key, f"typed the continue prompt into {pid}; done")
        except OSError as e:
            return _fail(key, session_id, f"{pid}: {e}")
        finally:
            console.close(handle)
            console.free()
        return 0
    return _fail(key, session_id, "; ".join(reasons) or "no console found")


def start(key: str, session_id: str):
    """The Stop hook's half: (True, what was started) or (False, why it cannot run here)."""
    if os.name != "nt":
        return False, "automatic clear needs Windows"
    if os.environ.get("TETHER_AUTOCLEAR", "1").strip() == "0":
        return False, "automatic clear is off (TETHER_AUTOCLEAR=0)"
    targets = candidates(ancestors(process_table(), os.getpid()), os.environ.get("CLAUDE_PID"))
    if not targets:
        return False, "no Claude Code process found above this hook"
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--key",
        key,
        "--session",
        session_id,
        f"--target={target_arg(targets[0])}",
    ]
    base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    kw = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        cwd=str(t.state_dir()),
    )
    try:
        proc = subprocess.Popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:  # a job that forbids breakaway: stay in it
        proc = subprocess.Popen(cmd, creationflags=base, **kw)
    return True, f"injector {proc.pid} for {target_arg(targets[0])}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="inject_clear.py")
    parser.add_argument("--key", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--target", action="append", default=[], type=parse_target)
    args = parser.parse_args(argv)
    try:
        return inject(args.key, args.session, args.target)
    except Exception as e:  # noqa: BLE001 -- detached: the log is the only place to say anything
        return _fail(args.key, args.session, "".join(traceback.format_exception_only(type(e), e)).strip())


if __name__ == "__main__":
    sys.exit(main())
