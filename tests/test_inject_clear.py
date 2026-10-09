import ctypes
import os

import pytest

import inject_clear as ij
import tether as t


def test_key_events_text_and_enter():
    ev = ij.key_events("/c", enter=True)
    assert ev == [
        (True, 0, ord("/")),
        (False, 0, ord("/")),
        (True, 0, ord("c")),
        (False, 0, ord("c")),
        (True, ij.VK_RETURN, 13),
        (False, ij.VK_RETURN, 13),
    ]


def test_key_events_surrogate_pair():
    ev = ij.key_events("\U0001f600")
    assert [u for _, _, u in ev[::2]] == [0xD83D, 0xDE00]


def test_input_record_layout():
    assert ctypes.sizeof(ij.INPUT_RECORD) == 20
    arr = ij.records(ij.key_events("A"))
    assert arr[0].EventType == ij.KEY_EVENT
    assert (arr[0].Event.KeyEvent.bKeyDown, arr[0].Event.KeyEvent.uChar) == (1, 65)
    assert arr[1].Event.KeyEvent.bKeyDown == 0
    assert arr[0].Event.KeyEvent.wRepeatCount == 1


TABLE = {
    100: (90, "python.exe"),  # the hook
    90: (80, "cmd.exe"),
    80: (70, "claude.exe"),  # the session
    70: (60, "WindowsTerminal.exe"),
    60: (50, "claude.exe"),  # an outer session (a claude started from a Bash tool)
    50: (0, "explorer.exe"),
    999: (80, "claude.exe"),  # not an ancestor
}


def test_ancestors_walk():
    assert ij.ancestors(TABLE, 100) == [
        (90, "cmd.exe"),
        (80, "claude.exe"),
        (70, "WindowsTerminal.exe"),
        (60, "claude.exe"),
        (50, "explorer.exe"),
    ]


def test_ancestors_stops_at_cycle_and_missing():
    assert ij.ancestors({1: (2, "a"), 2: (1, "b")}, 1) == [(2, "b")]
    assert ij.ancestors({1: (7, "a")}, 1) == []
    assert ij.ancestors({}, 1) == []


def test_candidates_nearest_claude_only():
    chain = ij.ancestors(TABLE, 100)
    assert ij.candidates(chain) == [(80, "claude.exe")]


def test_candidates_prefers_claude_pid_when_ancestor():
    chain = ij.ancestors(TABLE, 100)
    assert ij.candidates(chain, "60") == [(60, "claude.exe")]
    assert ij.candidates(chain, "999") == [(80, "claude.exe")]  # not an ancestor: ignored
    assert ij.candidates(chain, "junk") == [(80, "claude.exe")]


def test_candidates_falls_back_to_node():
    assert ij.candidates([(5, "cmd.exe"), (4, "node.exe"), (3, "bun.exe")]) == [(4, "node.exe")]
    assert ij.candidates([(5, "cmd.exe")]) == []


def test_parse_target():
    assert ij.parse_target("80:claude.exe") == (80, "claude.exe")
    with pytest.raises(ValueError):
        ij.parse_target("x:claude.exe")


def test_clear_delay(monkeypatch):
    assert ij.clear_delay() == 2.0
    monkeypatch.setenv("TETHER_CLEAR_DELAY", "0.5")
    assert ij.clear_delay() == 0.5
    for bad in ("nan", "-1", "999", "x"):
        monkeypatch.setenv("TETHER_CLEAR_DELAY", bad)
        assert ij.clear_delay() == 2.0


class FakeConsole:
    """Records what was typed; on Enter after '/clear' it plays SessionStart (source clear) when `clears`."""

    def __init__(self, key, clears=True, attach_ok=True):
        self.key, self.clears, self.attach_ok = key, clears, attach_ok
        self.typed, self.buf, self.calls = [], "", []

    def free(self):
        self.calls.append("free")

    def attach(self, pid):
        self.calls.append(f"attach {pid}")
        return (True, 0) if self.attach_ok else (False, 5)

    def open_input(self):
        return "H", 0

    def write(self, handle, events):
        for down, vk, unit in events:
            if not down:
                continue
            if vk == ij.VK_RETURN:
                self.typed.append(self.buf)
                if self.buf == "/clear" and self.clears:
                    t.write_json(t.cleared_path(self.key), {"session_id": "new-session"})
                self.buf = ""
            else:
                self.buf += chr(unit)
        return True, 0

    def close(self, handle):
        self.calls.append("close")


def setup_claim(project, session="old"):
    key = t.project_key(project)
    t.request_clear(project, session)
    assert t.claim_flag(key, session)
    return key


def no_sleep(_):
    pass


def live_table():
    return {80: (70, "claude.exe")}


def log_text(key):
    return t.log_path(key).read_text(encoding="utf-8")


def test_inject_types_clear_then_continue(project):
    key = setup_claim(project)
    con = FakeConsole(key)
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 0
    assert con.typed == ["/clear", "Continue from HANDOFF.md."]
    assert con.calls[:2] == ["free", "attach 80"]
    assert con.calls[-2:] == ["close", "free"]
    assert not t.claimed_path(key, "old").exists()
    assert "done" in log_text(key)


def test_inject_ignores_a_stale_cleared_record(project):
    key = setup_claim(project)
    t.write_json(t.cleared_path(key), {"session_id": "older"})  # left by an earlier clear
    con = FakeConsole(key, clears=False)
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 1
    assert con.typed == ["/clear"]


def test_no_continue_when_the_clear_never_runs(project):
    key = setup_claim(project)
    con = FakeConsole(key, clears=False)
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 1
    assert con.typed == ["/clear"]
    assert "FAILED" in log_text(key)


def test_refuses_without_claim(project):
    key = t.project_key(project)
    con = FakeConsole(key)
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 1
    assert con.typed == [] and con.calls == []


def test_refuses_session_mismatch(project):
    key = setup_claim(project, "old")
    # a claim file for "other" holding the wrong id: forged or corrupt
    t.write_json(t.claimed_path(key, "other"), {"session_id": "old"})
    con = FakeConsole(key)
    assert ij.inject(key, "other", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 1
    assert con.typed == []


def test_refuses_dead_or_reused_target(project):
    key = setup_claim(project)
    con = FakeConsole(key)
    table = lambda: {80: (70, "notepad.exe")}  # noqa: E731 -- pid reused by another program
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=table, sleep=no_sleep) == 1
    assert con.typed == [] and con.calls == []


def test_attach_failure_logged(project):
    key = setup_claim(project)
    con = FakeConsole(key, attach_ok=False)
    assert ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep) == 1
    assert "AttachConsole(80) failed" in log_text(key)


def test_start_refuses_when_off(monkeypatch):
    monkeypatch.setenv("TETHER_AUTOCLEAR", "0")
    ok, why = ij.start("k", "s")
    assert not ok


@pytest.mark.skipif(os.name != "nt", reason="Windows only")
def test_process_table_holds_this_process():
    table = ij.process_table()
    assert os.getpid() in table
    assert table[os.getpid()][1].lower().startswith("py")


def test_start_refuses_without_claude_ancestor(monkeypatch):
    monkeypatch.setenv("TETHER_AUTOCLEAR", "1")
    monkeypatch.setattr(ij.os, "name", "nt")
    monkeypatch.setattr(ij, "process_table", lambda: {os.getpid(): (1, "python.exe"), 1: (0, "init")})
    ok, why = ij.start("k", "s")
    assert not ok and "no Claude Code process" in why


def test_failure_recorded_for_the_session(project):
    key = setup_claim(project)
    con = FakeConsole(key, clears=False)
    ij.inject(key, "old", [(80, "claude.exe")], console=con, table=live_table, sleep=no_sleep)
    rec = t.read_json(t.failed_path(key, "old"))
    assert "SessionStart" in rec["reason"]


def test_success_records_no_failure(project):
    key = setup_claim(project)
    ij.inject(key, "old", [(80, "claude.exe")], console=FakeConsole(key), table=live_table, sleep=no_sleep)
    assert not t.failed_path(key, "old").exists()
