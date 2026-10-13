// Drawing tests: the fleet pane validates and reads right on the surfaces that draw panes.
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const AGENTS = [
  { id: 'a1', status: 'waiting', description: 'build wait', type: 'general-purpose', name: 'worker' },
  { id: 'a2', status: 'completed', description: 'old review', type: 'reviewer' },
]

/** The Pane props a surface hands a docked fleet pane. */
const PANE_PROPS = {
  title: 'Fleet',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

/** Stubs what fleet calls at start and on refresh, then starts the session. */
async function start($: any, on: any, agents: unknown[]) {
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('agent.list', () => ({ value: agents }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return clock
}

/** Fires one model request for an agent and reads the stream to its end. */
async function step($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

/** The texts of every Text the drawing holds, in order. */
async function texts(ui: any): Promise<Array<{ text: string; props: Record<string, unknown> }>> {
  return (await ui.findAll({ type: 'Text' })).map((t: any) => ({ text: t.text, props: t.props }))
}

test('the pane draws a summary and one row per agent on every pane surface', async ($, on) => {
  const clock = await start($, on, AGENTS)
  await step($, 'a1')
  await clock.advance(61 * MIN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'fleet', surface, component: 'Pane', requestId: 'fleet', props: PANE_PROPS as any })
    const all = await texts(ui)
    expect(all[4]?.text).toBe('1 agent (0 running, 1 waiting) · 1 cold')
    expect(all[4]?.props.bold).toBe(true)
    // Rows are a Text of coloured cells; live agents first, ended ones last
    expect(all[5]?.text.trimEnd()).toMatch(/^ {3}AGENT\s+STATE\s+CTX\s+IDLE\s+CACHE\s+FLAGS · NOTE$/)
    const rows = all.filter(t => /(worker|old review)\s/.test(t.text) && t.text.length > 40)
    expect(rows.map(t => t.text.trimEnd())).toEqual([
      expect.stringMatching(/^⏳ worker\s+waiting \(bg work\)\s+80k\s+61m\s+expired\s+🧊 wake≈80k$/),
      expect.stringMatching(/^✅ old review\s+completed/),
    ])
    const cell = (re: RegExp) => all.find(t => re.test(t.text) && t.text.length < 30)
    expect(cell(/^waiting \(bg work\)/)?.props.color).toBe('yellow')
    expect(cell(/^80k\s/)?.props.color).toBe('yellow')
    expect(cell(/^expired/)?.props.color).toBe('red')
    expect(cell(/^🧊 wake≈80k/)?.props.color).toBe('red')
    expect(all[all.length - 1]?.text).toBe('wake≈N: cache expired, waking it re-writes N tokens to the cache')
    expect(cell(/^61m/)?.props.color).toBeUndefined()
    // An ended agent's cells are dim and uncoloured
    expect(cell(/^completed/)?.props).toMatchObject({ dimColor: true })
    expect(cell(/^completed/)?.props.color).toBeUndefined()
    await ui.unmount()
  }
})

test('an empty session says so instead of drawing no rows', async ($, on) => {
  await start($, on, [])
  const ui = await $.ui.mount({ plugin: 'fleet', surface: 'terminal', component: 'Pane', requestId: 'fleet', props: PANE_PROPS as any })
  expect((await texts(ui)).map(t => t.text)).toEqual(['✅ Fleet   ✅ Watch', '✅ Fleet', '   ', '✅ Watch', '0 agents', 'No agents in this session yet.'])
  await ui.unmount()
})
