# Tether -- design

Tether keeps a Claude Code session tied to its project's state, and nothing more. It is meant to replace
heavier workflow plugins: current models know how to plan, test, review and write; what they lack is
memory across `/clear`, a way to reset their own context unattended, and a tidy way to turn a working branch into a
clean history. Tether provides exactly those, plus a starting point for a project's own rules.

Principles:

- **Trust the agent.** No workflow, hierarchy, task files, mandatory reviews or ceremony. Skills are short and say
  what, not how.
- **One state file.** `HANDOFF.md` at the project root is the whole memory. What is done leaves it: git history
  and the project's docs hold that.
- **Mechanics in code, judgement in the model.** Scripts do what must be exact (clearing the console, rebuilding
  commits, checking trees); the model writes the words.
- **Cheap in context.** Hooks print little; skills load only when used; nothing is injected that the session does
  not need.
- **Python 3.10+ standard library only.** No dependencies, on Windows, macOS and Linux (`lib/run.sh` finds the
  interpreter). The console injection is Windows-only; other systems get a one-line "type /clear" fallback.

## Layout

```
.claude-plugin/plugin.json, marketplace.json
hooks/hooks.json            SessionStart, Stop
hooks/session_start.py      inject HANDOFF.md
hooks/stop.py               context meter + clear trigger
lib/run.sh                  finds Python 3.10+ and runs a script (hooks, skills)
lib/tether.py               shared helpers (project root, state dir, transcript context size)
lib/inject_clear.py         Windows console injector (detached)
scripts/squash.py           plan / apply / verify
skills/handoff/SKILL.md     + template.md
skills/checkpoint/SKILL.md
skills/squash/SKILL.md
skills/setup/SKILL.md       + agents-template.md
tests/                      pytest
```

## 1. Handoff

`HANDOFF.md` sections, in order:

- **Resume** -- present only after a checkpoint: what just happened and the exact next action. The first thing a
  cleared session reads; removed once acted on.
- **Now** -- where the work stands, in a few bullets (branch, what works, what is half done).
- **Running** -- background agents and long jobs: what, where (worktree, branch, log), how to collect the result if
  its notice never arrives (its report file, `git log` of its branch).
- **Next** -- ordered steps.
- **Waiting on the user** -- decisions and actions only the user can take.
- **Decisions** -- one dated line per decision still in force, newest first, with who made it. Pruned when no
  longer relevant (git history keeps the old file).

Rules (the skill): update it whenever the picture changes (an agent dispatched or finished, a decision, a step
done), keep it under ~150 lines, write it for a reader with no context, commit it with the work it describes or
on its own (`handoff: ...` is not required; follow the project's conventions).

**SessionStart hook:** if `HANDOFF.md` exists at the project root (the git work tree of the session's `cwd`), its
text is added to the session's context on every start source (`startup`, `resume`, `clear`, `compact`), with one
line above it: "Project state from HANDOFF.md (Tether)". Capped at 400 lines (a longer file is cut with a note to
trim it). Nothing else is printed. A project without `HANDOFF.md` gets nothing.

## 2. Checkpoint and automatic clear

**Context meter (Stop hook, main session only).** Read the transcript at `transcript_path`; the context size is the
last main-chain assistant message's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. At
`TETHER_CHECKPOINT_AT` (default 200000) the hook blocks the stop once with a short reason: "Context is N tokens:
checkpoint at the next safe point (tether:checkpoint)." It reminds again only after the context grows by
`TETHER_CHECKPOINT_STEP` (default 25000), never when `stop_hook_active` is set, and keeps that state per session
in the state dir.

**`tether:checkpoint` skill.**

1. Safe point: dispatch nothing new. Clearing does not stop subagents, but their completion notices may not reach
   the cleared session, so every running agent must be in HANDOFF's **Running** section with how to collect its
   result. Prefer a moment when none is about to finish.
2. Write HANDOFF's **Resume** section and bring the rest up to date; commit.
3. Run `sh <plugin>/lib/run.sh <plugin>/lib/tether.py request-clear` (writes the flag for this project and session), then end the turn.

**Clear trigger (same Stop hook).** If the flag exists for this project and this session id: remove it and start
`inject_clear.py` detached; allow the stop. The injector finds the `claude.exe` ancestor of the hook process,
waits `TETHER_CLEAR_DELAY` (default 2 s), attaches to its console and types `/clear` + Enter, then after 4 s
`Continue from HANDOFF.md.` + Enter. It logs to the state dir only (output while attached corrupts the TUI) and
refuses if the target is not an ancestor or the session id does not match. Off switch `TETHER_AUTOCLEAR=0`, and
on non-Windows: the hook shows "Checkpoint saved -- type /clear, then: Continue from HANDOFF.md." instead.

The cleared session gets HANDOFF.md (with its Resume section) from the SessionStart hook, then the injected
prompt.

## 3. Squash

Turns a working branch's many commits into a few feature-sized ones, at milestones the agent or the user chooses,
before a push.

- `squash.py plan <base>` prints the commits in `base..HEAD` (hash, title, files) for the model to group.
- The model writes a proposal file: an ordered list of groups, each with its commit hashes and the new message
  (title and body following the project's Conventions section in AGENTS.md). The skill shows the proposal to the
  user unless the project says squashing is delegated.
- `squash.py apply <proposal>` builds the new commits on `base` in a temporary worktree by cherry-picking each
  group's commits in order and committing once per group with the given message, keeping the original author and
  dates of the group's last commit. Any conflict stops it with the commit named; nothing is changed.
- It then verifies the new tip's tree equals the old tip's tree (byte-identical), tags the old tip
  `squash/<branch>/<UTC timestamp>`, and moves the branch. A different tree refuses and changes nothing.
- `squash.py verify <tag>` repeats the tree check later.

## 4. Setup and conventions

`tether:setup` prepares a project once: creates `HANDOFF.md` from the template if missing; makes sure `CLAUDE.md`
contains `@AGENTS.md`; and adds to `AGENTS.md`, if missing, the project-rules skeleton from `agents-template.md`,
filled in with the user: **Project** (what it is, layout), **Build and test** (exact commands), **Conventions**
(commit title format and areas, trailers, branches and pushes, code style pointers), **Documentation** (where docs
live, and the rule that agents document as they work: a change that alters behaviour, knowledge or a command
updates the living doc in the same commit; one document per subject, updated in place), **Rules** (the project's
hard limits). Target: under ~60 lines, because AGENTS.md is in the context of every request. Tether never owns
these sections afterwards; they are the project's.

## 5. Testing

pytest for: HANDOFF injection (present, absent, cap, every source), the meter (threshold, step, loop guard,
per-session state, missing or malformed transcript), the flag and trigger, the injector's pure parts (key events,
ancestor walk over a fake process table), and squash (grouping, reordering, conflict refusal, tree check, tag).
The automatic clear and the hooks in a real session are checked by hand (CONTRIBUTING.md, Checking the hooks
live).
