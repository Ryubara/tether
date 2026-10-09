"""SessionStart: put HANDOFF.md into the session's context, on every start source.

The project is the git work tree of the payload's `cwd`. With a HANDOFF.md at its root, the hook adds one line,
"Project state from HANDOFF.md (Tether)", then the file (at most MAX_LINES lines; a longer file is cut with a note
to trim it). Nothing else is printed, and a project without HANDOFF.md gets nothing. HANDOFF.md is read from disk:
tracked, untracked or ignored makes no difference.

On source `clear` it also records the new session id in the state dir (cleared-<key>.json): the injector waits for
that record before it types the continue prompt, so the prompt never lands in the old session.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import tether as t  # noqa: E402

HEADER = "Project state from HANDOFF.md (Tether)"
MAX_LINES = 400


def handle(payload: dict):
    root = t.project_root(payload.get("cwd") if isinstance(payload.get("cwd"), str) else None)
    if root is None:
        return None
    if payload.get("source") == "clear":
        sid = payload.get("session_id")
        t.write_json(
            t.cleared_path(t.project_key(root)), {"session_id": sid if isinstance(sid, str) else "", "at": t.utc_now()}
        )
    path = root / "HANDOFF.md"
    if not path.is_file():
        return None
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES] + [f"[HANDOFF.md cut at {MAX_LINES} of {len(lines)} lines: trim it.]"]
    text = "\n".join([HEADER, ""] + lines)
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}


if __name__ == "__main__":
    t.run_hook("SessionStart", handle)
