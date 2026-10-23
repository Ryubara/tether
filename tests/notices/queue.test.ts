// Tests of the notice queue's delivery rules without the engine: a fake store, prompt and clock stand in for `$`.
import { expect, test } from 'claude-code/testing'

import { Notices, type NoticePorts, type WakeRules } from '../../src/notices/queue'
import type { Notice } from '../../src/notices/notice'

const SEC = 1000
const MIN = 60 * SEC

/** What the fake ports record and answer. */
type Fake = {
  now: number
  stored: unknown
  draft: string
  /** How a submit is answered: undefined takes it, a string drops it with that reason, `throw` fails. */
  answer?: string
  submits: string[]
  logs: string[]
  toasts: string[]
  changes: number
}

/** Fake ports over a plain object, so a test moves time and answers by hand. */
function ports(f: Fake): NoticePorts {
  return {
    now: async () => f.now,
    load: async () => f.stored,
    save: async list => {
      f.stored = list
    },
    draft: async () => f.draft,
    submit: async text => {
      f.submits.push(text)
      if (f.answer === 'throw') throw new Error('submit failed')
      return f.answer === undefined ? { text } : { drop: f.answer }
    },
    log: text => void f.logs.push(text),
    toast: text => void f.toasts.push(text),
    changed: async () => {
      f.changes++
    },
  }
}

/** A world at minute 10 with nothing stored. */
function fake(): Fake {
  return { now: 10 * MIN, stored: undefined, draft: '', submits: [], logs: [], toasts: [], changes: 0 }
}

const RULES: WakeRules = { gapSeconds: 60, deferMinutes: 10, resendAfterMinutes: 2, preamble: 'New:', plain: false }

/** A notice that wakes the model. */
function notice(key: string, at = 0, over: Partial<Notice> = {}): Notice {
  return { key, text: `text ${key}`, poller: 'p', title: 'P', wake: true, at, ...over }
}

test('a notice raised while the session is idle is told at once, and the queue empties', async () => {
  const f = fake()
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  expect((await q.pending(ports(f))).length).toBe(1)
  expect(q.count).toBe(1)
  await q.deliver(ports(f), RULES)
  expect(f.submits).toEqual(['New:\n\nP:\n- text a'])
  expect(f.stored).toEqual([])
  expect(q.lastWakeAt).toBe(f.now)
  expect(f.changes).toBe(1)
})

test('nothing is told during a turn; it goes when the turn ends', async () => {
  const f = fake()
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  q.turnStarted()
  await q.deliver(ports(f), RULES)
  expect(f.submits).toEqual([])
  expect(q.busy).toBe(true)
  q.turnEnded(f.now)
  expect(q.busy).toBe(false)
  expect(q.idleSince).toBe(f.now)
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
})

test('a draft holds the wake until the oldest notice has waited the defer limit', async () => {
  const f = fake()
  f.draft = 'half typed'
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  expect(f.submits).toEqual([])
  f.now += 10 * MIN
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
})

test('the gap after one wake holds the next', async () => {
  const f = fake()
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  q.turnStarted()
  q.turnEnded(f.now)
  await q.append(ports(f), notice('b', f.now))
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
  f.now += 61 * SEC
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(2)
})

test('a refused wake goes back to the queue, is told once, and holds the next try for the resend window', async () => {
  const f = fake()
  f.answer = 'a Stop stands'
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
  expect(f.stored).toEqual([notice('a', f.now)])
  expect(q.refused).toBe(true)
  expect(q.lastWakeAt).toBe(-Infinity)
  expect(f.logs).toEqual(['watch: wake refused: a Stop stands'])
  expect(f.toasts).toEqual(['watch: a wake was refused (a Stop stands); it is tried again in 2 min or after the next turn starts'])
  // Held: no retry storm
  f.now += 1 * MIN
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
  // Past the window it goes again, and the same reason is not told twice
  f.answer = undefined
  f.now += 1 * MIN + 1
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(2)
  expect(f.logs.length).toBe(1)
  expect(q.refused).toBe(false)
})

test('a failing submit is a refusal; a plain session is told only that a wake was refused', async () => {
  const f = fake()
  f.answer = 'throw'
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), { ...RULES, plain: true })
  expect(f.logs).toEqual(['watch: wake refused'])
  expect(f.toasts).toEqual(['watch: a wake was refused'])
  expect(f.stored).toEqual([notice('a', f.now)])
})

test('a turn that starts lifts the hold of a refusal', async () => {
  const f = fake()
  f.answer = 'a Stop stands'
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  f.answer = undefined
  q.turnStarted()
  q.turnEnded(f.now)
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(2)
})

test('a wake taken that starts no turn is resent once the session sat idle for the resend window', async () => {
  const f = fake()
  const q = new Notices()
  q.turnEnded(f.now)
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
  expect(q.held).toBe(true)
  // New notices meanwhile stack no second wake behind the first
  await q.merge(ports(f), [notice('b', f.now)])
  f.now += 1 * MIN
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
  f.now += 1 * MIN + 1
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(2)
  expect(f.submits[1]).toBe('New:\n\nP:\n- text a\n- text b')
  expect(f.logs).toContain('watch: the last wake started no turn; it is sent again')
})

test('a turn that starts clears the wake being waited for', async () => {
  const f = fake()
  const q = new Notices()
  q.turnEnded(f.now)
  await q.append(ports(f), notice('a', f.now))
  await q.deliver(ports(f), RULES)
  expect(q.held).toBe(true)
  q.turnStarted()
  expect(q.held).toBe(false)
  q.turnEnded(f.now)
  f.now += 10 * MIN
  await q.deliver(ports(f), RULES)
  expect(f.submits.length).toBe(1)
})

test('append keeps every notice told as it comes; merge puts one back once', async () => {
  const f = fake()
  const q = new Notices()
  await q.append(ports(f), notice('a'))
  await q.append(ports(f), notice('a'))
  expect(f.stored).toEqual([notice('a'), notice('a')])
  f.stored = [notice('a')]
  await q.merge(ports(f), [notice('a'), notice('b')])
  expect(f.stored).toEqual([notice('a'), notice('b')])
  // The count is the one of the last read, which the status line shows without reading the store
  expect(q.count).toBe(1)
  await q.pending(ports(f))
  expect(q.count).toBe(2)
})

test('two deliveries at once send the notices once', async () => {
  const f = fake()
  const q = new Notices()
  await q.append(ports(f), notice('a', f.now))
  await Promise.all([q.deliver(ports(f), RULES), q.deliver(ports(f), RULES)])
  expect(f.submits.length).toBe(1)
})

test('with nothing queued the idle step runs, with the time and whether a wake is held', async () => {
  const f = fake()
  const q = new Notices()
  const seen: Array<[number, boolean]> = []
  await q.deliver(ports(f), RULES, async (now, held) => void seen.push([now, held]))
  expect(seen).toEqual([[f.now, false]])
})

test('a wake submitted for no notices (the idle wake) is held and resent like any other, with nothing to put back', async () => {
  const f = fake()
  const q = new Notices()
  q.turnEnded(f.now)
  await q.submit(ports(f), RULES, f.now, 'Nothing new', [])
  expect(f.submits).toEqual(['Nothing new'])
  expect(q.held).toBe(true)
  f.now += 2 * MIN
  await q.deliver(ports(f), RULES)
  expect(q.held).toBe(false)
  expect(f.stored).toBeUndefined()
})
