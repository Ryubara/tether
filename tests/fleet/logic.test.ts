// Unit tests of fleet's pure logic: config, ledger, rows and the cold-cache guard.
import { expect, test } from 'claude-code/testing'

import { DEFAULTS, mergeConfig } from '../../src/fleet/config'
import { coldGuard } from '../../src/fleet/guard'
import { recordStep, type Ledger } from '../../src/fleet/ledger'
import { buildRows, summary, tokens } from '../../src/fleet/rows'
import { DEFAULT_TINT, headerCells, legend, rowCells, rowText } from '../../src/fleet/cells'

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

test('a decided agent is never woken, warm or cold; an undecided warm one is; an undecided expired one is refused', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'a1', 0, BIG, 60, 60_000)
  recordStep(ledger, 'a2', 0, BIG, 60, 60_000)
  const agents = [{ id: 'a1', status: 'waiting', name: 'worker' }, { id: 'a2', status: 'waiting', name: 'other' }]
  const decisions = { a1: { decision: 'retired' as const, note: 'waits on CI', at: 't' } }
  // Warm (10 min idle) and decided: refused, with the decision named
  const deny = coldGuard({ to: 'worker', message: 'go' }, agents, ledger, 10 * MIN, DEFAULTS, new Map(), decisions)
  expect(deny).toMatch(/decided retired \(waits on CI\).*never woken.*fresh agent/)
  // Decided and cold too
  expect(coldGuard({ to: 'a1', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS, new Map(), decisions)).toMatch(/decided retired/)
  // The override token passes a decided agent
  expect(coldGuard({ to: 'a1', message: '[cache-ok] go' }, agents, ledger, 10 * MIN, DEFAULTS, new Map(), decisions)).toBeUndefined()
  // Undecided and warm: allowed (also past the 45-minute demand, before the cache expires)
  expect(coldGuard({ to: 'other', message: 'go' }, agents, ledger, 50 * MIN, DEFAULTS, new Map(), decisions)).toBeUndefined()
  // Undecided and expired: refused as before
  expect(coldGuard({ to: 'other', message: 'go' }, agents, ledger, 75 * MIN, DEFAULTS, new Map(), decisions)).toMatch(/idle 75 min/)
  // With the cold guard off nothing is refused
  expect(coldGuard({ to: 'a1', message: 'go' }, agents, ledger, 10 * MIN, { ...DEFAULTS, coldGuard: false }, new Map(), decisions)).toBeUndefined()
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

test('enabled defaults on and turns fleet off, which also stops the cold guard', async () => {
  expect(mergeConfig({}).enabled).toBe(true)
  expect(mergeConfig({ enabled: false }).enabled).toBe(false)
  expect(mergeConfig({ enabled: 'no' }).enabled).toBe(true)
  const ledger: Ledger = new Map()
  const cold = { ...DEFAULTS, enabled: false }
  expect(coldGuard({ to: 'a1', message: 'hi' } as any, [{ id: 'a1', status: 'waiting', description: 'x', type: 't' } as any], ledger, 0, cold, new Map())).toBeUndefined()
})

test('BIG-WAIT flags a big live agent whose note matches, only when configured', async () => {
  const ledger: Ledger = new Map()
  recordStep(ledger, 'big', 0, BIG, 60, 60_000)
  recordStep(ledger, 'busy', 0, BIG, 60, 60_000)
  recordStep(ledger, 'small', 0, { cache_read_input_tokens: 10_000 }, 60, 60_000)
  recordStep(ledger, 'plain', 0, BIG, 60, 60_000)
  const agents = [
    { id: 'big', status: 'waiting', description: 'builder' },
    { id: 'busy', status: 'running', description: 'writer' },
    { id: 'small', status: 'waiting', description: 'tiny' },
    { id: 'plain', status: 'waiting', description: 'no note' },
  ]
  const notes = { big: 'Waiting for build slot 2', busy: 'editing files', small: 'waiting for build' }
  const flagged = (cfg: typeof DEFAULTS) => buildRows(agents, ledger, notes, 10 * MIN, cfg).filter(r => r.flags.includes('BIG-WAIT')).map(r => r.id)
  // Off by default, whatever the notes say
  expect(flagged(DEFAULTS)).toEqual([])
  // On: context at the line and a note matching the pattern, case-insensitively
  expect(flagged({ ...DEFAULTS, bigWaitTokens: 100_000, bigWaitNote: '^waiting|queue' })).toEqual(['big'])
  // An empty pattern is any note, but an agent with no note never matches
  expect(flagged({ ...DEFAULTS, bigWaitTokens: 100_000 }).sort()).toEqual(['big', 'busy'])
  // A pattern that is not a regular expression matches nothing
  expect(flagged({ ...DEFAULTS, bigWaitTokens: 100_000, bigWaitNote: '(' })).toEqual([])
  // An ended agent is not flagged, and the summary counts the flag
  const cfg = { ...DEFAULTS, bigWaitTokens: 100_000, bigWaitNote: 'build' }
  const rows = buildRows([...agents, { id: 'big2', status: 'completed', description: 'old' }], ledger, { ...notes, big2: 'build' }, 10 * MIN, cfg)
  expect(rows.filter(r => r.flags.includes('BIG-WAIT')).map(r => r.id)).toEqual(['big'])
  expect(summary(rows, undefined, [], 0, cfg)).toContain('1 big-wait')
})

test('a BIG-WAIT flag is drawn in the FLAGS column of a row, with its legend', async () => {
  const row = { id: 'a', label: 'builder', state: 'waiting (bg work)', contextTokens: 200_000, note: 'build slot 2', flags: ['BIG-WAIT'] }
  const cfg = { ...DEFAULTS, emoji: false }
  expect(rowText(row, cfg)).toContain('BIG-WAIT · build slot 2')
  expect(legend([row], cfg)).toContain('BIG-WAIT: a big context that is only waiting')
  expect(mergeConfig({ bigWaitTokens: 120_000, bigWaitNote: ' build ' })).toMatchObject({ bigWaitTokens: 120_000, bigWaitNote: 'build' })
  expect(mergeConfig({ bigWaitTokens: -5 }).bigWaitTokens).toBe(0)
})
