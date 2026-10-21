// Settings of the agent guard's own actions: how early it acts before a stopped agent's prompt cache expires,
// and what it does by itself (keep the cache warm, or hand a big agent over) instead of only asking the model.

export type CacheGuardConfig = {
  /** Tether acts by itself (message the agent, stop its leftover background tasks); off: it only blocks and asks. */
  auto: boolean
  /** Acts this many minutes before the cache expires (never more than half the cache lifetime). */
  leadMinutes: number
  /** A stopped agent with live background work and at least this context is handed over, not kept warm. */
  handoverTokens: number
  /**
   * A stopped agent with live background work whose context has passed `fleet.retireContextTokens` is asked to hand
   * over at once, at the first tick after it stops, not only near its cache's expiry. Off: size counts only then.
   */
  sizeHandover: boolean
  /** Minutes the agent gets to finish its handover; later the coordinator is alerted (the agent is never stopped silently). */
  handoverWaitMinutes: number
  /** Keep-warm messages to one agent before the coordinator is asked to decide. */
  keepWarmMax: number
  /** The keep-warm message. */
  keepWarmText: string
  /** The handover message. */
  handoverText: string
  /**
   * Register the guard tools (pr_owner, agent_decision) the model records owners and decisions with. Claude Code
   * serves a mod's tools from a loopback port in the session's process; off, no tool is registered, and the end
   * of a turn is never blocked for a record only those tools could make.
   */
  registerTools: boolean
}

export const CACHE_GUARD_DEFAULTS: CacheGuardConfig = {
  auto: true,
  leadMinutes: 20,
  handoverTokens: 250_000,
  sizeHandover: true,
  handoverWaitMinutes: 10,
  keepWarmMax: 12,
  keepWarmText: 'Tether cache guard: keep waiting, no action needed. Reply with one word, then wait as before.',
  handoverText:
    'Tether cache guard: hand over now. Commit your work, update STATUS.md (tip, done, left, running background jobs and their logs or result files, ' +
    'the next exact command), then stop. Do not start new work.',
  registerTools: true,
}

/** A positive finite number from `v`, else `fallback`. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/** Merges a parsed `cacheGuard` section over the defaults. */
export function mergeCacheGuard(raw: unknown): CacheGuardConfig {
  const out = { ...CACHE_GUARD_DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.auto === 'boolean') out.auto = r.auto
  if (typeof r.registerTools === 'boolean') out.registerTools = r.registerTools
  if (typeof r.sizeHandover === 'boolean') out.sizeHandover = r.sizeHandover
  out.leadMinutes = num(r.leadMinutes, out.leadMinutes)
  out.handoverTokens = num(r.handoverTokens, out.handoverTokens)
  out.handoverWaitMinutes = num(r.handoverWaitMinutes, out.handoverWaitMinutes)
  out.keepWarmMax = Math.floor(num(r.keepWarmMax, out.keepWarmMax))
  if (typeof r.keepWarmText === 'string' && r.keepWarmText.trim() !== '') out.keepWarmText = r.keepWarmText.trim()
  if (typeof r.handoverText === 'string' && r.handoverText.trim() !== '') out.handoverText = r.handoverText.trim()
  return out
}
