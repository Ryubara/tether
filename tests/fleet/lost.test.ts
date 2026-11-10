// Unit tests of the lost-agent record: what counts as at work, what counts as ended with a report, and what is lost.
// Synthetic data only.
import { expect, test } from 'claude-code/testing'

import { endRoster, isOver, lastAssistantText, lostLine, markTold, observe, prune, statusLine, toTell, type RosterAgent } from '../../src/fleet/lost'

const MIN = 60_000
const never = () => undefined

test('an agent seen running and then completed ended with its report: nothing to tell', async () => {
  let r = observe({}, [{ id: 'a', status: 'running', label: 'build' }], never, 0)
  expect(r.a?.state).toBe('running')
  r = observe(r, [{ id: 'a', status: 'completed', label: 'build' }], never, MIN)
  expect(r.a?.state).toBe('ended')
  expect(toTell(r, new Set())).toEqual([])
})

test('an agent that stopped to wait on background work and finished without running again is lost', async () => {
  let r = observe({}, [{ id: 'a', status: 'running', label: 'ci wait' }], never, 0)
  r = observe(r, [{ id: 'a', status: 'waiting', label: 'ci wait' }], () => 30_000, MIN)
  expect(r.a?.state).toBe('waiting')
  expect(r.a?.waitingAt).toBe(MIN)
  // Still waiting later: the time it started waiting stays
  r = observe(r, [{ id: 'a', status: 'waiting', label: 'ci wait' }], () => 30_000, 5 * MIN)
  expect(r.a?.waitingAt).toBe(MIN)
  // The work ended and nothing woke it: no request since it started waiting
  r = observe(r, [{ id: 'a', status: 'completed', label: 'ci wait' }], () => 30_000, 9 * MIN)
  expect(r.a?.state).toBe('lost')
  expect(toTell(r, new Set()).map(a => a.id)).toEqual(['a'])
})

test('a waiting agent that ran again after its work reported and ended: not lost', async () => {
  let r = observe({}, [{ id: 'a', status: 'waiting', label: 'x' }], () => 0, MIN)
  // A request after it started waiting: its background work woke it, and it finished
  r = observe(r, [{ id: 'a', status: 'completed', label: 'x' }], () => 2 * MIN, 3 * MIN)
  expect(r.a?.state).toBe('ended')
})

test('live background tasks count as waiting whatever the status says', async () => {
  const r = observe({}, [{ id: 'a', status: 'completed', label: 'x', tasks: 2 }], never, MIN)
  expect(r.a?.state).toBe('waiting')
})

test('an agent at work that leaves the list is lost; a failed one too; a killed one was stopped on purpose', async () => {
  let r = observe({}, [{ id: 'a', status: 'running', label: 'a' }, { id: 'b', status: 'running', label: 'b' }, { id: 'c', status: 'waiting', label: 'c' }], never, 0)
  r = observe(r, [{ id: 'b', status: 'failed', label: 'b' }, { id: 'c', status: 'killed', label: 'c' }], never, MIN)
  expect(r.a?.state).toBe('lost')
  expect(r.b?.state).toBe('lost')
  expect(r.c?.state).toBe('ended')
})

test('an agent first seen finished is not recorded, and a teammate is never judged', async () => {
  const r = observe({}, [{ id: 'a', status: 'completed', label: 'a' }, { id: 't', status: 'idle', label: 't', teammate: true }], never, 0)
  expect(r).toEqual({})
})

test('the end of a session loses what was at work in it; a lost agent is told once', async () => {
  let r: Record<string, RosterAgent> = observe({}, [{ id: 'a', status: 'running', label: 'a' }, { id: 'b', status: 'waiting', label: 'b' }, { id: 'c', status: 'running', label: 'c' }], never, 0)
  r = observe(r, [{ id: 'a', status: 'running', label: 'a' }, { id: 'b', status: 'waiting', label: 'b' }, { id: 'c', status: 'completed', label: 'c' }], never, MIN)
  r = endRoster(r)
  expect(toTell(r, new Set()).map(a => a.id)).toEqual(['a', 'b'])
  // An agent the guard handed over and retired is not lost, whatever the record says
  expect(toTell(r, new Set(['b'])).map(a => a.id)).toEqual(['a'])
  r = markTold(r, ['a', 'b'])
  expect(toTell(r, new Set())).toEqual([])
  // Told and old entries go; one at work stays
  r = observe(r, [{ id: 'd', status: 'running', label: 'd' }], never, 2 * MIN)
  expect(Object.keys(prune(r, 2 * MIN + 25 * 60 * MIN, 24 * 60 * MIN)).sort()).toEqual(['d'])
})

test('a session is over when it ended, or nothing heard from it for the stale time; never the current one', async () => {
  const cur = { session: 's2', cwd: '/work', now: 100 * MIN }
  expect(isOver({ session: 's1', cwd: '/work', aliveAt: 99 * MIN, endedAt: 99 * MIN, agents: {} }, cur, 5 * MIN)).toBe(true)
  expect(isOver({ session: 's1', cwd: '/work', aliveAt: 90 * MIN, agents: {} }, cur, 5 * MIN)).toBe(true)
  // Another session still at work in this folder: its agents are its own
  expect(isOver({ session: 's1', cwd: '/work', aliveAt: 98 * MIN, agents: {} }, cur, 5 * MIN)).toBe(false)
  // One that writes every 10 minutes is over only after three of its writes are missed
  expect(isOver({ session: 's1', cwd: '/work', aliveAt: 90 * MIN, everyMs: 10 * MIN, agents: {} }, cur, 5 * MIN)).toBe(false)
  expect(isOver({ session: 's1', cwd: '/work', aliveAt: 69 * MIN, everyMs: 10 * MIN, agents: {} }, cur, 5 * MIN)).toBe(true)
  expect(isOver({ session: 's1', cwd: '/other', aliveAt: 0, endedAt: 1, agents: {} }, cur, 5 * MIN)).toBe(false)
  expect(isOver({ session: 's2', cwd: '/work', aliveAt: 0, endedAt: 1, agents: {} }, cur, 5 * MIN)).toBe(false)
})

const row = (o: unknown) => JSON.stringify(o)

test('the last status line is the last assistant text in the transcript, on one line and cut', async () => {
  const transcript = [
    row({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting.' }] } }),
    row({ type: 'assistant', message: { content: [{ type: 'text', text: 'CI is running.\n\nA monitor will tell me when it ends.' }, { type: 'tool_use', name: 'Monitor', input: {} }] } }),
    row({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    row({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"half wri',
  ].join('\n')
  expect(lastAssistantText(transcript)).toBe('CI is running.\n\nA monitor will tell me when it ends.')
  expect(lastAssistantText(row({ type: 'user', message: { content: 'hi' } }))).toBeUndefined()
  expect(statusLine('CI is running.\n\nA monitor  will tell me.')).toBe('CI is running. A monitor will tell me.')
  expect(statusLine('x'.repeat(1000)).length).toBe(600)
  expect(statusLine('x'.repeat(1000)).endsWith('...')).toBe(true)
})

test('a lost agent is told with its name, id, what it was doing and its last status line; plainly by id alone', async () => {
  const a: RosterAgent = { id: 'a1', label: 'WebSocket link #903', state: 'lost', seenAt: 0, was: 'waiting' }
  expect(lostLine(a, 'CI is running.', false)).toBe('WebSocket link #903 (a1), waiting on background work when last seen. Last status: "CI is running."')
  expect(lostLine({ ...a, was: 'running' }, undefined, false)).toBe('WebSocket link #903 (a1), running when last seen. Last status: none found')
  expect(lostLine(a, 'CI is running.', true)).toBe('a1 waiting')
})
