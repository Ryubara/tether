"""Stop: the clear trigger and the context meter (main session only; subagents fire SubagentStop instead).

Clear trigger: when the state dir holds a clear flag for this project and this session (written by
`lib/tether.py request-clear`, the last step of tether:checkpoint), the flag is claimed and the detached injector
started; the stop is allowed. It runs even when `stop_hook_active` is set, because a checkpoint usually happens in
a turn the meter's own block continued. Where the injector cannot run (not Windows, TETHER_AUTOCLEAR=0, no Claude
Code process above the hook), the user is told to type /clear.

Meter: the context size of the transcript's last main-chain assistant message. At TETHER_CHECKPOINT_AT (default
200000; 0 turns it off) the stop is blocked once with a one-line reason, and again only after the context grew by
TETHER_CHECKPOINT_STEP (default 25000). Never when `stop_hook_active` is set. The last reminder is kept per session
in the state dir (meter-<session>.json); a context back below the mark starts over.

A failed automatic clear (the injector's failed-<key>-<session>.json) is shown to the user at this session's next
Stop, once.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import inject_clear as ij  # noqa: E402
import tether as t  # noqa: E402

DEFAULTS = {"TETHER_CHECKPOINT_AT": 200_000, "TETHER_CHECKPOINT_STEP": 25_000}
REMINDER = "Context is {n} tokens: checkpoint at the next safe point (tether:checkpoint)."
CLEARING = "Tether: checkpoint saved, clearing the context."
BY_HAND = "Checkpoint saved -- type /clear, then: Continue from HANDOFF.md."
FAILED = "Tether: the automatic /clear failed ({reason}). Type /clear, then: Continue from HANDOFF.md."


def env_int(name: str) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except ValueError:
        return DEFAULTS[name]


def clear_trigger(key: str, session_id: str):
    if not t.claim_flag(key, session_id):
        return None  # another Stop took it first
    try:
        started, why = ij.start(key, session_id)
    except Exception as e:  # noqa: BLE001 -- the checkpoint is saved; clearing by hand still works
        started, why = False, f"{type(e).__name__}: {e}"
    ij.log(key, f"Stop hook: {why}")
    if started:
        return {"systemMessage": CLEARING}
    t.take_claim(key, session_id)
    return {"systemMessage": BY_HAND}


def meter(path, session_id: str):
    at = env_int("TETHER_CHECKPOINT_AT")
    if at <= 0 or not isinstance(path, str) or not path:
        return None
    size = t.context_size(path)
    if size is None:
        return None
    state = t.state_dir() / f"meter-{t.safe_name(session_id)}.json"
    if size < at:
        try:
            state.unlink()
        except FileNotFoundError:
            pass
        return None
    last = (t.read_json(state) or {}).get("reminded_at")
    step = max(1, env_int("TETHER_CHECKPOINT_STEP"))
    if isinstance(last, int) and not isinstance(last, bool) and size < last + step:
        return None
    t.write_json(state, {"reminded_at": size})
    return {"decision": "block", "reason": REMINDER.format(n=size)}


def handle(payload: dict):
    root = t.project_root(payload.get("cwd") if isinstance(payload.get("cwd"), str) else None)
    sid = payload.get("session_id")
    if root is None or not isinstance(sid, str) or not sid:
        return None
    key = t.project_key(root)
    if t.flag_path(key, sid).is_file():
        return clear_trigger(key, sid)
    if payload.get("stop_hook_active"):
        return None
    out = meter(payload.get("transcript_path"), sid)
    failure = take_failure(key, sid)
    if failure:
        out = dict(out or {}, systemMessage=failure)
    return out


def take_failure(key: str, session_id: str):
    path = t.failed_path(key, session_id)
    rec = t.read_json(path)
    if rec is None:
        return None
    path.unlink()
    reason = rec.get("reason") if isinstance(rec.get("reason"), str) else "no reason recorded"
    return FAILED.format(reason=reason)


if __name__ == "__main__":
    t.run_hook("Stop", handle)
