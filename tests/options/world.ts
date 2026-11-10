// A fake world for whole-plugin tests of the config rules: files by path, the environment, commands, agents and
// every place Tether's output can land (prompts, the Stop hook, toasts, the status line, logs, files, the store,
// messages to agents, tool results). Synthetic data only.
import { mock } from 'claude-code/testing'

export const SEC = 1000
export const MIN = 60 * SEC

export type Run = { exitCode: number; stdout: string; stderr?: string }

export type World = {
  /** Files by path (forward slashes); a path ending in one of these keys matches it. */
  files: Record<string, string>
  /** Paths Tether read with fs.read. */
  reads: string[]
  env: Record<string, string>
  /** Every command Tether ran, as argv. */
  runs: string[][]
  /** The answer to a command; undefined: exit 1, nothing printed. */
  answer: (argv: string[]) => Run | undefined
  agents: Array<{ id: string; status: string; description?: string; type?: string; name?: string }>
  /** The session's messages (session.messages). */
  messages: unknown[]
  submits: string[]
  /** The context each submitted prompt carried down to the engine, in the order of `submits`. */
  submitContexts: Array<readonly string[] | undefined>
  /** The engine's live main context (session.usage `context.tokens`); undefined: none yet. */
  usageTokens?: number
  toasts: string[]
  logs: string[]
  statuses: string[]
  /** Every pane Tether asked ui.open for. */
  opened: Array<Record<string, unknown>>
  /** The name of every tool Tether registered. */
  registered: string[]
  /** What fs.write wrote, by path. */
  writes: Record<string, string>
  /** The store, and every value written to it (key and JSON). */
  store: Map<string, unknown>
  storeWrites: string[]
  /** Every session.send text, and what it answers. */
  sent: string[]
  delivery: { isDelivered: boolean; reason?: string }
  /** TaskStop task ids, and what the call answers. */
  stopped: string[]
  taskStop: { deny?: string }
  /** The context of every model request. */
  context: number
  /** The session's id (session.id); a clear gives the process a new one. */
  sessionId: string
  /** The session folders the project's transcript folder lists (fs.list); default one, `s1`. */
  dirs: string[]
  /** A file's size and mtime by its key in `files` (fs.stat); default 1000 bytes, mtime 1. Over 4 MiB fs.read rejects it, as the engine does. */
  stats: Record<string, { size: number; mtimeMs: number }>
}

export function world(over: Partial<World> = {}): World {
  return {
    files: {},
    reads: [],
    env: {},
    runs: [],
    answer: () => undefined,
    agents: [],
    messages: [],
    submits: [],
    submitContexts: [],
    toasts: [],
    logs: [],
    statuses: [],
    opened: [],
    registered: [],
    writes: {},
    store: new Map(),
    storeWrites: [],
    sent: [],
    delivery: { isDelivered: true },
    stopped: [],
    taskStop: {},
    context: 150_000,
    sessionId: 'abcdef12-0000',
    dirs: ['s1'],
    stats: {},
    ...over,
  }
}

const norm = (p: string) => p.replace(/\\/g, '/')
/** The file key a path means: equal, or the path ends with `/<key>` (the engine spells paths absolutely). */
function fileOf(w: World, path: string): string | undefined {
  const p = norm(path)
  return Object.keys(w.files).find(k => p === k || p.endsWith('/' + k.replace(/^\//, '')))
}

/** Starts Tether in the fake world. */
export async function start($: any, on: any, w: World) {
  const clock = mock.clock(on)
  on('store.get', ($: any, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    w.store.set(e.key, e.value)
    w.storeWrites.push(`${e.key}=${JSON.stringify(e.value)}`)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', ($: any, e: any) => {
    w.registered.push(String(e.name))
    return { value: { tool: 'x' } }
  })
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : w.env[e.name] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 1_000_000, ...(w.usageTokens !== undefined ? { tokens: w.usageTokens } : {}) } } }))
  on('fs.exists', ($: any, e: any) => ({ value: fileOf(w, e.path) !== undefined }))
  on('fs.read', ($: any, e: any) => {
    w.reads.push(norm(e.path))
    const k = fileOf(w, e.path)
    if (k === undefined) throw new Error('no such file')
    if ((w.stats[k]?.size ?? 0) > 4 * 1024 * 1024) throw new Error('file is over 4 MiB')
    return { value: w.files[k] }
  })
  on('fs.list', () => ({ value: w.dirs.map(name => ({ name, kind: 'dir', size: 0 })) }))
  on('fs.stat', ($: any, e: any) => {
    const k = fileOf(w, e.path)
    return { value: { kind: 'file', size: 1000, mtimeMs: 1, isLink: false, ...(k !== undefined ? w.stats[k] : {}) } }
  })
  on('fs.write', ($: any, e: any) => {
    w.writes[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    w.runs.push(e.argv)
    return { value: { stdout: '', stderr: '', exitCode: 1, ...(w.answer(e.argv) ?? {}) } }
  })
  on('agent.list', () => ({ value: w.agents }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', ($: any, e: any) => {
    w.submits.push(e.text)
    w.submitContexts.push(e.context)
    return { text: e.text, origin: e.origin }
  })
  on('session.send', ($: any, e: any) => {
    w.sent.push(e.text)
    return w.delivery
  })
  on('session.messages', () => ({ value: w.messages }))
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    w.statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', ($: any, e: any) => {
    w.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
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

/** A /clear as a mod sees it: the conversation ends with reason `clear` and the process takes a new id. */
export async function clearSession($: any, w: World, newId = 'abcdef12-0001') {
  const ended = w.sessionId
  w.sessionId = newId
  await $.session.end({ reason: 'clear', sessionId: ended, resume: { id: ended } })
}

/** One model request of an agent, read to its end. */
export async function step($: any, agentId: string, model = 'claude-opus-5-5') {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, agentId })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

/** The text a command answers. */
export async function command($: any, name: string, args = ''): Promise<string> {
  return ((await $.command.run({ command: name, args } as any)) as any)?.text ?? ''
}

/** What the Stop hook answers. */
export async function stopHook($: any): Promise<any> {
  return ($ as any).classic.Stop({ stop_hook_active: false })
}
