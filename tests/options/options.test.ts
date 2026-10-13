// The plugin's options: the table's defaults are the sections' own defaults, and an option is a default the project's file overrides.
import { expect, mock, test } from 'claude-code/testing'

import { CHECKPOINT_DEFAULTS, mergeCheckpoint } from '../../src/checkpoint/config'
import { DEFAULTS as FLEET_DEFAULTS, mergeConfig } from '../../src/fleet/config'
import { CONVERSATIONS_DEFAULTS, HOUSEKEEPING_DEFAULTS, STOP_DEFAULTS, mergeConversations, mergeHousekeeping, mergeStop } from '../../src/housekeeping/config'
import { OPTIONS, PANES, fromOptions, layered } from '../../src/options/options'
import { DEFAULTS as WATCH_DEFAULTS, parseConfig } from '../../src/watch/config'

/** The options as Claude Code hands them over when nobody has changed anything: every default. */
const defaults = Object.fromEntries([...OPTIONS, ...PANES].map(e => [e.option, e.default]))

test('every option has a unique name, a title, a description and a default of its own type', async () => {
  const names = [...OPTIONS, ...PANES].map(e => e.option)
  expect(new Set(names).size).toBe(names.length)
  for (const e of OPTIONS) expect(typeof e.default, e.option).toBe(e.kind)
  for (const e of [...OPTIONS, ...PANES]) expect(e.title.length > 0 && e.description.length > 0, e.option).toBe(true)
})

test('the option defaults reproduce every section\'s own defaults', async () => {
  expect(mergeCheckpoint(layered(defaults, 'checkpoint', undefined))).toEqual(CHECKPOINT_DEFAULTS)
  expect(mergeConfig(layered(defaults, 'fleet', undefined))).toEqual(FLEET_DEFAULTS)
  expect(parseConfig(layered(defaults, 'watch', undefined)).config).toEqual(WATCH_DEFAULTS)
  expect(mergeHousekeeping(layered(defaults, 'housekeeping', undefined))).toEqual(HOUSEKEEPING_DEFAULTS)
  expect(mergeConversations(layered(defaults, 'conversations', undefined))).toEqual(CONVERSATIONS_DEFAULTS)
  expect(mergeStop(layered(defaults, 'stop', undefined))).toEqual(STOP_DEFAULTS)
})

test('an option reaches its section, and the project file wins', async () => {
  const o = { checkpointContextTokens: 150_000, checkpointMaxRepairs: 5, fleetRetireContextTokens: 250_000, fleetColdGuard: false, watchMinWakeGapSeconds: 120, stopMaxBlocks: 2, conversationsMinSeconds: 90, housekeepingFolder: '.hold' }
  expect(mergeCheckpoint(layered(o, 'checkpoint', undefined))).toMatchObject({ contextTokens: 150_000, maxRepairs: 5 })
  expect(mergeCheckpoint(layered(o, 'checkpoint', { contextTokens: 99_000 }))).toMatchObject({ contextTokens: 99_000, maxRepairs: 5 })
  expect(mergeConfig(layered(o, 'fleet', undefined))).toMatchObject({ retireContextTokens: 250_000, coldGuard: false })
  expect(mergeConfig(layered(o, 'fleet', { coldGuard: true }))).toMatchObject({ retireContextTokens: 250_000, coldGuard: true })
  expect(parseConfig(layered(o, 'watch', undefined)).config.minWakeGapSeconds).toBe(120)
  expect(parseConfig(layered(o, 'watch', { minWakeGapSeconds: 30 })).config.minWakeGapSeconds).toBe(30)
  expect(mergeStop(layered(o, 'stop', undefined)).maxBlocks).toBe(2)
  expect(mergeConversations(layered(o, 'conversations', undefined)).minSeconds).toBe(90)
  expect(mergeHousekeeping(layered(o, 'housekeeping', undefined)).folder).toBe('.hold')
})

test('empty text and zero mean not set; a file section that is not an object is ignored', async () => {
  expect(fromOptions({ checkpointHandoffFile: '  ', checkpointMaxChars: 0, fleetOverrideToken: '', fleetColumnTint: '' }, 'checkpoint')).toEqual({})
  expect(fromOptions({ fleetOverrideToken: '', fleetColumnTint: '' }, 'fleet')).toEqual({})
  expect(layered({ stopMaxBlocks: 2 }, 'stop', 'nope')).toEqual({ maxBlocks: 2 })
  expect(layered({ stopMaxBlocks: 2 }, 'stop', ['x'])).toEqual({ maxBlocks: 2 })
})

test('column tint reads true and false as booleans, anything else as a colour; the watch countdown may be 0', async () => {
  expect(fromOptions({ fleetColumnTint: 'false' }, 'fleet').columnTint).toBe(false)
  expect(fromOptions({ fleetColumnTint: 'true' }, 'fleet').columnTint).toBe(true)
  expect(fromOptions({ fleetColumnTint: '#202020' }, 'fleet').columnTint).toBe('#202020')
  expect(parseConfig(layered({ watchTickSeconds: 0 }, 'watch', undefined)).config.tickSeconds).toBe(0)
})

test('pane options become the pane object of their own section; a file pane replaces it', async () => {
  const o = { fleetPaneRows: 12, watchPaneColumns: 40 }
  expect(mergeConfig(layered(o, 'fleet', undefined)).pane).toEqual({ rows: 12 })
  expect(parseConfig(layered(o, 'watch', undefined)).config.pane).toEqual({ columns: 40 })
  expect(mergeConfig(layered(o, 'fleet', { pane: { columns: 30 } })).pane).toEqual({ columns: 30 })
})

/** Starts a session with no config file and one waiting agent, under the given options. */
async function fleetText($: any, on: any): Promise<string> {
  const stub = on as any
  mock.clock(on)
  stub('session.start', () => ({ cwd: '/work' }))
  stub('command.register', () => ({ value: undefined }))
  stub('tool.register', () => ({ value: { tool: 'x' } }))
  stub('ui.log', () => ({ value: undefined }))
  stub('store.get', () => ({ value: undefined }))
  stub('fs.exists', () => ({ value: false }))
  stub('agent.list', () => ({ value: [{ id: 'a9', status: 'waiting', description: 'build wait' }] }))
  stub('session.usage', () => ({ value: { rateLimits: [] } }))
  stub('ui.status', () => ({ value: undefined }))
  stub('ui.invalidate', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return ((await $.command.run({ command: 'tether-fleet', args: 'text' } as any)) as any).text
}

test('the plugin reads its options: an off switch reaches the pane (here, no emoji)', { timeoutMs: 30_000, options: { fleetEmoji: false } }, async ($, on) => {
  const text = await fleetText($, on)
  expect(text).toMatch(/^build wait\s+waiting/m)
  expect(text).not.toContain('⏳')
})

test('without that option the pane draws its emoji', { timeoutMs: 30_000, options: { fleetEmoji: true } }, async ($, on) => {
  expect(await fleetText($, on)).toContain('⏳')
})
