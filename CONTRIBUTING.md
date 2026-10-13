# Contributing to Tether

Thank you for helping. This page is short on purpose: the rules a program can check live in
[`.github/conventions.yml`](.github/conventions.yml), and the checks tell you what is wrong.

## The flow

1. Start from an issue (the forms ask for what is needed), or open one first for anything larger than a small fix.
2. Work on a branch. `main` takes no direct pushes; every change is a pull request.
3. Give the pull request a title `area: Verb the rest`, at most 72 characters, present tense, no trailing period.
   The verbs are Add, Fix, Update, Remove, Rebuild, Rework, Improve and Document. The areas are:
   `checkpoint`, `fleet`, `watch`, `guards`, `housekeeping`, `conversation`, `plugin`, `build`, `ci`, `tests`, `docs` and `agents`.
4. Fill in the pull request template. Every task you list is finished and ticked; work you do not finish goes in
   its own issue. If the pull request finishes an issue, add a line `Fixes #<number>`.
5. A change to `src/` or `hooks/` also changes `CHANGELOG.md`, `README.md`, `examples/` or `docs/`, or the description says `Docs: none`.
6. The pull request is squash-merged: the title becomes the one commit on `main`.

## Checks

The required checks are `title`, `body`, `docs` and `build-ok`. Run `uv run --with pyyaml python .github/scripts/groundwork.py check
--offline` before you push to see whether the generated files still match the conventions.

## Conduct

Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).
