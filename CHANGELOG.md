# Changelog

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
