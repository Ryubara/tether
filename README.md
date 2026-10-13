# Tether

Tether holds a project together across Claude Code sessions. It is a *mod*: a Claude Code plugin whose hooks
run inside Claude Code (version 2.1.287 or later). See the
[mods overview](https://code.claude.com/docs/en/plugins/mods/overview).

> **Status: 1.0.0-alpha.** The agents pane and the watchers work and are tested. The checkpoint cycle,
> conversation logs and `HANDOFF.md` checks are being built; see the [changelog](CHANGELOG.md).

## What it does today

- **Fleet.** An agents pane and a status line: each subagent's state, context size, idle time and
  prompt-cache minutes left, with flags that say what waking it would cost. The `SendMessage` guard refuses
  to wake a big agent whose prompt cache has expired (waking it re-writes the whole context into the cache),
  for the main agent and for subagents. `/fleet` opens the pane; `/fleet text` prints it.
- **Watch.** Pollers that run inside the session: each finding is told once, and a model turn starts only for
  new findings, never during a turn or while you type. `/watch` reports; `/watch pane` shows a box per
  poller with its countdown and its findings.

## Install

```
/plugin marketplace add Ryubara/tether
/plugin install tether@tether
```

Then set the config with `/plugin configure tether@tether` (the `configPath` option), or put the file at
`.claude/tether.json` in your project. [`examples/tether.json`](examples/tether.json) shows the sections.

## Config

One JSON file, one section per part (`fleet`, `watch`). Every key is optional; the defaults are in
`src/fleet/config.ts` and `src/watch/config.ts`. Colours, column tints and emoji are fleet keys
(`colors`, `columnTint`, `emoji`).

## Develop

```
claude plugin validate .
claude plugin test .
```

The plugin names one hooks module, and the engine follows `$` only within the file it is passed in, so every
part that touches `$` lives in `hooks/register.tsx`; the pure logic is in `src/` and tested in `tests/`.

## Licence

MIT.
