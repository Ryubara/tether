// fleet.openOnStart and watch.openOnStart: the panes open, without focus, when a session starts; only while that
// part is on and the config has not failed closed.
import { expect, test } from 'claude-code/testing'

import { SEC, start, world, type World } from './world'

const ZONE = '/zone/tether-zone.json'

/** The pane ids Tether opened, once the start's unawaited opens have run. */
async function openedIds(w: World, clock: any): Promise<string[]> {
  await clock.advance(1 * SEC)
  return w.opened.map(o => String(o.id))
}

test('fleetOpenOnStart opens the Fleet pane at start, without focus', { timeoutMs: 30_000, options: { fleetOpenOnStart: true, fleetPaneColumns: 60 } }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['fleet'])
  expect(w.opened[0]).toMatchObject({ id: 'fleet', title: 'Fleet', columns: 60 })
  expect(w.opened[0]?.focus).toBeUndefined()
})

test('watch.openOnStart in the config file opens the Watch pane at start, without focus', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ watch: { openOnStart: true, pane: { rows: 9 } } }) } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['watch'])
  expect(w.opened[0]).toMatchObject({ id: 'watch', title: 'Watch', rows: 9 })
  expect(w.opened[0]?.focus).toBeUndefined()
})

test('both panes open at every session start, and a locked file can turn them on', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { 'team-zone.json': JSON.stringify({ locked: true, fleet: { openOnStart: true }, watch: { openOnStart: true } }) } })
  const clock = await start($, on, w)
  expect((await openedIds(w, clock)).sort()).toEqual(['fleet', 'watch'])
  // A resumed or cleared session starts again, and the panes are asked for again
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  expect((await openedIds(w, clock)).sort()).toEqual(['fleet', 'fleet', 'watch', 'watch'])
})

test('no pane opens at start when the options are off', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual([])
})

test('no pane opens at start when its part is off', { timeoutMs: 30_000, options: { fleetOpenOnStart: true, watchOpenOnStart: true, fleetEnabled: false } }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ watch: { enabled: false } }) } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual([])
})

test('no pane opens at start when the config fails closed', { timeoutMs: 30_000, options: { fleetOpenOnStart: true, watchOpenOnStart: true } }, async ($, on) => {
  const w = world({ env: { TETHER_CONFIG: ZONE } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual([])
})

test('an openOnStart of the wrong type in a locked file fails closed', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { 'team-zone.json': JSON.stringify({ locked: true, fleet: { openOnStart: 'yes' }, watch: { openOnStart: true } }) } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual([])
})
