import os

import tether as t
from conftest import ROOT, assistant, run_script, write_transcript


def test_project_root_finds_git_dir(project):
    sub = project / "a" / "b"
    sub.mkdir(parents=True)
    assert t.project_root(sub) == project.resolve()


def test_project_root_accepts_git_file_of_linked_worktree(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("gitdir: elsewhere\n")
    assert t.project_root(wt) == wt.resolve()


def test_project_root_none_outside_git(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    assert t.project_root(d) is None or (t.project_root(d) / ".git").exists()
    assert t.project_root("") is None


def test_project_key_stable_and_distinct(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    assert t.project_key(a) == t.project_key(a)
    assert t.project_key(a) != t.project_key(b)
    assert len(t.project_key(a)) == 12


def test_state_dir_from_env(isolated_state):
    assert t.state_dir() == isolated_state
    assert isolated_state.is_dir()


def test_state_dir_default_under_config_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("TETHER_STATE_DIR")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    assert t.state_dir() == tmp_path / "cfg" / "tether"


def test_safe_name_hashes_odd_ids():
    assert t.safe_name("abc-123") == "abc-123"
    assert t.safe_name("../x").startswith("h")


def test_context_size_last_main_chain_message(tmp_path):
    p = write_transcript(
        tmp_path / "t.jsonl",
        [
            assistant(inp=5, create=100, read=1000),
            {"type": "user", "message": {"content": "hi"}},
            assistant(inp=7, create=200, read=3000, out=999),
            assistant(inp=1, read=50, sidechain=True),
            assistant(model="<synthetic>"),
            assistant(inp=9, error=True),
            {"type": "attachment"},
        ],
    )
    assert t.context_size(p) == 3207


def test_context_size_missing_or_malformed(tmp_path):
    assert t.context_size(tmp_path / "none.jsonl") is None
    bad = tmp_path / "bad.jsonl"
    bad.write_text('not json\n{"type": "assistant", "message": 5}\n[1]\n', encoding="utf-8")
    assert t.context_size(bad) is None
    assert t.context_size(None) is None


def test_context_size_reads_past_a_long_tail(tmp_path):
    rows = [assistant(inp=1, read=42)] + [{"type": "user", "message": {"content": "x" * 1000}}] * 200
    assert t.context_size(write_transcript(tmp_path / "t.jsonl", rows)) == 43


def test_flag_claim_and_take(project):
    key = t.project_key(project)
    t.request_clear(project, "s1")
    assert t.flag_path(key, "s1").is_file()
    assert not t.claim_flag(key, "s2")
    assert t.claim_flag(key, "s1")
    assert not t.flag_path(key, "s1").exists()
    assert not t.claim_flag(key, "s1")
    rec = t.take_claim(key, "s1")
    assert rec["session_id"] == "s1"
    assert t.take_claim(key, "s1") is None


def test_cli_request_clear_uses_session_env(project, isolated_state):
    r = run_script(
        ROOT / "lib" / "tether.py",
        "",
        env={"CLAUDE_CODE_SESSION_ID": "abc"},
        args=["request-clear", "--root", str(project)],
    )
    assert r.returncode == 0, r.stderr
    assert "Continue from HANDOFF.md" in r.stdout
    assert t.flag_path(t.project_key(project), "abc").is_file()


def test_cli_request_clear_refuses_without_session(project):
    r = run_script(ROOT / "lib" / "tether.py", "", args=["request-clear", "--root", str(project)])
    assert r.returncode == 2
    assert "session" in r.stderr


def test_cli_request_clear_refuses_outside_git(tmp_path, monkeypatch):
    d = tmp_path / "plain"
    d.mkdir()
    if t.project_root(d) is not None:
        return  # the temp dir itself sits inside a work tree on this machine
    r = run_script(
        ROOT / "lib" / "tether.py", "", env={"CLAUDE_CODE_SESSION_ID": "abc"}, args=["request-clear", "--root", str(d)]
    )
    assert r.returncode == 2


def test_autoclear_switch(monkeypatch):
    monkeypatch.setenv("TETHER_AUTOCLEAR", "0")
    assert not t.autoclear_enabled()
    monkeypatch.setenv("TETHER_AUTOCLEAR", "1")
    assert t.autoclear_enabled() == (os.name == "nt")
