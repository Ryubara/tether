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
  /** What the project's health command (argv[0] `health`) prints and exits with. */
  health?: { stdout: string; exitCode: number }
  /** The messages of the session. */
  messages: unknown[]
  agents: Array<{ id: string; status: string; description: string; type: string }>
  /** Transcript files Claude Code wrote (path suffix -> text); `fs.list` shows one session folder `s1`. */
  transcripts: Record<string, string>
}

/** What was written to the file whose path ends with `suffix` (the engine spells paths absolutely). */
function written(w: World, suffix: string): string | undefined {
  const key = Object.keys(w.files).find(k => k.endsWith(suffix))
  return key === undefined ? undefined : w.files[key]
}

const world = (over: Partial<World> = {}): World => ({ files: {}, exist: new Set(), submits: [], logs: [], prs: [], messages: [], agents: [], transcripts: {}, ...over })

/** Starts Tether with `config` as the project file and the fake world's answers. */
async function start($: any, on: any, config: unknown, w: World) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  const transcript = (p: string) => Object.keys(w.transcripts).find(k => p.replace(/\\/g, '/').endsWith(k))
  on('fs.exists', ($: any, e: any) => ({ value: w.exist.has(e.path.replace(/\\/g, '/')) || e.path.endsWith('tether.json') || transcript(e.path) !== undefined }))
  on('fs.list', () => ({ value: [{ name: 's1', kind: 'dir', size: 0 }] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.read', ($: any, e: any) => {
    const k = transcript(e.path)
    if (k !== undefined) return { value: w.transcripts[k] }
    return { value: e.path.endsWith('tether.json') ? JSON.stringify(config) : (w.files[e.path.replace(/\\/g, '/')] ?? w.files[e.path] ?? '') }
  })
  on('fs.write', ($: any, e: any) => {
    w.files[e.path.replace(/\\/g, '/')] = e.text
    w.exist.add(e.path.replace(/\\/g, '/'))
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return { value: { stdout: '.git/info/exclude\n', stderr: '', exitCode: 0 } }
    if (argv[0] === 'health') return { value: { stdout: w.health?.stdout ?? '{}', stderr: '', exitCode: w.health?.exitCode ?? 0 } }
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
  on('classic.SessionStart', () => ({}))
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
  const report: any = await $.command.run({ command: 'tether-guards' } as any)
  expect(report.text).toContain('owner #12: agent-7')
})

const HEALTH = { stuck: [{ number: 12, branch: 'fix-x', cause: 'conflict', detail: 'with main', who: 'author' }] }

test('a health command that exits 1 with stuck JSON still yields findings; exit 2 or bad JSON is an error', { timeoutMs: 30_000 }, async ($, on) => {
  const config = { watch: { pollers: [{ id: 'prs', kind: 'prs', everySeconds: 300, command: ['health'] }] } }
  const w = world({ prs: CONFLICT, health: { stdout: JSON.stringify(HEALTH), exitCode: 1 } })
  const clock = await start($, on, config, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('#12 fix-x')
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('#12 fix-x')
})

test('a health command that exits 2 is an error, not a quiet pass', { timeoutMs: 30_000 }, async ($, on) => {
  const config = { watch: { pollers: [{ id: 'prs', kind: 'prs', everySeconds: 300, command: ['health'] }] } }
  const w = world({ prs: CONFLICT, health: { stdout: JSON.stringify(HEALTH), exitCode: 2 } })
  const clock = await start($, on, config, w)
  await clock.advance(3 * SEC)
  expect(w.submits.length).toBe(0)
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toBeUndefined()
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
  // Undecided and warm (50 min idle, cache of 60): a message still goes through
  expect(await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'go on' } as any)).toEqual({ result: 'ok' })
  await $.tool.call({ tool: 'mcp__tether__agent_decision', id: 'a1', decision: 'retired', note: 'successor later' } as any)
  expect((((await ($ as any).classic.Stop({ stop_hook_active: false })) as any).block)).toBeUndefined()
  // Decided: never woken, though its cache is still warm; the override token passes
  const refused: any = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'go on' } as any)
  expect(refused.deny).toMatch(/decided retired.*never woken/)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'a1', message: '[cache-ok] go on' } as any)).toEqual({ result: 'ok' })
})

test('the guard demands a decision 20 minutes before the cache expires and not before', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: [{ id: 'a1', status: 'completed', description: 'builder', type: 'general-purpose' }] })
  const clock = await start($, on, { watch: { pollers: [{ id: 'agents', kind: 'agents', everySeconds: 60 }] }, fleet: { bigContextTokens: 1000 } }, w)
  const stream = ($ as any).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  await clock.advance(35 * MIN)
  expect((((await ($ as any).classic.Stop({ stop_hook_active: false })) as any).block)).toBeUndefined()
  await clock.advance(6 * MIN)
  expect(((await ($ as any).classic.Stop({ stop_hook_active: false })) as any).block).toContain('CACHE GUARD')
})

test('a big agent that stepped before Tether loaded is still caught, from its transcript', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ agents: [{ id: 'a1', status: 'completed', description: 'builder', type: 'general-purpose' }] })
  const clock = await start($, on, { watch: { pollers: [{ id: 'agents', kind: 'agents', everySeconds: 60 }] } }, w)
  // The agent made its last request 50 minutes ago, before Tether loaded, so Tether never saw it step: only Claude
  // Code's transcript knows (written after the start, as the agent's own run would have)
  const at = new Date((await (clock as any).now()) - 50 * MIN).toISOString()
  const line = JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: 90_000 } } })
  w.transcripts['/s1/subagents/agent-a1.jsonl'] = line
  await clock.advance(6 * MIN)
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('CACHE GUARD')
  expect(stop.block).toContain('a1')
  expect(stop.block).toContain('context 90k')
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

const FAILED = { stuck: [{ number: 12, branch: 'fix-x', cause: 'checks-failed', checks: ['lint', 'build'] }] }

test('a rerun the health command made is told as information and owns the failed checks', { timeoutMs: 30_000 }, async ($, on) => {
  const config = { watch: { pollers: [{ id: 'prs', kind: 'prs', everySeconds: 300, command: ['health'] }] } }
  const health = { ...FAILED, rerun: [{ number: 12, branch: 'fix-x', run: 99, checks: ['build', 'lint'], reasons: ['infra', 'infra'], status: 'reran', detail: '', other: 1 }] }
  const w = world({ prs: CONFLICT, health: { stdout: JSON.stringify(health), exitCode: 1 } })
  const clock = await start($, on, config, w)
  await clock.advance(3 * SEC)
  // The info line is told; the failed-checks problem is owned by the rerun, so it is not
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('#12 fix-x: rerun build, lint (run 99) reran: infra; infra')
  expect(w.submits[0]).not.toContain('checks-failed')
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toBeUndefined()
  const report: any = await $.command.run({ command: 'tether-guards' } as any)
  expect(report.text).toContain('0 without an owner')
  expect(report.text).toContain('info: #12 fix-x: rerun build, lint (run 99) reran: infra; infra')
})

test('a rerun that cannot fix the problem is told but owns nothing, and the rerun owns only the checks it reran', { timeoutMs: 30_000 }, async ($, on) => {
  const config = { watch: { pollers: [{ id: 'prs', kind: 'prs', everySeconds: 300, command: ['health'] }] } }
  const skipped = { ...FAILED, rerun: [{ number: 12, run: 98, checks: ['lint', 'build'], reasons: ['x', 'y'], status: 'refused', detail: 'not flaky' }] }
  const w = world({ prs: CONFLICT, health: { stdout: JSON.stringify(skipped), exitCode: 1 } })
  const clock = await start($, on, config, w)
  await clock.advance(3 * SEC)
  expect(w.submits[0]).toContain('rerun build, lint (run 98) refused: not flaky')
  expect(w.submits[0]).toContain('#12 fix-x: checks-failed')
  const stop: any = await ($ as any).classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('#12 fix-x: checks-failed')
  expect(stop.block).not.toContain('rerun build')
})

test('checkpoint.injectHandoff adds the handoff to the session at start, capped; off it adds nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world()
  await start($, on, { checkpoint: { injectHandoff: true } }, w)
  // Housekeeping made the handoff from the template; put real text in its place
  const path = Object.keys(w.files).find(k => k.endsWith('/HANDOFF.md'))!
  w.files[path] = 'Line one\n' + Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n')
  const r: any = await ($ as any).classic.SessionStart({ source: 'startup' })
  expect(r.additionalContext.length).toBe(1)
  expect(r.additionalContext[0]).toContain('Project state from the handoff file (Tether)')
  expect(r.additionalContext[0]).toContain('Line one')
  expect(r.additionalContext[0]).toContain('row 398')
  expect(r.additionalContext[0]).not.toContain('row 399')
  expect(r.additionalContext[0]).toContain('is 501 lines; only the first 400 are shown')
  // Every start source gets it
  const cleared: any = await ($ as any).classic.SessionStart({ source: 'compact' })
  expect(cleared.additionalContext.length).toBe(1)
})

test('without injectHandoff, or without a handoff, the session start adds no context', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world()
  await start($, on, {}, w)
  const off: any = await ($ as any).classic.SessionStart({ source: 'startup' })
  expect(off?.additionalContext).toBeUndefined()
})
