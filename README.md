# Tether

Tether holds a project together across Claude Code sessions. It is a *mod*: a Claude Code plugin whose hooks
run inside Claude Code (version 2.1.287 or later). See the
[mods overview](https://code.claude.com/docs/en/plugins/mods/overview).

> **Status: 1.0.0-alpha.** Everything below works and is tested; the checkpoint cycle is off by default. See the
> [changelog](CHANGELOG.md).

## What it does today

- **One pane.** Tether draws one pane, titled Tether: Fleet's table on top and Watch's poller boxes beneath it, each
  section left out while its part is off. `/tether-fleet` and `/tether-watch pane` open and focus it, `/tether-watch`
  opens it beside its report, and `fleet.openOnStart` or `watch.openOnStart` (either, while its part is on) opens it
  once at every session start and after a clear. One pane, one size: `fleet.pane`, with `watch.pane` filling a
  dimension `fleet.pane` leaves unset.
- **Fleet.** An agents table and a status line: each subagent's state, context size, idle time and
  prompt-cache minutes left, with flags that say what waking it would cost. The `SendMessage` guard refuses
  to wake an agent that has a recorded decision, and a big agent whose prompt cache has expired (waking it
  re-writes the whole context into the cache), for the main agent and for subagents (see the agent guard rule). `/tether-fleet` opens the Tether pane; `/tether-fleet text` prints the table. The main session's context is the one
  its last request read; before a resumed session's first request it is the engine's own figure (the one the status
  line shows), so the checkpoint is due at once in a long resumed session.
  **BIG-WAIT**: with `fleet.bigWaitTokens` set (0, the default, is off), a live agent whose context has reached
  it and whose annotation note (`fleet.annotate`) matches `fleet.bigWaitNote` (a regular expression, matched
  case-insensitively; empty: any note, but an agent with no note never matches) shows `BIG-WAIT` in the FLAGS
  column, in `/tether-fleet text` and as a count in the status line: it holds a big context while only waiting, so retire
  it and start a small successor from its status notes. `fleet.retireContextTokens` (option: Subagent max context,
  default 300000) is the one size a subagent should not pass: the pane flags an agent at it (`retire`), and an
  `agents` poller of watch wakes you at it unless that poller sets its own `contextTokens`. `fleet.usageWarnPercent` (the `!` after a rate limit) is
  only shown with `fleet.showSession`, because only then does fleet read the rate limits.
- **Watch.** Pollers that run inside the session: each finding is told once, and a model turn starts only for
  new findings, never during a turn or while you type. `/tether-watch` reports (it never stops polling) and opens
  the Tether pane, whose boxes show each poller's countdown and findings; `/tether-watch run`, `forget` and
  `reload` poll now, tell findings again and re-read the config.
  A wake counts as sent only once a turn starts for it: one the engine refuses (a hook drops it, or a Stop stands
  after you interrupt a turn) is told once in a toast and the status line (`wake refused`) and tried again after
  `watch.resendAfterMinutes` (default 2) or as soon as your next turn starts; one it takes that starts no turn
  while the session sits idle that long is sent again. Until then no second wake stacks behind it; what is found
  meanwhile joins the next one. A finding still reported after it was told is not told again, unless its poller sets
  `remindMinutes` (default 0, off): then it is told again that long after, marked `(still reported)`, then after
  twice as long each time, at most every `remindMaxMinutes` (default 240). `watch.idleWakeMinutes` (default 0, off)
  also wakes the model after that many idle minutes with nothing found, nobody typing and no subagent pending,
  running or waiting, with `watch.idleWakeText` as the prompt (`{minutes}` stands for the minutes).
- **Commands.** `/tether-fleet` (the pane; `text` prints the table), `/tether-watch` (report and pane; `run`, `forget`, `reload`, `pane`),
  `/tether-guards` (text) and `/tether-checkpoint` (a checkpoint now). Pane commands say `(PANE)` in the command list. The names are prefixed with `tether-`
  because the plugin API takes only letters, digits, `_` and `-` in a command name (no `:`).
- **Services row.** The pane starts with one line naming each service: `✅ Fleet` in green when it is on,
  `❌ Watch` dimmed when it is off. A service is off when its section sets `"enabled": false`; it then runs
  nothing (no polls, no refresh, no guard, no status text).

- **Checkpoint.** Off by default. Turn it on with `"checkpoint": { "enabled": true }`. When the session's
  context reaches `contextTokens` (default 200000) and has been quiet for `quietSeconds` (default 90), it asks
  the model to write the handoff file (`HANDOFF.md` by default), checks it (the headings in `sections` and the
  `maxChars` limit), repairs it up to `maxRepairs` times, then runs `/clear` and continues from it. It never
  clears over a handoff that fails its check. Nothing is cleared while you are typing or a turn is running.
  Any clear, its own or yours, starts the cycle over with the old session's context forgotten. After a give-up, or
  a clear that did not happen, it waits `retryMinutes` (default 15) before asking again.
  `/tether-checkpoint` starts the same cycle now, below `contextTokens` and through a back-off: the handoff is
  asked for once the session is quiet, checked and repaired the same way, then cleared and continued from. It
  does nothing while the checkpoint is off or a cycle is already running, and says so.
  The pane's line says what the cycle waits for: the handoff file while it is missing, a repair while it fails, and
  `clearing` only over a handoff that passes.
  With `"injectHandoff": true` (off by default), every session start (new, resumed, cleared or compacted) adds the
  handoff's text to the session as context, under a header line, cut at 400 lines with a note to trim it; a missing
  or empty handoff adds nothing. It works through the `SessionStart` hook's `additionalContext`, the one place
  the plugin API lets a plugin add context at the start (`session.start` itself returns only the folder). A clear
  raises no session start for a plugin, so after one the next prompt (the checkpoint's continue, or yours) carries the
  handoff instead, through `prompt.submit` or the `UserPromptSubmit` hook, once; a session start that adds it first
  leaves the prompt without it.

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
- **Issues.** An `issues` poller tells each open issue on GitHub that carries one of its `labels` (read with `gh
  issue list` in the poller's `cwd`, at most `limit`, default 100, per label; every `everySeconds`, default 120). An
  issue is told once by its number and the label, never its title or body, and again when it changes (its
  `updatedAt`) or comes back after losing the label. For example, to be woken for issues waiting for triage:
  `{ "id": "triage", "kind": "issues", "title": "Issues to triage", "labels": ["needs-triage"] }`.
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
    the agent is told again. A keep-warm or handover message that fails is said once and tried again 5 minutes
    later, not at every tick. The messages go out first and together, and every send and every `TaskStop` has a 30 s
    timeout, so one blocked permission dialog cannot stall the pings due for other agents.
  - **Hand over past the max context.** A busy agent that stops between build waits every few minutes never sits
    idle long enough for the rule above, so it would only grow. With `cacheGuard.sizeHandover` on (the default), a
    stopped agent with background work whose context has passed `fleet.retireContextTokens` (the one subagent max
    context, default 300k, that the pane's `retire` flag and the agents poller also use) is sent the same handover
    request at the first tick after it stops, whatever its idle time, and then goes through the same steps (its
    leftover tasks stopped once it has stopped, retired once quiet, an alert when late). Tether's own keep-warm pings
    do not hold it back; a retired or done record does, and an expired cache is never messaged. If the coordinator
    records the agent `kept-warm` after the request (or once it is past the line), that is its call: Tether does not
    ask again at later stops, though the usual near-expiry rule still applies. An agent on another model is asked
    too, and the toast says the message writes one new cache on the session's model. An agent past the line that
    stopped with no background work has ended its turn and reported, so it is left to the model, as before.
  - **Tasks the agent ends itself.** A background task ends at its `<task-notification>`, or when the agent stops it
    with its own `TaskStop` (the answer "Successfully stopped task: <id>" is the only trace; no notification
    follows). Only TaskStop's own result counts, read from its structured record or, in an appended row, from a row
    whose origin is the TaskStop tool, and its id must match whole: the same JSON printed by Bash ends nothing. A command moved to the background by its timeout, or by the user, starts a task like
    `run_in_background` does.
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

  **Without the tools.** Claude Code serves a mod's registered tools from a loopback port in the session's own
  process. `cacheGuard.registerTools` false (default true) registers neither `pr_owner` nor `agent_decision`, so the
  session opens no such port. What is lost: the model cannot record an owner, a waiver or a decision, so the Stop
  hook never blocks for a PR problem or an undecided agent (it could not be cleared). Everything else stays: the
  guard's own keep-warm and handover actions, its toasts, log lines and flags, the PR findings it tells, and the
  `SendMessage` guard (which then sees no recorded decision).

  **What the plugin API allows** (Claude Code 2.1.296): `$.session.send({ to: { agentId }, text })` messages a stopped
  or waiting subagent (a finished one is resumed from its transcript) and `$.tool.call({ tool: 'TaskStop', task_id })`
  stops a task, through the permission check, so a project that has not allowed TaskStop may see a prompt. There is no
  call that lists an agent's background tasks. `$.agent.list()` says `waiting` for an agent held on background work;
  the task ids come from the rows appended to its conversation (`session.append`: "running in background with ID",
  "moved to the background (ID: ...)" or "manually backgrounded by user with ID", and the `<task-notification>` or
  the agent's own `TaskStop` answer that ends a task) and, for a transcript under 4 MB (the most `$.fs.read` returns),
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
`.claude/tether.json` in your project, or name it with the `TETHER_CONFIG` environment variable (see Config). [`examples/tether.json`](examples/tether.json) shows the sections.

## Config

Every scalar setting is a plugin option: `/plugin configure tether@tether` lists them all. An option is a
default for its section; the project file (`.claude/tether.json`, or the `configPath` option's file) wins field by
field (except a `pane`, which a file replaces whole); a `locked` file ignores the options altogether. Empty text and `0` mean "not set" (the section's own default
applies), except `watchTickSeconds`, where 0 turns the live countdown off. What has no option because it is
structured stays in the file only: `watch.pollers`, `fleet.annotate`, `fleet.colors`, `checkpoint.sections` and
`housekeeping.exclude`.

<!-- options:begin (generated by scripts/sync-options.mjs from src/options/options.ts) -->

| Option | Default | What it does |
| --- | --- | --- |
| `configPath` | (empty) | Path of Tether's JSON config. Empty: .claude/tether.json in the session's folder. The TETHER_CONFIG environment variable wins over it. |
| `checkpointEnabled` | `false` | Ask for a handoff, check it, clear and continue when the session is long and quiet. |
| `checkpointContextTokens` | `200000` | The main session context at which a checkpoint is due. |
| `checkpointQuietSeconds` | `5` | Seconds with no typing and no new message of yours before the checkpoint acts. A new message of yours re-queues it. |
| `checkpointTickSeconds` | `2` | Seconds between checks of the session's state. |
| `checkpointHandoffFile` | `HANDOFF.md` | The handoff file, relative to the session folder. |
| `checkpointMaxChars` | `9500` | The handoff is injected into the next session, so it must stay under this size. |
| `checkpointInjectHandoff` | `false` | When a session starts (new, resumed, cleared or compacted) and the handoff file exists, add its text to the session as context. |
| `checkpointMaxRepairs` | `3` | Repair attempts before the cycle gives up and the session carries on. |
| `checkpointRetryMinutes` | `15` | After a give-up or a clear that did not happen, minutes before the checkpoint asks for a handoff again. |
| `fleetEnabled` | `true` | The agents pane, the status line and the SendMessage guard. |
| `fleetCacheTtlMinutes` | `60` | How long the prompt cache is taken to live after an agent's last request (5, or 60 with subagentPromptCacheTtl 1h). It is also the idle time from which waking an undecided big agent is refused, so a lower value adds a safety margin before the real expiry. |
| `fleetBigContextTokens` | `60000` | Context size from which an agent is guarded: the agent guard acts on it before its cache expires, and a wake-up is refused once its cache has expired. |
| `fleetRetireContextTokens` | `300000` | The context size a subagent should not pass. The pane flags an agent at this size, and the watch agents poller wakes you at this size unless that poller sets its own contextTokens. |
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
| `fleetWatchState` | (empty) | A state file the watch of another session writes; when set and this session runs no poller of its own, the Tether pane draws its boxes under the table. Empty: none. |
| `fleetOpenOnStart` | `false` | Open the Tether pane (the Fleet table, the Watch boxes under it), without taking focus, when a session starts or is cleared, while fleet is on. |
| `fleetPaneRows` | `0` | Rows asked for the Tether pane when inline above the prompt. 0: Claude Code decides. |
| `fleetPaneColumns` | `0` | Columns asked for the Tether pane when docked beside a fullscreen transcript. 0: Claude Code decides. |
| `watchEnabled` | `true` | The pollers and the findings they wake the model for. |
| `watchMinWakeGapSeconds` | `60` | At least this long between two wakes; findings in between join the next one. |
| `watchDeferWhileTypingMinutes` | `10` | While you have a draft, a wake waits up to this long, then goes anyway. |
| `watchTickSeconds` | `1` | Seconds between redraws of the countdowns; 0 turns the live countdown off. |
| `watchBoxRows` | `6` | Log lines each poller box shows. |
| `watchWakePreamble` | `watch found something new. Handle it or say why it can wait:` | The first line of the wake prompt. |
| `watchStoreName` | `default` | Names this project seen-set in the store, so two projects keep their own. |
| `watchStateFile` | (empty) | A file watch writes the boxes data to, for fleet to draw. Empty: none. |
| `watchOpenOnStart` | `false` | Open the Tether pane, without taking focus, when a session starts or is cleared, while watch is on. Either option opens it once. |
| `watchIdleWakeMinutes` | `0` | Wake the model after this many idle minutes with no subagent at work, though no poller found anything. 0: never. |
| `watchIdleWakeText` | `Nothing new: woken after {minutes} idle minutes with no subagent at work. Take up the next piece of work, or say why there is none.` | The prompt of the idle wake; {minutes} stands for the idle minutes. |
| `watchResendAfterMinutes` | `2` | A wake that started no turn while the session sat idle this long is sent again; a refused wake is tried again after this long or after the next turn starts. |
| `watchPaneRows` | `0` | Rows for the Tether pane when fleet.pane sets none (kept for configs written for a separate Watch pane). 0: not set. |
| `watchPaneColumns` | `0` | Columns for the Tether pane when fleet.pane sets none (kept for configs written for a separate Watch pane). 0: not set. |
| `housekeepingEnabled` | `true` | Tether folder, exclude lines, handoff template and handoff checks. |
| `housekeepingFolder` | `.tether` | Tether folder in the project (conversation logs live in its conversations folder). |
| `housekeepingCreateHandoff` | `true` | Create the handoff from the template when it is missing. |
| `housekeepingEnforceHandoff` | `true` | Refuse a Write of the handoff that fails its check; report an Edit that leaves it failing. |
| `conversationsEnabled` | `true` | Write each session to a log under the Tether folder. |
| `conversationsMinSeconds` | `30` | Seconds between log writes while turns complete; a log is always written before a clear. |
| `cacheGuardAuto` | `true` | Before a stopped agent with live background work loses its prompt cache, Tether messages it (keep waiting, or hand over) and stops the leftover background tasks after a handover. Off: it only blocks the end of a turn and asks the model. |
| `cacheGuardRegisterTools` | `true` | Register pr_owner and agent_decision, the tools the model records owners and decisions with (Claude Code serves them from a loopback port in the session). Off: no tool, and the end of a turn is never blocked for a record only they could make. |
| `cacheGuardLeadMinutes` | `20` | Act this many minutes before the cache expires (at most half the cache lifetime). |
| `cacheGuardHandoverTokens` | `250000` | A stopped agent with live background work and at least this context is asked to hand over and is then stopped; a smaller one is kept warm, if it runs on the session model (else it is handed over too). |
| `cacheGuardSizeHandover` | `true` | A stopped agent with live background work whose context has passed the subagent max context (fleetRetireContextTokens) is asked to hand over at its next stop, not only near its cache expiry. Off: size counts only then. |
| `cacheGuardHandoverWaitMinutes` | `10` | Minutes an agent gets to finish its handover (at most half the lead); later the coordinator is alerted. The agent is never stopped silently. |
| `cacheGuardKeepWarmMax` | `12` | Keep-warm messages to one agent in a row (real work between two starts a new run) before the coordinator is asked to decide. |
| `cacheGuardKeepWarmText` | `Tether cache guard: keep waiting, no action needed. Reply with one word, then wait as before.` | The message that keeps a waiting agent warm. |
| `cacheGuardHandoverText` | `Tether cache guard: hand over now. Commit your work, update STATUS.md (tip, done, left, running background jobs and their logs or result files, the next exact command), then stop. Do not start new work.` | The message that asks an agent to hand over and stop. |
| `stopEnabled` | `true` | Block the end of a turn while PR problems or stopped agents nobody has dealt with are known. |
| `stopMaxBlocks` | `3` | The same block this many times in a row, then let the turn end. |

<!-- options:end -->

One JSON file, one section per part: `checkpoint`, `fleet`, `watch`, `housekeeping`, `conversations`, `stop` and
`cacheGuard`. Every key is optional; the defaults are in each part's `src/*/config.ts`. Colours, column tints and
emoji are fleet keys (`colors`, `columnTint`, `emoji`). `enabled` (default `true`; `false` for `checkpoint`) turns a
whole section off; `cacheGuard.auto: false` turns off the agent guard's own actions. Every option above can also be
set in the file, under its section.

### Which file

1. The `TETHER_CONFIG` environment variable, when set: an absolute path. It wins over everything below.
2. Else the `configPath` option.
3. Else `.claude/tether.json` in the session's folder (a missing one means "no file").

The file is picked once each time the plugin loads; `/tether-watch reload` reads that same file again and applies it
to every part.

### One handoff file per session

The `TETHER_HANDOFF_FILE` environment variable names this session's handoff file, relative to the session's folder.
It wins over `checkpoint.handoffFile` (and its option), a locked file's included, so several sessions started in one
folder each checkpoint into their own file: the launcher sets it, and the session cannot change it. A value that is
absolute or leaves the folder (a `..` part) turns the checkpoint off for that session, with the log line `checkpoint:
off, TETHER_HANDOFF_FILE must be a path inside the session's folder`; unset or empty leaves the config's file.

### Top-level keys

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `locked` | boolean | `false` | The file's values are final: the plugin options are not read at all (defaults, then the file), no other file is read, and the file fails closed. |
| `network` | boolean | `true` | `false`: no `prs` or `issues` poller runs (and so no PR health command), and a command poller or `fleet.annotate` whose program is `gh`, `curl`, `wget`, `ssh`, `scp`, or `git` with `fetch`, `pull`, `push`, `clone`, `ls-remote`, `remote` or `submodule` (or a `-c alias.*`), is refused. The program is matched by its file name, in any case, without `.exe` (or `.cmd`, `.bat`, `.com`). |
| `allowedCommands` | list of lists of strings | none | When set, a command runs only if its argv starts with one of these lists, exactly. It applies to every command Tether runs, its own included (`git rev-parse --git-path info/exclude` for housekeeping, `gh pr list` and `git -C <worktree> rev-parse` / `rev-list` for the PR guard), whether or not `network` is `false`. `[]` runs nothing. |
| `plainOutput` | boolean | `false` | Everything Tether says is built from fixed templates filled only with ids, numbers and codes (see below). |

A refused command is told by a code, never by its text: `refused:network` or `refused:not-allowed`, in
`/tether-watch` and the log. The network rule matches programs by name, so a wrapper (a shell, an interpreter) that
reaches the network itself is not caught: list exactly what may run with `allowedCommands`.

### Failing closed

A file named by `TETHER_CONFIG`, a file that says `"locked": true`, and a file seen locked earlier in the same load
**fail closed**: when it is missing, unreadable, not JSON, not an object, or not valid, Tether turns every part off (no
pollers, no refresh, no guard acting, no Stop block, no checkpoint, no handoff added, no housekeeping, no conversation
logs, no store or file writes) and says so once, with the fixed text `tether: off, the config file is missing or not
valid`, in the status line and a toast; every command answers with that text. It never falls back to the options,
the defaults or `.claude/tether.json`. Not valid means: a `TETHER_CONFIG` that is not an absolute path, an unknown
top-level key, a section that is not an object, a field an option feeds with the wrong type, a watch problem (a bad
poller), or a top-level key of the table above with the wrong type. That last one fails closed in any file, locked
or not. Any other file keeps the old behaviour: a missing or broken file falls back to the options and defaults.

### plainOutput

With `"plainOutput": true` every text Tether submits to the session (wake prompts), returns (Stop-hook and deny
reasons, tool results, command answers), shows (toasts, the status line, pane cells) or writes (logs, the watch
state file, the store) is a fixed template filled only with ids (poller, agent, task and session ids), numbers
(tokens, minutes, counts, PR numbers) and codes from closed sets (agent states, PR causes, error codes such as `exit 2`
or `refused:network`), besides values the config itself sets (the wake preamble, the keep-warm and handover messages,
the override token, the handoff file and its headings). So:

- an agent is named by its id, never by its description, name or type, and the annotate notes are not shown;
- a PR problem is told as `#12: conflict`, `#12: checks-failed (2 checks)`, `#12: other` (a cause outside the closed
  set): no branch, check name or detail; check names and dedupe keys are kept in the store as hashes;
- a failure is a code: `exit N`, `refused:network`, `refused:not-allowed`, `bad-output` or `failed`; never stderr,
  stdout, an error message or `TaskStop`'s error text (only how many tasks failed);
- the model's notes (`pr_owner`, `agent_decision`) are not stored, an owner that is not id-like is kept as `?`, and a
  cause outside the closed set as `other`;
- a poller is named by its id (not its `title`); `/tether-fleet text` and the handoff added at session start are off;
  the Tether pane does not draw another session's watch state file (its own pollers' boxes stay);
- watch keeps its seen-set, findings and logs under their own store names, so nothing told before is told again.

A command poller under `plainOutput` reads only JSON lines `{ "key": "<id>", "code": "<code>" }`: `key` matches
`^[A-Za-z0-9._:-]{1,64}$`, `code` is one of the poller's `codes` (a list of such ids in its config), and the object has
no other field. It is told as `<key> <code>`. Every other line is dropped and only counted (`/tether-watch` shows
`N dropped`); its `format`, `match` and `key` settings are not used. Conversation logs are your own copy of the session
and are written as before; turn them off with `"conversations": { "enabled": false }`.

### A locked zone

A minimal file for a session that may not reach the network and may only repeat ids, numbers and codes, named with
`TETHER_CONFIG=/path/to/zone.json`:

```json
{
  "locked": true,
  "network": false,
  "plainOutput": true,
  "allowedCommands": [["node", "tools/check.js"]],
  "conversations": { "enabled": false },
  "housekeeping": { "enabled": false },
  "watch": {
    "pollers": [
      { "id": "agents", "kind": "agents", "everySeconds": 60 },
      { "id": "check", "command": ["node", "tools/check.js"], "everySeconds": 300, "codes": ["failed", "stale"] }
    ]
  }
}
```

`tools/check.js` then prints lines such as `{"key":"job-12","code":"failed"}`.

## Develop

```
claude plugin validate .
claude plugin test .
```

The plugin names one hooks module, and the engine follows `$` only within the file it is passed in, so every
part that touches `$` lives in `hooks/register.tsx`; the pure logic is in `src/` and tested in `tests/`.

## Licence

MIT.
