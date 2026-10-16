// cacheGuard.registerTools: the guard tools (pr_owner, agent_decision) are registered only while it is on. That off
// never blocks the Stop hook is held in tests/guards/hooks.test.ts.
import { expect, test } from 'claude-code/testing'

import { SEC, start, world } from './world'

const TOOLS = ['pr_owner', 'agent_decision']

test('the guard tools are registered by default', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  await clock.advance(1 * SEC)
  expect(w.registered).toEqual(TOOLS)
})

test('cacheGuard.registerTools false in a locked file registers no tool', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { 'team-zone.json': JSON.stringify({ locked: true, cacheGuard: { registerTools: false } }) } })
  const clock = await start($, on, w)
  await clock.advance(1 * SEC)
  expect(w.registered).toEqual([])
})

test('the option turns the tools off too', { timeoutMs: 30_000, options: { cacheGuardRegisterTools: false } }, async ($, on) => {
  const w = world()
  const clock = await start($, on, w)
  await clock.advance(1 * SEC)
  expect(w.registered).toEqual([])
})

test('a registerTools of the wrong type in a locked file fails closed: no tool', { timeoutMs: 30_000, options: { configPath: 'team-zone.json' } }, async ($, on) => {
  const w = world({ files: { 'team-zone.json': JSON.stringify({ locked: true, cacheGuard: { registerTools: 'no' } }) } })
  const clock = await start($, on, w)
  await clock.advance(1 * SEC)
  expect(w.registered).toEqual([])
})
