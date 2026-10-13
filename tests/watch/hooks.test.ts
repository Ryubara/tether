// Tests of watch's hooks against the engine's test kit: polls, dedupe, and when a wake goes.
import { expect, mock, test } from 'claude-code/testing'

const SEC = 1000
const MIN = 60 * SEC

/** What a test's fake world records and answers. */
type World = {
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
  on('process.run', () => {
    const r = world.runs.length > 1 ? world.runs.shift()! : world.runs[0]!
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  on('agent.list', () => ({ value: world.agents }))
  on('prompt.read', () => ({ value: { text: world.draft, cursor: world.draft.length } }))
  on('prompt.submit', ($: any, e: any) => {
    world.submits.push(e.text)
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
  return { submits: [], toasts: [], logs: [], statuses: [], files: {}, draft: '', runs: [{ exitCode, stdout }], agents: [] }
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
    requestId: 'watch',
    props: { title: 'Watch', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as any)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts.some((t: string) => /^Pull requests {2}next in 4:5[0-9]$/.test(t))).toBe(true)
  expect(texts.some((t: string) => /^agents {2}next in 0:5[0-9]$/.test(t))).toBe(true)
  expect(texts.some((t: string) => /^[0-9][0-9]:[0-9][0-9] #7 conflict with main$/.test(t))).toBe(true)
  // The box is as tall as boxRows: the default six log lines under the title
  expect(texts.filter((t: string) => t === ' ').length).toBeGreaterThanOrEqual(5)
})
