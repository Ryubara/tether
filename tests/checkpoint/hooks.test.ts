// The checkpoint in the whole plugin, around a clear: any clear starts the cycle over with the old context
// forgotten, Tether's own clear continues from the handoff even when the new session starts after the command
// returns, and a clear that did not happen waits `retryMinutes` before asking again. Synthetic data only.
import { expect, test } from 'claude-code/testing'

import { MIN, SEC, start, step, world, type World } from '../options/world'

const HANDOFF = '## Where to look\nx\n## Summary\nx\n## Next steps\nx\n## Open questions\nx\n'
const CONFIG = JSON.stringify({ checkpoint: { enabled: true, contextTokens: 100_000, quietSeconds: 5, tickSeconds: 1, retryMinutes: 10 } })

const asks = (w: World) => w.submits.filter(t => t.startsWith('Checkpoint:')).length
const continues = (w: World) => w.submits.filter(t => t === 'Continue from HANDOFF.md.').length

/** A long session (context over the threshold) with a passing handoff, the clear command answered by `clear`. */
async function longSession($: any, on: any, clear: () => unknown) {
  const w = world({ context: 150_000, files: { '.claude/tether.json': CONFIG, 'HANDOFF.md': HANDOFF } })
  on('command.run', ($: any, e: any, next: any) => (e.command === 'clear' ? clear() : next(e)))
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
  await ($ as any).classic.SessionStart({ source: 'clear' })
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
  await ($ as any).classic.SessionStart({ source: 'clear' })
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
  await ($ as any).classic.SessionStart({ source: 'clear' })
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
