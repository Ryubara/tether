// Tests of the notice queue's pure rules: when a wake goes, what it says and how findings are put back.
import { expect, test } from 'claude-code/testing'

import { requeue, wakeText, wakeVerdict, type Notice } from '../../src/notices/notice'

const MIN = 60_000

test('wakeVerdict waits for the turn, the gap and a draft (up to the defer limit)', async () => {
  const pend: Notice[] = [{ key: 'k', text: 't', poller: 'p', title: 'P', wake: true, at: 0 }]
  const base = { busy: false, draft: '', now: 5 * MIN, lastWakeAt: 0, gapSeconds: 60, deferMinutes: 10 }
  expect(wakeVerdict([], base)).toBe('nothing')
  expect(wakeVerdict([{ ...pend[0]!, wake: false }], base)).toBe('nothing')
  expect(wakeVerdict(pend, base)).toBe('go')
  expect(wakeVerdict(pend, { ...base, busy: true })).toBe('busy')
  expect(wakeVerdict(pend, { ...base, lastWakeAt: 4.5 * MIN })).toBe('gap')
  expect(wakeVerdict(pend, { ...base, draft: 'half typed' })).toBe('typing')
  expect(wakeVerdict(pend, { ...base, draft: 'half typed', now: 11 * MIN })).toBe('go')
})

test('wakeText groups findings under their poller titles', async () => {
  const p = (title: string, text: string): Notice => ({ key: text, text, poller: title, title, wake: true, at: 0 })
  expect(wakeText('New:', [p('PRs', 'one'), p('Disk', 'low'), p('PRs', 'two')])).toBe('New:\n\nPRs:\n- one\n- two\n\nDisk:\n- low')
})

test('a reminder is marked in the wake text', async () => {
  const pend = (text: string, again?: boolean): Notice => ({ key: text, text, poller: 'p', title: 'P', wake: true, at: 0, ...(again ? { again } : {}) })
  expect(wakeText('W', [pend('#1 x'), pend('#2 y', true)])).toBe('W\n\nP:\n- #1 x\n- #2 y (still reported)')
})

test('requeue puts findings back once, ahead of the ones that joined meanwhile', async () => {
  const pend = (poller: string, key: string): Notice => ({ key, text: key, poller, title: poller, wake: true, at: 0 })
  expect(requeue([pend('a', '1'), pend('a', '2')], [pend('a', '2'), pend('b', '2'), pend('a', '3')]).map(p => `${p.poller}${p.key}`)).toEqual(['a1', 'a2', 'b2', 'a3'])
})

test('wakeVerdict holds a wake while the last one waits for its turn or was refused', async () => {
  const pending: Notice[] = [{ key: 'k', text: 't', poller: 'p', title: 'P', wake: true, at: 0 }]
  const s = { busy: false, draft: '', now: 10 * MIN, lastWakeAt: 0, gapSeconds: 60, deferMinutes: 10 }
  expect(wakeVerdict(pending, s)).toBe('go')
  expect(wakeVerdict(pending, { ...s, held: true })).toBe('held')
})
