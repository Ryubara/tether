# Tether

Tether holds a project together across Claude Code sessions. It is a *mod*: a Claude Code plugin whose hooks
run inside Claude Code (version 2.1.287 or later). See the
[mods overview](https://code.claude.com/docs/en/plugins/mods/overview).

> **Status: 1.0.0-alpha.** Everything below works and is tested; the checkpoint cycle is off by default. See the
> [changelog](CHANGELOG.md).

## What it does today

- **Fleet.** An agents pane and a status line: each subagent's state, context size, idle time and
  prompt-cache minutes left, with flags that say what waking it would cost. The `SendMessage` guard refuses
  to wake a big agent whose prompt cache has expired (waking it re-writes the whole context into the cache),
  for the main agent and for subagents. `/tether-fleet` opens the pane; `/tether-fleet text` prints it.
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
- **Agent guard.** The agents poller also tells stopped agents with a big context that nobody has decided about
  as their prompt cache runs out (an agent that stepped before Tether loaded is read from its transcript); the model records `retired` or `done` with `mcp__tether__agent_decision`.
- **Stop hook.** The end of a turn is blocked while a PR problem or an undecided agent is open, at most
  `stop.maxBlocks` times in a row for the same reason. `/tether-guards` prints what is open.
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
| `fleetCacheTtlMinutes` | `60` | How long the prompt cache lives after an agent's last request (5, or 60 with subagentPromptCacheTtl 1h). |
| `fleetBigContextTokens` | `60000` | Context size from which an expired cache is worth guarding. |
| `fleetRetireContextTokens` | `300000` | Context size at which an agent is flagged for retirement. |
| `fleetBigWaitTokens` | `0` | An agent with at least this context and a matching note (see the note pattern) is flagged BIG-WAIT. 0: off. |
| `fleetBigWaitNote` | (empty) | A regular expression matched case-insensitively against the agent's annotation note. Empty: any note. |
| `fleetColdGuard` | `true` | Refuse SendMessage to a big agent whose cache has expired, unless the message starts with the override token. |
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
