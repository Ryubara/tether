// watch's settings: the pollers a project declares, and how its JSON file is read.

import { ID_LIKE } from '../options/plain'

/**
 * What every poller kind shares about telling a finding again. A finding still reported after it was told is told
 * again `remindMinutes` later, then after twice as long each time, at most every `remindMaxMinutes`; 0 never.
 */
export type Reminders = {
  remindMinutes: number
  remindMaxMinutes: number
}

/** A poller that runs a command and reads findings from its output. */
export type CommandPoller = Reminders & {
  kind: 'command'
  /** Names the poller in the status line, the wake prompt and the seen-set keys. */
  id: string
  /** The command, as argv: no shell. */
  command: string[]
  /** Working directory for the command; absent, the session's. */
  cwd?: string
  /** Seconds between runs. A run never starts while the previous one is still going. */
  everySeconds: number
  /** A run that takes longer is stopped and counted as a failure. */
  timeoutMs: number
  /**
   * How stdout becomes findings: `lines`, one finding per non-empty line (filtered by `match`);
   * `json`, an array of `{ key?, text }` (or `{ items: [...] }`).
   */
  format: 'lines' | 'json'
  /** For `lines`: only lines matching this regex are findings; its first group, when it has one, is the text. */
  match?: string
  /** A regex over a finding's text whose first group (else the whole match) is its dedupe key; absent, the text. */
  key?: string
  /** Exit codes whose output is read. */
  okExitCodes: number[]
  /** Exit codes that mean "nothing to report"; any other code is a failure. */
  quietExitCodes: number[]
  /** Tell each key once (until it is forgotten). Off for a command that already only prints what is new. */
  dedupe: boolean
  /** A told key unseen for this long is forgotten, so its return is new again. */
  forgetMinutes: number
  /** Start a model turn for new findings; off shows them in the status line and a toast only. */
  wake: boolean
  /** The heading of this poller's findings in the wake prompt, and the title of its box. */
  title: string
  /** Log lines its box shows (the box is this plus the title row tall); absent, the config's `boxRows`. */
  boxRows?: number
  /**
   * Under `plainOutput`, the codes a finding may carry: the command then prints JSON lines
   * `{ "key": "<id>", "code": "<one of these>" }`, and anything else is dropped (counted, not shown).
   */
  codes: string[]
}

/** A poller over the session's own subagents: running ones gone silent, or past a context size. */
export type AgentsPoller = Reminders & {
  kind: 'agents'
  id: string
  everySeconds: number
  /** A running agent with no model request for this long is a finding (once per silence). */
  silentMinutes: number
  /**
   * An agent whose context reaches this is a finding (once). Unset in the file, it is the subagent max context
   * (`fleet.retireContextTokens`), so one setting decides both the pane's retire flag and this wake.
   */
  contextTokens: number
  /** Also count agents `waiting` on their own background work as silent (off: that wait is normal). */
  includeWaiting: boolean
  dedupe: boolean
  forgetMinutes: number
  wake: boolean
  title: string
  boxRows?: number
}

/**
 * A poller over the project's open pull requests (the PR guard). A problem with no owner is a finding; the
 * model records an owner or a waiver with the tether pr_owner tool. By default it reads GitHub with `gh`;
 * a `command` replaces that read with the project's own (its JSON is `{ "stuck": [...], "rerun": [...] }`).
 */
export type PrsPoller = Reminders & {
  kind: 'prs'
  id: string
  everySeconds: number
  /** The project's own health command, as argv; absent, the built-in `gh pr list` read. */
  command?: string[]
  /** Working directory of `gh`, `git` and the command; absent, the session's. */
  cwd?: string
  timeoutMs: number
  /** The `command`'s exit codes that carry its JSON (a health command may exit 1 to say "something is stuck"); any other is an error. */
  okExitCodes: number[]
  /** Built-in read: CI running this long counts as stuck. */
  stuckMinutes: number
  /** Built-in read: a PR without auto-merge is a problem. */
  requireAutoMerge: boolean
  /** Built-in read: draft PRs are not checked. */
  ignoreDrafts: boolean
  /** A folder holding one worktree per PR branch (`<worktrees>/<branch>`); idle ones ahead of origin are `unpushed`. */
  worktrees?: string
  /** A file whose presence in a worktree marks it busy (an agent is working there), so it is not `unpushed`. */
  busyMarker?: string
  /** How long an `assign` lasts, in hours. */
  assignHours: number
  /** How long a rerun the health command reports (status `would-rerun` or `reran`) owns its PR's failed checks, in hours. */
  rerunHours: number
  dedupe: boolean
  forgetMinutes: number
  wake: boolean
  title: string
  boxRows?: number
}

/**
 * A poller over the project's open issues on GitHub (read with `gh`): each open issue carrying one of `labels` is a
 * finding, keyed by its number and the label, so it is told once while it keeps the label (its `remindMinutes` tells
 * it again). Nothing of the issue but its number and the configured label is told.
 */
export type IssuesPoller = Reminders & {
  kind: 'issues'
  id: string
  everySeconds: number
  /** The labels that make an open issue a finding; an issue with two of them is two findings. No commas (`gh` splits on them). */
  labels: string[]
  /** Working directory of `gh` (it reads that folder's repository); absent, the session's. */
  cwd?: string
  timeoutMs: number
  /** Issues read per label, at most. */
  limit: number
  dedupe: boolean
  forgetMinutes: number
  wake: boolean
  title: string
  boxRows?: number
}

export type Poller = CommandPoller | AgentsPoller | PrsPoller | IssuesPoller

/** Everything watch can be told. */
export type WatchConfig = {
  /** Off: no poller runs, nothing wakes the model, and the pane's services row shows watch off. */
  enabled: boolean
  pollers: Poller[]
  /** While the person has a draft in the prompt box, a wake waits up to this long, then goes anyway (the draft is kept). */
  deferWhileTypingMinutes: number
  /** At least this long between two wakes; findings in between join the next one. */
  minWakeGapSeconds: number
  /** The first line of the wake prompt. */
  wakePreamble: string
  /** Names this config's seen-set in $.store, so two projects' watch sessions keep their own. */
  storeName: string
  /** Seconds between redraws of the countdowns (status line and pane); 0 turns the live countdown off. */
  tickSeconds: number
  /** Log lines each poller's box shows unless it sets its own `boxRows`. */
  boxRows: number
  /** Open the pane, without focus, when a session starts (new, resumed or cleared). */
  openOnStart: boolean
  /** The pane size asked: `rows` inline above the prompt, `columns` docked beside a fullscreen transcript. */
  pane: { rows?: number; columns?: number }
  /** A file watch writes the boxes' data to, for fleet (its `watchState`) to draw under its table; empty: none. */
  stateFile: string
  /**
   * Wake the model after this many idle minutes, though nothing was found, while no subagent is at work (or stopped
   * with background tasks) and the main loop has no background task of its own; 0: never.
   */
  idleWakeMinutes: number
  /** The idle wake's prompt; `{minutes}` stands for idleWakeMinutes. */
  idleWakeText: string
  /**
   * A wake the engine took that started no turn while the session sat idle this long is sent again; a wake it
   * refused (a Stop stands, a hook dropped it) is tried again after this long, or after the next turn starts.
   */
  resendAfterMinutes: number
}

export const DEFAULTS: WatchConfig = {
  enabled: true,
  pollers: [],
  deferWhileTypingMinutes: 10,
  minWakeGapSeconds: 60,
  wakePreamble: 'watch found something new. Handle it or say why it can wait:',
  storeName: 'default',
  tickSeconds: 1,
  boxRows: 6,
  openOnStart: false,
  pane: {},
  stateFile: '',
  idleWakeMinutes: 0,
  idleWakeText: 'Nothing new: woken after {minutes} idle minutes with no subagent at work. Take up the next piece of work, or say why there is none.',
  resendAfterMinutes: 2,
}

/** The poller ids watch accepts: they become parts of store keys and command names. */
const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** A positive finite number from `v`, else `fallback`. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/** A list of integers from `v`, else `fallback`. */
function codes(v: unknown, fallback: number[]): number[] {
  return Array.isArray(v) && v.every(c => Number.isInteger(c)) ? (v as number[]) : fallback
}

/** A regex source that compiles, else undefined (and a problem noted). */
function regex(v: unknown, where: string, problems: string[]): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  try {
    new RegExp(v)
    return v
  } catch {
    problems.push(`${where}: not a valid regex`)
    return undefined
  }
}

/** The context an agents poller wakes at when nothing sets one: fleet's default subagent max context. */
export const DEFAULT_AGENT_CONTEXT_TOKENS = 300_000

/** Reads one poller entry; undefined (with a problem noted) when it cannot be used. `agentContextTokens` is what an agents poller without its own `contextTokens` uses. */
function poller(raw: unknown, i: number, problems: string[], agentContextTokens: number): Poller | undefined {
  if (raw === null || typeof raw !== 'object') {
    problems.push(`pollers[${i}]: not an object`)
    return undefined
  }
  const r = raw as Record<string, unknown>
  const id = r.id
  if (typeof id !== 'string' || !ID.test(id)) {
    problems.push(`pollers[${i}]: id must be 1-40 of a-z 0-9 . _ -`)
    return undefined
  }
  const common = {
    id,
    dedupe: typeof r.dedupe === 'boolean' ? r.dedupe : true,
    forgetMinutes: num(r.forgetMinutes, 30),
    wake: typeof r.wake === 'boolean' ? r.wake : true,
    title: typeof r.title === 'string' && r.title !== '' ? r.title : id,
    ...(Number.isInteger(r.boxRows) && (r.boxRows as number) >= 1 && (r.boxRows as number) <= 50 ? { boxRows: r.boxRows as number } : {}),
    remindMinutes: typeof r.remindMinutes === 'number' && Number.isFinite(r.remindMinutes) && r.remindMinutes > 0 ? r.remindMinutes : 0,
    remindMaxMinutes: num(r.remindMaxMinutes, 240),
  }
  if (r.kind === 'issues') {
    const labels = r.labels
    if (!Array.isArray(labels) || labels.length === 0 || !labels.every(l => typeof l === 'string' && l.trim() !== '' && !l.includes(','))) {
      // `gh --label a,b` means both labels, so a comma would change what is read
      problems.push(`${id}: labels must be a non-empty list of label names without commas`)
      return undefined
    }
    return {
      kind: 'issues',
      ...common,
      everySeconds: num(r.everySeconds, 120),
      labels: [...new Set((labels as string[]).map(l => l.trim()))],
      ...(typeof r.cwd === 'string' && r.cwd.trim() !== '' ? { cwd: r.cwd.trim() } : {}),
      timeoutMs: num(r.timeoutMs, 60_000),
      limit: Number.isInteger(r.limit) && (r.limit as number) >= 1 && (r.limit as number) <= 1000 ? (r.limit as number) : 100,
    }
  }
  if (r.kind === 'agents') {
    return {
      kind: 'agents',
      ...common,
      everySeconds: num(r.everySeconds, 60),
      silentMinutes: num(r.silentMinutes, 20),
      contextTokens: num(r.contextTokens, agentContextTokens),
      includeWaiting: r.includeWaiting === true,
    }
  }
  if (r.kind === 'prs') {
    const command = r.command
    if (command !== undefined && (!Array.isArray(command) || command.length === 0 || !command.every(s => typeof s === 'string'))) {
      problems.push(`${id}: command must be a non-empty list of strings`)
      return undefined
    }
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
    return {
      kind: 'prs',
      ...common,
      everySeconds: num(r.everySeconds, 300),
      ...(command ? { command: command as string[] } : {}),
      ...(text(r.cwd) ? { cwd: text(r.cwd) } : {}),
      timeoutMs: num(r.timeoutMs, 240_000),
      okExitCodes: codes(r.okExitCodes, [0, 1]),
      stuckMinutes: num(r.stuckMinutes, 90),
      requireAutoMerge: r.requireAutoMerge === true,
      ignoreDrafts: r.ignoreDrafts !== false,
      ...(text(r.worktrees) ? { worktrees: text(r.worktrees) } : {}),
      ...(text(r.busyMarker) ? { busyMarker: text(r.busyMarker) } : {}),
      assignHours: num(r.assignHours, 4),
      rerunHours: num(r.rerunHours, 3),
    }
  }
  if (r.kind !== undefined && r.kind !== 'command') {
    problems.push(`${id}: unknown kind ${JSON.stringify(r.kind)}`)
    return undefined
  }
  const command = r.command
  if (!Array.isArray(command) || command.length === 0 || !command.every(s => typeof s === 'string')) {
    problems.push(`${id}: command must be a non-empty list of strings`)
    return undefined
  }
  const pollerCodes = r.codes === undefined ? [] : r.codes
  if (!Array.isArray(pollerCodes) || !pollerCodes.every(c => typeof c === 'string' && ID_LIKE.test(c))) {
    problems.push(`${id}: codes must be a list of ids (letters, digits, . _ : -)`)
    return undefined
  }
  const match = regex(r.match, `${id}.match`, problems)
  const key = regex(r.key, `${id}.key`, problems)
  return {
    kind: 'command',
    ...common,
    command: command as string[],
    ...(typeof r.cwd === 'string' && r.cwd !== '' ? { cwd: r.cwd } : {}),
    everySeconds: num(r.everySeconds, 300),
    timeoutMs: num(r.timeoutMs, 120_000),
    format: r.format === 'json' ? 'json' : 'lines',
    ...(match ? { match } : {}),
    ...(key ? { key } : {}),
    okExitCodes: codes(r.okExitCodes, [0]),
    quietExitCodes: codes(r.quietExitCodes, []),
    codes: pollerCodes as string[],
  }
}

/**
 * Merges a parsed config file over the defaults; `problems` lists what was left out and why. `agentContextTokens` is
 * the effective subagent max context (`fleet.retireContextTokens`, from the option or the file): an agents poller
 * that sets no `contextTokens` of its own wakes at it.
 */
export function parseConfig(raw: unknown, agentContextTokens = DEFAULT_AGENT_CONTEXT_TOKENS): { config: WatchConfig; problems: string[] } {
  const problems: string[] = []
  const config: WatchConfig = { ...DEFAULTS, pollers: [], pane: {} }
  if (raw === null || typeof raw !== 'object') return { config, problems: ['the config is not a JSON object'] }
  const r = raw as Record<string, unknown>
  config.deferWhileTypingMinutes = num(r.deferWhileTypingMinutes, DEFAULTS.deferWhileTypingMinutes)
  config.minWakeGapSeconds = num(r.minWakeGapSeconds, DEFAULTS.minWakeGapSeconds)
  if (typeof r.tickSeconds === 'number' && Number.isFinite(r.tickSeconds) && r.tickSeconds >= 0) config.tickSeconds = r.tickSeconds
  if (Number.isInteger(r.boxRows) && (r.boxRows as number) >= 1 && (r.boxRows as number) <= 50) config.boxRows = r.boxRows as number
  if (typeof r.stateFile === 'string') config.stateFile = r.stateFile.trim()
  if (typeof r.enabled === 'boolean') config.enabled = r.enabled
  if (typeof r.openOnStart === 'boolean') config.openOnStart = r.openOnStart
  const pane = r.pane as Record<string, unknown> | undefined
  if (pane && typeof pane === 'object') {
    for (const k of ['rows', 'columns'] as const) if (Number.isInteger(pane[k]) && (pane[k] as number) > 0) config.pane[k] = pane[k] as number
  }
  if (typeof r.wakePreamble === 'string' && r.wakePreamble !== '') config.wakePreamble = r.wakePreamble
  if (typeof r.storeName === 'string' && ID.test(r.storeName)) config.storeName = r.storeName
  if (typeof r.idleWakeMinutes === 'number' && Number.isFinite(r.idleWakeMinutes) && r.idleWakeMinutes >= 0) config.idleWakeMinutes = r.idleWakeMinutes
  if (typeof r.idleWakeText === 'string' && r.idleWakeText.trim() !== '') config.idleWakeText = r.idleWakeText
  config.resendAfterMinutes = num(r.resendAfterMinutes, DEFAULTS.resendAfterMinutes)
  const list = Array.isArray(r.pollers) ? r.pollers : []
  const ids = new Set<string>()
  list.forEach((p, i) => {
    const one = poller(p, i, problems, agentContextTokens)
    if (!one) return
    if (ids.has(one.id)) {
      problems.push(`${one.id}: duplicate id, the later one is ignored`)
      return
    }
    ids.add(one.id)
    config.pollers.push(one)
  })
  return { config, problems }
}
