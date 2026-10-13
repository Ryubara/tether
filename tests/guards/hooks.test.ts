// Tests of the guards, housekeeping and conversation logs against the engine's test kit.
import { expect, mock, test } from 'claude-code/testing'

const SEC = 1000
const MIN = 60 * SEC

type World = {
  /** What was written with fs.write, by path. */
  files: Record<string, string>
  /** Paths that exist. */
  exist: Set<string>
  submits: string[]
  logs: string[]
  /** `gh pr list` answer. */
  prs: unknown[]
  /** The messages of the session. */
  messages: unknown[]
  agents: Array<{ id: string; status: string; description: string; type: string }>
}

/** What was written to the file whose path ends with `suffix` (the engine spells paths absolutely). */
function written(w: World, suffix: string): string | undefined {
  const key = Object.keys(w.files).find(k => k.endsWith(suffix))
  return key === undefined ? undefined : w.files[key]
}

const world = (over: Partial<World> = {}): World => ({ files: {}, exist: new Set(), submits: [], logs: [], prs: [], messages: [], agents: [], ...over })

/** Starts Tether with `config` as the project file and the fake world's answers. */
async function start($: any, on: any, config: unknown, w: World) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('fs.exists', ($: any, e: any) => ({ value: w.exist.has(e.path.replace(/\\/g, '/')) || e.path.endsWith('tether.json') }))
  on('fs.read', ($: any, e: any) => ({ value: e.path.endsWith('tether.json') ? JSON.stringify(config) : (w.files[e.path] ?? '') }))
  on('fs.write', ($: any, e: any) => {
    w.files[e.path.replace(/\\/g, '/')] = e.text
    w.exist.add(e.path.replace(/\\/g, '/'))
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return { value: { stdout: '.git/info/exclude\n', stderr: '', exitCode: 0 } }
    if (argv[0] === 'gh') return { value: { stdout: JSON.stringify(w.prs), stderr: '', exitCode: 0 } }
    return { value: { stdout: '', stderr: 'unexpected', exitCode: 1 } }
  })
  on('agent.list', () => ({ value: w.agents }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', ($: any, e: any) => {
    w.submits.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abcdef12-0000' }))
  on('session.messages', () => ({ value: w.messages }))
  on('classic.Stop', () => ({}))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000 } }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer ?? '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return clock
}

const CONFLICT = [{ number: 12, headRefName: 'fix-x', headRefOid: 'abc', mergeable: 'CONFLICTING' }]
const PRS = { watch: { pollers: [{ id: 'prs', kind: 'prs', everySeconds: 300 }] } }

test('a PR problem is told, blocks the Stop hook until owned, and an owner ends both', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ prs: CONFLICT })
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  // The poll found the conflict and woke the model with it
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('#12 fix-x: conflicts with the base branch')

  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('PR GUARD')
  expect(stop.block).toContain('#12 fix-x')

  const done: any = await $.tool.call({ tool: 'mcp__tether__pr_owner', pr: 12, kind: 'assign', who: 'agent-7', note: 'fixing it' } as any)
  expect(done.text ?? JSON.stringify(done)).toContain('#12 assigned to agent-7')
  // The harness refuses a tool result that is an object: the text goes back as a plain string
  expect(typeof (done.result ?? done.text)).toBe('string')
  const after: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(after.block).toBeUndefined()
  const report: any = await $.command.run({ command: 'guards' } as any)
  expect(report.text).toContain('owner #12: agent-7')
})

test('the Stop hook gives up after the same block maxBlocks times', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ prs: CONFLICT })
  const clock = await start($, on, { ...PRS, stop: { maxBlocks: 2 } }, w)
  await clock.advance(3 * SEC)
  const blocks: boolean[] = []
  for (let i = 0; i < 4; i++) blocks.push(Boolean(((await ($ as any).classic.Stop({ stop_hook_active: true })) as any).block))
  expect(blocks).toEqual([true, true, false, false])
})

test('a waiver covers one cause only, and the tool refuses a bad call', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ prs: CONFLICT })
  const clock = await start($, on, PRS, w)
  await clock.advance(3 * SEC)
  await $.tool.call({ tool: 'mcp__tether__pr_owner', pr: 12, kind: 'waive', hours: 2, cause: 'checks-failed', note: 'waits' } as any)
  expect((((await ($ as any).classic.Stop({ stop_hook_active: false })) as any).block ?? '')).toContain('#12 fix-x')
  const bad: any = await $.tool.call({ tool: 'mcp__tether__pr_owner', pr: 12, kind: 'waive', note: 'no hours' } as any)
  expect(bad.isError ?? bad.deny ?? bad.text).toBeTruthy()
})

test('a stopped big agent blocks Stop until it is decided', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: [{ id: 'a1', status: 'completed', description: 'builder', type: 'general-purpose' }] })
  const clock = await start($, on, { watch: { pollers: [{ id: 'agents', kind: 'agents', everySeconds: 60 }] }, fleet: { bigContextTokens: 1000 } }, w)
  // It made one big request, then stopped; 50 minutes pass
  const stream = ($ as any).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  await clock.advance(50 * MIN)
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('CACHE GUARD')
  expect(stop.block).toContain('a1')
  await $.tool.call({ tool: 'mcp__tether__agent_decision', id: 'a1', decision: 'retired', note: 'successor later' } as any)
  expect((((await ($ as any).classic.Stop({ stop_hook_active: false })) as any).block)).toBeUndefined()
})

test('housekeeping hides Tether from git, makes the handoff, and holds writes of it to the template', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world()
  await start($, on, {}, w)
  expect(written(w, '.git/info/exclude')).toBe('.tether/\nHANDOFF.md\n.claude/tether.json\n')
  expect(written(w, '/HANDOFF.md')).toContain('## Open questions')
  // A write that breaks the template is refused; a good one goes through
  const bad: any = await $.tool.call({ tool: 'Write', file_path: '/work/HANDOFF.md', content: '# nothing' } as any)
  expect(JSON.stringify(bad)).toContain('must follow its template')
  const good: any = await $.tool.call({ tool: 'Write', file_path: '/work/HANDOFF.md', content: written(w, '/HANDOFF.md') } as any)
  expect(JSON.stringify(good)).not.toContain('must follow its template')
  const other: any = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# nothing' } as any)
  expect(JSON.stringify(other)).not.toContain('must follow its template')
})

test('a conversation log is written after a turn, whole, under the folder', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ messages: [{ role: 'user', text: 'Fix the bug', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'Read', input: { file_path: 'a.ts' } }] }] })
  const clock = await start($, on, {}, w)
  await $.turn.complete({ turnId: 't', answer: 'Done.' } as any)
  await clock.advance(1 * SEC)
  const [path] = Object.keys(w.files).filter(p => p.includes('conversations/'))
  expect(path).toMatch(/\.tether\/conversations\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md$/)
  expect(w.files[path!]).toContain('## 1. Fix the bug')
  expect(w.files[path!]).toContain('- Read: a.ts')
})
