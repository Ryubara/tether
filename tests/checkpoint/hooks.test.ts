// The checkpoint in the whole plugin, around a clear: any clear starts the cycle over with the old context
// forgotten, Tether's own clear continues from the handoff even when the new session starts after the command
// returns, and a clear that did not happen waits `retryMinutes` before asking again. Synthetic data only.
import { expect, test } from 'claude-code/testing'

import { clearSession, command, MIN, SEC, start, step, world, type World } from '../options/world'

const HANDOFF = '## Where to look\nx\n## Summary\nx\n## Next steps\nx\n## Open questions\nx\n'
const CONFIG = JSON.stringify({ checkpoint: { enabled: true, contextTokens: 100_000, quietSeconds: 5, tickSeconds: 1, retryMinutes: 10 } })

const asks = (w: World) => w.submits.filter(t => t.startsWith('Checkpoint:')).length
const continues = (w: World) => w.submits.filter(t => t === 'Continue from HANDOFF.md.').length

/** A long session (context over the threshold) with a passing handoff, the clear command answered by `clear`. */
async function longSession($: any, on: any, clear: (w: World) => unknown) {
  const w = world({ context: 150_000, files: { '.claude/tether.json': CONFIG, 'HANDOFF.md': HANDOFF } })
  on('command.run', ($: any, e: any, next: any) => (e.command === 'clear' ? clear(w) : next(e)))
  const clock = await start($, on, w)
  await step($, 'main')
  return { w, clock }
}

test('a long, quiet session is asked for its handoff (the setup the other tests rely on)', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(3 * SEC)
  expect(asks(w)).toBe(1)
})

test('after a clear by the person, the new session is not asked at once: the old context is forgotten', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clearSession($, w)
  await clock.advance(30 * SEC)
  expect(asks(w)).toBe(0)
  expect(continues(w)).toBe(0)
  // Once the new session is long itself, the checkpoint is due again
  await step($, 'main')
  await clock.advance(3 * SEC)
  expect(asks(w)).toBe(1)
})

test('a clear by the person while a handoff is asked for starts the cycle over', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(2 * SEC)
  expect(asks(w)).toBe(1)
  await clearSession($, w)
  await clock.advance(60 * SEC)
  expect(asks(w)).toBe(1)
  expect(continues(w)).toBe(0)
  expect(w.toasts.filter(t => t.includes('checkpoint'))).toEqual([])
})

test("Tether's clear continues from the handoff when the new session starts after the command returns", { timeoutMs: 30_000 }, async ($, on) => {
  let cleared = false
  const { w, clock } = await longSession($, on, () => {
    cleared = true
    return {}
  })
  await clock.advance(10 * SEC)
  expect(asks(w)).toBe(1)
  expect(cleared).toBe(true)
  // The new session starts a moment later, not inside the command
  await clearSession($, w)
  await clock.advance(60 * SEC)
  expect(continues(w)).toBe(1)
  expect(asks(w)).toBe(1)
  expect(w.toasts).not.toContain('checkpoint: the clear did not happen')
})

test('a clear that never starts a new session is told once, and the handoff is asked for again only after retryMinutes', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(45 * SEC)
  expect(asks(w)).toBe(1)
  expect(w.toasts.filter(t => t === 'checkpoint: the clear did not happen')).toHaveLength(1)
  await clock.advance(9 * MIN)
  expect(asks(w)).toBe(1)
  await clock.advance(2 * MIN)
  expect(asks(w)).toBe(2)
})

test('a clear command that fails backs off the same way', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => {
    throw new Error('no clear here')
  })
  await clock.advance(10 * SEC)
  expect(asks(w)).toBe(1)
  expect(w.toasts).toContain('checkpoint: the clear did not happen')
  await clock.advance(5 * MIN)
  expect(asks(w)).toBe(1)
  expect(continues(w)).toBe(0)
})

test('a clear that ends the conversation inside the command continues once the new session is in', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, async (w: World) => {
    await clearSession($, w)
    return {}
  })
  await clock.advance(10 * SEC)
  expect(asks(w)).toBe(1)
  await clock.advance(60 * SEC)
  expect(continues(w)).toBe(1)
  expect(w.logs).toContain('checkpoint: cleared; continuing from HANDOFF.md')
  expect(w.toasts).not.toContain('checkpoint: the clear did not happen')
})

test('the continue waits until the process runs under the new session id', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(10 * SEC)
  expect(asks(w)).toBe(1)
  // The conversation ends, but the new id is not in yet
  await ($ as any).session.end({ reason: 'clear', sessionId: w.sessionId, resume: { id: w.sessionId } })
  await clock.advance(5 * SEC)
  expect(continues(w)).toBe(0)
  w.sessionId = 'abcdef12-0001'
  await clock.advance(2 * SEC)
  expect(continues(w)).toBe(1)
  await clock.advance(60 * SEC)
  expect(continues(w)).toBe(1)
})

test('a session end that is not a clear does not continue', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(10 * SEC)
  await ($ as any).session.end({ reason: 'other', sessionId: w.sessionId, resume: { id: w.sessionId } })
  await clock.advance(60 * SEC)
  expect(continues(w)).toBe(0)
})

test('a session with history is cleared after the reply to the ask, not asked to update the handoff', { timeoutMs: 30_000 }, async ($, on) => {
  let cleared = false
  const history = [
    { role: 'user', text: 'first request' },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: 'second request' },
    { role: 'assistant', text: 'second answer' },
  ]
  const w = world({ context: 150_000, messages: [...history], files: { '.claude/tether.json': CONFIG, 'HANDOFF.md': HANDOFF } })
  on('command.run', ($: any, e: any, next: any) => {
    if (e.command !== 'clear') return next(e)
    cleared = true
    return {}
  })
  const clock = await start($, on, w)
  await step($, 'main')
  await clock.advance(2 * SEC)
  expect(asks(w)).toBe(1)
  // The ask, then the reply: a tool call (its result a user row with no text) and one closing line
  w.messages.push(
    { role: 'user', text: `The tether plugin sent a message:\n${w.submits[0]}` },
    { role: 'assistant', text: '' },
    { role: 'user', text: '' },
    { role: 'assistant', text: 'HANDOFF.md is written.' },
  )
  await clock.advance(10 * SEC)
  expect(w.submits.filter(t => t.includes('Update HANDOFF.md'))).toEqual([])
  expect(asks(w)).toBe(1)
  expect(cleared).toBe(true)
})

test('/tether-checkpoint runs the whole cycle in a short session: ask, check, clear, continue', { timeoutMs: 30_000 }, async ($, on) => {
  let cleared = false
  const w = world({ context: 1_000, files: { '.claude/tether.json': CONFIG, 'HANDOFF.md': HANDOFF } })
  on('command.run', ($: any, e: any, next: any) => {
    if (e.command !== 'clear') return next(e)
    cleared = true
    return {}
  })
  const clock = await start($, on, w)
  await step($, 'main')
  await clock.advance(10 * SEC)
  expect(asks(w)).toBe(0)
  expect(await command($, 'tether-checkpoint')).toBe('checkpoint: asking for HANDOFF.md once the session is quiet')
  await clock.advance(2 * SEC)
  expect(asks(w)).toBe(1)
  await clock.advance(10 * SEC)
  expect(cleared).toBe(true)
  await clearSession($, w)
  await clock.advance(60 * SEC)
  expect(continues(w)).toBe(1)
  // The new, short session is not asked again
  expect(asks(w)).toBe(1)
})

test('/tether-checkpoint while a cycle runs says so and starts nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const { w, clock } = await longSession($, on, () => ({}))
  await clock.advance(2 * SEC)
  expect(asks(w)).toBe(1)
  expect(await command($, 'tether-checkpoint')).toBe('checkpoint: already running (HANDOFF.md requested)')
  await clock.advance(2 * SEC)
  expect(asks(w)).toBe(1)
})

test('/tether-checkpoint while the checkpoint is off starts nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ context: 150_000, files: { '.claude/tether.json': '{}', 'HANDOFF.md': HANDOFF } })
  const clock = await start($, on, w)
  await step($, 'main')
  expect(await command($, 'tether-checkpoint')).toBe('checkpoint: off, so nothing was started')
  await clock.advance(30 * SEC)
  expect(asks(w)).toBe(0)
})
