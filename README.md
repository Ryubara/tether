# Tether

Tether holds a project together across Claude Code sessions. It is a *mod*: a Claude Code plugin whose hooks
run inside Claude Code (version 2.1.287 or later). See the
[mods overview](https://code.claude.com/docs/en/plugins/mods/overview).

> **Status: 1.0.0-alpha.** Everything below works and is tested; the checkpoint cycle is off by default. See the
> [changelog](CHANGELOG.md).

## What it does today

- **Fleet.** An agents pane and a status line: each subagent's state, context size, idle time and
  prompt-cache minutes left, with flags that say what waking it would cost. The `SendMessage` guard refuses
  to wake an agent that has a recorded decision, and a big agent whose prompt cache has expired (waking it
  re-writes the whole context into the cache), for the main agent and for subagents (see the agent guard rule). `/tether-fleet` opens the pane; `/tether-fleet text` prints it.
  **BIG-WAIT**: with `fleet.bigWaitTokens` set (0, the default, is off), a live agent whose context has reached
  it and whose annotation note (`fleet.annotate`) matches `fleet.bigWaitNote` (a regular expression, matched
  case-insensitively; empty: any note, but an agent with no note never matches) shows `BIG-WAIT` in the FLAGS
  column, in `/tether-fleet text` and as a count in the status line: it holds a big context while only waiting, so retire
  it and start a small successor from its status notes. `fleet.usageWarnPercent` (the `!` after a rate limit) is
  only shown with `fleet.showSession`, because only then does fleet read the rate limits.
- **Watch.** Pollers that run inside the session: each finding is told once, and a model turn starts only for
  new findings, never during a turn or while you type. `/tether-watch` only reports (it never stops polling);
  `/tether-watch pane` shows a box per poller with its countdown and its findings; `/tether-watch run`, `forget` and
  `reload` poll now, tell findings again and re-read the config.
- **Commands.** `/tether-fleet` (pane; `text` prints it), `/tether-watch` (pane; `run`, `forget`, `reload`) and
  `/tether-guards` (text). Pane commands say `(PANE)` in the command list. The names are prefixed with `tether-`
  because the plugin API takes only letters, digits, `_` and `-` in a command name (no `:`).
- **Services row.** The pane starts with one line naming each service: `✅ Fleet` in green when it is on,
  `❌ Watch` dimmed when it is off. A service is off when its section sets `"enabled": false`; it then runs
  nothing (no polls, no refresh, no guard, no status text).

- **Checkpoint.** Off by default. Turn it on with `"checkpoint": { "enabled": true }`. When the session's
  context reaches `contextTokens` (default 200000) and has been quiet for `quietSeconds` (default 90), it asks
  the model to write the handoff file (`HANDOFF.md` by default), checks it (the headings in `sections` and the
  `maxChars` limit), repairs it up to `maxRepairs` times, then runs `/clear` and continues from it. It never
  clears over a handoff that fails its check. Nothing is cleared while you are typing or a turn is running.
  With `"injectHandoff": true` (off by default), every session start (new, resumed, cleared or compacted) adds the
  handoff's text to the session as context, under a header line, cut at 400 lines with a note to trim it; a missing
  or empty handoff adds nothing. It works through the `SessionStart` hook's `additionalContext`, the one place
  the plugin API lets a plugin add context at the start (`session.start` itself returns only the folder).

- **PR guard.** A `prs` poller tells each problem with an open pull request that nobody owns: a conflict, failed
  checks, CI that seems stuck, auto-merge off (opt in), or work in a worktree that was never pushed. By default it
  reads GitHub with `gh`; `command` swaps in the project's own health command (its JSON is `{ "stuck": [...], "rerun": [...] }`). The command
  may exit 1 to say "something is stuck": `okExitCodes` (default `[0, 1]`) lists the exit codes whose output is read;
  any other code (or output that is not JSON) is an error shown in `/tether-watch`, never a quiet pass.
  The optional `rerun` list says what the command did about failed checks. Each entry is told as an information
  line (never an owner, never blocks Stop) and has these fields; unknown fields are ignored and a project with no
  `rerun` key is unaffected:
  `number` (the PR), `branch`, `run` (the workflow run), `checks` (the failed checks, sorted), `reasons` (why each
  check was chosen, in the order of `checks`), `status` and `detail` (why a rerun was refused or capped, empty
  otherwise). With status `would-rerun` or `reran` the rerun owns that PR's `checks-failed` problem, as long as
  every failing check is among `checks` and the head commit is unchanged, for the poller's `rerunHours` (default
  3); with `refused`, `capped` or `new-event` the rerun cannot fix it, so the problem stays unowned and the
  line's `detail` says why.
  The model records an owner (`assign`, a few hours) or a known wait (`waive`, optionally for one cause) with the
  `mcp__tether__pr_owner` tool; an expired owner raises the problem again.
- **Agent guard.** A stopped subagent holding a big context (`fleet.bigContextTokens`, default 60k) loses its prompt
  cache `fleet.cacheTtlMinutes` (default 60) after its last request, and one with live background work (a
  `run_in_background` poller, a build wait) wakes itself when that work reports, re-writing the whole context
  if the cache has gone. So Tether acts by itself, `cacheGuard.leadMinutes` (default 20; never more than half the
  cache lifetime) before the cache expires, once a minute, whatever the model is doing:
  - **Keep warm.** A stopped agent with background work, a context under `cacheGuard.handoverTokens` (default
    250k) and **running on the session's own model** is sent a short message ("keep waiting, no action needed",
    through `$.session.send`). The agent's reply is a cache read, which re-arms the expiry. The agent is recorded as
    `kept-warm`; the guard is quiet for one more window, counted from the later of the agent's last activity and
    the ping, and pings again then, up to `cacheGuard.keepWarmMax` (12) times in a row before it asks the model to
    decide. Real work between two pings (the context grew by 10k or more) starts a new run of pings.
  - **A ping must not switch the agent's model.** A message wakes a subagent on the *session's* model unless its
    Agent call pinned one. Measured on 2.1.296 transcripts (`~/.claude/projects/<project>/<session>/subagents/`):
    every wake of an agent whose `.meta.json` names a `model` (55 of 55, sonnet and haiku) kept that model, and
    every wake of an agent without one that had run on sonnet or haiku (12 of 12, by a message or a task
    notification) ran on the session's opus; the cache is per model, so such a ping would write a whole new cache
    at the session model's rates and leave the agent on the dearer model. `$.session.send` takes only `to` and
    `text`: it cannot name a model. So Tether pings only an agent whose `.meta.json` pins a model or whose last
    request (`turn.step`, else its transcript when under 4 MB) was on the session's model (`$.session.model()`,
    compared as `claude-opus-5-5` = `claude-opus-5-5[1m]`; a bare alias such as `opus` matches only itself, because it
    could be an older opus, so it never proves a full id is the same model; `"model": "inherit"` in the meta file is
    not a pin). An agent on another model, or whose model Tether cannot
    tell, is handed over instead, whatever its size; that one wake writes one cache on the session's model, once.
  - **Hand over.** A stopped agent with background work and at least `handoverTokens` is sent the handover request
    (commit, update `STATUS.md`, list the running background jobs and their result files, say the next exact
    command, then stop). That message is a cache read on the agent's own model, so it is cheap. Only after the
    agent has stopped (a turn ended with a request after the message) does Tether look at the agent once more
    (a task that finished meanwhile may have woken it) and stop the background tasks it left behind
    (`TaskStop`). It records the agent `retired` on a later tick, once it has settled: not running and not
    `waiting`. A retired agent is never woken (`SendMessage` to it is refused unless the message starts with the
    override token, `fleet.overrideToken`). A detached build (started with `nohup`/`start`, not tracked by Claude
    Code) keeps running, so the successor reads its result files. Nothing is ever stopped silently, and nothing is
    retired while the agent can still wake itself: the toast, the log and a wake prompt tell the model, and the
    Stop hook blocks, for an agent that has not finished within `cacheGuard.handoverWaitMinutes` (10; at most
    half the lead, so the alert comes before the cache expires), for tasks that `TaskStop` would not stop or did
    not answer within 30 s, and for an agent that is still `waiting` after its known tasks were stopped (a Monitor
    or a background Agent that Tether cannot identify). Each kind of alert is told once per cycle; a new silence of
    the agent is told again. The messages go out first and together, and every send and every `TaskStop` has a 30 s
    timeout, so one blocked permission dialog cannot stall the pings due for other agents.
  - **The guard trusts `fleet.cacheTtlMinutes`** (default 60, the one-hour cache the sessions use). It acts at that
    value less the lead. If the real cache lifetime is shorter (the 5-minute default cache, when the one-hour cache
    is not enabled for subagents), the cache dies long before the guard acts and nothing it does helps: set
    `fleet.cacheTtlMinutes` to the real lifetime (at most that, with the margin you want) and `leadMinutes`
    accordingly. A longer value than the real one is the dangerous direction.
  - **No ping on an expired cache** (it would be the re-write), and no action for a stopped agent without
    background work (it cannot wake itself): those are left to the model, below.
  Every action is a toast, a log line (`agent guard: ...`), a line in `/tether-guards` and a `guard ...` flag in the
  fleet pane. `cacheGuard.auto` off turns the actions off and leaves only the following.

  **The fallback, which also covers a failed send.** An agent the guard could not deal with (auto off, the message
  not delivered, a late handover) stays a finding and the Stop hook blocks until the model deals with it by one of
  two ways: (a) send the agent a short message and record `kept-warm`, or (b) hand it over, `TaskStop` its
  background tasks and record `retired` (or `done` when its work is finished), all with
  `mcp__tether__agent_decision`. `retired` and `done` are refused while the agent runs or has live background tasks
  ("TaskStop it first"): it would wake itself. `kept-warm` quiets the warning for one window and does not stop the
  agent being woken. An undecided big agent is refused a `SendMessage` only once idle for `fleet.cacheTtlMinutes`.

  **What the plugin API allows** (Claude Code 2.1.296): `$.session.send({ to: { agentId }, text })` messages a stopped
  or waiting subagent (a finished one is resumed from its transcript) and `$.tool.call({ tool: 'TaskStop', task_id })`
  stops a task, through the permission check, so a project that has not allowed TaskStop may see a prompt. There is no
  call that lists an agent's background tasks. `$.agent.list()` says `waiting` for an agent held on background work;
  the task ids come from the rows appended to its conversation (`session.append`: "running in background with ID"
  and the `<task-notification>` that ends a task) and, for a transcript under 4 MB (the most `$.fs.read` returns),
  from its transcript file; tasks seen in a small transcript are kept as the baseline when it later grows past
  4 MB. Only the harness's own structure counts (a user row's `toolUseResult.backgroundTaskId` or tool result that
  starts with the answer, and a notification block with a final status in a `queued_command` attachment or a
  `task-notification` row), never text an agent printed or read. Only a background Bash is recognised; a monitor or a
  background agent started by a subagent keeps the agent `waiting` but has no id for Tether to stop, which is why
  such an agent is not retired. Tether stops tasks, never the agent
  itself (a `TaskStop` of an agent's id is possible, but it would be abrupt and lose its handover).
- **Stop hook.** The end of a turn is blocked while a PR problem or an agent the guard has not dealt with is open,
  at most `stop.maxBlocks` times in a row for the same reason. `/tether-guards` prints what is open and what the
  agent guard did.
- **Housekeeping.** Tether's folder, the handoff and a project-relative config go into `.git/info/exclude` (no
  tracked file is touched); a missing `HANDOFF.md` is made from the template; a Write of it that breaks the
  template is refused.
- **Conversation logs.** Each session is rendered to `.tether/conversations/` as Markdown, after every turn,
  before a checkpoint clear and when the session ends. Logs are for you to look back at; they are never loaded
  into a session.

## Install

```
/plugin marketplace add Ryubara/tether
/plugin install tether@tether
```

Then set the config with `/plugin configure tether@tether` (the `configPath` option), or put the file at
`.claude/tether.json` in your project. [`examples/tether.json`](examples/tether.json) shows the sections.

## Config

Every scalar setting is a plugin option: `/plugin configure tether@tether` lists them all. An option is a
default for its section; the project file (`.claude/tether.json`, or the `configPath` option's file) wins field by
field (except a `pane`, which a file replaces whole). Empty text and `0` mean "not set" (the section's own default
applies), except `watchTickSeconds`, where 0 turns the live countdown off. What has no option because it is
structured stays in the file only: `watch.pollers`, `fleet.annotate`, `fleet.colors`, `checkpoint.sections` and
`housekeeping.exclude`.

<!-- options:begin (generated by scripts/sync-options.mjs from src/options/options.ts) -->

| Option | Default | What it does |
| --- | --- | --- |
| `configPath` | (empty) | Path of Tether's JSON config. Empty: .claude/tether.json in the session's folder. |
| `checkpointEnabled` | `false` | Ask for a handoff, check it, clear and continue when the session is long and quiet. |
| `checkpointContextTokens` | `200000` | The main session context at which a checkpoint is due. |
| `checkpointQuietSeconds` | `5` | Seconds with no typing and no new message of yours before the checkpoint acts. A new message of yours re-queues it. |
| `checkpointTickSeconds` | `2` | Seconds between checks of the session's state. |
| `checkpointHandoffFile` | `HANDOFF.md` | The handoff file, relative to the session folder. |
| `checkpointMaxChars` | `9500` | The handoff is injected into the next session, so it must stay under this size. |
| `checkpointInjectHandoff` | `false` | When a session starts (new, resumed, cleared or compacted) and the handoff file exists, add its text to the session as context. |
| `checkpointMaxRepairs` | `3` | Repair attempts before the cycle gives up and the session carries on. |
| `fleetEnabled` | `true` | The agents pane, the status line and the SendMessage guard. |
| `fleetCacheTtlMinutes` | `60` | How long the prompt cache is taken to live after an agent's last request (5, or 60 with subagentPromptCacheTtl 1h). It is also the idle time from which waking an undecided big agent is refused, so a lower value adds a safety margin before the real expiry. |
| `fleetBigContextTokens` | `60000` | Context size from which an agent is guarded: the agent guard acts on it before its cache expires, and a wake-up is refused once its cache has expired. |
| `fleetRetireContextTokens` | `300000` | Context size at which an agent is flagged for retirement. |
| `fleetBigWaitTokens` | `0` | An agent with at least this context and a matching note (see the note pattern) is flagged BIG-WAIT. 0: off. |
| `fleetBigWaitNote` | (empty) | A regular expression matched case-insensitively against the agent's annotation note. Empty: any note. |
| `fleetColdGuard` | `true` | Refuse SendMessage to an agent with a recorded decision, and to an undecided big agent whose cache has expired, unless the message starts with the override token. |
| `fleetOverrideToken` | `[cache-ok]` | The text a message starts with to pass the cold-cache guard on purpose. |
| `fleetShowSession` | `false` | Also show the main session context and the tightest rate limit in the status line. |
| `fleetUsageWarnPercent` | `90` | A rate limit at or above this percent gets a !. Only shown with Show session context. |
| `fleetRefreshSeconds` | `15` | Seconds between refreshes of the agent list, usage and annotations. |
| `fleetCacheWarnMinutes` | `15` | Cache minutes left at or under which the cache cell turns to the warning colour. |
| `fleetEmoji` | `true` | An emoji per state and flag in the pane and /tether-fleet text; off for plain text. |
| `fleetColumnTint` | (empty) | true bands alternate columns with the theme colour, false divides columns with a bar, or give a colour. Empty: true. |
| `fleetWatchState` | (empty) | A state file watch writes; when set the pane draws watch boxes under the table. Empty: none. |
| `fleetPaneRows` | `0` | Rows asked for the pane when inline above the prompt. 0: Claude Code decides. |
| `fleetPaneColumns` | `0` | Columns asked for the pane when docked beside a fullscreen transcript. 0: Claude Code decides. |
| `watchEnabled` | `true` | The pollers and the findings they wake the model for. |
| `watchMinWakeGapSeconds` | `60` | At least this long between two wakes; findings in between join the next one. |
| `watchDeferWhileTypingMinutes` | `10` | While you have a draft, a wake waits up to this long, then goes anyway. |
| `watchTickSeconds` | `1` | Seconds between redraws of the countdowns; 0 turns the live countdown off. |
| `watchBoxRows` | `6` | Log lines each poller box shows. |
| `watchWakePreamble` | `watch found something new. Handle it or say why it can wait:` | The first line of the wake prompt. |
| `watchStoreName` | `default` | Names this project seen-set in the store, so two projects keep their own. |
| `watchStateFile` | (empty) | A file watch writes the boxes data to, for fleet to draw. Empty: none. |
| `watchPaneRows` | `0` | Rows asked for the pane when inline above the prompt. 0: Claude Code decides. |
| `watchPaneColumns` | `0` | Columns asked for the pane when docked beside a fullscreen transcript. 0: Claude Code decides. |
| `housekeepingEnabled` | `true` | Tether folder, exclude lines, handoff template and handoff checks. |
| `housekeepingFolder` | `.tether` | Tether folder in the project (conversation logs live in its conversations folder). |
| `housekeepingCreateHandoff` | `true` | Create the handoff from the template when it is missing. |
| `housekeepingEnforceHandoff` | `true` | Refuse a Write of the handoff that fails its check; report an Edit that leaves it failing. |
| `conversationsEnabled` | `true` | Write each session to a log under the Tether folder. |
| `conversationsMinSeconds` | `30` | Seconds between log writes while turns complete; a log is always written before a clear. |
| `cacheGuardAuto` | `true` | Before a stopped agent with live background work loses its prompt cache, Tether messages it (keep waiting, or hand over) and stops the leftover background tasks after a handover. Off: it only blocks the end of a turn and asks the model. |
| `cacheGuardLeadMinutes` | `20` | Act this many minutes before the cache expires (at most half the cache lifetime). |
| `cacheGuardHandoverTokens` | `250000` | A stopped agent with live background work and at least this context is asked to hand over and is then stopped; a smaller one is kept warm, if it runs on the session model (else it is handed over too). |
| `cacheGuardHandoverWaitMinutes` | `10` | Minutes an agent gets to finish its handover (at most half the lead); later the coordinator is alerted. The agent is never stopped silently. |
| `cacheGuardKeepWarmMax` | `12` | Keep-warm messages to one agent in a row (real work between two starts a new run) before the coordinator is asked to decide. |
| `cacheGuardKeepWarmText` | `Tether cache guard: keep waiting, no action needed. Reply with one word, then wait as before.` | The message that keeps a waiting agent warm. |
| `cacheGuardHandoverText` | `Tether cache guard: hand over now. Commit your work, update STATUS.md (tip, done, left, running background jobs and their logs or result files, the next exact command), then stop. Do not start new work.` | The message that asks an agent to hand over and stop. |
| `stopEnabled` | `true` | Block the end of a turn while PR problems or stopped agents nobody has dealt with are known. |
| `stopMaxBlocks` | `3` | The same block this many times in a row, then let the turn end. |

<!-- options:end -->

One JSON file, one section per part (`fleet`, `watch`). Every key is optional; the defaults are in
`src/fleet/config.ts` and `src/watch/config.ts`. Colours, column tints and emoji are fleet keys
(`colors`, `columnTint`, `emoji`). `enabled` (default `true`) turns a whole section off.

## Develop

```
claude plugin validate .
claude plugin test .
```

The plugin names one hooks module, and the engine follows `$` only within the file it is passed in, so every
part that touches `$` lives in `hooks/register.tsx`; the pure logic is in `src/` and tested in `tests/`.

## Licence

MIT.
