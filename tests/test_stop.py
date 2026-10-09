import json

import pytest

import inject_clear as ij
import stop
import tether as t
from conftest import ROOT, assistant, run_script, write_transcript


@pytest.fixture
def tx(tmp_path):
    def make(size, name="t.jsonl"):
        return str(write_transcript(tmp_path / name, [assistant(inp=1, create=size - 101, read=100)]))

    return make


def payload(project, transcript, session="s1", active=False):
    return {"cwd": str(project), "session_id": session, "transcript_path": transcript, "stop_hook_active": active}


def test_below_threshold_silent(project, tx):
    assert stop.handle(payload(project, tx(199_999))) is None


def test_at_threshold_blocks_once(project, tx):
    out = stop.handle(payload(project, tx(200_000)))
    assert out["decision"] == "block"
    assert out["reason"] == "Context is 200000 tokens: checkpoint at the next safe point (tether:checkpoint)."
    assert stop.handle(payload(project, tx(210_000))) is None


def test_reminds_again_after_step(project, tx):
    stop.handle(payload(project, tx(200_000)))
    assert stop.handle(payload(project, tx(224_999))) is None
    assert stop.handle(payload(project, tx(225_000)))["decision"] == "block"
    assert stop.handle(payload(project, tx(240_000))) is None


def test_env_thresholds(project, tx, monkeypatch):
    monkeypatch.setenv("TETHER_CHECKPOINT_AT", "1000")
    monkeypatch.setenv("TETHER_CHECKPOINT_STEP", "10")
    assert stop.handle(payload(project, tx(1000)))["decision"] == "block"
    assert stop.handle(payload(project, tx(1009))) is None
    assert stop.handle(payload(project, tx(1010)))["decision"] == "block"


def test_bad_env_uses_defaults(project, tx, monkeypatch):
    monkeypatch.setenv("TETHER_CHECKPOINT_AT", "lots")
    assert stop.handle(payload(project, tx(199_000))) is None
    assert stop.handle(payload(project, tx(200_000))) is not None


def test_zero_switches_meter_off(project, tx, monkeypatch):
    monkeypatch.setenv("TETHER_CHECKPOINT_AT", "0")
    assert stop.handle(payload(project, tx(900_000))) is None


def test_loop_guard(project, tx):
    assert stop.handle(payload(project, tx(300_000), active=True)) is None


def test_state_is_per_session(project, tx):
    assert stop.handle(payload(project, tx(200_000), session="a")) is not None
    assert stop.handle(payload(project, tx(200_000), session="b")) is not None
    assert stop.handle(payload(project, tx(200_000), session="a")) is None


def test_drop_below_threshold_starts_over(project, tx):
    stop.handle(payload(project, tx(200_000)))
    assert stop.handle(payload(project, tx(50_000))) is None  # compacted
    assert stop.handle(payload(project, tx(200_000))) is not None


def test_missing_or_malformed_transcript(project, tmp_path):
    assert stop.handle(payload(project, str(tmp_path / "none.jsonl"))) is None
    bad = tmp_path / "bad.jsonl"
    bad.write_text("garbage\n", encoding="utf-8")
    assert stop.handle(payload(project, str(bad))) is None
    assert stop.handle(payload(project, None)) is None


def test_outside_git_or_no_session_silent(project, tx):
    assert stop.handle({"cwd": "", "session_id": "s", "transcript_path": tx(300_000)}) is None
    assert stop.handle({"cwd": str(project), "transcript_path": tx(300_000)}) is None


def test_flag_by_hand_when_autoclear_off(project, tx):
    t.request_clear(project, "s1")
    out = stop.handle(payload(project, tx(300_000)))
    assert out == {"systemMessage": "Checkpoint saved -- type /clear, then: Continue from HANDOFF.md."}
    key = t.project_key(project)
    assert not t.flag_path(key, "s1").exists() and not t.claimed_path(key, "s1").exists()


@pytest.mark.parametrize("active", [False, True])
def test_flag_starts_injector_even_under_loop_guard(project, tx, monkeypatch, active):
    started = []
    monkeypatch.setattr(ij, "start", lambda key, sid: started.append((key, sid)) or (True, "injector 1"))
    t.request_clear(project, "s1")
    out = stop.handle(payload(project, tx(300_000), active=active))
    key = t.project_key(project)
    assert started == [(key, "s1")]
    assert out == {"systemMessage": "Tether: checkpoint saved, clearing the context."}
    assert t.claimed_path(key, "s1").is_file()  # left for the injector
    assert not t.flag_path(key, "s1").exists()


def test_injector_failing_to_start_falls_back(project, tx, monkeypatch):
    def boom(key, sid):
        raise OSError("nope")

    monkeypatch.setattr(ij, "start", boom)
    t.request_clear(project, "s1")
    out = stop.handle(payload(project, tx(10)))
    assert "type /clear" in out["systemMessage"]
    assert not t.claimed_path(t.project_key(project), "s1").exists()


def test_other_sessions_flag_ignored(project, tx, monkeypatch):
    monkeypatch.setattr(ij, "start", lambda *a: pytest.fail("must not start"))
    t.request_clear(project, "other")
    assert stop.handle(payload(project, tx(10))) is None
    assert t.flag_path(t.project_key(project), "other").exists()


def test_other_projects_flag_ignored(project, tx, tmp_path, monkeypatch):
    monkeypatch.setattr(ij, "start", lambda *a: pytest.fail("must not start"))
    other = tmp_path / "other"
    (other / ".git").mkdir(parents=True)
    t.request_clear(other, "s1")
    assert stop.handle(payload(project, tx(10))) is None


def test_script_end_to_end(project, tx):
    r = run_script(ROOT / "hooks" / "stop.py", payload(project, tx(250_000)))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["decision"] == "block"
    r = run_script(ROOT / "hooks" / "stop.py", payload(project, tx(250_000)))
    assert (r.returncode, r.stdout) == (0, "")


def test_failed_clear_reported_once_at_next_stop(project, tx):
    key = t.project_key(project)
    t.write_json(t.failed_path(key, "s1"), {"reason": "AttachConsole(80) failed (error 5)"})
    out = stop.handle(payload(project, tx(10)))
    assert out == {
        "systemMessage": "Tether: the automatic /clear failed (AttachConsole(80) failed (error 5)). "
        "Type /clear, then: Continue from HANDOFF.md."
    }
    assert stop.handle(payload(project, tx(10))) is None


def test_failed_clear_reported_alongside_the_meter(project, tx):
    t.write_json(t.failed_path(t.project_key(project), "s1"), {"reason": "x"})
    out = stop.handle(payload(project, tx(300_000)))
    assert out["decision"] == "block" and "automatic /clear failed" in out["systemMessage"]


def test_other_sessions_failure_not_reported(project, tx):
    t.write_json(t.failed_path(t.project_key(project), "other"), {"reason": "x"})
    assert stop.handle(payload(project, tx(10))) is None
