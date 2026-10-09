# Tether

A Claude Code plugin that keeps long sessions cheap: it clears the context by itself at safe points and picks the
work up again from a single state file, so you can leave a session running unattended.

## Why: the automatic clear

Every request a session makes carries the whole conversation so far, so a long session costs more tokens, and gets
slower, with every turn. Claude Code's autocompact steps in only when the context is nearly full, and it replaces
your work with a summary it writes itself.

Tether resets the context on purpose, well before that:

1. A **context meter** in the Stop hook watches the session's size and, past a threshold (200000 tokens by default),
   asks for a checkpoint.
2. The `tether:checkpoint` skill has Claude write down exactly where it is and what to do next in `HANDOFF.md`.
3. Tether then **types `/clear` and `Continue from HANDOFF.md.` into the session itself**, so the session carries on
   from a small, fresh context with nobody at the keyboard.

What a clear gives you:

- **Fewer tokens per turn.** The context goes back to a fresh session's size after every checkpoint, instead of
  growing for as long as the session runs.
- **Faster turns.** Smaller requests come back sooner.
- **Nothing lost to a summary.** What the next session needs is written down on purpose in `HANDOFF.md`, not
  condensed by autocompact at the last moment.
- **Focus.** The model works from the current state and next step, not from hours of old tool output.
- **Unattended runs.** Long tasks keep going through many clears without anyone at the keyboard.

The automatic clear works on Windows today. On macOS and Linux, Tether saves the checkpoint the same way and asks
you to type `/clear`; doing it automatically there is planned.

## What else it does

- **Handoff.** `HANDOFF.md` at the project root is the session's memory. Tether puts it into the context at every
  session start (`startup`, `resume`, `clear`, `compact`), so a cleared session picks up where the last one stopped.
- **Squash.** `scripts/squash.py` turns a working branch's many commits into a few feature-sized ones, with a
  byte-identical tree and the old tip tagged.
- **Setup.** `tether:setup` creates `HANDOFF.md` and a short project-rules skeleton in `AGENTS.md`.

Design: [`docs/design.md`](docs/design.md). Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

Requirements: Claude Code, git, Python 3.10+ (standard library only; found as `python3`, `python` or `py`), and a
POSIX `sh` to run the hooks: built in on macOS and Linux, Git Bash on Windows (see Limits).

## Install

Tether is installed from this repository, which is its own plugin marketplace. It is not listed in any public
plugin directory.

```sh
claude plugin marketplace add Ryubara/tether
claude plugin install tether@tether
```

Pin a release with `claude plugin marketplace add Ryubara/tether@v0.1.2`. To share it with everyone working on a
project, add it to the project's `.claude/settings.json` instead:

```json
{
  "extraKnownMarketplaces": {
    "tether": { "source": { "source": "github", "repo": "Ryubara/tether" } }
  },
  "enabledPlugins": { "tether@tether": true }
}
```

To work on Tether itself, load your checkout for one session with `claude --plugin-dir <checkout>`. Then run
`tether:setup` once in each project.

Updates: third-party marketplaces do not auto-update by default. Run `claude plugin marketplace update tether` and
`claude plugin update tether@tether`, or turn on auto-update for the marketplace under `/plugin`.

## Skills

| Skill | Use |
|---|---|
| `tether:handoff` | Keep `HANDOFF.md` current: Resume (after a checkpoint only), Now, Running, Next, Waiting on the user, Decisions. |
| `tether:checkpoint` | Save the state, then `sh <plugin>/lib/run.sh <plugin>/lib/tether.py request-clear` and end the turn. |
| `tether:squash` | `squash.py plan <base>`, write a proposal, `squash.py apply <proposal>`, `squash.py verify <tag>`. |
| `tether:setup` | Create `HANDOFF.md` (tracked or ignored, the user's choice), `@AGENTS.md` in `CLAUDE.md`, the AGENTS.md skeleton. |

`HANDOFF.md` may be tracked or ignored: the hooks read it from disk and squash compares committed trees only.

## Settings (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `TETHER_CHECKPOINT_AT` | `200000` | Context size (tokens) at which the Stop hook asks for a checkpoint; `0` turns the meter off. |
| `TETHER_CHECKPOINT_STEP` | `25000` | Growth after which it asks again. |
| `TETHER_CLEAR_DELAY` | `2` | Seconds the injector waits for the turn to finish rendering before typing `/clear`. |
| `TETHER_AUTOCLEAR` | `1` | `0` turns the console injection off: the hook asks the user to type `/clear` instead. |
| `TETHER_STATE_DIR` | `~/.claude/tether` | Meter state, clear flags, the injector's log (`inject-<key>.log`). |

## How the automatic clear works

1. `request-clear` writes a flag for this project (the git work tree) and this session (`CLAUDE_CODE_SESSION_ID`).
2. When the turn ends, the Stop hook claims the flag, walks its own parent processes to the nearest `claude.exe`
   (or `$CLAUDE_PID`), and starts `lib/inject_clear.py` detached with that one target.
3. The injector waits `TETHER_CLEAR_DELAY`, checks the claimed flag names the same session and the target still
   runs, attaches to its console (FreeConsole, AttachConsole, `CONIN$`) and types `/clear` + Enter with
   WriteConsoleInputW.
4. SessionStart (source `clear`) injects `HANDOFF.md` and records the new session id; once the injector sees it,
   it waits 4 s and types `Continue from HANDOFF.md.` + Enter.
5. It logs only to the state dir (output while attached would corrupt the TUI). A failure is reported at the
   session's next Stop.

## Tests

```
py -m pytest -q
```

The suite sets `TETHER_AUTOCLEAR=0` and its own state dir, so it never types into a console.

## Limits

- The automatic clear is Windows-only; elsewhere the hook prints "Checkpoint saved -- type /clear, then: Continue
  from HANDOFF.md."
- The hooks run through `sh`. Claude Code uses Git Bash for hooks on Windows and falls back to PowerShell when Git
  Bash is not installed; Tether's hooks then fail (shown as hook errors), so install Git for Windows.
- Checked live with a native `claude.exe` in Windows Terminal only; an npm (`node.exe`) install and the classic
  console host are untested.
- A `claude` started from inside another Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION` and saves no
  transcript, so the meter never fires there.
- If the session is busy when `/clear` arrives (a background agent's notice started a turn), Claude Code holds the
  `/clear` until that turn ends; the continue prompt waits for the new session (up to 10 minutes), then gives up
  and reports the failure.
- The meter can read one call behind: the Stop hook fires before the turn's final message is on disk, so the size
  is the previous API call's. Harmless at a 25000-token step.
- `TETHER_CHECKPOINT_AT` must sit well above a fresh session's context, which depends on your setup (the skills,
  MCP servers and plugins loaded at start, plus `HANDOFF.md`). Below it, every cleared session is asked to
  checkpoint again, in a loop.
- `/clear` kills the shell command a background agent is running at that moment (exit 137, seen twice live); the
  agent survives, and its completion notice reaches the cleared session. The checkpoint skill therefore prefers a
  moment with no agent running.
- Claude Code labels the meter's block "Stop hook error" in the TUI, like every Stop block.
- Squash refuses ranges with merge commits, and runs the project's git hooks on the new commits.

## Licence

[MIT](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
