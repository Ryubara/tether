// Tests of how notices reach the model: never during a turn, not while typing, a refusal held and retried, a lost wake resent.
// A command poller is the vehicle; the rules under test are the notice queue's.
import { expect, test } from 'claude-code/testing'

import { MIN, PRS, SEC, start, world } from '../watch/world'

test('a draft in the prompt box holds the wake until it is sent or the defer limit passes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.draft = 'half typed'
  const clock = await start($, on, { ...PRS, deferWhileTypingMinutes: 2 }, w)
  await clock.advance(1 * MIN)
  expect(w.submits).toEqual([])
  await clock.advance(1 * MIN + 10 * SEC)
  expect(w.submits.length).toBe(1)

  // Typing again later: emptied box releases the wake at the next check
  w.runs = [{ exitCode: 0, stdout: '- #15 new: conflict\n' }]
  await clock.advance(5 * MIN - 1 * MIN)
  expect(w.submits.length).toBe(1)
  w.draft = ''
  await clock.advance(6 * SEC)
  expect(w.submits.length).toBe(2)
})

test('no wake while a turn runs; it goes when the turn completes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, PRS, w)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await clock.advance(30 * SEC)
  expect(w.submits).toEqual([])
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await clock.settle()
  expect(w.submits.length).toBe(1)
})

test('a wake the engine refuses is told once, and the findings are sent again after resendAfterMinutes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'a Stop stands'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  expect(w.toasts.filter(t => t.includes('refused (a Stop stands)')).length).toBe(1)
  expect(w.statuses.at(-1)).toContain('wake refused')
  // Held for two minutes: no retry storm meanwhile
  await clock.advance(1 * MIN)
  expect(w.submits.length).toBe(1)
  w.answer = undefined
  await clock.advance(1 * MIN + 10 * SEC)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('#12 fix-x: conflict')
  await clock.advance(10 * MIN)
  expect(w.submits.length).toBe(2)
})

test('a refused wake goes again as soon as a turn of the person has run', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'a Stop stands'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  w.answer = undefined
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await clock.advance(6 * SEC)
  expect(w.submits.length).toBe(2)
})

test('a wake taken that starts no turn is sent again once the session sat idle resendAfterMinutes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'no-turn'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  // New findings meanwhile do not stack a second wake behind the first
  w.runs = [{ exitCode: 0, stdout: '- #12 fix-x: conflict\n- #13 y: conflict\n' }]
  await $.command.run({ command: 'tether-watch', args: 'run prs' } as any)
  await clock.advance(1 * MIN + 30 * SEC)
  expect(w.submits.length).toBe(1)
  w.answer = undefined
  await clock.advance(40 * SEC)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toMatch(/- #12 fix-x: conflict\n- #13 y: conflict$/)
  expect(w.logs).toContain('watch: the last wake started no turn; it is sent again')
})

test('a subagent turn leaves the session free for a wake', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, PRS, w)
  await $.turn.start({ text: 'work', turnId: 'a', agentId: 'a1' } as any)
  await clock.advance(10 * SEC)
  expect(w.submits.length).toBe(1)
})
