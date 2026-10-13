// Unit tests of fleet's pure logic: config, ledger, rows and the cold-cache guard.
import { expect, test } from 'claude-code/testing'

import { DEFAULTS, mergeConfig } from '../../src/fleet/config'
import { coldGuard } from '../../src/fleet/guard'
import { recordStep, type Ledger } from '../../src/fleet/ledger'
import { buildRows, summary, tokens } from '../../src/fleet/rows'
import { DEFAULT_TINT, headerCells, rowCells, rowText } from '../../src/fleet/cells'

const MIN = 60_000
const BIG = { input_tokens: 2, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 2_000 }

test('mergeConfig keeps defaults and takes only well-typed fields', async () => {
  expect(mergeConfig(null)).toEqual(DEFAULTS)
  const c = mergeConfig({ cacheTtlMinutes: 5, coldGuard: false, bigContextTokens: 'x', annotate: { command: ['py', 'a.py'] } })
  expect(c.cacheTtlMinutes).toBe(5)
  expect(c.coldGuard).toBe(false)
  expect(c.bigContextTokens).toBe(DEFAULTS.bigContextTokens)
  expect(c.annotate).toEqual({ command: ['py', 'a.py'], everySeconds: 60 })
})

test('a first request is never a cold wake; a big re-write after the TTL is', async () => {
  const ledger: Ledger = new Map()
  expect(recordStep(ledger, 'a', 0, { cache_creation_input_tokens: 200_000 }, 60, 60_000).isColdWake).toBe(false)
  // Within the TTL: warm, whatever it writes
  expect(recordStep(ledger, 'a', 30 * MIN, { cache_creation_input_tokens: 200_000 }, 60, 60_000).isColdWake).toBe(false)
  // 61 minutes later and 200k written: the waste fleet exists to catch
  const v = recordStep(ledger, 'a', 91 * MIN, { cache_creation_input_tokens: 200_000 }, 60, 60_000)
  expect(v.isColdWake).toBe(true)
  expect(Math.round(v.idleMinutes)).toBe(61)
  expect(ledger.get('a')?.coldWritten).toBe(200_000)
  expect(ledger.get('a')?.steps).toBe(3)
})

test('rows spell out waiting, flag cold and retire, and sort live agents first', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'w', 0, BIG, 60, 60_000)
  recordStep(ledger, 'r', 0, { cache_read_input_tokens: 320_000 }, 60, 60_000)
  const rows = buildRows(
    [
      { id: 'd', status: 'completed', description: 'old' },
      { id: 'w', status: 'waiting', description: 'build wait' },
      { id: 'r', status: 'running', name: 'big' },
    ],
    ledger,
    { w: 'queue place 3' },
    70 * MIN,
    DEFAULTS,
  )
  expect(rows.map(r => r.id)).toEqual(['w', 'r', 'd'])
  expect(rows[0]?.state).toBe('waiting (bg work)')
  expect(rows[0]?.flags).toContain('wake≈152k')
  expect(rows[0]?.note).toBe('queue place 3')
  expect(rows[1]?.flags).toContain('≥300k retire')
  const line = summary(rows, 50_000, [{ kind: 'seven_day', percentUsed: 97 }, { kind: 'five_hour', percentUsed: 11 }], 0, DEFAULTS)
  expect(line).toBe('2 agents (1 running, 1 waiting) · 2 cold · 1 to retire')
  // The session's own numbers only when asked for
  expect(summary(rows, 50_000, [{ kind: 'seven_day', percentUsed: 97 }, { kind: 'five_hour', percentUsed: 11 }], 0, { ...DEFAULTS, showSession: true }))
    .toBe('2 agents (1 running, 1 waiting) · 2 cold · 1 to retire · main ctx 50k · seven day 97% !')
})

test('the guard refuses a cold big agent, and lets warm, small, unknown and overridden ones through', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'a1', 0, BIG, 60, 60_000)
  recordStep(ledger, 'small', 0, { input_tokens: 5_000 }, 60, 60_000)
  const agents = [{ id: 'a1', status: 'waiting', name: 'worker' }, { id: 'small', status: 'idle' }]
  expect(coldGuard({ to: 'worker', message: 'go' }, agents, ledger, 30 * MIN, DEFAULTS)).toBeUndefined()
  const deny = coldGuard({ to: 'worker', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS)
  expect(deny).toMatch(/idle 75 min.*152k/)
  expect(coldGuard({ to: 'a1', message: '[cache-ok] go' }, agents, ledger, 75 * MIN, DEFAULTS)).toBeUndefined()
  expect(coldGuard({ to: 'small', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS)).toBeUndefined()
  expect(coldGuard({ to: 'stranger', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS)).toBeUndefined()
  expect(coldGuard({ to: 'a1', message: 'go' }, agents, ledger, 75 * MIN, { ...DEFAULTS, coldGuard: false })).toBeUndefined()
})

test('the guard finds an agent by the name its Agent call gave, when the list lacks it', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'a9', 0, BIG, 60, 60_000)
  const agents = [{ id: 'a9', status: 'idle', description: 'build wait' }]
  expect(coldGuard({ to: 'worker', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS)).toBeUndefined()
  expect(coldGuard({ to: 'worker', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS, new Map([['worker', 'a9']]))).toMatch(/not sent/)
  expect(coldGuard({ to: 'build wait', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS)).toMatch(/not sent/)
})

test('tokens prints short counts', async () => {
  expect([tokens(undefined), tokens(950), tokens(12_400), tokens(1_150_000)]).toEqual(['-', '950', '12k', '1.1M'])
})

test('cells: an ended agent has no size flags and no colour; colors false draws plain; overrides apply', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'd', 0, BIG, 60, 60_000)
  recordStep(ledger, 'w', 0, BIG, 60, 60_000)
  const rows = buildRows([{ id: 'd', status: 'completed', description: 'done' }, { id: 'w', status: 'running', description: 'live' }], ledger, {}, 50 * 60_000, DEFAULTS)
  const done = rows.find(r => r.id === 'd')!
  expect(done.flags).toEqual([])
  expect(rowCells(done, DEFAULTS).every(c => c.dim && c.color === undefined)).toBe(true)
  const live = rows.find(r => r.id === 'w')!
  // 10 min of cache left is under cacheWarnMinutes (15): the warning colour
  expect(rowCells(live, DEFAULTS).find(c => c.text.startsWith('10m'))?.color).toBe('yellow')
  expect(rowCells(live, { ...DEFAULTS, colors: { running: 'blue' } })[2]?.color).toBe('blue')
  expect(rowCells(live, { ...DEFAULTS, colors: false }).some(c => c.color)).toBe(false)
  expect(rowText(live, DEFAULTS)).toMatch(/^🟢 live\s+running\s+152k\s+50m\s+10m$/)
})

test('the header names the columns over the same widths; emoji false drops the emoji column', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'w', 0, BIG, 60, 60_000)
  const [row] = buildRows([{ id: 'w', status: 'running', description: 'live' }], ledger, {}, 70 * 60_000, DEFAULTS)
  const head = headerCells(DEFAULTS).map(c => c.text).join('')
  expect(head.trimEnd()).toMatch(/^ {3}AGENT\s+STATE\s+CTX\s+IDLE\s+CACHE\s+FLAGS · NOTE$/)
  // Each column starts where its header does (the emoji counts as two columns, one UTF-16 unit more than its length here)
  expect(rowText(row!, DEFAULTS).indexOf('running')).toBe(head.indexOf('STATE'))
  const plain = { ...DEFAULTS, emoji: false }
  expect(rowText(row!, plain)).toMatch(/^live\s+running\s+152k\s+70m\s+expired\s+wake≈152k$/)
  expect(headerCells(plain).map(c => c.text).join('').indexOf('STATE')).toBe(rowText(row!, plain).indexOf('running'))
})

test('columnTint bands every other column on a fixed width; false divides columns with │ instead', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'w', 0, BIG, 60, 60_000)
  const [row] = buildRows([{ id: 'w', status: 'running', description: 'live' }], ledger, {}, 70 * 60_000, DEFAULTS)
  const cells = rowCells(row!, DEFAULTS)
  // Agent (with its emoji), ctx and cache are banded; state, idle and flags are not
  expect(cells.filter(c => c.bg).map(c => c.text.trim())).toEqual(['🟢', 'live', '152k', 'expired'])
  expect(cells.every(c => !c.bg || c.bg === DEFAULT_TINT)).toBe(true)
  expect(headerCells(DEFAULTS).filter(c => c.bg).map(c => c.text.trim())).toEqual(['', 'AGENT', 'CTX', 'CACHE'])
  // A colour of its own replaces the default
  expect(rowCells(row!, { ...DEFAULTS, columnTint: '#222222' }).find(c => c.bg)?.bg).toBe('#222222')
  // Off: no background anywhere, and a │ between the columns that lines up under the header's
  const off = { ...DEFAULTS, columnTint: false }
  expect(rowCells(row!, off).some(c => c.bg)).toBe(false)
  const head = headerCells(off).map(c => c.text).join('')
  const text = rowText(row!, off)
  expect(text.split('│').length).toBe(6)
  expect(text.indexOf('│')).toBe(head.indexOf('│'))
})

test('columnTint is read from the config as a boolean or a colour', async () => {
  expect(mergeConfig({}).columnTint).toBe(true)
  expect(mergeConfig({ columnTint: false }).columnTint).toBe(false)
  expect(mergeConfig({ columnTint: ' subtle ' }).columnTint).toBe('subtle')
  expect(mergeConfig({ columnTint: 5 }).columnTint).toBe(true)
})
