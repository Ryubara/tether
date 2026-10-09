"""Turn a working branch's many commits into a few feature-sized ones, keeping the tree byte-identical.

    py squash.py plan <base>          the commits in base..HEAD, oldest first: hash, title, files
    py squash.py apply <proposal>     rebuild the branch from the proposal
    py squash.py verify <tag>         repeat the tree check for an earlier squash

The proposal is a JSON file the model writes:

    {"base": "<rev>", "groups": [{"commits": ["<hash>", ...], "message": "title\\n\\nbody"}, ...]}

Groups are in the new order, and every commit of base..HEAD must appear in exactly one group (short hashes are
fine; commits may be reordered). `apply` builds the new commits on `base` in a temporary worktree: per group it
cherry-picks the group's commits in order without committing, then commits once with the group's message, the
author and author date of the group's last commit, and that commit's committer date. Any conflict stops it with the
commit named, and nothing is changed. It then checks the new tip's tree equals the old tip's (byte-identical: the
same tree hash), tags the old tip `squash/<branch>/<UTC time>` (annotated, its message naming the new tip) and
moves the branch. A different tree refuses and changes nothing. Untracked and ignored files, HANDOFF.md included,
are never touched: only committed trees are compared, and the working tree is not checked out again.

Merge commits in the range are refused. The project's git hooks run on the new commits as usual.
Exit codes: 0 done, 1 verify found a difference, 2 refused (the reason on stderr).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


class Refused(Exception):
    pass


def git(repo, *args, env=None, check=True) -> subprocess.CompletedProcess:
    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", env=full
    )
    if check and r.returncode != 0:
        raise Refused(f"git {' '.join(args)} failed: {(r.stderr or r.stdout).strip()}")
    return r


def out(repo, *args) -> str:
    return git(repo, *args).stdout.strip()


def resolve(repo, rev: str) -> str:
    r = git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}", check=False)
    if r.returncode != 0 or not r.stdout.strip():
        raise Refused(f"{rev!r} is not a commit in this repository")
    return r.stdout.strip()


def commit_range(repo, base: str, tip: str) -> list:
    if git(repo, "merge-base", "--is-ancestor", base, tip, check=False).returncode != 0:
        raise Refused(f"{base[:12]} is not an ancestor of {tip[:12]}")
    merges = out(repo, "rev-list", "--merges", f"{base}..{tip}")
    if merges:
        raise Refused(f"the range holds merge commits ({merges.split()[0][:12]}); squash a linear range only")
    return out(repo, "rev-list", "--reverse", f"{base}..{tip}").split()


def plan(repo, base_rev: str) -> str:
    base = resolve(repo, base_rev)
    commits = commit_range(repo, base, resolve(repo, "HEAD"))
    lines = [f"base {base[:12]}: {len(commits)} commits in {base_rev}..HEAD, oldest first"]
    for c in commits:
        lines.append(f"{c[:12]} {out(repo, 'log', '-1', '--format=%s', c)}")
        files = out(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", c).splitlines()
        lines += [f"    {f}" for f in files]
    return "\n".join(lines)


def read_proposal(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        raise Refused(f"cannot read the proposal: {e}") from e
    except ValueError as e:
        raise Refused(f"the proposal is not JSON: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("base"), str) or not isinstance(data.get("groups"), list):
        raise Refused('the proposal must be {"base": "<rev>", "groups": [{"commits": [...], "message": "..."}]}')
    return data


def check_groups(repo, groups: list, commits: list) -> list:
    """[(full hashes, message)] in order; refuses a group with no commits or no message, an unknown commit, one
    outside the range, one listed twice, and a range commit left out."""
    in_range, seen, result = set(commits), set(), []
    for i, g in enumerate(groups, 1):
        if not isinstance(g, dict) or not isinstance(g.get("commits"), list) or not g["commits"]:
            raise Refused(f"group {i} has no commits")
        msg = g.get("message")
        if not isinstance(msg, str) or not msg.strip():
            raise Refused(f"group {i} has no message")
        full = []
        for c in g["commits"]:
            h = resolve(repo, str(c))
            if h not in in_range:
                raise Refused(f"group {i}: {c} is not in base..HEAD")
            if h in seen:
                raise Refused(f"group {i}: {c} is listed more than once")
            seen.add(h)
            full.append(h)
        result.append((full, msg))
    missing = [c[:12] for c in commits if c not in seen]
    if missing:
        raise Refused(f"commits missing from the proposal: {', '.join(missing)}")
    return result


def build(repo, base: str, groups: list) -> str:
    """The new commits on `base`, in a temporary worktree; the new tip's hash. The worktree is always removed."""
    tmp = Path(tempfile.mkdtemp(prefix="tether-squash-"))
    wt = tmp / "wt"
    git(repo, "worktree", "add", "-q", "--detach", str(wt), base)
    try:
        for i, (hashes, msg) in enumerate(groups, 1):
            for h in hashes:
                r = git(wt, "cherry-pick", "--no-commit", h, check=False)
                if r.returncode != 0:
                    title = out(repo, "log", "-1", "--format=%s", h)
                    raise Refused(f"group {i}: conflict cherry-picking {h[:12]} ({title}); nothing was changed")
            if git(wt, "diff", "--cached", "--quiet", check=False).returncode == 0:
                raise Refused(f"group {i} makes no change; merge it into a neighbour")
            last = out(repo, "log", "-1", "--format=%an%x00%ae%x00%aI%x00%cI", hashes[-1]).split("\0")
            env = {
                "GIT_AUTHOR_NAME": last[0],
                "GIT_AUTHOR_EMAIL": last[1],
                "GIT_AUTHOR_DATE": last[2],
                "GIT_COMMITTER_DATE": last[3],
            }
            msg_file = tmp / f"msg-{i}.txt"
            msg_file.write_text(msg.strip() + "\n", encoding="utf-8")
            git(wt, "commit", "-q", "--cleanup=whitespace", "-F", str(msg_file), env=env)
        return out(wt, "rev-parse", "HEAD")
    finally:
        git(wt, "cherry-pick", "--abort", check=False)
        git(repo, "worktree", "remove", "--force", str(wt), check=False)
        git(repo, "worktree", "prune", check=False)
        shutil.rmtree(tmp, ignore_errors=True)


def tree(repo, rev: str) -> str:
    return out(repo, "rev-parse", f"{rev}^{{tree}}")


def finish(repo, branch: str, old: str, new: str) -> str:
    """Tree check, tag on the old tip, branch moved (only if it still points at `old`). The tag's name."""
    if tree(repo, new) != tree(repo, old):
        raise Refused(f"the new tree differs from the old one ({new[:12]} vs {old[:12]}); nothing was changed")
    tag = f"squash/{branch}/{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    git(repo, "tag", "-a", tag, "-m", f"tether squash of {branch}\n\nsquashed-to: {new}", old)
    r = git(repo, "update-ref", "-m", "tether squash", f"refs/heads/{branch}", new, old, check=False)
    if r.returncode != 0:
        git(repo, "tag", "-d", tag, check=False)
        raise Refused(f"{branch} moved while squashing; nothing was changed")
    return tag


def apply(repo, proposal_path) -> str:
    data = read_proposal(proposal_path)
    branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip()
    if not branch:
        raise Refused("HEAD is detached: check out the branch to squash")
    old = resolve(repo, "HEAD")
    base = resolve(repo, data["base"])
    groups = check_groups(repo, data["groups"], commit_range(repo, base, old))
    new = build(repo, base, groups)
    tag = finish(repo, branch, old, new)
    return f"{branch}: {sum(len(h) for h, _ in groups)} commits -> {len(groups)}; tree identical; old tip tagged {tag}"


def verify(repo, tag: str):
    r = git(repo, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}", check=False)
    if r.returncode != 0:
        raise Refused(f"no tag {tag}")
    old = resolve(repo, tag)
    body = out(repo, "tag", "-l", "--format=%(contents)", tag)
    new = next((ln.split(":", 1)[1].strip() for ln in body.splitlines() if ln.startswith("squashed-to:")), "")
    if not new:
        raise Refused(f"{tag} is not a squash tag (no squashed-to line)")
    new = resolve(repo, new)
    same = tree(repo, old) == tree(repo, new)
    verdict = "identical" if same else "differ"
    return same, f"{tag}: old tip {old[:12]} and squashed tip {new[:12]} trees {verdict}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="squash.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", default=".", help="a path inside the repository (default: here)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan").add_argument("base")
    sub.add_parser("apply").add_argument("proposal")
    sub.add_parser("verify").add_argument("tag")
    args = parser.parse_args(argv)
    try:
        repo = out(args.repo, "rev-parse", "--show-toplevel")
        if args.cmd == "plan":
            print(plan(repo, args.base))
        elif args.cmd == "apply":
            print(apply(repo, args.proposal))
        else:
            same, text = verify(repo, args.tag)
            print(text)
            return 0 if same else 1
    except Refused as e:
        print(f"squash: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
