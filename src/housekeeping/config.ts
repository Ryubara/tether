// Settings of the parts that keep a project tidy: the files Tether creates and hides from git, the checks on the
// handoff, the conversation logs, and the Stop hook that blocks the end of a turn over unowned problems.

export type HousekeepingConfig = {
  /** Off: no folder, no handoff, no exclude lines are made, and the handoff is not checked on writes. */
  enabled: boolean
  /** Tether's folder in the project (logs live in `<folder>/conversations`). */
  folder: string
  /** Lines added to `.git/info/exclude` besides Tether's own (its folder, the handoff, the project-relative config). */
  exclude: string[]
  /** Create the handoff from the template when it is missing. */
  createHandoff: boolean
  /** Refuse a Write of the handoff that fails its check; an Edit that leaves it failing is reported. */
  enforceHandoff: boolean
}

export type ConversationsConfig = {
  enabled: boolean
  /** Seconds between log writes while turns complete; a log is always written before a clear. */
  minSeconds: number
}

export type StopConfig = {
  /** Block the end of a turn while PR problems or stopped agents nobody has dealt with are known. */
  enabled: boolean
  /** The same block this many times in a row, then let the turn end: a model that cannot fix it must not loop for ever. */
  maxBlocks: number
}

export const HOUSEKEEPING_DEFAULTS: HousekeepingConfig = { enabled: true, folder: '.tether', exclude: [], createHandoff: true, enforceHandoff: true }
export const CONVERSATIONS_DEFAULTS: ConversationsConfig = { enabled: true, minSeconds: 30 }
export const STOP_DEFAULTS: StopConfig = { enabled: true, maxBlocks: 3 }

/** A positive finite number from `v`, else `fallback`. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/** Merges a parsed `housekeeping` section over the defaults. */
export function mergeHousekeeping(raw: unknown): HousekeepingConfig {
  const out: HousekeepingConfig = { ...HOUSEKEEPING_DEFAULTS, exclude: [] }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.folder === 'string' && r.folder.trim() !== '' && !/^([a-zA-Z]:|[\\/])|\.\./.test(r.folder.trim())) out.folder = r.folder.trim().replace(/[\\/]+$/, '')
  if (Array.isArray(r.exclude)) out.exclude = r.exclude.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim())
  if (typeof r.createHandoff === 'boolean') out.createHandoff = r.createHandoff
  if (typeof r.enforceHandoff === 'boolean') out.enforceHandoff = r.enforceHandoff
  return out
}

/** Merges a parsed `conversations` section over the defaults. */
export function mergeConversations(raw: unknown): ConversationsConfig {
  const out = { ...CONVERSATIONS_DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  out.minSeconds = num(r.minSeconds, out.minSeconds)
  return out
}

/** Merges a parsed `stop` section over the defaults. */
export function mergeStop(raw: unknown): StopConfig {
  const out = { ...STOP_DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  out.maxBlocks = Math.floor(num(r.maxBlocks, out.maxBlocks))
  return out
}

/** What the Stop hook remembers about its last block. */
export type StopState = { reason: string; count: number; at: number }

/** After this long without a block, the count starts over (a new piece of work, not the same loop). */
export const STOP_WINDOW_MS = 10 * 60_000

/** Whether the Stop hook blocks now: it does, until the same reason has been given `maxBlocks` times in a row. */
export function stopBlocks(previous: StopState | undefined, reason: string, maxBlocks: number, now: number): { block: boolean; next: StopState } {
  const same = previous !== undefined && previous.reason === reason && now - previous.at < STOP_WINDOW_MS
  const count = same ? previous.count : 0
  return count >= maxBlocks ? { block: false, next: { reason, count, at: now } } : { block: true, next: { reason, count: count + 1, at: now } }
}
