// Tests of fleet's hooks against the engine's test kit: requests feed the ledger, SendMessage is guarded.
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const AGENTS = [{ id: 'a1', status: 'waiting', description: 'build wait', type: 'general-purpose', name: 'worker' }]

/** Stubs what fleet's session.start and refresh call, and fires session.start. */
async function start($: any, on: any, statuses: string[], toasts: string[]) {
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('agent.list', () => ({ value: AGENTS }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'seven_day', percentUsed: 97 }] } }))
  on('ui.status', ($: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000 } }
  })
  on('tool.call', () => ({ result: 'delivered' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return clock
}

/** Fires one model request for an agent and reads the stream to its end. */
async function step($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

test('SendMessage to a big agent passes while its cache is warm and is refused once it is cold', { timeoutMs: 30_000 }, async ($, on) => {
  const statuses: string[] = []
  const toasts: string[] = []
  const clock = await start($, on, statuses, toasts)
  await step($, 'a1')

  expect(await $.tool.call({ tool: 'SendMessage', to: 'worker', message: 'go on' })).toEqual({ result: 'delivered' })

  await clock.advance(61 * MIN)
  const refused: any = await $.tool.call({ tool: 'SendMessage', to: 'worker', message: 'go on' })
  expect(refused.deny).toMatch(/not sent.*idle 61 min/)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'worker', message: '[cache-ok] go on' })).toEqual({ result: 'delivered' })

  // The refresh timer has kept the status line current with the cold agent and the weekly limit
  expect(statuses[statuses.length - 1]).toBe('1 agent (0 running, 1 waiting) · 1 cold')
})

test('a cold wake is toasted and counted', { timeoutMs: 30_000 }, async ($, on) => {
  const statuses: string[] = []
  const toasts: string[] = []
  const clock = await start($, on, statuses, toasts)
  await step($, 'a1')
  await clock.advance(90 * MIN)
  await step($, 'a1')
  // (the agent guard's own toasts are tested with the guards)
  expect(toasts.filter(x => !x.startsWith('agent guard:'))).toEqual(['worker woke after 90 min and re-wrote 150k cache tokens'])
})
