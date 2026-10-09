"""Tether's shared helpers: the project root, the state dir, the transcript's context size, and the clear flag.

Run as a script, it is the checkpoint's last step:

    sh <plugin>/lib/run.sh <plugin>/lib/tether.py request-clear [--session ID] [--root DIR]

which writes the clear flag for this project and this session (the session id comes from $CLAUDE_CODE_SESSION_ID,
which Claude Code sets in its Bash tool). The Stop hook acts on the flag when the turn ends.

The state dir is $TETHER_STATE_DIR, else <$CLAUDE_CONFIG_DIR or ~/.claude>/tether. It is not $CLAUDE_PLUGIN_DATA:
the Bash tool that runs request-clear does not see that variable, and the hooks and this script must agree on the
place. Nothing in it is ever inside a project.

Python 3.9+, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

INPUT_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
SAFE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_TAIL = 64 * 1024


# ---------- where ----------


def _absolute(path) -> Path:
    try:
        return Path(path).resolve()
    except OSError:
        return Path(os.path.abspath(str(path)))


def project_root(cwd) -> Path | None:
    """The git work tree holding `cwd` (the nearest ancestor with `.git`, a file in a linked worktree); None
    outside every work tree."""
    if not cwd:
        return None
    start = _absolute(cwd)
    for d in (start, *start.parents):
        if (d / ".git").exists():
            return d
    return None


def project_key(root) -> str:
    """12 hex digits naming a work tree (each linked worktree has its own HANDOFF.md, so its own key)."""
    return hashlib.sha1(os.path.normcase(str(_absolute(root))).encode("utf-8")).hexdigest()[:12]


def state_dir() -> Path:
    env = os.environ.get("TETHER_STATE_DIR")
    if env:
        d = Path(env)
    else:
        base = os.environ.get("CLAUDE_CONFIG_DIR")
        d = (Path(base) if base else Path.home() / ".claude") / "tether"
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_name(session_id: str) -> str:
    """A session id usable in a file name (ids are UUIDs; anything else is hashed)."""
    if SAFE.fullmatch(session_id):
        return session_id
    return "h" + hashlib.sha1(session_id.encode("utf-8")).hexdigest()[:16]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path: Path, value: dict) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> dict | None:
    """The file's JSON object; None when it is missing or not a JSON object."""
    try:
        value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


# ---------- the clear flag ----------


def flag_path(key: str, session_id: str) -> Path:
    return state_dir() / f"clear-{key}-{safe_name(session_id)}.json"


def claimed_path(key: str, session_id: str) -> Path:
    return state_dir() / f"claimed-{key}-{safe_name(session_id)}.json"


def request_clear(root, session_id: str) -> Path:
    key = project_key(root)
    path = flag_path(key, session_id)
    write_json(path, {"session_id": session_id, "root": str(_absolute(root)), "at": utc_now()})
    try:
        failed_path(key, session_id).unlink()  # an older failure is stale once a new clear is asked for
    except FileNotFoundError:
        pass
    return path


def claim_flag(key: str, session_id: str) -> bool:
    """Move this session's flag aside (the Stop hook): the flag is gone, so no later Stop acts on it twice, and the
    injector reads the claimed copy to check the session. False when there is no flag."""
    try:
        os.replace(flag_path(key, session_id), claimed_path(key, session_id))
    except FileNotFoundError:
        return False
    return True


def take_claim(key: str, session_id: str) -> dict | None:
    """The claimed flag's record, removed (the injector); None when there is none."""
    path = claimed_path(key, session_id)
    rec = read_json(path)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return rec


def failed_path(key: str, session_id: str) -> Path:
    """Written by the injector when a clear fails; the session's next Stop reports it once."""
    return state_dir() / f"failed-{key}-{safe_name(session_id)}.json"


def cleared_path(key: str) -> Path:
    """Written by SessionStart (source clear) with the new session id: the injector's proof that /clear ran."""
    return state_dir() / f"cleared-{key}.json"


def log_path(key: str) -> Path:
    return state_dir() / f"inject-{key}.log"


def autoclear_enabled() -> bool:
    return os.name == "nt" and os.environ.get("TETHER_AUTOCLEAR", "1").strip() != "0"


# ---------- the transcript ----------


def _int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def _main_chain_size(row) -> int | None:
    """The entry's context size when it is a real main-chain assistant message, else None. The harness's
    synthetic messages (API errors) carry model "<synthetic>" and zero usage; subagent entries carry isSidechain."""
    if not isinstance(row, dict) or row.get("type") != "assistant" or row.get("isSidechain"):
        return None
    if row.get("isApiErrorMessage"):
        return None
    msg = row.get("message")
    if not isinstance(msg, dict) or msg.get("model") == "<synthetic>":
        return None
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return None
    size = sum(_int(usage.get(k)) for k in INPUT_FIELDS)
    return size or None


def context_size(path) -> int | None:
    """input + cache creation + cache read tokens of the transcript's last main-chain assistant message, read from
    the file's tail (growing the read until one is found). None when the file is missing, unreadable or has none."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            n = _TAIL
            while True:
                start = max(0, size - n)
                f.seek(start)
                lines = f.read(size - start).decode("utf-8", "replace").splitlines()
                if start > 0:
                    lines = lines[1:]  # the first line of a tail read is most likely cut
                for line in reversed(lines):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    found = _main_chain_size(row)
                    if found is not None:
                        return found
                if start == 0:
                    return None
                n *= 16
    except (OSError, TypeError, ValueError):
        return None


# ---------- hooks ----------


def run_hook(event: str, handler) -> None:
    """Read the hook payload from stdin, call `handler(payload)`, print its result (a dict) as JSON, exit 0.
    Fails open: any error prints one line to stderr and exits 1, which Claude Code treats as non-blocking."""
    for stream, kw in (
        (sys.stdout, {"encoding": "utf-8"}),
        (sys.stderr, {"encoding": "utf-8", "errors": "backslashreplace"}),
    ):
        try:
            stream.reconfigure(**kw)
        except (AttributeError, ValueError, OSError):
            pass
    try:
        raw = sys.stdin.buffer.read() if sys.stdin is not None else b""
        try:
            payload = json.loads(raw.decode("utf-8", "replace") or "{}")
        except (ValueError, RecursionError):
            payload = {}
        out = handler(payload if isinstance(payload, dict) else {})
    except Exception as e:  # noqa: BLE001 -- a hook must never break the session
        sys.stderr.write(f"tether {event}: internal error, skipped: {type(e).__name__}: {e}\n")
        sys.exit(1)
    if out:
        print(json.dumps(out), flush=True)
    sys.exit(0)


# ---------- the CLI ----------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="tether.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("request-clear", help="ask the Stop hook to clear this session when the turn ends")
    p.add_argument("--session", help="default: $CLAUDE_CODE_SESSION_ID")
    p.add_argument("--root", help="default: the work tree holding the current directory")
    args = parser.parse_args(argv)
    session = args.session or os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not session:
        print("tether: no session id (run it from Claude Code's Bash tool, or pass --session)", file=sys.stderr)
        return 2
    root = project_root(args.root or os.getcwd())
    if root is None:
        print("tether: not inside a git work tree", file=sys.stderr)
        return 2
    request_clear(root, session)
    if autoclear_enabled():
        print("Clear requested: end your turn now. Tether types /clear and the continue prompt when it ends.")
    else:
        print("Clear requested: end your turn now. The user types /clear, then: Continue from HANDOFF.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
