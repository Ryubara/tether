// fleet.openOnStart and watch.openOnStart: the one Tether pane opens, without focus, when a session starts; only
// while a part that asks for it is on and the config has not failed closed.
import { expect, test } from 'claude-code/testing'

import { clearSession, SEC, start, world, type World } from './world'

const ZONE = '/zone/tether-zone.json'

/** The pane ids Tether opened, once the start's unawaited opens have run. */
async function openedIds(w: World, clock: any): Promise<string[]> {
  await clock.advance(1 * SEC)
  return w.opened.map(o => String(o.id))
}

test('fleetOpenOnStart opens the Tether pane at start, without focus', { timeoutMs: 30_000, options: { fleetOpenOnStart: true, fleetPaneColumns: 60 } }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['tether'])
  expect(w.opened[0]).toMatchObject({ id: 'tether', title: 'Tether', columns: 60 })
  expect(w.opened[0]?.focus).toBeUndefined()
})

test('watch.openOnStart in the config file opens the same pane, with watch.pane filling what fleet.pane leaves', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ fleet: { pane: { columns: 50 } }, watch: { openOnStart: true, pane: { rows: 9, columns: 30 } } }) } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['tether'])
  expect(w.opened[0]).toMatchObject({ id: 'tether', title: 'Tether', rows: 9, columns: 50 })
  expect(w.opened[0]?.focus).toBeUndefined()
})

test('both parts asking open the one pane once, at every session start; a locked file can turn it on', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { 'team-zone.json': JSON.stringify({ locked: true, fleet: { openOnStart: true }, watch: { openOnStart: true } }) } })
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['tether'])
  // A resumed session starts again, and the pane is asked for again
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  expect(await openedIds(w, clock)).toEqual(['tether', 'tether'])
})

test('a clear, which no session start follows, opens the pane again', { timeoutMs: 30_000, options: { fleetOpenOnStart: true } }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['tether'])
  await clearSession($, w)
  expect(await openedIds(w, clock)).toEqual(['tether', 'tether'])
})

test('only the part asking counts: watch off, fleet asking, the pane still opens', { timeoutMs: 30_000, options: { fleetOpenOnStart: true, watchEnabled: false } }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  expect(await openedIds(w, clock)).toEqual(['tether'])
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
