// Tests of watch's hooks against the engine's test kit: polls, dedupe, and when a wake goes.
import { expect, mock, test } from 'claude-code/testing'

const SEC = 1000
const MIN = 60 * SEC

/** What a test's fake world records and answers. */
type World = {
  /** How the engine answers a wake: absent, it takes it and a turn starts; `no-turn`, it takes it and no turn starts; any other text, it drops it with that reason. */
  answer?: string
  submits: string[]
  toasts: string[]
  logs: string[]
  statuses: string[]
  /** What watch wrote with fs.write, by path. */
  files: Record<string, string>
  draft: string
  /** The next process.run answers, in order; the last one repeats. */
  runs: Array<{ exitCode: number; stdout: string; stderr?: string }>
  agents: Array<{ id: string; status: string; description: string; type: string }>
  /** Every command run, as argv. */
  argv: string[][]
}

/** The turn the engine runs for a wake it took: a main-loop turn, started and completed. */
async function pickUp($: any, n: number) {
  await $.turn.start({ text: '', turnId: `wake-${n}` } as any)
  await $.turn.complete({ turnId: `wake-${n}`, answer: '' } as any)
}

/** Starts watch with `config` as .claude/watch.json and the fake world's answers. */
async function start($: any, on: any, config: unknown, world: World) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ watch: config, housekeeping: { enabled: false }, conversations: { enabled: false } }) }))
  on('process.run', ($: any, e: any) => {
    world.argv.push([...e.argv])
    const r = world.runs.length > 1 ? world.runs.shift()! : world.runs[0]!
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  on('agent.list', () => ({ value: world.agents }))
  on('prompt.read', () => ({ value: { text: world.draft, cursor: world.draft.length } }))
  on('prompt.submit', (_: any, e: any) => {
    world.submits.push(e.text)
    // The engine starts a turn for a prompt it takes, once the session is idle: a wake is picked up
    if (world.answer === undefined) void Promise.resolve().then(() => pickUp($, world.submits.length))
    else if (world.answer !== 'no-turn') return { drop: world.answer }
    return { text: e.text, origin: e.origin }
  })
  on('ui.toast', ($: any, e: any) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.write', ($: any, e: any) => {
    world.files[e.path] = e.text
    return { value: undefined }
  })
  // Every request is a 250k-context one (see bigStep)
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 250_000 } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return clock
}

/** A fresh world with one command answer. */
function world(stdout: string, exitCode = 0): World {
  return { submits: [], toasts: [], logs: [], statuses: [], files: {}, draft: '', runs: [{ exitCode, stdout }], agents: [], argv: [] }
}

const PRS = {
  minWakeGapSeconds: 60,
  pollers: [{ id: 'prs', title: 'Pull requests', command: ['check'], everySeconds: 300, match: '^- (.*)$', quietExitCodes: [3] }],
}

test('new findings wake the model once; the same findings again do not', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('HEADER\n- #12 fix-x: conflict\n- #13 add-y: checks failed\n')
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits).toEqual(['watch found something new. Handle it or say why it can wait:\n\nPull requests:\n- #12 fix-x: conflict\n- #13 add-y: checks failed'])
  expect(w.toasts).toEqual(['watch: 2 new from Pull requests'])

  // Five minutes on, the same two and one new: only the new one is told
  w.runs = [{ exitCode: 0, stdout: '- #12 fix-x: conflict\n- #13 add-y: checks failed\n- #14 z: unpushed\n' }]
  await clock.advance(5 * MIN)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toMatch(/Pull requests:\n- #14 z: unpushed$/)
  // A quiet exit tells nothing
  w.runs = [{ exitCode: 3, stdout: 'no new problem' }]
  await clock.advance(5 * MIN)
  expect(w.submits.length).toBe(2)
})

test('a draft in the prompt box holds the wake until it is sent or the defer limit passes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.draft = 'half typed'
  const clock = await start($, on, { ...PRS, deferWhileTypingMinutes: 2 }, w)
  await clock.advance(1 * MIN)
  expect(w.submits).toEqual([])
  await clock.advance(1 * MIN + 10 * SEC)
  expect(w.submits.length).toBe(1)

  // Typing again later: emptied box releases the wake at the next check
  w.runs = [{ exitCode: 0, stdout: '- #15 new: conflict\n' }]
  await clock.advance(5 * MIN - 1 * MIN)
  expect(w.submits.length).toBe(1)
  w.draft = ''
  await clock.advance(6 * SEC)
  expect(w.submits.length).toBe(2)
})

test('no wake while a turn runs; it goes when the turn completes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, PRS, w)
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await clock.advance(30 * SEC)
  expect(w.submits).toEqual([])
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await clock.settle()
  expect(w.submits.length).toBe(1)
})

test('a failing poller is logged once per reason and shows in /tether-watch', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('', 1)
  w.runs = [{ exitCode: 1, stdout: '', stderr: 'GitHub could not be read' }]
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  await clock.advance(10 * MIN)
  expect(w.logs).toEqual(['watch: prs failed: exit 1: GitHub could not be read'])
  const report: any = await $.command.run({ command: 'tether-watch', args: '' } as any)
  expect(report.text).toMatch(/- prs \(every 300s, next in [0-9:]+\): FAILED 0 min ago: exit 1: GitHub could not be read/)
  expect(w.submits).toEqual([])
})

test('the agents poller wakes for a running agent gone silent, once per silence', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('')
  w.agents = [{ id: 'a1', status: 'running', description: 'builder', type: 'general-purpose' }]
  const clock = await start($, on, { pollers: [{ id: 'agents', kind: 'agents', title: 'Agents', everySeconds: 60, silentMinutes: 20 }] }, w)
  await clock.advance(19 * MIN)
  expect(w.submits).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.submits).toEqual(['watch found something new. Handle it or say why it can wait:\n\nAgents:\n- builder (a1) running, silent 20 min'])
  await clock.advance(10 * MIN)
  expect(w.submits.length).toBe(1)
})

test('/tether-watch forget makes told findings new again; /tether-watch run polls now', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  await $.command.run({ command: 'tether-watch', args: 'forget prs' } as any)
  await clock.advance(2 * MIN)
  await $.command.run({ command: 'tether-watch', args: 'run prs' } as any)
  await clock.advance(6 * SEC)
  expect(w.submits.length).toBe(2)
  const r: any = await $.command.run({ command: 'tether-watch', args: 'run nope' } as any)
  expect(r.text).toBe('watch: no poller "nope"')
})

test('the status line counts down to each poller and the state file carries the boxes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #7 conflict with main')
  const clock = await start($, on, { ...PRS, stateFile: '/work/watch-state.json', pollers: [{ ...PRS.pollers[0], boxRows: 3 }] }, w)
  await clock.advance(3 * SEC)
  // The first run is done at 2 s; the next regular one starts 300 s after the start
  await clock.advance(60 * SEC)
  expect(w.statuses[w.statuses.length - 1]).toMatch(/prs 3:5[0-9]$/)
  // The harness may spell the path its own way, so take the one file written
  const state = JSON.parse(Object.values(w.files)[0]!)
  expect(state.pollers[0]).toMatchObject({ id: 'prs', title: 'Pull requests', everySeconds: 300, running: false, ok: true, rows: 3 })
  expect(state.pollers[0].log.map((l: any) => l.text)).toEqual(['#7 conflict with main'])
  expect(state.pollers[0].nextAt).toBeGreaterThan(state.updatedAt)
})

test('/tether-watch pane draws a box per poller with its countdown and findings', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #7 conflict with main')
  const clock = await start($, on, { ...PRS, pollers: [PRS.pollers[0], { id: 'agents', kind: 'agents', everySeconds: 60 }] }, w)
  await clock.advance(10 * SEC)
  expect(await $.command.run({ command: 'tether-watch', args: 'pane' } as any)).toEqual({})
  const ui: any = await $.ui.mount({
    plugin: 'watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tether',
    props: { title: 'Tether', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as any)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts.some((t: string) => /^Pull requests {2}next in 4:5[0-9]$/.test(t))).toBe(true)
  expect(texts.some((t: string) => /^agents {2}next in 0:5[0-9]$/.test(t))).toBe(true)
  expect(texts.some((t: string) => /^[0-9][0-9]:[0-9][0-9] #7 conflict with main$/.test(t))).toBe(true)
  // The box is as tall as boxRows: the default six log lines under the title
  expect(texts.filter((t: string) => t === ' ').length).toBeGreaterThanOrEqual(5)
})

/** Fires one 250k-context request for an agent and reads the stream to its end. */
async function bigStep($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

test('the agents poller wakes at the subagent max context option, not at 300k', { timeoutMs: 30_000, options: { fleetRetireContextTokens: 200_000 } }, async ($, on) => {
  const w = world('')
  w.agents = [{ id: 'a1', status: 'running', description: 'builder', type: 'general-purpose' }]
  const clock = await start($, on, { pollers: [{ id: 'agents', kind: 'agents', title: 'Agents', everySeconds: 60 }] }, w)
  await bigStep($, 'a1')
  await clock.advance(2 * MIN)
  expect(w.submits).toEqual(['watch found something new. Handle it or say why it can wait:\n\nAgents:\n- builder (a1) context 250k, past 200k'])
})

test('an agents poller with its own contextTokens ignores the subagent max context option', { timeoutMs: 30_000, options: { fleetRetireContextTokens: 200_000 } }, async ($, on) => {
  const w = world('')
  w.agents = [{ id: 'a1', status: 'running', description: 'builder', type: 'general-purpose' }]
  const clock = await start($, on, { pollers: [{ id: 'agents', kind: 'agents', title: 'Agents', everySeconds: 60, contextTokens: 400_000 }] }, w)
  await bigStep($, 'a1')
  await clock.advance(2 * MIN)
  expect(w.submits).toEqual([])
})

const TRIAGE = { pollers: [{ id: 'triage', kind: 'issues', title: 'Issues to triage', labels: ['needs-triage'], everySeconds: 120 }] }
const issue = (n: number, updatedAt: string) => ({ number: n, updatedAt, title: 'never told' })

test('the issues poller wakes once per labelled issue, and again when the issue changes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(JSON.stringify([issue(5, '2026-10-20T10:00:00Z')]))
  const clock = await start($, on, TRIAGE, w)
  await clock.advance(3 * SEC)
  expect(w.argv[0]).toEqual(['gh', 'issue', 'list', '--state', 'open', '--label', 'needs-triage', '--limit', '100', '--json', 'number,updatedAt'])
  expect(w.submits).toEqual(['watch found something new. Handle it or say why it can wait:\n\nIssues to triage:\n- #5 needs-triage'])
  await clock.advance(2 * MIN)
  expect(w.submits.length).toBe(1)
  // A change to the issue (a comment, an edit) makes it news again; its title is never told
  w.runs = [{ exitCode: 0, stdout: JSON.stringify([issue(5, '2026-10-20T11:00:00Z')]) }]
  await clock.advance(2 * MIN)
  expect(w.submits.length).toBe(2)
  expect(w.submits.join('\n')).not.toContain('never told')
})

test('a wake the engine refuses is told once, and the findings are sent again after resendAfterMinutes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'a Stop stands'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  expect(w.toasts.filter(t => t.includes('refused (a Stop stands)')).length).toBe(1)
  expect(w.statuses.at(-1)).toContain('wake refused')
  // Held for two minutes: no retry storm meanwhile
  await clock.advance(1 * MIN)
  expect(w.submits.length).toBe(1)
  w.answer = undefined
  await clock.advance(1 * MIN + 10 * SEC)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('#12 fix-x: conflict')
  await clock.advance(10 * MIN)
  expect(w.submits.length).toBe(2)
})

test('a refused wake goes again as soon as a turn of the person has run', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'a Stop stands'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  w.answer = undefined
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await clock.advance(6 * SEC)
  expect(w.submits.length).toBe(2)
})

test('a wake taken that starts no turn is sent again once the session sat idle resendAfterMinutes', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  w.answer = 'no-turn'
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  // New findings meanwhile do not stack a second wake behind the first
  w.runs = [{ exitCode: 0, stdout: '- #12 fix-x: conflict\n- #13 y: conflict\n' }]
  await $.command.run({ command: 'tether-watch', args: 'run prs' } as any)
  await clock.advance(1 * MIN + 30 * SEC)
  expect(w.submits.length).toBe(1)
  w.answer = undefined
  await clock.advance(40 * SEC)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toMatch(/- #12 fix-x: conflict\n- #13 y: conflict$/)
  expect(w.logs).toContain('watch: the last wake started no turn; it is sent again')
})

test('the idle wake goes after idleWakeMinutes with nothing found and no subagent at work', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('')
  const clock = await start($, on, { idleWakeMinutes: 30, pollers: [] }, w)
  await clock.advance(29 * MIN)
  expect(w.submits).toEqual([])
  await clock.advance(1 * MIN + 10 * SEC)
  expect(w.submits).toEqual(['Nothing new: woken after 30 idle minutes with no subagent at work. Take up the next piece of work, or say why there is none.'])
  // The wake's own turn ended: the next one is 30 minutes on, and none while a subagent is at work
  w.agents = [{ id: 'a1', status: 'running', description: 'builder', type: 'general-purpose' }]
  await clock.advance(40 * MIN)
  expect(w.submits.length).toBe(1)
  w.agents = [{ id: 'a1', status: 'completed', description: 'builder', type: 'general-purpose' }]
  await clock.advance(10 * SEC)
  expect(w.submits.length).toBe(2)
})

test('the idle wake is off by default', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('')
  const clock = await start($, on, { tickSeconds: 0, pollers: [] }, w)
  await clock.advance(2 * 60 * MIN)
  expect(w.submits).toEqual([])
})

test('a subagent turn leaves the session free for a wake', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, PRS, w)
  await $.turn.start({ text: 'work', turnId: 'a', agentId: 'a1' } as any)
  await clock.advance(10 * SEC)
  expect(w.submits.length).toBe(1)
})

test('a poller with remindMinutes tells a finding still reported again, marked, with backoff', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world('- #12 fix-x: conflict\n')
  const clock = await start($, on, { pollers: [{ ...PRS.pollers[0], everySeconds: 60, remindMinutes: 10, forgetMinutes: 600 }] }, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  await clock.advance(9 * MIN)
  expect(w.submits.length).toBe(1)
  await clock.advance(2 * MIN)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toMatch(/- #12 fix-x: conflict \(still reported\)$/)
  // The next reminder is twenty minutes on
  await clock.advance(15 * MIN)
  expect(w.submits.length).toBe(2)
  await clock.advance(6 * MIN)
  expect(w.submits.length).toBe(3)
})
