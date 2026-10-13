# Changelog

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
