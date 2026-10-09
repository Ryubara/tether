import json

import pytest

import session_start as ss
import tether as t
from conftest import ROOT, run_script

SOURCES = ("startup", "resume", "clear", "compact")


def handoff(project, lines):
    (project / "HANDOFF.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.mark.parametrize("source", SOURCES)
def test_injects_handoff_on_every_source(project, source):
    handoff(project, ["# Handoff", "## Now", "- all good"])
    out = ss.handle({"cwd": str(project), "source": source, "session_id": "s1"})
    ctx = out["hookSpecificOutput"]["additionalContext"]
    assert out["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert ctx.splitlines()[0] == "Project state from HANDOFF.md (Tether)"
    assert "- all good" in ctx


def test_found_from_a_subdirectory(project):
    handoff(project, ["x"])
    sub = project / "src"
    sub.mkdir()
    assert ss.handle({"cwd": str(sub), "source": "startup"}) is not None


def test_nothing_without_handoff(project):
    assert ss.handle({"cwd": str(project), "source": "startup"}) is None


def test_nothing_outside_git(tmp_path):
    assert ss.handle({"cwd": "", "source": "startup"}) is None
    assert ss.handle({}) is None


def test_cap_at_400_lines(project):
    handoff(project, [f"line {i}" for i in range(1, 451)])
    ctx = ss.handle({"cwd": str(project), "source": "startup"})["hookSpecificOutput"]["additionalContext"]
    assert "line 400" in ctx
    assert "line 401" not in ctx
    assert "450 lines" in ctx.splitlines()[-1]


def test_exactly_400_lines_not_cut(project):
    handoff(project, [f"line {i}" for i in range(1, 401)])
    ctx = ss.handle({"cwd": str(project), "source": "startup"})["hookSpecificOutput"]["additionalContext"]
    assert ctx.splitlines()[-1] == "line 400"


def test_clear_records_new_session_for_the_injector(project):
    ss.handle({"cwd": str(project), "source": "clear", "session_id": "new"})
    rec = t.read_json(t.cleared_path(t.project_key(project)))
    assert rec["session_id"] == "new"


def test_clear_recorded_even_without_handoff(project):
    ss.handle({"cwd": str(project), "source": "clear", "session_id": "new"})
    assert t.cleared_path(t.project_key(project)).is_file()


def test_startup_records_nothing(project):
    handoff(project, ["x"])
    ss.handle({"cwd": str(project), "source": "startup", "session_id": "s"})
    assert not t.cleared_path(t.project_key(project)).exists()


def test_script_prints_json(project):
    handoff(project, ["# Handoff", "ünïcode"])
    r = run_script(ROOT / "hooks" / "session_start.py", {"cwd": str(project), "source": "startup"})
    assert r.returncode == 0, r.stderr
    assert "ünïcode" in json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]


def test_script_silent_without_handoff_and_on_bad_payload(project):
    r = run_script(ROOT / "hooks" / "session_start.py", {"cwd": str(project), "source": "startup"})
    assert (r.returncode, r.stdout) == (0, "")
    r = run_script(ROOT / "hooks" / "session_start.py", "not json")
    assert (r.returncode, r.stdout) == (0, "")
