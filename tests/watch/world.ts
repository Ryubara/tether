// The fake world the watch and notice hook tests run in: a started plugin with a command poller and the engine's answers.
import { mock } from 'claude-code/testing'

export const SEC = 1000
export const MIN = 60 * SEC

/** What a test's fake world records and answers. */
export type World = {
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
export async function pickUp($: any, n: number) {
  await $.turn.start({ text: '', turnId: `wake-${n}` } as any)
  await $.turn.complete({ turnId: `wake-${n}`, answer: '' } as any)
}

/** Starts watch with `config` as the file's watch section (`top` beside it) and the fake world's answers. */
export async function start($: any, on: any, config: unknown, world: World, top: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ ...top, watch: config, housekeeping: { enabled: false }, conversations: { enabled: false } }) }))
  on('classic.Stop', () => ({}))
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
export function world(stdout: string, exitCode = 0): World {
  return { submits: [], toasts: [], logs: [], statuses: [], files: {}, draft: '', runs: [{ exitCode, stdout }], agents: [], argv: [] }
}

export const PRS = {
  minWakeGapSeconds: 60,
  pollers: [{ id: 'prs', title: 'Pull requests', command: ['check'], everySeconds: 300, match: '^- (.*)$', quietExitCodes: [3] }],
}
