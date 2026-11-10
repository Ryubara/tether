// The lost-agent notice in the whole plugin: an agent at work that ended without a report is told once, at the next
// session start (new, resumed or after a clear), with its last status line. Synthetic data only.
import { expect, test } from 'claude-code/testing'

import { clearSession, SEC, start, step, world, type World } from '../options/world'

const row = (o: unknown) => JSON.stringify(o)
const TRANSCRIPT = [
  row({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting on #903.' }] } }),
  row({ type: 'assistant', message: { content: [{ type: 'text', text: 'CI is running.\n\nA monitor will tell me when the checks finish.' }] } }),
].join('\n')
const LINE = 'WebSocket link #903 (a1), waiting on background work when last seen. Last status: "CI is running. A monitor will tell me when the checks finish."'

const agent = (status: string) => [{ id: 'a1', status, description: 'WebSocket link #903', type: 'godot-engineer' }]
const context = (r: any): string => (r?.additionalContext ?? []).join('\n')

/** An agent that runs, stops to wait on background work, and is left finished with no request since. */
async function loseOne($: any, w: World, clock: any) {
  await step($, 'a1')
  await clock.advance(20 * SEC)
  w.agents = agent('waiting')
  await clock.advance(20 * SEC)
  w.agents = agent('completed')
  await clock.advance(20 * SEC)
}

/** The record an earlier session of this folder left in the store. */
const roster = (session: string, over: Record<string, unknown>) => ({
  session,
  cwd: '/work',
  aliveAt: 1,
  agents: { a2: { id: 'a2', label: 'AI research #882', state: 'waiting', seenAt: 1, waitingAt: 1 } },
  ...over,
})
const LINE2 = 'AI research #882 (a2), waiting on background work when last seen. Last status: "Jolt matrix running; a watcher will notify me."'
const TRANSCRIPT2 = row({ type: 'assistant', message: { content: [{ type: 'text', text: 'Jolt matrix running; a watcher will notify me.' }] } })

test('after a clear, the first prompt is told of an agent that stopped to wait and was never woken, once', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: agent('running'), files: { 's1/subagents/agent-a1.jsonl': TRANSCRIPT } })
  const clock = await start($, on, w)
  await loseOne($, w, clock)
  // Nothing is said in the session itself
  expect(w.submits).toEqual([])
  await clearSession($, w)
  await clock.advance(1 * SEC)
  const r: any = await ($ as any).classic.UserPromptSubmit({ prompt: 'go on' })
  expect(context(r)).toContain('Subagents that ended without a report')
  expect(context(r)).toContain(LINE)
  // Told once: neither the next prompt nor the next clear repeats it
  expect(context(await ($ as any).classic.UserPromptSubmit({ prompt: 'and then?' }))).not.toContain('(a1)')
  await clearSession($, w, 'abcdef12-0002')
  await clock.advance(1 * SEC)
  expect(context(await ($ as any).classic.UserPromptSubmit({ prompt: 'again' }))).not.toContain('(a1)')
})

test('an agent that ran again after its background work and finished is not told', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: agent('running'), files: { 's1/subagents/agent-a1.jsonl': TRANSCRIPT } })
  const clock = await start($, on, w)
  await step($, 'a1')
  await clock.advance(20 * SEC)
  w.agents = agent('waiting')
  await clock.advance(20 * SEC)
  // Its work reported and woke it: a request after it started waiting
  await step($, 'a1')
  w.agents = agent('completed')
  await clock.advance(20 * SEC)
  await clearSession($, w)
  await clock.advance(1 * SEC)
  expect(context(await ($ as any).classic.UserPromptSubmit({ prompt: 'go on' }))).not.toContain('(a1)')
})

test('a resumed session is told of what was at work when the session before it ended, once', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ store: new Map<string, unknown>([['fleet:roster:old-1', roster('old-1', { endedAt: 2 })]]), files: { 's1/subagents/agent-a2.jsonl': TRANSCRIPT2 } })
  await start($, on, w)
  const r: any = await ($ as any).classic.SessionStart({ source: 'resume' })
  expect(context(r)).toContain('Subagents that ended without a report')
  expect(context(r)).toContain(LINE2)
  expect(w.store.has('fleet:roster:old-1')).toBe(false)
  expect(context(await ($ as any).classic.SessionStart({ source: 'startup' }))).not.toContain('(a2)')
})

test('a session still at work in the same folder keeps its agents: nothing is told of them', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { 's1/subagents/agent-a2.jsonl': TRANSCRIPT2 } })
  const clock = await start($, on, w)
  await clock.advance(30 * 60 * SEC)
  // Heard from a minute ago: still at work
  w.store.set('fleet:roster:live-1', roster('live-1', { aliveAt: clock.now() - 60 * SEC }))
  w.store.set('fleet:roster:other-dir', roster('other-dir', { cwd: '/elsewhere', endedAt: 2 }))
  expect(context(await ($ as any).classic.SessionStart({ source: 'startup' }))).not.toContain('(a2)')
  expect(w.store.has('fleet:roster:live-1')).toBe(true)
  expect(w.store.has('fleet:roster:other-dir')).toBe(true)
})

test('a session that ends records it, so the next start does not wait for its record to go stale', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: agent('running') })
  const clock = await start($, on, w)
  await clock.advance(20 * SEC)
  await ($ as any).session.end({ reason: 'prompt_input_exit', sessionId: w.sessionId, resume: { id: w.sessionId } })
  const saved = w.store.get(`fleet:roster:${w.sessionId}`) as any
  expect(saved?.agents?.a1?.state).toBe('running')
  expect(typeof saved?.endedAt).toBe('number')
})

test('under plainOutput a lost agent is told by its id alone, and its transcript is not read', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ store: new Map<string, unknown>([['fleet:roster:old-1', roster('old-1', { endedAt: 2 })]]), files: { '.claude/tether.json': JSON.stringify({ plainOutput: true }), 's1/subagents/agent-a2.jsonl': TRANSCRIPT2 } })
  await start($, on, w)
  const text = context(await ($ as any).classic.SessionStart({ source: 'startup' }))
  expect(text).toContain('- a2 waiting')
  expect(text).not.toContain('AI research')
  expect(w.reads.some(p => p.endsWith('agent-a2.jsonl'))).toBe(false)
})

test('with fleet off nothing is told and the record is left alone', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ store: new Map<string, unknown>([['fleet:roster:old-1', roster('old-1', { endedAt: 2 })]]), files: { '.claude/tether.json': JSON.stringify({ fleet: { enabled: false } }) } })
  await start($, on, w)
  expect(context(await ($ as any).classic.SessionStart({ source: 'startup' }))).not.toContain('(a2)')
  expect(w.store.has('fleet:roster:old-1')).toBe(true)
})
