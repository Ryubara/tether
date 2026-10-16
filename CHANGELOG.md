# Changelog

## 1.0.0-alpha.24

- Fixed: after a `/clear` the checkpoint no longer asks for the handoff at once. Any clear, the checkpoint's or the
  person's, starts the cycle over and forgets the old session's context size, which survived the clear and made
  the new session look due before its first request.
- Fixed: the checkpoint's own clear waits up to 30 seconds for the new session to start before it counts the clear
  as not done, so a new session that starts after the command returns still gets `Continue from <handoff>.`
- Added: `checkpoint.retryMinutes` (option `checkpointRetryMinutes`, default 15). After a give-up, or a clear that
  did not happen, the checkpoint waits this long before asking for the handoff again instead of asking at once.

## 1.0.0-alpha.23

- Added: `fleet.openOnStart` and `watch.openOnStart` (options `fleetOpenOnStart` and `watchOpenOnStart`, both off by
  default) open the Fleet and Watch panes when a session starts (new, resumed or cleared), with the same title and
  `pane` size as the commands, beside the panes already open. They do not take the focus and do not hold the start
  up; where no pane can be placed (a headless session) nothing opens. Nothing opens while that part is off or the
  config has failed closed.

## 1.0.0-alpha.22

- Added: the `TETHER_CONFIG` environment variable names the config file (an absolute path) and wins over the
  `configPath` option and `.claude/tether.json`. The file is picked once per load of the plugin.
- Added: failing closed. A file named by `TETHER_CONFIG`, or one that says `"locked": true`, that is missing,
  unreadable, not JSON or not valid (an unknown top-level key, a section that is not an object, a field of the wrong
  type, a bad poller, a relative `TETHER_CONFIG`) turns every part off: no pollers, no guard acting, no Stop block,
  no checkpoint, no handoff added, no housekeeping, no logs or store writes. Tether says so once, with a fixed text, in
  the status line and a toast, and every command answers with it. It never falls back to the options or the
  project file. A top-level policy key with the wrong type fails closed in any file.
- Added: `"locked": true`. The file's values are final: the plugin options are not read (defaults, then the file),
  no other file is read, and `/tether-watch reload` reads only the same file again. Every option can be set from
  the file.
- Added: `"network": false`. No `prs` poller (so no PR health command), and a command poller or `fleet.annotate`
  whose program is `gh`, `curl`, `wget`, `ssh`, `scp`, or `git` with a network subcommand is refused, told by the
  code `refused:network`, never by the command.
- Added: `allowedCommands`, a list of argv prefixes; when set, only commands that start with one run (Tether's own
  `git` and `gh` calls included), told by `refused:not-allowed` otherwise.
- Added: `"plainOutput": true`. Every text Tether submits, returns, shows or writes is a fixed template filled with
  ids, numbers and codes only: agents by id, PR problems by number and cause code, failures by code; no descriptions,
  branch or check names, details, stderr, stdout, error texts or notes. Command pollers then read only
  `{ "key", "code" }` JSON lines with a code from their new `codes` list, and count the rest as dropped.
  `/tether-fleet text` and the handoff added at session start are off under it. A table-driven test plants
  synthetic text in every input and checks that none of it reaches any sink.
- Changed: `/tether-watch reload` re-reads the config for every part (fleet, checkpoint, guards, housekeeping),
  not only watch.

## 1.0.0-alpha.21

- Changed: the subagent max context is one setting. The option `fleetRetireContextTokens` (config key
  `fleet.retireContextTokens`, default 300000; the name is unchanged, so existing configs keep working) is now titled
  "Subagent max context (tokens)". The pane flags an agent at this size, and an `agents` poller of watch, which wakes
  you with "context NNNk, past ...", now wakes at it too: its `contextTokens` falls back to the effective fleet value
  (the option or the file) instead of a fixed 300000. A poller that sets its own `contextTokens` keeps it. Before, changing
  the option still left the wake at 300k.

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
- Added: the guard never pings an agent that a message would switch to another model. A message wakes a subagent on
  the session's model unless its Agent call pinned one (measured on 2.1.296 transcripts: 55 of 55 wakes of agents
  with a `model` in their `.meta.json` kept it; 12 of 12 wakes of unpinned sonnet or haiku agents ran on opus), the
  cache is per model, and `$.session.send` cannot name a model; so a ping would write a new cache at the session
  model's rates and leave the agent there. Tether pings only an agent whose `.meta.json` pins a model or whose last
  request was on the session's model (`$.session.model()`); any other, or one whose model is unknown, gets the
  handover. The Stop hook's reason says the same for a manual ping.
- Changed: a model is compared by its normalised name (no `claude-` prefix, date or `[1m]`); a bare family alias such
  as `opus` matches only itself, never a full id, so an agent on an older opus is handed over, not pinged. A
  `.meta.json` that says `"model": "inherit"` does not pin the agent.
- Fixed: the wake the `killed` notification causes after the stops is not a late handover (no `handover-late` alert
  once the tasks were stopped); the `prs` poller writes the guard store under the same lock as the other writers; a
  store call that never answers times out after 30 s instead of blocking every later writer; a stuck tick is taken
  over by the engine clock, and the stuck tick finishing late no longer clears the flag of the tick that replaced it.
- Added: a handed-over agent is retired only when it is quiet. After the leftover tasks are stopped Tether waits for
  the agent to settle; one that is still `waiting` (a Monitor or a background Agent Tether cannot identify) is
  alerted and not recorded `retired`. Before the stops it looks at the agent's status once more.
- Added: every `session.send` and `TaskStop` has a 30 s timeout, the messages (keep-warm, handover) go out first and
  together before any alert or stop, and a tick stuck for 5 minutes no longer blocks the next one, so one blocked
  permission dialog cannot stall the pings due for other agents. The guard store is written under a lock.
- Changed: background tasks are read from the harness's own structure (`toolUseResult.backgroundTaskId`, a tool
  result that starts with the start answer, a notification block with a final status in a `queued_command` attachment
  or a `task-notification` row), never from text an agent printed, read or wrote; a notification block with no status
  no longer swallows the next one. Tasks seen in a small transcript are kept when it grows past the 4 MB read limit,
  and tasks Tether stopped are not counted again.
- Changed: alerts are keyed by kind and cycle (handover late, cache expired, too many pings, still waiting) instead of
  one permanent "alerted" flag, so a later problem of the same agent is told too. A ping or a `kept-warm` decision
  ends a handover cycle (its `handoverAt` and leftovers are cleared); the ping limit counts pings in a row, and real
  work between two (the context grew by 10k) starts a new run. The handover wait is cut to half the lead.
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
