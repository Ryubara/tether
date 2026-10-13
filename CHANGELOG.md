# Changelog

## 1.0.0-alpha.20

- Added: the agent guard acts by itself. Once a minute, `cacheGuard.leadMinutes` (default 20, at most half the cache
  lifetime) before a stopped agent's prompt cache expires, a stopped agent with background work (status `waiting`,
  or live tasks) is sent a short keep-warm message (`$.session.send`; the reply is a cache read), or, from
  `cacheGuard.handoverTokens` (default 250k), a handover request (commit, update `STATUS.md`, list background jobs and
  result files, the next command, then stop). After a handover Tether stops the background tasks the agent left
  behind (`TaskStop`) and records it `retired`. An agent that does not finish within `cacheGuard.handoverWaitMinutes`
  (10), tasks `TaskStop` would not stop, a cache that expired before the guard could act, and more than
  `cacheGuard.keepWarmMax` (12) pings alert the model (toast, log, a wake prompt) and are never stopped silently.
  `cacheGuard.auto` off keeps only the blocking guard. Seven new options (51 in all), a `cacheGuard` config section,
  `guard ...` flags in the fleet pane and an action list in `/tether-guards`.
- Added: `mcp__tether__agent_decision` takes `kept-warm`: the agent was pinged; the warning is quiet for one expiry
  window counted from the later of its last activity and the record. A kept-warm agent can still be messaged.
- Changed: `retired` and `done` are refused while the agent is running or has live background work ("TaskStop it
  first"): it would wake itself and re-write its cache. Tether reads the task ids from the rows appended to the
  agent's conversation (`session.append`) and from its transcript when under 4 MB.
- Changed: the Stop hook looks again at the agents when it runs, and its message names the two ways out: keep warm
  (send a message, record `kept-warm`), or hand over and stop (`TaskStop`, then `retired`). An idle agent is guarded
  like a completed or waiting one.
- Removed: the agents poller's `actAfterMinutes` (default 45). The lead time is `cacheGuard.leadMinutes`
  (`cacheTtlMinutes` less 20 by default); a config that still sets it is read without error and the value is ignored.

## 1.0.0-alpha.19

- Changed: the agent guard is one rule. A stopped agent with a big context (`fleet.bigContextTokens`) idle for
  the agents poller's `actAfterMinutes` (default 45) is a finding at once and the Stop hook blocks until a
  decision (`retired` or `done`) is recorded. An agent with a recorded decision is never woken: the cold-cache
  guard refuses any `SendMessage` to it, whatever its cache age, unless the message starts with the override
  token. An undecided big agent is still refused only once idle for `fleet.cacheTtlMinutes` (default 60; a lower
  value adds a safety margin). The pane's cold flag and countdown are unchanged.
- Removed: the agents poller's `forgetAgentMinutes` (default 180). An undecided agent is no longer forgotten:
  it stays reported, with "cache EXPIRED", until decided; `stop.maxBlocks` prevents a loop. A config that still
  sets it is read without error and the value is ignored.

## 1.0.0-alpha.18

- Changed: every command now carries the `tether-` prefix, so Tether's commands sort together and cannot clash
  with another plugin's: `/fleet` is now `/tether-fleet`, `/watch` is `/tether-watch`, `/guards` is
  `/tether-guards`. The old names are gone (no aliases). The prefix is a hyphen because `$.command.register`
  refuses `:` in a name (letters, digits, `_`, `-`). The description of a command that opens or shows something
  in the pane (`/tether-fleet`, `/tether-watch`) ends with `(PANE)`; `/tether-guards` only prints text.

## 1.0.0-alpha.17

- Added: `checkpoint.injectHandoff` (default off; a plugin option, 44 in all). At each session start the handoff
  file's text is added to the session as context, as the 0.x plugin did, through the `classic.SessionStart` hook's
  `additionalContext` (the `session.start` event returns no context). Cut at 400 lines.

## 1.0.0-alpha.16

- Added: the fleet flag `BIG-WAIT`. With `fleet.bigWaitTokens` set (default 0, off) a live agent whose context has
  reached it and whose annotation note matches the new `fleet.bigWaitNote` (regular expression, case-insensitive,
  default any note) is flagged in the pane, in `/fleet text` and in the status line count. Both settings are
  plugin options (43 in all). `usageWarnPercent` is documented as needing `showSession`.

## 1.0.0-alpha.15

- Added: a `prs` poller reads the `rerun` list of the project health command's JSON. Every entry is told as an
  information line that never blocks Stop; an entry with status `would-rerun` or `reran` owns that PR's
  `checks-failed` problem (for the poller's new `rerunHours`, default 3), so it is not told as unowned. The
  entry's fields are in the README. A project with no `rerun` key is unaffected.

## 1.0.0-alpha.14

- Fixed: the agent guard forgot every agent that had stepped before Tether loaded (a plugin reload, a restart, a
  `/clear`), because it only knew requests it had seen. It now reads the agent's last request from Claude Code's
  transcript, as the fleet pane does, so a stopped big agent is still told and still blocks Stop.

## 1.0.0-alpha.13

- Fixed: a `prs` poller's health command that exits 1 (as Coney's `pr-health` does whenever a PR is stuck) was
  treated as a failed run, so the PR guard saw nothing exactly when it should. The poller has `okExitCodes`
  (default `[0, 1]`); any other exit code is still an error.

## 1.0.0-alpha.12

- **Every scalar setting is a plugin option** (`/plugin configure tether@tether`, 41 in all): the checkpoint's
  threshold, quiet time, check interval, handoff file, size limit and repair attempts; the fleet's cache lifetime,
  big and retire context sizes, cold-cache guard and its override token, session display, warning thresholds,
  refresh, emoji, column tint, watch state file and pane size; watch's wake gap, typing deferral, countdown, box
  rows, wake line, store name, state file and pane size; housekeeping, conversation logs and the Stop guard.
  An option is a default for its section and the project file wins field by field; empty text and 0 mean "not
  set". Structured settings (pollers, annotate, colours, handoff headings, extra exclude lines) stay in the file.
- Fixed: with no config file, watch ignored its plugin options.
- One table (`src/options/options.ts`) now feeds the manifest and the README's options table
  (`node scripts/sync-options.mjs`; CI runs it with `--check`), and a test holds each option's default to the
  section's own default.

## 1.0.0-alpha.11

- Fix: `pr_owner` and `agent_decision` returned an object, which Claude Code refuses as a tool result ("does not
  match its output shape"); they now return their text as a string. The record was kept, but the model saw an error.

## 1.0.0-alpha.10

- **PR guard.** A poller of `kind: "prs"` reads the open pull requests (with `gh`, or with a project's own
  health command whose JSON is `{ "stuck": [...] }`) and tells each problem nobody owns: `conflict`,
  `checks-failed`, `ci-stuck`, `auto-merge-off` (opt in), `unpushed` (a worktree ahead of origin, via
  `worktrees`), and whatever causes the health command reports. A problem is keyed PR + cause + head commit.
- **Agent guard.** The agents poller also tells stopped agents with a big context that nobody has decided about
  (retired or done) as their prompt cache runs out. Thresholds come from `fleet`, so there is one source.
- **One store, two tools.** The model records an owner or a waiver with `mcp__tether__pr_owner` and a decision
  with `mcp__tether__agent_decision`; both live in one value in `$.store`. `/guards` prints what is open.
- **Stop hook.** The end of a turn is blocked while a PR problem or a stopped big agent has no owner or decision,
  at most `stop.maxBlocks` (3) times in a row for the same reason, so a model that cannot fix it never loops.
- **Housekeeping.** At session start Tether adds its folder (`.tether/`), the handoff and a project-relative
  config to `.git/info/exclude` (no tracked file is edited), and makes `HANDOFF.md` from the template when it is
  missing. A Write of the handoff that breaks its template (headings, size) is refused; an Edit that leaves it
  broken is told to the model. Section `housekeeping`: `enabled`, `folder`, `exclude`, `createHandoff`,
  `enforceHandoff`.
- **Conversation logs.** Each session is rendered to `.tether/conversations/<date>-<time>-<id>.md` after every
  turn (at most every `conversations.minSeconds`), before a checkpoint clear and when the session ends. The log
  is never loaded into a session.
- `scripts/check-version.sh` and a CI workflow check that `plugin.json` and the changelog agree, then validate
  and test the plugin.

## 1.0.0-alpha.9

- The pane shows one checkpoint line above the agent table: what the checkpoint waits for and a countdown to its
  next action.

## 1.0.0-alpha.8

- Every message the model writes in reply to a cycle prompt is ignored until the person writes again.

## 1.0.0-alpha.7

- The checkpoint recognises its own prompts inside the transcript's plugin frame.

## 1.0.0-alpha.6

- New information is every message of the person's or the main agent's, except the cycle's own prompts and
  their replies.

## 1.0.0-alpha.5

- The checkpoint waits 5 quiet seconds (checked every 2 s) and requeues only on the person's new messages.

## 1.0.0-alpha.4

- The main settings are plugin options: `/plugin configure tether@tether` sets checkpoint on or off, the checkpoint
  threshold and quiet time, and the fleet and watch switches.
- Precedence: the project file (`.claude/tether.json`) overrides the plugin options, which override the defaults.

## 1.0.0-alpha.3

- **Checkpoint cycle** (off by default: `"checkpoint": { "enabled": true }`). When the main session's context
  reaches `contextTokens` and it has been quiet for `quietSeconds` (no turn, no draft), it asks for the handoff
  file, checks it against the template (the required headings and `maxChars`), repairs it up to `maxRepairs`
  times, updates it if messages arrived meanwhile, then runs `/clear` and continues from the handoff. It never
  clears over a handoff that fails its check, and a clear that does not happen is reported.
- The continue prompt is kept in `$.store` until the new session starts, so a reload cannot lose it.

## 1.0.0-alpha.2

- A services row opens the pane: `✅ Fleet` green when on, `❌ Watch` dimmed when off.
- `enabled` in the `fleet` and `watch` sections (default `true`): off stops that part entirely.

## 1.0.0-alpha.1

A rewrite of Tether as a Claude Code mod, replacing the 0.x hooks-and-skills plugin (the last 0.x release,
0.1.7, stays in the repository history).

- One plugin, one hooks module, one config file (`.claude/tether.json`, or the `configPath` option), one
  section per part.
- **fleet**: an agents pane and status line (state, context, idle time, prompt-cache minutes left, flags
  that say their cost), column tints, and a guard that refuses `SendMessage` to a big agent whose prompt
  cache has expired, for the main agent and for subagents alike.
- **watch**: pollers inside the session that wake the model only for findings it has not been told, with a
  countdown per poller and a box of findings under the agents table.
- The status line is shared: each part's text, joined.

Not yet: the checkpoint cycle (idle-gated checkpoint, `/clear`, continue), conversation logs, the
`HANDOFF.md` structure checks, and a single store for PR and agent decisions.
