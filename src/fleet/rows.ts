// Turns the agent list, the ledger and annotations into the rows and the one-line summary fleet shows.

import type { FleetConfig } from './config'
import { cacheMinutesLeft, type Ledger } from './ledger'

/** One agent as `$.agent.list()` returns it (the fields fleet reads). */
export type AgentLike = { id: string; status: string; description?: string; type?: string; name?: string }

/** One rate limit as `$.session.usage()` returns it. */
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** One row of the fleet pane. */
export type Row = {
  id: string
  label: string
  /** The engine's status, with `waiting` spelled out: its turn ended, background work it owns still runs. */
  state: string
  contextTokens?: number
  idleMinutes?: number
  cacheLeftMinutes?: number
  note?: string
  flags: string[]
}

/** Short token counts: 950, 12k, 1.2M. */
export function tokens(n: number | undefined): string {
  if (n === undefined) return '-'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

/** The agents that are still alive come first, then the ended ones, newest activity first within each. */
const ENDED = new Set(['completed', 'failed', 'killed'])

/** Builds one row per agent, with flags for what needs a decision. */
export function buildRows(
  agents: AgentLike[],
  ledger: Ledger,
  notes: Record<string, string>,
  now: number,
  cfg: FleetConfig,
): Row[] {
  const rows = agents.map(a => {
    const entry = ledger.get(a.id)
    const left = cacheMinutesLeft(entry, now, cfg.cacheTtlMinutes)
    const flags: string[] = []
    const ctx = entry?.contextTokens
    const live = !ENDED.has(a.status)
    // Size alone needs no flag (the ctx column is coloured); what matters is a context to retire and
    // the price of waking an agent whose cache expired: its whole context written to the cache again
    if (live && ctx !== undefined && ctx >= cfg.retireContextTokens) flags.push(`≥${tokens(cfg.retireContextTokens)} retire`)
    if (live && left !== undefined && left <= 0 && ctx !== undefined && ctx >= cfg.bigContextTokens) flags.push(`wake≈${tokens(ctx)}`)
    if (entry && entry.coldWritten > 0) flags.push('WASTED ' + tokens(entry.coldWritten))
    const note = notes[a.id] ?? (a.name ? notes[a.name] : undefined) ?? (a.description ? notes[a.description] : undefined)
    return {
      id: a.id,
      label: a.name ?? a.description ?? a.type ?? a.id,
      state: a.status === 'waiting' ? 'waiting (bg work)' : a.status,
      ...(ctx !== undefined ? { contextTokens: ctx } : {}),
      ...(entry ? { idleMinutes: (now - entry.lastStepAt) / 60_000 } : {}),
      ...(left !== undefined ? { cacheLeftMinutes: left } : {}),
      ...(note ? { note } : {}),
      flags,
    }
  })
  return rows.sort((x, y) => {
    const ex = ENDED.has(x.state) ? 1 : 0
    const ey = ENDED.has(y.state) ? 1 : 0
    if (ex !== ey) return ex - ey
    return (x.idleMinutes ?? Infinity) - (y.idleMinutes ?? Infinity)
  })
}

/** The status-line summary: counts by state and flags; with `showSession`, the main context and the tightest rate limit. */
export function summary(rows: Row[], mainContext: number | undefined, limits: RateLimit[], coldToday: number, cfg: FleetConfig): string {
  const live = rows.filter(r => !ENDED.has(r.state))
  const parts: string[] = []
  const running = live.filter(r => r.state === 'running').length
  const waiting = live.filter(r => r.state.startsWith('waiting')).length
  parts.push(`${live.length} agent${live.length === 1 ? '' : 's'}` + (live.length ? ` (${running} running, ${waiting} waiting)` : ''))
  const cold = rows.filter(r => r.flags.some(f => f.startsWith('wake≈'))).length
  const retire = rows.filter(r => r.flags.some(f => f.endsWith(' retire'))).length
  if (cold) parts.push(`${cold} cold`)
  if (retire) parts.push(`${retire} to retire`)
  if (cfg.showSession && mainContext !== undefined) parts.push(`main ctx ${tokens(mainContext)}`)
  const worst = [...limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (cfg.showSession && worst) parts.push(`${worst.kind.replace('_', ' ')} ${worst.percentUsed}%` + (worst.percentUsed >= cfg.usageWarnPercent ? ' !' : ''))
  if (coldToday > 0) parts.push(`cold re-writes today ${tokens(coldToday)}`)
  return parts.join(' · ')
}
