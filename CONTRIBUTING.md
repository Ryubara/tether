# Contributing to Tether

Thanks for helping. Tether is deliberately small: it keeps a Claude Code session tied to its project's state and
nothing more ([docs/design.md](docs/design.md) explains the principles). Changes that keep it small, portable and
dependency-free are the easiest to accept; for a bigger idea, open an issue first so we can agree on the shape.

## Set up

You need git and Python 3.9 or newer. Tether has no runtime dependencies; the tests use pytest.

```sh
git clone https://github.com/Ryubara/tether.git
cd tether
python -m pip install pytest ruff
python -m pytest
python -m ruff check .
```

To try your checkout in Claude Code without installing it, start a session with `claude --plugin-dir <checkout>`.

## Rules

- **Python 3.9+, standard library only.** The hooks run on every session start and turn end, on whatever Python
  the user has.
- **Every platform.** Windows, macOS and Linux. Anything platform-specific (today only the console injector) needs
  a fallback elsewhere and a test for both paths.
- **No machine-specific paths** in code, docs, manifests or tests: use `${CLAUDE_PLUGIN_ROOT}`, the project root,
  `TETHER_STATE_DIR` or placeholders such as `<checkout>`.
- **Cheap in context.** Hooks print as little as possible; skills say what to do, briefly.
- **Tests** for every change that can be tested without a live Claude Code session. Changes to the hooks or the
  automatic clear also need a live check ([below](#checking-the-hooks-live)); say in the pull request what you ran
  and what you saw.
- Update [CHANGELOG.md](CHANGELOG.md) under **Unreleased**, and the README or docs when behaviour changes.

## Checking the hooks live

The unit tests cannot start a real Claude Code session, so a change to the hooks, the meter or the automatic clear
is checked by hand:

1. Make a throwaway git project outside the repository with a `HANDOFF.md` whose **Now** section holds a codeword
   that appears nowhere else.
2. Start Claude Code in it with your checkout loaded: `claude --plugin-dir <checkout>`. Use a fresh terminal, not a
   session started from inside another Claude Code session (that one saves no transcript, so the meter never
   fires). Set `TETHER_STATE_DIR` to a scratch folder so the meter's files and the injector's log are easy to find.
3. Ask the session for the codeword: it must answer from `HANDOFF.md` without reading the file.
4. Lower the meter for the test (`TETHER_CHECKPOINT_AT`, well above a fresh session's context, which depends
   on your setup, or every cleared session checkpoints again), read a few files to pass it, and let the session run
   `tether:checkpoint`.
5. Expect, on Windows: `/clear`, a new session id, and `Continue from HANDOFF.md.` answered from the Resume section;
   the injector's log (`inject-<key>.log` in the state folder) shows each step. Elsewhere, or with
   `TETHER_AUTOCLEAR=0`: the "type /clear" message instead.
6. For the squash script, use a scratch repository with a few dozen small commits: `plan`, a proposal, `apply`,
   then `verify` must report identical trees.

## Commits and pull requests

- Commit titles are `area: Verb the rest`, at most 72 characters, present tense, no trailing period. Areas:
  `hooks`, `skills`, `lib`, `scripts`, `tests`, `docs`, `ci`, `plugin` (the manifests). Verbs: Add, Fix, Update,
  Remove, Rework, Improve, Document.
- The body says what changed for a user and why.
- Agent-written commits end with `Co-Authored-By: <model name> <its noreply address>`.
- One topic per pull request; CI must pass.

## Releases

A maintainer bumps `version` in `.claude-plugin/plugin.json`, moves the Unreleased notes under the new version in
the changelog, and tags `vX.Y.Z`.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
