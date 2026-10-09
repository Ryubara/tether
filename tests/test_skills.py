import json
import re
import shutil
import subprocess

import pytest

from conftest import ROOT

SKILLS = ("handoff", "checkpoint", "squash", "setup")


@pytest.mark.parametrize("name", SKILLS)
def test_skill_frontmatter(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    m = re.match(r"---\nname: (\S+)\ndescription: (.+)\n---\n", text)
    assert m and m.group(1) == name
    assert len(text.splitlines()) <= 40  # short: what, not how


@pytest.mark.parametrize("name", SKILLS)
def test_skill_paths_exist(name):
    base = ROOT / "skills" / name
    text = (base / "SKILL.md").read_text(encoding="utf-8")
    for rel in re.findall(r"base directory>/([^\"` ]+)", text) + re.findall(r"`(\.\./[^`]+)`", text):
        assert (base / rel).resolve().is_file(), rel
    for local in re.findall(r"`([a-z-]+\.md)`", text):
        if local not in ("HANDOFF.md", "AGENTS.md", "CLAUDE.md"):
            assert (base / local).is_file(), local


def test_handoff_template_sections_in_order():
    text = (ROOT / "skills" / "handoff" / "template.md").read_text(encoding="utf-8")
    heads = re.findall(r"^## (.+)$", text, re.M)
    assert heads == ["Now", "Running", "Next", "Waiting on the user", "Decisions"]


def test_manifests():
    plugin = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert plugin["name"] == "tether" and plugin["license"] == "MIT" and plugin["author"]["name"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", plugin["version"])
    # The changelog has a section for the manifest's version (or it is still Unreleased).
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"## [{plugin['version']}]" in changelog or "## [Unreleased]" in changelog
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
    assert market["name"] == "tether"
    assert market["plugins"][0]["name"] == "tether" and market["plugins"][0]["source"] == "./"
    hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
    assert set(hooks) == {"SessionStart", "Stop"}
    for event in hooks.values():
        command = event[0]["hooks"][0]["command"]
        # Every hook goes through the launcher, and every file it names exists.
        paths = re.findall(r'"\$\{CLAUDE_PLUGIN_ROOT\}/([^"]+)"', command)
        assert paths[0] == "lib/run.sh" and len(paths) == 2
        assert all((ROOT / path).is_file() for path in paths)


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX sh (Git Bash on Windows)")
def test_launcher_finds_python():
    # The launcher picks a Python 3.10+ and passes the arguments through.
    out = subprocess.run(
        ["sh", str(ROOT / "lib" / "run.sh"), "-c", "import sys; print(sys.version_info >= (3, 10))"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "True"


MACHINE_PATH = re.compile(r"[A-Za-z]:[\/](Users|Documents and Settings)[\/]|/(home|Users)/[a-z]", re.I)


def test_no_machine_paths():
    # Docs, code and manifests use placeholders, never a contributor's own paths.
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    for name in tracked.split():
        path = ROOT / name
        if path.suffix in {".png"} or not path.is_file():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            assert not MACHINE_PATH.search(line), f"{name}:{number}: {line.strip()}"
