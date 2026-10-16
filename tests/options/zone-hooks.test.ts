// The config rules against the engine's test kit: TETHER_CONFIG, failing closed, a locked file, the network rule
// and allowedCommands, each through the whole plugin.
import { expect, test } from 'claude-code/testing'

import { HALT_TEXT } from '../../src/options/policy'
import { MIN, command, start, step, stopHook, world, type World } from './world'

const ZONE = '/zone/tether-zone.json'
/** A project file that must never be read while TETHER_CONFIG names another, or a locked file is in use. */
const PROJECT = { '.claude/tether.json': JSON.stringify({ watch: { pollers: [{ id: 'proj', command: ['node', 'project.js'], everySeconds: 60 }] } }) }
const HANDOFF = { 'HANDOFF.md': '# HANDOFF\n\n## Where to look\n\nx\n' }

/** Everything Tether did that a halted Tether must not do. */
function quiet(w: World): void {
  expect(w.runs).toEqual([])
  expect(w.writes).toEqual({})
  expect(w.storeWrites).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.sent).toEqual([])
  expect(w.reads.some(p => p.endsWith('.claude/tether.json'))).toBe(false)
}

/** Drives a halted Tether through every entry point and checks it does nothing and says only the fixed text. */
async function haltedEverywhere($: any, w: World, clock: any): Promise<void> {
  w.agents = [{ id: 'a1', status: 'waiting', description: 'worker' }]
  await step($, 'a1')
  await clock.advance(70 * MIN)
  await $.turn.complete({ turnId: 't', answer: '' } as any)
  expect(w.statuses[w.statuses.length - 1]).toBe(HALT_TEXT)
  expect(w.toasts).toEqual([HALT_TEXT])
  expect((await stopHook($))?.block).toBeUndefined()
  expect(await command($, 'tether-fleet', 'text')).toBe(HALT_TEXT)
  expect(await command($, 'tether-watch')).toBe(HALT_TEXT)
  expect(await command($, 'tether-guards')).toBe(HALT_TEXT)
  expect(((await $.tool.call({ tool: 'mcp__tether__agent_decision', id: 'a1', decision: 'done' } as any)) as any).deny).toBe(HALT_TEXT)
  // The SendMessage guard does not act either
  expect(((await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'hi' } as any)) as any).deny).toBeUndefined()
  // No handoff is added at session start, whatever the options say
  const ss: any = await ($ as any).classic.SessionStart({ source: 'startup' })
  expect(ss?.additionalContext).toBeUndefined()
  quiet(w)
}

/** Options that would turn things on if Tether fell back to them. */
const LOUD = { checkpointEnabled: true, checkpointInjectHandoff: true, conversationsEnabled: true, housekeepingEnabled: true }

test('TETHER_CONFIG naming a missing file turns everything off and says so once', { timeoutMs: 30_000, options: LOUD }, async ($, on) => {
  const w = world({ env: { TETHER_CONFIG: ZONE }, files: { ...PROJECT, ...HANDOFF } })
  const clock = await start($, on, w)
  await haltedEverywhere($, w, clock)
})

test('TETHER_CONFIG naming a file that is not valid turns everything off', { timeoutMs: 30_000, options: LOUD }, async ($, on) => {
  const w = world({ env: { TETHER_CONFIG: ZONE }, files: { ...PROJECT, ...HANDOFF, [ZONE]: JSON.stringify({ netwrok: false }) } })
  const clock = await start($, on, w)
  await haltedEverywhere($, w, clock)
})

test('TETHER_CONFIG that is not an absolute path turns everything off', { timeoutMs: 30_000, options: LOUD }, async ($, on) => {
  const w = world({ env: { TETHER_CONFIG: '.claude/tether.json' }, files: { ...PROJECT, ...HANDOFF } })
  const clock = await start($, on, w)
  await haltedEverywhere($, w, clock)
})

test('a locked file that turns on a policy key with a wrong type turns everything off', { timeoutMs: 30_000, options: { ...LOUD, configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { ...PROJECT, ...HANDOFF, 'team-zone.json': JSON.stringify({ locked: true, plainOutput: 'yes' }) } })
  const clock = await start($, on, w)
  await haltedEverywhere($, w, clock)
})

test('TETHER_CONFIG wins over the configPath option and the project file', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const files = { ...PROJECT, 'team-zone.json': JSON.stringify({ fleet: { enabled: false } }), [ZONE]: JSON.stringify({ watch: { pollers: [{ id: 'zone', command: ['node', 'zone.js'], everySeconds: 60 }] } }) }
  const w = world({ env: { TETHER_CONFIG: ZONE }, files })
  const clock = await start($, on, w)
  await clock.advance(1 * MIN)
  expect(w.reads.filter(p => p.endsWith('.json')).map(p => p.replace(/^[A-Za-z]:/, ''))).toEqual([ZONE])
  expect(w.runs.some(a => a.join(' ') === 'node zone.js')).toBe(true)
  expect(w.runs.some(a => a.join(' ') === 'node project.js')).toBe(false)
})

test('a locked file ignores the plugin options: its own values and the defaults decide', { timeoutMs: 30_000, options: { fleetEmoji: false, configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { ...PROJECT, 'team-zone.json': JSON.stringify({ locked: true, housekeeping: { enabled: false } }) } })
  w.agents = [{ id: 'a1', status: 'waiting', description: 'worker' }]
  await start($, on, w)
  // fleetEmoji: false is an option, so it does not count: the pane keeps its default emoji
  expect(await command($, 'tether-fleet', 'text')).toContain('⏳')
})

test('reload re-reads only the same locked file, and a locked file that goes missing turns everything off', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const locked = JSON.stringify({ locked: true, housekeeping: { enabled: false }, conversations: { enabled: false }, watch: { pollers: [{ id: 'zone', command: ['node', 'zone.js'], everySeconds: 60 }] } })
  const w = world({ files: { ...PROJECT, 'team-zone.json': locked } })
  const clock = await start($, on, w)
  await clock.advance(1 * MIN)
  expect(w.runs.length).toBeGreaterThan(0)
  delete w.files['team-zone.json']
  expect(await command($, 'tether-watch', 'reload')).toBe(HALT_TEXT)
  expect(w.statuses[w.statuses.length - 1]).toBe(HALT_TEXT)
  expect(w.toasts).toEqual([HALT_TEXT])
  const before = w.runs.length
  await clock.advance(10 * MIN)
  expect(w.runs.length).toBe(before)
  expect(w.reads.some(p => p.endsWith('.claude/tether.json'))).toBe(false)
  // The file back, a reload brings Tether back
  w.files['team-zone.json'] = locked
  expect(await command($, 'tether-watch', 'reload')).toContain('watch: team-zone.json, 1 pollers')
  await clock.advance(2 * MIN)
  expect(w.runs.length).toBeGreaterThan(before)
})

test('network false: no prs poller, no gh or curl command; refusals are told by a code, not the command', { timeoutMs: 30_000 }, async ($, on) => {
  const config = {
    network: false,
    housekeeping: { enabled: false },
    conversations: { enabled: false },
    fleet: { annotate: { command: ['curl', 'https://example.invalid/notes'], everySeconds: 60 } },
    watch: {
      pollers: [
        { id: 'prs', kind: 'prs', everySeconds: 60 },
        { id: 'remote', command: ['C:\\Tools\\GH.exe', 'api', 'secret-route'], everySeconds: 60 },
        { id: 'fetcher', command: ['git', '-C', 'repo', 'fetch', 'origin'], everySeconds: 60 },
        { id: 'local', command: ['node', 'check.js'], everySeconds: 60 },
      ],
    },
  }
  const w = world({ files: { '.claude/tether.json': JSON.stringify(config) }, answer: () => ({ exitCode: 0, stdout: '' }) })
  const clock = await start($, on, w)
  await clock.advance(2 * MIN)
  expect(w.runs.map(a => a.join(' '))).toEqual(expect.arrayContaining(['node check.js']))
  expect(w.runs.every(a => a.join(' ') === 'node check.js')).toBe(true)
  const report = await command($, 'tether-watch')
  expect(report).not.toMatch(/- prs /)
  expect(report).toMatch(/- remote .*FAILED .*: refused:network$/m)
  expect(report).toMatch(/- fetcher .*FAILED .*: refused:network$/m)
  expect(report).not.toContain('secret-route')
  expect(w.logs).toContain('watch: prs is off (network is false)')
  expect(w.logs).toContain('fleet: annotate command failed: Error: refused:network')
  expect(w.logs.join('\n')).not.toContain('example.invalid')
})

test('allowedCommands runs only the listed argv prefixes, Tether\'s own commands included', { timeoutMs: 30_000 }, async ($, on) => {
  const config = {
    allowedCommands: [['node', 'check.js']],
    conversations: { enabled: false },
    watch: { pollers: [{ id: 'ok', command: ['node', 'check.js', '--all'], everySeconds: 60 }, { id: 'other', command: ['node', 'other.js'], everySeconds: 60 }] },
  }
  const w = world({ files: { '.claude/tether.json': JSON.stringify(config) }, answer: () => ({ exitCode: 0, stdout: '' }) })
  const clock = await start($, on, w)
  await clock.advance(2 * MIN)
  // Housekeeping's git rev-parse is not listed, so it does not run either
  expect([...new Set(w.runs.map(a => a.join(' ')))]).toEqual(['node check.js --all'])
  expect(await command($, 'tether-watch')).toMatch(/- other .*FAILED .*: refused:not-allowed$/m)
})
