import json
import subprocess
import sys

import pytest

import squash as sq
from conftest import ROOT

SCRIPT = ROOT / "scripts" / "squash.py"


def git(repo, *args, env=None):
    import os

    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def commit(repo, files, title, author="Ann <ann@example.com>", date="2026-01-01T10:00:00+00:00"):
    for name, text in files.items():
        p = repo / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        git(repo, "add", name)
    git(
        repo, "commit", "-q", "--author", author, "-m", title, env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
    )
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    git(r, "init", "-q", "-b", "work")
    git(r, "config", "user.name", "Tester")
    git(r, "config", "user.email", "tester@example.com")
    git(r, "config", "commit.gpgsign", "false")
    git(r, "config", "core.autocrlf", "false")
    base = commit(r, {"README.md": "base\n"}, "docs: Add the readme")
    hashes = [
        commit(r, {"a.txt": "a1\n"}, "a: Add a", date="2026-01-02T10:00:00+00:00"),
        commit(r, {"b.txt": "b1\n"}, "b: Add b", date="2026-01-03T10:00:00+00:00"),
        commit(
            r, {"a.txt": "a1\na2\n"}, "a: Extend a", author="Bob <bob@example.com>", date="2026-01-04T10:00:00+00:00"
        ),
        commit(r, {"b.txt": "b1\nb2\n"}, "b: Extend b", date="2026-01-05T10:00:00+00:00"),
        commit(r, {"c/d.txt": "d\n"}, "c: Add d", date="2026-01-06T10:00:00+00:00"),
    ]
    return r, base, hashes


def proposal(path, base, groups):
    path.write_text(
        json.dumps({"base": base, "groups": [{"commits": c, "message": m} for c, m in groups]}), encoding="utf-8"
    )
    return path


def run(repo, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], cwd=str(repo), capture_output=True, text=True, encoding="utf-8"
    )


def log_titles(repo, rng):
    return git(repo, "log", "--reverse", "--format=%s", rng).splitlines()


def test_plan_lists_commits_oldest_first_with_files(repo):
    r, base, h = repo
    out = run(r, "plan", base)
    assert out.returncode == 0, out.stderr
    assert out.stdout.index("a: Add a") < out.stdout.index("c: Add d")
    assert h[0][:12] in out.stdout
    assert "c/d.txt" in out.stdout
    assert "5 commits" in out.stdout


def test_apply_groups_and_keeps_tree(repo, tmp_path):
    r, base, h = repo
    old_tree = git(r, "rev-parse", "HEAD^{tree}")
    p = proposal(
        tmp_path / "p.json",
        base,
        [
            ([h[0], h[2]], "a: Add a\n\nTwo lines."),
            ([h[1], h[3], h[4]], "b: Add b and d"),
        ],
    )
    out = run(r, "apply", str(p))
    assert out.returncode == 0, out.stderr + out.stdout
    assert log_titles(r, f"{base}..work") == ["a: Add a", "b: Add b and d"]
    assert git(r, "rev-parse", "HEAD^{tree}") == old_tree
    assert git(r, "log", "-1", "--format=%b", "HEAD~1") == "Two lines."
    # author and dates of each group's last commit
    fmt = "--format=%an|%ae|%aI|%cI"
    assert git(r, "log", "-1", fmt, "HEAD~1") == git(r, "log", "-1", fmt, h[2])
    assert git(r, "log", "-1", fmt, "HEAD") == git(r, "log", "-1", fmt, h[4])
    assert git(r, "log", "-1", "--format=%an", "HEAD~1") == "Bob"
    tags = git(r, "tag", "--list", "squash/work/*").splitlines()
    assert len(tags) == 1
    assert git(r, "rev-parse", tags[0] + "^{commit}") == h[4]
    assert git(r, "status", "--porcelain") == ""
    assert git(r, "worktree", "list").count("\n") == 0  # the temporary worktree is gone
    assert run(r, "verify", tags[0]).returncode == 0


def test_apply_accepts_short_hashes_and_reordering(repo, tmp_path):
    r, base, h = repo
    old_tree = git(r, "rev-parse", "HEAD^{tree}")
    p = proposal(
        tmp_path / "p.json", base, [([h[4][:8]], "c: Add d"), ([h[1], h[3]], "b: Add b"), ([h[0], h[2]], "a: Add a")]
    )
    out = run(r, "apply", str(p))
    assert out.returncode == 0, out.stderr
    assert log_titles(r, f"{base}..work") == ["c: Add d", "b: Add b", "a: Add a"]
    assert git(r, "rev-parse", "HEAD^{tree}") == old_tree


def test_conflict_refuses_and_changes_nothing(repo, tmp_path):
    r, base, h = repo
    p = proposal(tmp_path / "p.json", base, [([h[2], h[0]], "a"), ([h[1], h[3], h[4]], "b")])
    out = run(r, "apply", str(p))
    assert out.returncode == 2
    assert h[2][:12] in out.stderr and "conflict" in out.stderr
    assert git(r, "rev-parse", "work") == h[4]
    assert git(r, "tag", "--list") == ""
    assert git(r, "worktree", "list").count("\n") == 0


@pytest.mark.parametrize(
    "groups, words",
    [
        (lambda h: [(h[:4], "x")], "missing"),
        (lambda h: [(h, "x"), ([h[0]], "y")], "more than once"),
        (lambda h: [(h + ["0" * 40], "x")], "not"),
        (lambda h: [(h, "")], "message"),
        (lambda h: [([], "x"), (h, "y")], "no commits"),
    ],
)
def test_bad_proposals_refused(repo, tmp_path, groups, words):
    r, base, h = repo
    out = run(r, "apply", str(proposal(tmp_path / "p.json", base, groups(h))))
    assert out.returncode == 2
    assert words in out.stderr
    assert git(r, "rev-parse", "work") == h[4]


def test_unreadable_proposal(repo, tmp_path):
    r, base, h = repo
    (tmp_path / "p.json").write_text("{", encoding="utf-8")
    assert run(r, "apply", str(tmp_path / "p.json")).returncode == 2
    assert run(r, "apply", str(tmp_path / "missing.json")).returncode == 2


def test_merge_commits_refused(repo, tmp_path):
    r, base, h = repo
    git(r, "checkout", "-q", "-b", "side", base)
    commit(r, {"s.txt": "s\n"}, "s: Add s")
    git(r, "checkout", "-q", "work")
    git(r, "merge", "-q", "--no-ff", "-m", "merge side", "side")
    out = run(r, "plan", base)
    assert out.returncode == 2 and "merge" in out.stderr


def test_detached_head_refused(repo, tmp_path):
    r, base, h = repo
    git(r, "checkout", "-q", "--detach")
    out = run(r, "apply", str(proposal(tmp_path / "p.json", base, [(h, "x")])))
    assert out.returncode == 2 and "branch" in out.stderr


def test_group_with_no_net_change_refused(repo, tmp_path):
    r, base, h = repo
    revert = commit(r, {"c/d.txt": "d\n", "a.txt": "a1\n"}, "a: Undo a2")
    redo = commit(r, {"a.txt": "a1\na2\n"}, "a: Redo a2")
    p = proposal(tmp_path / "p.json", base, [(h, "all"), ([revert, redo], "noop")])
    out = run(r, "apply", str(p))
    assert out.returncode == 2 and "no change" in out.stderr


def test_untracked_handoff_is_left_alone(repo, tmp_path):
    r, base, h = repo
    (r / "HANDOFF.md").write_text("state\n", encoding="utf-8")
    out = run(r, "apply", str(proposal(tmp_path / "p.json", base, [(h, "all: Add everything")])))
    assert out.returncode == 0, out.stderr
    assert (r / "HANDOFF.md").read_text(encoding="utf-8") == "state\n"
    assert git(r, "status", "--porcelain") == "?? HANDOFF.md"


def test_finish_refuses_a_different_tree(repo):
    r, base, h = repo
    with pytest.raises(sq.Refused, match="tree"):
        sq.finish(r, "work", h[4], h[3])
    assert git(r, "rev-parse", "work") == h[4]
    assert git(r, "tag", "--list") == ""


def test_verify_detects_a_different_tree(repo):
    r, base, h = repo
    git(r, "tag", "-a", "squash/work/x", "-m", f"squashed-to: {h[3]}", h[4])
    out = run(r, "verify", "squash/work/x")
    assert out.returncode == 1 and "differ" in out.stdout
    git(r, "tag", "-a", "squash/work/y", "-m", f"squashed-to: {h[4]}", h[4])
    assert run(r, "verify", "squash/work/y").returncode == 0
    assert run(r, "verify", "nope").returncode == 2
