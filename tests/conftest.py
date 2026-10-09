import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for sub in ("lib", "hooks", "scripts"):
    sys.path.insert(0, str(ROOT / sub))


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Every test gets its own state dir, and never types into a console."""
    state = tmp_path / "state"
    monkeypatch.setenv("TETHER_STATE_DIR", str(state))
    monkeypatch.setenv("TETHER_AUTOCLEAR", "0")
    for name in (
        "TETHER_CHECKPOINT_AT",
        "TETHER_CHECKPOINT_STEP",
        "TETHER_CLEAR_DELAY",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_PID",
    ):
        monkeypatch.delenv(name, raising=False)
    return state


@pytest.fixture
def project(tmp_path):
    """A directory that looks like a git work tree (no git needed: the root is found by `.git`)."""
    p = tmp_path / "proj"
    (p / ".git").mkdir(parents=True)
    return p


def write_transcript(path: Path, rows: list) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def assistant(inp=0, create=0, read=0, out=10, sidechain=False, model="claude-opus-5-5", error=False):
    row = {
        "type": "assistant",
        "message": {
            "model": model,
            "usage": {
                "input_tokens": inp,
                "cache_creation_input_tokens": create,
                "cache_read_input_tokens": read,
                "output_tokens": out,
            },
        },
    }
    if sidechain:
        row["isSidechain"] = True
    if error:
        row["isApiErrorMessage"] = True
    return row


def run_script(script: Path, payload, env=None, args=()):
    full = dict(os.environ)
    full.update(env or {})
    data = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run(
        [sys.executable, str(script), *args],
        input=data,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=full,
        timeout=60,
    )
