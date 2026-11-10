// Where the agent guard reads a subagent's size from, and the retire alert that hangs on it (#29). Claude Code writes
// an agent's rows in the folder of the session it runs under, so after a /clear its newest stretch is in a new
// session folder while the older copy stays behind, and a transcript over 4 MiB cannot be read at all. Synthetic
// data only.
import { expect, test } from 'claude-code/testing'

import { MIN, SEC, clearSession, command, start, step, stopHook, world } from '../options/world'

/** Watch off: an alert is told at the next turn boundary (the Stop hook), once, with no wake to count. */
const CONFIG = { '.claude/tether.json': JSON.stringify({ fleet: { bigContextTokens: 1000, retireContextTokens: 500_000 }, watch: { enabled: false } }) }
const running = () => [{ id: 'a1', status: 'running', description: 'big task', type: 'general-purpose', name: 'worker' }]
const stopped = () => [{ id: 'a1', status: 'completed', description: 'big task', type: 'general-purpose', name: 'worker' }]

/** One assistant row with usage, as a subagent transcript holds it. */
const request = (at: number, context: number) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1, cache_read_input_tokens: context - 1, cache_creation_input_tokens: 0 } } })
const file = (session: string) => `${session}/subagents/agent-a1.jsonl`

/** What the next Stop hook says about the retire line, or undefined. */
async function retireBlock($: any): Promise<string | undefined> {
  const block = (await stopHook($))?.block as string | undefined
  return block?.includes('retire line') ? block : undefined
}

test('a running agent whose newest transcript, in a later session folder, is past the retire line while the older copy is under it is told once', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG }, agents: running(), sessionId: 's1' })
  const clock = await start($, on, w)
  const t0 = clock.now()
  // Tether saw none of its requests (it loaded after them): the only size is the transcript's
  w.files[file('s1')] = request(t0 - MIN, 235_000)
  w.stats[file('s1')] = { size: 2_000_000, mtimeMs: t0 - MIN }
  await clock.advance(2 * MIN)
  expect(await retireBlock($)).toBeUndefined()
  // A /clear: the agent goes on in the new session's folder, past the line; the old copy stays at 235k
  await clearSession($, w, 's2')
  w.dirs = ['s1', 's2']
  const t1 = clock.now()
  w.files[file('s2')] = request(t1, 576_000)
  w.stats[file('s2')] = { size: 3_000_000, mtimeMs: t1 }
  await clock.advance(2 * MIN)
  const block = await retireBlock($)
  expect(block).toContain('worker (a1) is running with 576k context, past the 500k retire line')
  expect(block).toContain('Ask it to hand over now')
  // Once
  expect(await retireBlock($)).toBeUndefined()
  await clock.advance(10 * MIN)
  expect(await retireBlock($)).toBeUndefined()
})

test('an agent whose requests stopped reaching Tether at 235k is told once its newer transcript shows it past the line', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG }, agents: running(), sessionId: 's1', context: 235_000 })
  const clock = await start($, on, w)
  await step($, 'a1')
  await clock.advance(2 * MIN)
  expect(await retireBlock($)).toBeUndefined()
  await clearSession($, w, 's2')
  w.dirs = ['s1', 's2']
  await clock.advance(5 * MIN)
  const t1 = clock.now()
  w.files[file('s2')] = request(t1, 576_000)
  w.stats[file('s2')] = { size: 3_000_000, mtimeMs: t1 }
  await clock.advance(2 * MIN)
  expect(await retireBlock($)).toContain('worker (a1) is running with 576k context, past the 500k retire line')
  expect(await retireBlock($)).toBeUndefined()
})

test('the #29 timeline with its requests seen: past the line while running it is told once, and not again after a stop and a wake', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG }, agents: running(), sessionId: 's1', context: 235_000 })
  const clock = await start($, on, w)
  await step($, 'a1')
  await clock.advance(2 * MIN)
  await clearSession($, w, 's2')
  w.context = 501_000
  await step($, 'a1')
  await clock.advance(1 * MIN + 5 * SEC)
  expect(await retireBlock($)).toContain('worker (a1) is running with 501k context, past the 500k retire line')
  // It stops, sits for hours, is woken and grows on: the alert was told once per agent
  w.agents = stopped()
  await clock.advance(60 * MIN)
  w.agents = running()
  w.context = 565_000
  await step($, 'a1')
  await clock.advance(5 * MIN)
  expect(await retireBlock($)).toBeUndefined()
})

test('a size Tether kept stands in for a transcript too big to read: a stopped agent past the line is told after a reload', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG }, agents: stopped(), sessionId: 's2', dirs: ['s1', 's2'] })
  // What an earlier load of Tether kept before this one started, and the agent's transcripts, both over 4 MiB
  const t0 = 2 * MIN
  w.store.set('guards:sizes:default', { a1: { at: t0, contextTokens: 506_000 } })
  w.files[file('s1')] = request(MIN, 235_000)
  w.stats[file('s1')] = { size: 4_400_000, mtimeMs: MIN }
  w.files[file('s2')] = 'too big to read'
  w.stats[file('s2')] = { size: 11_000_000, mtimeMs: t0 }
  const clock = await start($, on, w)
  await clock.advance(2 * MIN)
  const block = await retireBlock($)
  expect(block).toContain('worker (a1) stopped with 506k context, past the 500k retire line')
  expect(block).toContain('Do not wake it with SendMessage')
})

test('the size of an agent seen with a request is kept in the store, once per change', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG }, agents: running(), context: 320_000 })
  const clock = await start($, on, w)
  await step($, 'a1')
  await clock.advance(1 * MIN + 5 * SEC)
  // The world's request reads one fresh token beside the cache write
  expect((w.store.get('guards:sizes:default') as any)?.a1?.contextTokens).toBe(320_001)
  const writes = () => w.storeWrites.filter(x => x.startsWith('guards:sizes:')).length
  const before = writes()
  await clock.advance(3 * MIN)
  expect(writes()).toBe(before)
})

test('Tether logs the version it runs at each start and after a clear, and /tether-guards names it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { ...CONFIG, '.claude-plugin/plugin.json': JSON.stringify({ name: 'tether', version: '9.9.9-test' }) } })
  await start($, on, w)
  expect(w.logs.filter(l => l.startsWith('version 9.9.9-test loaded')).length).toBe(1)
  expect(await command($, 'tether-guards')).toContain('tether version: 9.9.9-test')
  await clearSession($, w)
  expect(w.logs.filter(l => l.startsWith('version 9.9.9-test loaded')).length).toBe(2)
})
