// Tests of the agent guard's own actions against the engine's test kit: a stopped agent with background work is
// kept warm or handed over before its cache expires, its leftover tasks are stopped only after it has stopped, a
// late handover alerts instead of stopping, and the decision tool refuses to retire an agent that will wake itself.
import { expect, mock, test } from 'claude-code/testing'

const SEC = 1000
const MIN = 60 * SEC

type World = {
  agents: Array<{ id: string; status: string; description: string; type: string; name?: string }>
  /** The transcript of agent a1 (path suffix /s1/subagents/agent-a1.jsonl). */
  transcript: string
  /** Its mtime; bump it when the transcript changes. */
  mtime: number
  /** Its size: over 4 MB the plugin cannot read it. */
  size: number
  /** Every session.send: recipient id and text. */
  sent: Array<{ to: string; text: string }>
  /** What session.send answers. */
  delivery: { isDelivered: boolean; reason?: string }
  /** Every TaskStop call's task_id, and what the call answers. */
  stopped: string[]
  taskStop: { deny?: string }
  /** The prompts the watch part submitted to wake the model. */
  submits: string[]
  toasts: string[]
  logs: string[]
  /** The context of the next model request. */
  context: number
}

const world = (over: Partial<World> = {}): World => ({
  agents: [{ id: 'a1', status: 'waiting', description: 'build wait', type: 'general-purpose', name: 'worker' }],
  transcript: '',
  mtime: 1,
  size: 1000,
  sent: [],
  delivery: { isDelivered: true },
  stopped: [],
  taskStop: {},
  submits: [],
  toasts: [],
  logs: [],
  context: 150_000,
  ...over,
})

/** A background Bash start line and its end notification, in the shape Claude Code 2.1.296 writes. */
const started = (id: string) =>
  JSON.stringify({ type: 'user', toolUseResult: { backgroundTaskId: id }, message: { role: 'user', content: [{ type: 'tool_result', content: `Command running in background with ID: ${id}. Output is being written to: x` }] } })
const ended = (id: string, status = 'completed') =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` } })

/** Starts Tether with `config` as the project file and the fake world's answers. */
async function start($: any, on: any, config: unknown, w: World) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  const isTranscript = (p: string) => p.replace(/\\/g, '/').endsWith('/s1/subagents/agent-a1.jsonl')
  on('fs.exists', ($: any, e: any) => ({ value: e.path.endsWith('tether.json') || isTranscript(e.path) }))
  on('fs.list', () => ({ value: [{ name: 's1', kind: 'dir', size: 0 }] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: w.size, mtimeMs: w.mtime, isLink: false } }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.read', ($: any, e: any) => ({ value: isTranscript(e.path) ? w.transcript : e.path.endsWith('tether.json') ? JSON.stringify(config) : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', exitCode: 1 } }))
  on('agent.list', () => ({ value: w.agents }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', ($: any, e: any) => {
    w.submits.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('session.send', ($: any, e: any) => {
    w.sent.push({ to: e.to, text: e.text })
    return w.delivery
  })
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abcdef12-0000' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'TaskStop') {
      w.stopped.push(e.task_id)
      return w.taskStop.deny ? { deny: w.taskStop.deny } : { result: 'stopped' }
    }
    return { result: 'ok' }
  })
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: w.context } }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return clock
}

/** One model request of agent a1 (its last activity), read to the end. */
async function step($: any, agentId = 'a1') {
  const stream = ($ as any).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

const stopHook = async ($: any): Promise<any> => ($ as any).classic.Stop({ stop_hook_active: false })
const decide = async ($: any, decision: string, id = 'a1'): Promise<any> => $.tool.call({ tool: 'mcp__tether__agent_decision', id, decision, note: 'test' } as any)
const CFG = { fleet: { bigContextTokens: 1000 } }

test('a waiting agent under the handover size is kept warm 20 minutes before its cache expires, again each window, and Stop stays quiet', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1') })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(38 * MIN)
  expect(w.sent).toEqual([])
  await clock.advance(3 * MIN)
  // Cache of 60 min, lead of 20: the first ping goes at 40 minutes idle
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.to).toBe('a1')
  expect(w.sent[0]!.text).toContain('keep waiting, no action needed')
  expect(w.toasts.some(t => t.includes('kept worker (a1) warm (ping 1)'))).toBe(true)
  expect((await stopHook($)).block).toBeUndefined()
  // The agent answered the ping, so its activity is fresh and the next window starts there
  await step($)
  await clock.advance(30 * MIN)
  expect(w.sent.length).toBe(1)
  await clock.advance(11 * MIN)
  expect(w.sent.length).toBe(2)
  // A kept-warm agent is still wakeable by the model: only a retired or done one is refused
  expect(await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'go on' } as any)).toEqual({ result: 'ok' })
  const flags: any = await $.command.run({ command: 'tether-fleet', args: 'text' } as any)
  expect(flags.text).toContain('guard kept warm')
})

test('a waiting agent over the handover size is asked to hand over; its tasks are stopped only after it has stopped, then it is retired', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1') + '\n' + started('bt2') + '\n' + ended('bt1'), context: 300_000 })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(41 * MIN)
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.text).toContain('hand over now')
  expect(w.sent[0]!.text).toContain('update STATUS.md')
  // Tether has the agent in hand: nothing is stopped yet, and the end of a turn is not blocked
  expect(w.stopped).toEqual([])
  expect((await stopHook($)).block).toBeUndefined()
  await clock.advance(3 * MIN)
  expect(w.stopped).toEqual([])
  // The agent writes its status and ends its turn
  await step($)
  await $.turn.complete({ turnId: 't', answer: 'handed over', agentId: 'a1' } as any)
  await clock.advance(2 * MIN)
  // Only the task that is still live is stopped
  expect(w.stopped).toEqual(['bt2'])
  expect(w.toasts.some(t => t.includes('handed over and is retired; stopped 1 background task'))).toBe(true)
  expect((await stopHook($)).block).toBeUndefined()
  // Retired is final: a message to it is refused unless it carries the override token
  const refused: any = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'go on' } as any)
  expect(refused.deny).toMatch(/decided retired/)
  // Nothing more is sent or stopped
  await clock.advance(30 * MIN)
  expect(w.sent.length).toBe(1)
  expect(w.stopped).toEqual(['bt2'])
})

test('a handover that does not finish in time alerts the model and stops nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1'), context: 300_000 })
  const clock = await start($, on, { ...CFG, cacheGuard: { handoverWaitMinutes: 5 } }, w)
  await step($)
  await clock.advance(41 * MIN)
  expect(w.sent.length).toBe(1)
  await clock.advance(7 * MIN)
  expect(w.stopped).toEqual([])
  expect(w.submits.some(s => s.includes('has not finished its handover 5 min after Tether asked; it is NOT stopped'))).toBe(true)
  // Told once, and the Stop hook now blocks on it
  const alerts = w.toasts.filter(t => t.includes('has not finished its handover')).length
  await clock.advance(5 * MIN)
  expect(w.toasts.filter(t => t.includes('has not finished its handover')).length).toBe(alerts)
  expect((await stopHook($)).block).toContain('handover asked, it has not finished in time and is NOT stopped')
  // The agent finishes late: its tasks are stopped then
  await step($)
  await $.turn.complete({ turnId: 't', answer: 'handed over', agentId: 'a1' } as any)
  await clock.advance(2 * MIN)
  expect(w.stopped).toEqual(['bt1'])
  expect((await stopHook($)).block).toBeUndefined()
})

test('when the leftover tasks cannot be stopped the agent is not retired and the model is told', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1'), context: 300_000, taskStop: { deny: 'permission denied' } })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(41 * MIN)
  await step($)
  await $.turn.complete({ turnId: 't', answer: 'handed over', agentId: 'a1' } as any)
  await clock.advance(2 * MIN)
  expect(w.stopped).toEqual(['bt1'])
  expect(w.submits.some(s => s.includes('TaskStop failed for bt1: permission denied'))).toBe(true)
  const block = (await stopHook($)).block
  expect(block).toContain('CACHE GUARD')
  expect(block).toContain('its background tasks could not be stopped')
  // Not retired: the model is still allowed to message it
  expect(await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'go on' } as any)).toEqual({ result: 'ok' })
})

test('a message that cannot be delivered leaves the agent a finding and the Stop hook blocks', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1'), delivery: { isDelivered: false, reason: 'the recipient is gone' } })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(41 * MIN)
  expect(w.sent.length).toBeGreaterThan(0)
  expect(w.logs.filter(l => l.includes('keep-warm of worker (a1) failed: the recipient is gone')).length).toBe(1)
  const block = (await stopHook($)).block
  expect(block).toContain('CACHE GUARD')
  expect(block).toContain('keep it warm')
  expect(block).toContain('TaskStop')
  expect(block).toContain('1 live background task')
})

test('with auto off the guard sends nothing and only blocks, naming both ways out', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1') })
  const clock = await start($, on, { ...CFG, cacheGuard: { auto: false } }, w)
  await step($)
  await clock.advance(45 * MIN)
  expect(w.sent).toEqual([])
  expect((await stopHook($)).block).toMatch(/keep it warm.*hand it over and stop it/s)
})

test('a waiting agent whose cache already expired is not pinged (that would re-write it), the model is alerted', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1'), delivery: { isDelivered: false, reason: 'down' } })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(62 * MIN)
  // The pings failed while the cache lived; once expired no more are tried and the model is told
  const before = w.sent.length
  await clock.advance(5 * MIN)
  expect(w.sent.length).toBe(before)
  expect(w.submits.some(s => s.includes('cache EXPIRED') && s.includes('Tether did not ping it'))).toBe(true)
})

test('agent_decision refuses retired and done for an agent with live background tasks, running, or waiting; kept-warm is recorded', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ transcript: started('bt1') })
  const clock = await start($, on, { ...CFG, cacheGuard: { auto: false } }, w)
  await step($)
  await clock.advance(5 * MIN)
  const retired: any = await decide($, 'retired')
  expect(retired.deny).toContain('TaskStop it first')
  expect(retired.deny).toContain('bt1')
  expect((await decide($, 'done') as any).deny).toContain('wakes itself')
  // Waiting with no task Tether can see: still refused
  w.transcript = ''
  w.mtime = 2
  await clock.advance(1 * MIN)
  expect((await decide($, 'retired') as any).deny).toContain('TaskStop it first')
  // A running agent
  w.agents = [{ id: 'a1', status: 'running', description: 'build wait', type: 'general-purpose', name: 'worker' }]
  expect((await decide($, 'retired') as any).deny).toContain('still running')
  // Once it has stopped with nothing live it may be retired
  w.agents = [{ id: 'a1', status: 'completed', description: 'build wait', type: 'general-purpose', name: 'worker' }]
  expect(JSON.stringify(await decide($, 'retired'))).toContain('a1 recorded as retired')
})

test('kept-warm quiets the guard for one window from the later of the ping and the last activity, and never refuses a message', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: [{ id: 'a1', status: 'completed', description: 'builder', type: 'general-purpose', name: 'worker' }] })
  const clock = await start($, on, CFG, w)
  await step($)
  await clock.advance(41 * MIN)
  expect((await stopHook($)).block).toContain('CACHE GUARD')
  // The model pinged it (SendMessage) and records that
  expect(JSON.stringify(await decide($, 'kept-warm'))).toContain('a1 recorded as kept-warm')
  expect((await stopHook($)).block).toBeUndefined()
  expect(await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'ping' } as any)).toEqual({ result: 'ok' })
  // Quiet for another window, then it is due again
  await clock.advance(35 * MIN)
  expect((await stopHook($)).block).toBeUndefined()
  await clock.advance(6 * MIN)
  expect((await stopHook($)).block).toContain('CACHE GUARD')
  // A finished agent has no background work, so Tether sends it nothing by itself
  expect(w.sent).toEqual([])
})

test('background tasks are learned from the rows appended to an agent whose transcript is too big to read', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ size: 25_000_000 })
  const clock = await start($, on, { ...CFG, cacheGuard: { auto: false } }, w)
  await step($)
  const appended: any = await $.session.append({ message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Command running in background with ID: bx9. Output is being written to: y' }] }, agentId: 'a1' } as any)
  expect(appended.message).toBeTruthy()
  await clock.advance(1 * MIN)
  expect(((await decide($, 'retired')) as any).deny).toContain('bx9')
  await $.session.append({ message: { type: 'attachment', name: 'queued_command', content: [{ type: 'text', text: '<task-notification><task-id>bx9</task-id><status>killed</status></task-notification>' }] }, agentId: 'a1' } as any)
  await clock.advance(1 * MIN)
  // Its status still says waiting, so the refusal stands, now without a task id
  expect(((await decide($, 'retired')) as any).deny).toContain('waiting on background work')
})
