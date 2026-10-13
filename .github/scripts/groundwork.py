#!/usr/bin/env python3
"""Groundwork's portable checker: reads .github/conventions.yml and enforces it.

One file, standard library plus PyYAML, so a repository set up by Groundwork needs nothing from Coney.
Run it as `uv run --with pyyaml python .github/scripts/groundwork.py <command>`; `--help` lists the commands.

Exit codes: 0 passed, 1 a rule was broken (or drift found), 2 the conventions file or the invocation is unusable.
Text that a stranger controls (a title, a description) only ever arrives on stdin or in a file, never in a command
line, so a workflow can pass it without expanding it into a script.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

CONVENTIONS = Path(".github/conventions.yml")
MARKER = "groundwork-hygiene"  # the hygiene comment starts with <!-- MARKER -->

# Top-level keys and the keys each may hold. An unknown key is an error, so a typo fails loudly instead of being
# ignored (the reference, Coney's checker, does the same).
KNOWN: dict[str, set[str]] = {
    "version": set(),
    "repo": {"default_branch", "wording", "maintainer_decisions", "tools"},
    "paths": {"code", "docs", "generated", "large_file_kb"},
    "commits": {"title", "body", "trailers"},
    "pull_requests": {"template", "sections", "filled", "placeholders", "local_paths", "docs_none", "closing",
                      "checklist", "ai_use", "guidance"},
    "merge": {"methods", "squash_title", "squash_message", "auto_merge", "delete_branch_on_merge",
              "linear_history", "required_checks", "ruleset_name"},
    "issues": {"blank_issues", "placeholders", "forms", "labels"},
    "labels": {"description_max", "families", "list"},
    "hygiene": {"report_issue", "sweep", "thresholds"},
}


class ConventionsError(Exception):
    """The conventions file is missing or malformed."""


# --------------------------------------------------------------------------------------------------------------------
# Loading and validating the conventions
# --------------------------------------------------------------------------------------------------------------------


def load(path: Path = CONVENTIONS) -> dict[str, Any]:
    """Read the conventions file and refuse unknown keys and wrong types."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as err:
        raise ConventionsError(f"cannot read {path}: {err}") from err
    if not isinstance(data, dict):
        raise ConventionsError(f"{path} must be a mapping")
    problems = validate(data)
    if problems:
        raise ConventionsError("; ".join(problems))
    return data


def validate(data: dict[str, Any]) -> list[str]:
    """Return every problem found in a parsed conventions mapping (empty when it is fine)."""
    problems: list[str] = []
    for key, value in data.items():
        if key not in KNOWN:
            problems.append(f"unknown key {key!r}")
        elif KNOWN[key] and not isinstance(value, dict):
            problems.append(f"{key} must be a mapping")
        elif KNOWN[key]:
            problems += [f"unknown key {key}.{sub!r}" for sub in value if sub not in KNOWN[key]]
    if problems:
        return problems
    title = data.get("commits", {}).get("title", {})
    if not title.get("areas") or not title.get("verbs"):
        problems.append("commits.title needs areas and verbs")
    labels = {item["name"] for item in data.get("labels", {}).get("list", []) if isinstance(item, dict)}
    names = [item.get("name") for item in data.get("labels", {}).get("list", []) if isinstance(item, dict)]
    if len(names) != len(set(names)):
        problems.append("labels.list has a duplicate name")
    for form_name, form in data.get("issues", {}).get("forms", {}).items():
        for label in form.get("labels", []):
            if labels and label not in labels:
                problems.append(f"issues.forms.{form_name} uses the label {label!r}, which labels.list lacks")
    for check in data.get("merge", {}).get("required_checks", []):
        if not isinstance(check, str):
            problems.append("merge.required_checks must be a list of names")
    return problems


# --------------------------------------------------------------------------------------------------------------------
# Titles
# --------------------------------------------------------------------------------------------------------------------


def title_problems(conv: dict[str, Any], title: str) -> list[str]:
    """Check a commit or pull request title against commits.title; return what is wrong."""
    rule = conv["commits"]["title"]
    problems: list[str] = []
    suffix = rule.get("breaking_suffix") or ""
    text = title.strip()
    if len(text) > rule.get("max_length", 72):
        problems.append(f"{len(text)} characters; at most {rule.get('max_length', 72)}")
    body = text[: -len(suffix)].rstrip() if suffix and text.endswith(suffix) else text
    if not rule.get("trailing_period", False) and body.endswith("."):
        problems.append("ends with a period")
    match = re.fullmatch(r"([a-z0-9-]+): ([A-Z][a-z]+) (\S.*)", body)
    if not match:
        problems.append(f"does not match the form {rule.get('form', 'area: Verb the rest')!r}")
        return problems
    area, verb, _ = match.groups()
    if area not in rule["areas"]:
        problems.append(f"area {area!r} is not one of: {', '.join(rule['areas'])}")
    if verb not in rule["verbs"]:
        problems.append(f"verb {verb!r} is not one of: {', '.join(rule['verbs'])}")
    return problems


# --------------------------------------------------------------------------------------------------------------------
# Pull request descriptions
# --------------------------------------------------------------------------------------------------------------------

_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LOCAL_PATH = re.compile(r"(?<![\w/.-])(?:[A-Za-z]:\\|\.\./\.\./|scratch/)")


def split_sections(body: str) -> dict[str, str]:
    """Split a description into its `## Heading` sections (heading -> text); text before the first is dropped."""
    sections: dict[str, str] = {}
    current: str | None = None
    for line in body.splitlines():
        heading = re.match(r"##\s+(.+?)\s*$", line)
        if heading and not line.startswith("###"):
            current = heading.group(1)
            sections[current] = ""
        elif current is not None:
            sections[current] += line + "\n"
    return sections


def is_empty(text: str, placeholders: list[str]) -> bool:
    """True when a section holds only comments, bullets and template placeholders."""
    stripped = _COMMENT.sub("", text)
    lines = [re.sub(r"^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)?", "", ln).strip() for ln in stripped.splitlines()]
    lines = [ln for ln in lines if ln]
    low = {p.lower() for p in placeholders} | {p.lower().rstrip(".") for p in placeholders}
    return all(ln.lower() in low or ln.lower().rstrip(".") in low for ln in lines)


def body_problems(conv: dict[str, Any], body: str) -> list[str]:
    """Check a pull request description against pull_requests (the docs rule is `docs_problems`)."""
    rule = conv["pull_requests"]
    problems: list[str] = []
    sections = split_sections(body)
    wanted: list[str] = rule.get("sections", [])
    present = [name for name in sections if name in wanted]
    for name in wanted:
        if name not in sections:
            problems.append(f"missing the section ## {name}")
    if not problems and present != wanted:
        problems.append(f"sections out of order; expected {', '.join(wanted)}")
    placeholders = rule.get("placeholders", ["..."])
    for name in rule.get("filled", []):
        if name in sections and is_empty(sections[name], placeholders):
            problems.append(f"the section ## {name} is empty or still the template's placeholder")
    if not rule.get("local_paths", False):
        for number, line in enumerate(_IMAGE.sub("", _COMMENT.sub("", body)).splitlines(), 1):
            if _LOCAL_PATH.search(line):
                problems.append(f"line {number} names a path on someone's machine; say it in words instead")
    checklist = rule.get("checklist")
    if checklist and checklist["section"] in sections:
        text = _COMMENT.sub("", sections[checklist["section"]])
        if re.search(r"^\s*[-*]\s*\[ \]", text, re.MULTILINE):
            problems.append(f"the section ## {checklist['section']} has an unticked task; finish it or move it to an issue")
    closing = rule.get("closing")
    if closing:
        for line in _COMMENT.sub("", body).splitlines():
            if re.match(rf"\s*{re.escape(closing['keyword'])}\b", line) and not re.fullmatch(
                rf"{re.escape(closing['keyword'])} #\d+", line.strip()
            ):
                problems.append(f"a closing line must read '{closing['form']}', one per line: {line.strip()!r}")
    ai = rule.get("ai_use")
    if ai and ai["section"] in sections:
        text = _COMMENT.sub("", sections[ai["section"]])
        written = _field(text, ai["written_by"]["label"])
        if written not in ai["written_by"]["choices"]:
            problems.append(f"'{ai['written_by']['label']}' must be one of: {'; '.join(ai['written_by']['choices'])}")
        elif written != ai["written_by"]["no_ai"]:
            model = _field(text, ai["model"]["label"])
            if not model or model.lower() == ai["model"]["none"]:
                problems.append(f"'{ai['model']['label']}' must name the model when an AI took part")
    return problems


def _field(text: str, label: str) -> str:
    """The value after a `**Label**` (or `Label`) in a section, '' when absent."""
    bare = label.rstrip(":")
    match = re.search(rf"\*\*{re.escape(bare)}:?\*\*:?[ \t]*(.*)|^[ \t]*[-*]?[ \t]*{re.escape(label)}[ \t]*(.*)", text,
                      re.MULTILINE)
    if not match:
        return ""
    return (match.group(1) or match.group(2) or "").strip()


def _under(path: str, prefixes: list[str]) -> bool:
    """True when `path` is under one of the folder prefixes (or equals a file prefix)."""
    return any(path == p or (p.endswith("/") and path.startswith(p)) for p in prefixes)


def docs_problems(conv: dict[str, Any], body: str, changed: list[str]) -> list[str]:
    """A change to code needs a change to docs, or the description's escape line (pull_requests.docs_none)."""
    rule = conv["pull_requests"].get("docs_none")
    if not rule:
        return []
    paths = conv.get("paths", {})
    code, docs = paths.get(rule["when_changed"], []), paths.get(rule["unless_changed"], [])
    if not any(_under(p, code) for p in changed) or any(_under(p, docs) for p in changed):
        return []
    if any(ln.strip() == rule["line"] for ln in _COMMENT.sub("", body).splitlines()):
        return []
    return [f"code changed without a docs change; update the docs or add a line '{rule['line']}'"]


# --------------------------------------------------------------------------------------------------------------------
# Rendering the files that follow the conventions (so they cannot drift)
# --------------------------------------------------------------------------------------------------------------------


def render_template(conv: dict[str, Any]) -> str:
    """The pull request template: the sections in order, with their guidance as comments."""
    rule = conv["pull_requests"]
    guidance = rule.get("guidance", {})
    out = ["<!-- markdownlint-disable-file MD041 -- a pull request body starts at the second heading level -->"]
    for name in rule["sections"]:
        out.append(f"## {name}\n")
        if name in guidance:
            out.append(f"<!-- {guidance[name].strip()} -->\n")
        if name == rule.get("checklist", {}).get("section"):
            out.append("- [x] ...\n")
        elif rule.get("ai_use") and name == rule["ai_use"]["section"]:
            ai = rule["ai_use"]
            out.append(f"- **{ai['written_by']['label']}** <!-- {' / '.join(ai['written_by']['choices'])} -->")
            out.append(f"- **{ai['model']['label']}** <!-- the model that wrote them; {ai['model']['none']} when a person did -->\n")
        elif name in rule.get("filled", []):
            out.append("- ...\n")
    return "\n".join(out).rstrip() + "\n"


def render_form(conv: dict[str, Any], name: str) -> str:
    """One issue form as GitHub's YAML, from issues.forms.<name>."""
    form = conv["issues"]["forms"][name]
    body: list[dict[str, Any]] = []
    if form.get("intro"):
        body.append({"type": "markdown", "attributes": {"value": form["intro"].strip() + "\n"}})
    for key, spec in form["sections"].items():
        label, required = (spec[0], spec[1]) if isinstance(spec, list) else (spec["heading"], spec.get("required", False))
        kind = "textarea" if isinstance(spec, list) else spec.get("type", "textarea")
        entry: dict[str, Any] = {"type": kind, "id": key, "attributes": {"label": label}}
        if isinstance(spec, dict):
            if spec.get("description"):
                entry["attributes"]["description"] = spec["description"]
            if kind == "dropdown":
                entry["attributes"]["options"] = spec["options"]
        if required:
            entry["validations"] = {"required": True}
        body.append(entry)
    doc = {"name": form.get("name", name.capitalize()), "description": form.get("description", f"File a {name}"),
           "title": form["title_prefix"], "labels": form["labels"], "body": body}
    header = "# Generated from .github/conventions.yml by `groundwork.py render`; edit the conventions, not this file.\n"
    return header + yaml.safe_dump(doc, sort_keys=False, width=110, allow_unicode=True)


def render_config(conv: dict[str, Any]) -> str:
    """ISSUE_TEMPLATE/config.yml: whether a blank issue is allowed."""
    blank = str(bool(conv["issues"].get("blank_issues", False))).lower()
    return f"# Generated from .github/conventions.yml by `groundwork.py render`.\nblank_issues_enabled: {blank}\n"


def rendered_files(conv: dict[str, Any]) -> dict[str, str]:
    """Every file `render` owns, by repository-relative path."""
    files = {
        conv["pull_requests"].get("template", ".github/pull_request_template.md"): render_template(conv),
        ".github/ISSUE_TEMPLATE/config.yml": render_config(conv),
    }
    for name, form in conv["issues"].get("forms", {}).items():
        files[form.get("file", f".github/ISSUE_TEMPLATE/{name}.yml")] = render_form(conv, name)
    return files


# --------------------------------------------------------------------------------------------------------------------
# GitHub: labels, settings, the ruleset
# --------------------------------------------------------------------------------------------------------------------


def gh(*args: str, stdin: str | None = None, check: bool = True) -> str:
    """Run `gh` and return its standard output."""
    result = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def label_diff(conv: dict[str, Any], repo: str | None) -> tuple[list[dict], list[dict], list[str]]:
    """Compare labels.list with the repository: (to create, to change, extra names the repository has)."""
    repo_args = ["-R", repo] if repo else []
    have = {item["name"]: item for item in json.loads(gh("label", "list", "--json", "name,color,description", "-L", "500", *repo_args))}
    create: list[dict] = []
    change: list[dict] = []
    wanted = {item["name"]: item for item in conv["labels"]["list"]}
    for name, item in wanted.items():
        if name not in have:
            create.append(item)
        elif have[name]["color"].lower() != str(item["color"]).lower() or have[name].get("description", "") != item.get("description", ""):
            change.append(item)
    return create, change, sorted(set(have) - set(wanted))


def settings_wanted(conv: dict[str, Any]) -> dict[str, Any]:
    """The repository settings that the merge section asks for, as GitHub's API names them."""
    merge = conv["merge"]
    methods = merge.get("methods", ["squash"])
    return {
        "allow_squash_merge": "squash" in methods,
        "allow_merge_commit": "merge" in methods,
        "allow_rebase_merge": "rebase" in methods,
        "allow_auto_merge": bool(merge.get("auto_merge", False)),
        "delete_branch_on_merge": bool(merge.get("delete_branch_on_merge", True)),
        "squash_merge_commit_title": merge.get("squash_title", "PR_TITLE"),
        "squash_merge_commit_message": merge.get("squash_message", "PR_BODY"),
    }


def ruleset_wanted(conv: dict[str, Any]) -> dict[str, Any]:
    """The branch ruleset for the default branch, as the rulesets API takes it."""
    merge = conv["merge"]
    rules: list[dict[str, Any]] = [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {"type": "pull_request", "parameters": {
            "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": False,
            "require_code_owner_review": False, "require_last_push_approval": False,
            "required_review_thread_resolution": False,
            "allowed_merge_methods": [m for m in merge.get("methods", ["squash"])]}},
    ]
    if merge.get("linear_history", True):
        rules.append({"type": "required_linear_history"})
    if merge.get("required_checks"):
        rules.append({"type": "required_status_checks", "parameters": {
            "strict_required_status_checks_policy": bool(merge.get("up_to_date_required", False)),
            "required_status_checks": [{"context": c} for c in merge["required_checks"]]}})
    return {"name": merge.get("ruleset_name", "Main"), "target": "branch", "enforcement": "active",
            "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}}, "rules": rules,
            "bypass_actors": []}


def normalise_ruleset(rs: dict[str, Any]) -> dict[str, Any]:
    """Reduce a ruleset (ours or GitHub's reply) to the fields that matter, for comparison."""
    rules = {}
    for rule in rs.get("rules", []):
        params = rule.get("parameters", {})
        if rule["type"] == "required_status_checks":
            params = {"strict": params.get("strict_required_status_checks_policy", False),
                      "contexts": sorted(c["context"] for c in params.get("required_status_checks", []))}
        elif rule["type"] == "pull_request":
            params = {"methods": sorted(params.get("allowed_merge_methods", []))}
        else:
            params = {}
        rules[rule["type"]] = params
    return {"name": rs["name"], "enforcement": rs.get("enforcement"), "rules": rules}


def current_repo() -> str:
    """owner/name of the repository gh is pointed at."""
    return json.loads(gh("repo", "view", "--json", "nameWithOwner"))["nameWithOwner"]


def ruleset_state(conv: dict[str, Any], repo: str) -> tuple[dict | None, dict]:
    """(the existing ruleset with our name or None, the wanted one)."""
    wanted = ruleset_wanted(conv)
    for item in json.loads(gh("api", f"repos/{repo}/rulesets") or "[]"):
        if item["name"] == wanted["name"]:
            return json.loads(gh("api", f"repos/{repo}/rulesets/{item['id']}")), wanted
    return None, wanted


def settings_drift(conv: dict[str, Any], repo: str) -> dict[str, tuple[Any, Any]]:
    """Settings that differ: name -> (now, wanted)."""
    now = json.loads(gh("api", f"repos/{repo}"))
    return {k: (now.get(k), v) for k, v in settings_wanted(conv).items() if now.get(k) != v}


# --------------------------------------------------------------------------------------------------------------------
# Hygiene: the weekly sweep
# --------------------------------------------------------------------------------------------------------------------


def _age_days(stamp: str, now: dt.datetime) -> float:
    return (now - dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds() / 86400


def hygiene_findings(conv: dict[str, Any], repo: str | None, now: dt.datetime) -> list[str]:
    """Findings about open issues and pull requests, as Markdown bullets."""
    repo_args = ["-R", repo] if repo else []
    issues = json.loads(gh("issue", "list", "--state", "open", "-L", "500", "--json", "number,title,labels,updatedAt", *repo_args))
    prs = json.loads(gh("pr", "list", "--state", "open", "-L", "200", "--json", "number,title,updatedAt,body", *repo_args))
    fam = conv.get("labels", {}).get("families", {})
    thresholds = conv.get("hygiene", {}).get("thresholds", {})
    findings: list[str] = []

    def members(names: list[str], family: str) -> list[str]:
        spec = fam.get(family, {})
        prefix = spec.get("prefix", "")
        listed = spec.get("names", [])
        return [n for n in names if (prefix and n.startswith(prefix)) or n in listed]

    wanted = conv.get("issues", {}).get("labels", {})
    for issue in issues:
        names = [lab["name"] for lab in issue["labels"]]
        ref = f"#{issue['number']} {issue['title']}"
        for family, mode in wanted.items():
            if family not in fam or mode.startswith("exactly-one-after"):
                continue
            count = len(members(names, family))
            if mode == "exactly-one" and count != 1:
                findings.append(f"- {ref}: {count} {family} labels, expected exactly one")
            elif mode == "at-least-one" and count < 1:
                findings.append(f"- {ref}: no {family} label")
        age = _age_days(issue["updatedAt"], now)
        status = members(names, "status")
        limits = {"S-needs-triage": thresholds.get("needs_triage_days"), "S-needs-info": thresholds.get("needs_info_days"),
                  "S-in-progress": thresholds.get("in_progress_idle_days")}
        for label in status:
            if limits.get(label) and age > limits[label]:
                findings.append(f"- {ref}: {label} for {int(age)} days (limit {limits[label]})")
    limit = thresholds.get("pull_request_idle_days")
    for pr in prs:
        ref = f"#{pr['number']} {pr['title']}"
        for problem in title_problems(conv, pr["title"]):
            findings.append(f"- {ref}: title {problem}")
        for problem in body_problems(conv, pr.get("body") or ""):
            findings.append(f"- {ref}: description: {problem}")
        if limit and _age_days(pr["updatedAt"], now) > limit:
            findings.append(f"- {ref}: no activity for {int(_age_days(pr['updatedAt'], now))} days (limit {limit})")
    return findings


def post_report(conv: dict[str, Any], repo: str | None, text: str) -> str:
    """Edit the one report comment on the report issue (creating the issue and the comment when missing)."""
    repo_args = ["-R", repo] if repo else []
    spec = conv.get("hygiene", {}).get("report_issue", {"title": "Repo hygiene", "labels": []})
    found = json.loads(gh("issue", "list", "--state", "open", "--search", f'"{spec["title"]}" in:title', "--json",
                          "number,title", *repo_args))
    number = next((i["number"] for i in found if i["title"] == spec["title"]), None)
    if number is None:
        label_args = [a for lab in spec.get("labels", []) for a in ("--label", lab)]
        url = gh("issue", "create", "--title", spec["title"], "--body", "The weekly hygiene sweep keeps one comment here.",
                 *label_args, *repo_args).strip()
        number = int(url.rsplit("/", 1)[1])
    target = repo or current_repo()
    comments = json.loads(gh("api", f"repos/{target}/issues/{number}/comments", "--paginate"))
    marker = f"<!-- {MARKER} -->"
    body = f"{marker}\n{text}"
    for comment in comments:
        if comment["body"].startswith(marker):
            gh("api", "--method", "PATCH", f"repos/{target}/issues/comments/{comment['id']}", "-f", f"body={body}")
            return f"updated the report on #{number}"
    gh("api", "--method", "POST", f"repos/{target}/issues/{number}/comments", "-f", f"body={body}")
    return f"posted the report on #{number}"


# --------------------------------------------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------------------------------------------


def _read(source: str) -> str:
    """Text from stdin when source is '-', else from a file."""
    return sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8-sig")


def _report(problems: list[str], what: str) -> int:
    if problems:
        print(f"{what}: refused", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"{what}: ok")
    return 0


def cmd_validate(conv: dict[str, Any], args: argparse.Namespace) -> int:
    return _report([], "conventions")  # load() already refused a bad file


def cmd_check_title(conv: dict[str, Any], args: argparse.Namespace) -> int:
    lines = _read(args.title).splitlines()
    return _report(title_problems(conv, lines[0] if lines else ""), "title")


def cmd_check_body(conv: dict[str, Any], args: argparse.Namespace) -> int:
    return _report(body_problems(conv, _read(args.body)), "description")


def cmd_check_docs(conv: dict[str, Any], args: argparse.Namespace) -> int:
    changed = Path(args.changed).read_text(encoding="utf-8").split()
    return _report(docs_problems(conv, _read(args.body), changed), "docs")


def cmd_render(conv: dict[str, Any], args: argparse.Namespace) -> int:
    drift: list[str] = []
    for path, text in rendered_files(conv).items():
        target = Path(path)
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                drift.append(f"{path} differs from the conventions (run `groundwork.py render`)")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
            print(f"wrote {path}")
    return _report(drift, "rendered files") if args.check else 0


def cmd_labels(conv: dict[str, Any], args: argparse.Namespace) -> int:
    create, change, extra = label_diff(conv, args.repo)
    for item in create + change:
        verb = "create" if item in create else "change"
        print(f"{verb} {item['name']}")
        if args.apply:
            gh("label", "create", item["name"], "--color", str(item["color"]), "--description", item.get("description", ""),
               "--force", *(["-R", args.repo] if args.repo else []))
    for name in extra:
        print(f"extra label (kept{'; deleted' if args.prune and args.apply else ''}): {name}")
        if args.prune and args.apply:
            gh("label", "delete", name, "--yes", *(["-R", args.repo] if args.repo else []))
    return 0 if args.apply or not (create or change) else 1


def cmd_settings(conv: dict[str, Any], args: argparse.Namespace) -> int:
    repo = args.repo or current_repo()
    drift = settings_drift(conv, repo)
    for key, (now, want) in drift.items():
        print(f"{key}: {now!r} -> {want!r}")
    if args.apply and drift:
        fields = [a for k, (_, v) in drift.items() for a in ("-F" if isinstance(v, bool) else "-f", f"{k}={str(v).lower() if isinstance(v, bool) else v}")]
        gh("api", "--method", "PATCH", f"repos/{repo}", *fields)
        print("applied")
        return 0
    return 1 if drift else 0


def cmd_ruleset(conv: dict[str, Any], args: argparse.Namespace) -> int:
    repo = args.repo or current_repo()
    existing, wanted = ruleset_state(conv, repo)
    if args.print:
        print(json.dumps(wanted, indent=2))
        return 0
    same = existing is not None and normalise_ruleset(existing) == normalise_ruleset(wanted)
    print("ruleset: in sync" if same else f"ruleset: {'differs' if existing else 'missing'}")
    if not same and args.apply:
        method, url = ("PUT", f"repos/{repo}/rulesets/{existing['id']}") if existing else ("POST", f"repos/{repo}/rulesets")
        gh("api", "--method", method, url, "--input", "-", stdin=json.dumps(wanted))
        print("applied")
        return 0
    return 0 if same else 1


def cmd_hygiene(conv: dict[str, Any], args: argparse.Namespace) -> int:
    findings = hygiene_findings(conv, args.repo, dt.datetime.now(dt.timezone.utc))
    text = "\n".join(findings) if findings else "No findings."
    print(text)
    if args.apply:
        print(post_report(conv, args.repo, text))
    return 0  # a sweep reports; it never fails a build


def cmd_check(conv: dict[str, Any], args: argparse.Namespace) -> int:
    """Everything at once: the files, then (unless --offline) the labels, settings and ruleset."""
    status = cmd_render(conv, argparse.Namespace(check=True))
    if not args.offline:
        repo = args.repo or current_repo()
        status |= cmd_labels(conv, argparse.Namespace(repo=repo, apply=False, prune=False))
        status |= cmd_settings(conv, argparse.Namespace(repo=repo, apply=False))
        status |= cmd_ruleset(conv, argparse.Namespace(repo=repo, apply=False, print=False))
    print("drift found" if status else "no drift")
    return 1 if status else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--conventions", default=str(CONVENTIONS), help="path to conventions.yml")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="check that the conventions file is well formed").set_defaults(run=cmd_validate)
    p = sub.add_parser("check-title", help="check a title (a file, or - for stdin)")
    p.add_argument("title"); p.set_defaults(run=cmd_check_title)
    p = sub.add_parser("check-body", help="check a pull request description")
    p.add_argument("--body", required=True, help="a file, or - for stdin")
    p.set_defaults(run=cmd_check_body)
    p = sub.add_parser("check-docs", help="a change to code needs a change to docs, or the escape line")
    p.add_argument("--body", required=True, help="the description: a file, or - for stdin")
    p.add_argument("--changed", required=True, help="a file listing the changed paths")
    p.set_defaults(run=cmd_check_docs)
    p = sub.add_parser("render", help="write (or with --check, compare) the template and issue forms")
    p.add_argument("--check", action="store_true"); p.set_defaults(run=cmd_render)
    for name, fn, helptext in (("labels", cmd_labels, "compare or sync the labels"),
                               ("settings", cmd_settings, "compare or apply the merge settings"),
                               ("ruleset", cmd_ruleset, "compare or apply the branch ruleset"),
                               ("hygiene", cmd_hygiene, "report stale or malformed issues and pull requests"),
                               ("check", cmd_check, "report drift between the repository and the conventions")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("-R", "--repo", help="owner/name (default: the current repository)")
        if name != "check":
            p.add_argument("--apply", action="store_true", help="change GitHub (otherwise only report)")
        if name == "labels":
            p.add_argument("--prune", action="store_true", help="with --apply, delete labels the conventions lack")
        if name == "ruleset":
            p.add_argument("--print", action="store_true", help="print the wanted ruleset JSON")
        if name == "check":
            p.add_argument("--offline", action="store_true", help="skip GitHub")
        p.set_defaults(run=fn)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point; returns the exit code."""
    args = build_parser().parse_args(argv)
    try:
        conv = load(Path(args.conventions))
        return args.run(conv, args)
    except ConventionsError as err:
        print(f"conventions unusable: {err}", file=sys.stderr)
        return 2
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
