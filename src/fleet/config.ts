// fleet's settings: defaults, and how a project's JSON file is merged over them.

/** Everything fleet can be told. Every field has a default, so a config file names only what it changes. */
export type FleetConfig = {
  /** How long the prompt cache lives after an agent's last request (Claude Code's 5 min, or 60 with `subagentPromptCacheTtl: "1h"`). */
  cacheTtlMinutes: number
  /** Context size from which an expired cache is worth guarding: re-writing it costs real money. */
  bigContextTokens: number
  /** Context size at which an agent is flagged for retirement. */
  retireContextTokens: number
  /** Refuse SendMessage to a big agent whose cache has expired, unless the message starts with `overrideToken`. */
  coldGuard: boolean
  /** The text a message starts with to pass the cold-cache guard on purpose. */
  overrideToken: string
  /** Off: fleet does nothing (no refresh, no guard, no status text) and the pane's services row shows it off. */
  enabled: boolean
  /** Also show the main session's context and the tightest rate limit (off: most status lines already show them). */
  showSession: boolean
  /** With `showSession`, a rate limit at or above this percent gets a `!`. */
  usageWarnPercent: number
  /** Pane colours by value (src/cells.ts PALETTE), each name overridable; `false` draws without colour. */
  colors: Partial<Record<'running' | 'waiting' | 'warn' | 'bad' | 'good' | 'note', string>> | false
  /** An emoji per state and flag in the pane and /fleet text; `false` for plain text. */
  emoji: boolean
  /** Cache minutes left at or under which the cache cell turns to the warning colour. */
  cacheWarnMinutes: number
  /**
   * Alternate columns get a band background so the table reads in columns: `true` uses the theme's
   * message background (src/cells.ts DEFAULT_TINT), a string is another colour (a theme key or a raw
   * colour); `false` divides the columns with `│` instead.
   */
  columnTint: boolean | string
  /**
   * A state file the watch mod writes (its `stateFile`): when set, the pane draws watch's poller boxes
   * (name, live countdown, findings) under the agent table. Empty: none.
   */
  watchState: string
  /** The pane size asked for: `rows` when inline above the prompt, `columns` when docked beside a fullscreen transcript. */
  pane: { rows?: number; columns?: number }
  /** Seconds between refreshes of the agent list, usage and annotations. */
  refreshSeconds: number
  /**
   * Optional command that prints a JSON object `{ "<agent id, name or description>": "<short note>" }`, such as
   * which build-queue place an agent holds. Run every `annotate.everySeconds`, no shell.
   */
  annotate?: { command: string[]; everySeconds: number; timeoutMs?: number }
}

/** The defaults: Claude Code's 1-hour subagent cache and a 300k retirement line. */
export const DEFAULTS: FleetConfig = {
  cacheTtlMinutes: 60,
  bigContextTokens: 60_000,
  retireContextTokens: 300_000,
  coldGuard: true,
  overrideToken: '[cache-ok]',
  enabled: true,
  showSession: false,
  usageWarnPercent: 90,
  refreshSeconds: 15,
  colors: {},
  emoji: true,
  columnTint: true,
  watchState: '',
  cacheWarnMinutes: 15,
  pane: {},
}

/** Merges a parsed config file over the defaults, keeping only fields of the right type. */
export function mergeConfig(raw: unknown): FleetConfig {
  const out: FleetConfig = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const key of ['cacheTtlMinutes', 'bigContextTokens', 'retireContextTokens', 'usageWarnPercent', 'refreshSeconds', 'cacheWarnMinutes'] as const) {
    if (typeof r[key] === 'number' && Number.isFinite(r[key]) && (r[key] as number) > 0) out[key] = r[key] as number
  }
  if (typeof r.coldGuard === 'boolean') out.coldGuard = r.coldGuard
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.showSession === 'boolean') out.showSession = r.showSession
  if (typeof r.watchState === 'string') out.watchState = r.watchState.trim()
  if (typeof r.emoji === 'boolean') out.emoji = r.emoji
  if (typeof r.columnTint === 'boolean' || (typeof r.columnTint === 'string' && r.columnTint.trim() !== '')) {
    out.columnTint = typeof r.columnTint === 'string' ? r.columnTint.trim() : r.columnTint
  }
  if (r.colors === false) out.colors = false
  else if (r.colors && typeof r.colors === 'object') {
    out.colors = Object.fromEntries(Object.entries(r.colors).filter(([k, v]) => ['running', 'waiting', 'warn', 'bad', 'good', 'note'].includes(k) && typeof v === 'string' && v !== ''))
  }
  const pane = r.pane as Record<string, unknown> | undefined
  if (pane && typeof pane === 'object') {
    out.pane = {}
    for (const k of ['rows', 'columns'] as const) if (Number.isInteger(pane[k]) && (pane[k] as number) > 0) out.pane[k] = pane[k] as number
  }
  if (typeof r.overrideToken === 'string' && r.overrideToken.length > 0) out.overrideToken = r.overrideToken
  const a = r.annotate as Record<string, unknown> | undefined
  if (a && Array.isArray(a.command) && a.command.length > 0 && a.command.every(s => typeof s === 'string')) {
    out.annotate = {
      command: a.command as string[],
      everySeconds: typeof a.everySeconds === 'number' && a.everySeconds > 0 ? a.everySeconds : 60,
      ...(typeof a.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {}),
    }
  }
  return out
}
