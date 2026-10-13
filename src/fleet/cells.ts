// One pane row as cells with a colour each: what the pane draws, and (joined) what /fleet text prints.

import type { FleetConfig } from './config'
import { BIG_WAIT, tokens, type Row } from './rows'

/** The colour names the pane uses, each overridable in the config's `colors`. */
export type Palette = {
  /** A running agent's state. */
  running: string
  /** An agent waiting on its own background work. */
  waiting: string
  /** Warnings: a big context, cache close to expiry. */
  warn: string
  /** Trouble: a context to retire, an expired cache, the wake≈ and retire flags, failed or killed. */
  bad: string
  /** Plenty of cache left. */
  good: string
  /** Project notes (the annotate command's). */
  note: string
}

export const PALETTE: Palette = { running: 'green', waiting: 'yellow', warn: 'yellow', bad: 'red', good: 'green', note: 'cyan' }

/** One cell: its padded text, its colour (none: the default), and whether it is dimmed. */
export type Cell = { text: string; color?: string; dim?: boolean; bg?: string }

/**
 * The band colour when `columnTint` is on without a colour of its own. A theme key, so it follows the
 * person's theme (a subtle block background on dark and light alike); `columnTint: "<colour>"` replaces it.
 */
export const DEFAULT_TINT = 'userMessageBackground'

/** The separator between columns when the tint is off. */
const SEP = '│ '

/** The tint colour `cfg.columnTint` asks for, or undefined when the columns are separated by `│` instead. */
export function tintOf(cfg: FleetConfig): string | undefined {
  if (cfg.columnTint === false) return undefined
  return typeof cfg.columnTint === 'string' ? cfg.columnTint : DEFAULT_TINT
}

/**
 * Lays columns out as cells: with a tint, every other column gets the band background (cells are
 * padded to a fixed width, so the bands line up); without, columns are divided by a `│`. A column
 * is a list of cells, so a state emoji can share the agent column's band.
 */
function layout(columns: Cell[][], cfg: FleetConfig): Cell[] {
  const tint = tintOf(cfg)
  return columns.flatMap((col, i) => {
    if (tint) return i % 2 === 0 ? col.map(c => ({ ...c, bg: tint })) : col
    return i === 0 || col.length === 0 ? col : [{ text: SEP, dim: true }, ...col]
  })
}

const ENDED = new Set(['completed', 'failed', 'killed'])

/** Column widths, shared by the rows and the header. */
const W = { agent: 28, state: 17, ctx: 5, idle: 5, cache: 7 }

/** A state's emoji (each two columns wide, so rows stay aligned). */
export function stateEmoji(state: string): string {
  if (state === 'running') return '🟢'
  if (state.startsWith('waiting')) return '⏳'
  if (state === 'failed' || state === 'killed') return '❌'
  if (state === 'completed') return '✅'
  return '💤'
}

/** A flag's emoji: a cold wake's cost, a context to retire, tokens already wasted. */
function flagEmoji(flag: string): string {
  return flag.startsWith('wake≈') ? '🧊' : flag.endsWith(' retire') ? '🔁' : flag === BIG_WAIT ? '🛑' : '💸'
}

/** The header row: each column's name, padded as the rows are. */
export function headerCells(cfg: FleetConfig): Cell[] {
  const names = ['AGENT'.padEnd(W.agent), 'STATE'.padEnd(W.state), 'CTX'.padEnd(W.ctx), 'IDLE'.padEnd(W.idle), 'CACHE'.padEnd(W.cache), 'FLAGS · NOTE']
  // Where the tint is off the `│` takes the place of each column's trailing space
  const gap = tintOf(cfg) ? ' ' : ''
  const cols: Cell[][] = names.map((n, i) => [{ text: n + (i < names.length - 1 ? gap : ''), dim: true }])
  if (cfg.emoji) cols[0] = [{ text: '   ', dim: true }, ...cols[0]!]
  return layout(cols, cfg)
}

/** The cells of one row, coloured by value when `cfg.colors` is not false. */
export function rowCells(r: Row, cfg: FleetConfig): Cell[] {
  const p = cfg.colors === false ? undefined : { ...PALETTE, ...cfg.colors }
  const ended = ENDED.has(r.state)
  const paint = (text: string, color?: string, dim = false): Cell => ({
    text,
    ...(p && color && !ended ? { color } : {}),
    ...(dim || ended ? { dim: true } : {}),
  })

  const state =
    r.state === 'running' ? p?.running : r.state.startsWith('waiting') ? p?.waiting : r.state === 'failed' || r.state === 'killed' ? p?.bad : undefined
  const ctx = r.contextTokens
  const ctxColor = ctx === undefined ? undefined : ctx >= cfg.retireContextTokens ? p?.bad : ctx >= cfg.bigContextTokens ? p?.warn : undefined
  const left = r.cacheLeftMinutes
  const cacheText = left === undefined ? '-' : left > 0 ? Math.round(left) + 'm' : 'expired'
  const cacheColor = left === undefined ? undefined : left <= 0 ? p?.bad : left <= cfg.cacheWarnMinutes ? p?.warn : p?.good
  const idle = r.idleMinutes === undefined ? '-' : Math.round(r.idleMinutes) + 'm'

  const gap = tintOf(cfg) ? ' ' : ''
  const last: Cell[] = []
  for (const f of r.flags) {
    const color = f.startsWith('wake≈') || f.endsWith(' retire') || f === BIG_WAIT ? p?.bad : p?.note
    last.push(paint((cfg.emoji ? flagEmoji(f) + ' ' : '') + f + ' ', color))
  }
  if (r.note) last.push(paint('· ' + r.note, p?.note))
  return layout(
    [
      [...(cfg.emoji ? [paint(stateEmoji(r.state) + ' ')] : []), paint(r.label.slice(0, W.agent).padEnd(W.agent) + gap)],
      [paint(r.state.padEnd(W.state) + gap, state, r.state === 'idle')],
      [paint(tokens(ctx).padEnd(W.ctx) + gap, ctxColor, ctx === undefined)],
      [paint(idle.padEnd(W.idle) + gap, undefined, r.idleMinutes === undefined)],
      [paint(cacheText.padEnd(W.cache) + gap, cacheColor, left === undefined)],
      last,
    ],
    cfg,
  )
}

/** The row as plain text: the cells joined, trailing spaces cut. */
export function rowText(r: Row, cfg: FleetConfig): string {
  return rowCells(r, cfg).map(c => c.text).join('').trimEnd()
}

/** The pane's footer: what the flags on screen mean, or nothing when no row has one. */
export function legend(rows: Row[], cfg: FleetConfig): string | undefined {
  const parts: string[] = []
  const flags = rows.flatMap(r => r.flags)
  if (flags.some(f => f.startsWith('wake≈'))) parts.push('wake≈N: cache expired, waking it re-writes N tokens to the cache')
  if (flags.some(f => f.endsWith(' retire'))) parts.push(`≥${tokens(cfg.retireContextTokens)} retire: context past the retire line`)
  if (flags.includes(BIG_WAIT)) parts.push('BIG-WAIT: a big context that is only waiting; retire it and start a small successor from its status notes')
  if (flags.some(f => f.startsWith('WASTED'))) parts.push('WASTED N: tokens already re-written on cold wakes')
  return parts.length ? parts.join(' · ') : undefined
}
