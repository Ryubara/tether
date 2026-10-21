// Reading Claude Code's transcript files for agents fleet did not see start.
import { expect, mock, test } from 'claude-code/testing'

import { contentText, lastRequest, liveTasks, metaDescription, metaModel, noteAppendedRow, noteTaskEntry, projectKey, subagentsDir } from '../../src/fleet/transcript'

const T0 = Date.parse('2026-10-12T20:00:00.000Z')

/** One transcript line: an assistant entry with usage, or another kind of entry. */
function line(kind: 'assistant' | 'user', at: string, usage?: Record<string, number>): string {
  return JSON.stringify({ type: kind, timestamp: at, message: usage ? { role: 'assistant', usage } : { role: 'user', content: 'x' } })
}

test('paths follow Claude Code: the cwd with every other character a dash', async () => {
  const sep = String.fromCharCode(92)
  expect(projectKey(['C:', 'Repositories', 'Coney', 'repos', 'coney'].join(sep))).toBe('C--Repositories-Coney-repos-coney')
  expect(subagentsDir('C:/Users/me/.claude/', '/home/me/my.app', 's1')).toBe('C:/Users/me/.claude/projects/-home-me-my-app/s1/subagents')
})

test('lastRequest takes the last entry with usage and skips a torn last line', async () => {
  const text = [
    line('assistant', '2026-10-12T19:00:00.000Z', { input_tokens: 1, cache_read_input_tokens: 10 }),
    line('assistant', '2026-10-12T20:00:00.000Z', { input_tokens: 2, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 500 }),
    line('user', '2026-10-12T20:01:00.000Z'),
    '{"type":"assistant","message":{"usage":{"input_tok',
  ].join('\n')
  expect(lastRequest(text)).toEqual({ at: T0, contextTokens: 150_502 })
  expect(lastRequest(line('user', '2026-10-12T20:01:00.000Z'))).toBeUndefined()
  expect(lastRequest('')).toBeUndefined()
})

test('metaDescription reads the Agent call description', async () => {
  expect(metaDescription('{"agentType":"implementer","description":"PR poller"}')).toBe('PR poller')
  expect(metaDescription('{"description":""}')).toBeUndefined()
  expect(metaDescription('nope')).toBeUndefined()
})

test('an agent started before fleet loaded gets its context and idle time, a resumed one its description', { timeoutMs: 30_000 }, async ($, on) => {
  const stub = on as any
  const clock = mock.clock(on)
  await clock.set(T0 + 30 * 60_000)
  const dir = 'C:/Users/me/.claude/projects/C--work/s1/subagents'
  const files: Record<string, string> = {
    [`${dir}/agent-a1.jsonl`]: line('assistant', '2026-10-12T20:00:00.000Z', { input_tokens: 2, cache_read_input_tokens: 90_000 }),
    [`${dir}/agent-a1.meta.json`]: '{"description":"build wait"}',
  }
  const reads: string[] = []
  const norm = (p: string) => p.replace(/\\/g, '/')
  // The kit hands the stubs a path in the platform's form (backslashes on Windows, resolved against the cwd on
  // Linux), so a file is found by the end of its path.
  const find = (p: string) => Object.keys(files).find(k => norm(p).endsWith(k))
  stub('session.start', () => ({ cwd: 'C:/work' }))
  stub('command.register', () => ({ value: undefined }))
  stub('store.get', () => ({ value: undefined }))
  stub('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  stub('session.cwd', () => ({ value: 'C:/work' }))
  stub('session.id', () => ({ value: 's1' }))
  stub('fs.exists', ($: any, e: any) => ({ value: find(e.path) !== undefined }))
  stub('fs.list', () => ({ value: [{ name: 's1', kind: 'dir', size: 0 }, { name: 'old.jsonl', kind: 'file', size: 1 }] }))
  stub('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  stub('fs.read', ($: any, e: any) => {
    const key = find(e.path)
    reads.push(key ?? norm(e.path))
    return { value: key ? files[key] : '' }
  })
  stub('agent.list', () => ({ value: [{ id: 'a1', status: 'waiting', description: '(resumed)', type: 'general-purpose' }] }))
  stub('ui.status', () => ({ value: undefined }))
  stub('ui.invalidate', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/work' })

  const first: any = await $.command.run({ command: 'tether-fleet', args: 'text' } as any)
  expect(first.text).toMatch(/^⏳ build wait\s+waiting \(bg work\)\s+90k\s+30m\s+30m$/m)
  // An unchanged transcript is not read again
  const count = reads.length
  await $.command.run({ command: 'tether-fleet', args: 'text' } as any)
  expect(reads.length).toBe(count)
})

/** A background Bash start and a task notification, in the shapes Claude Code 2.1.296 writes (measured). */
const start = (id: string) => JSON.stringify({ type: 'user', toolUseResult: { backgroundTaskId: id }, message: { role: 'user', content: [{ type: 'tool_result', content: `Command running in background with ID: ${id}. Output is being written to: C:\\x\\${id}.output` }] } })
const block = (id: string, status?: string) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>Background command done</summary>\n</task-notification>`
const queued = (id: string, status?: string) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: block(id, status) } })
const woken = (id: string, status?: string) => JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n${block(id, status)}` } })

test('liveTasks keeps the background tasks a transcript started and has not seen end, in the shape Claude Code writes', async () => {
  const text = [start('b1'), start('b2'), start('b3'), queued('b1', 'completed'), woken('b3', 'killed'), start('b4'), queued('b4', 'failed'), start('b5')].join('\n')
  expect(liveTasks(text)).toEqual(['b2', 'b5'])
  // A task seen to end and started again (the id reused) counts as live
  expect(liveTasks([start('b1'), queued('b1', 'completed'), start('b1')].join('\n'))).toEqual(['b1'])
  // An unfinished notification (no final status yet) does not end a task
  expect(liveTasks([start('b1'), '<task-notification><task-id>b1</task-id>'].join('\n'))).toEqual(['b1'])
  expect(liveTasks('')).toEqual([])
})

test('a notification without a status ends nothing and cannot swallow the next one', async () => {
  // The first block names b1 with no status (a progress event); the second ends b2. The lazy match across blocks used to end b1 and lose b2
  const text = [start('b1'), start('b2'), queued('b1'), queued('b2', 'completed')].join('\n')
  expect(liveTasks(text)).toEqual(['b1'])
  // Two blocks in one prompt are read one by one
  const both = JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: block('b1') + '\n' + block('b2', 'killed') } })
  expect(liveTasks([start('b1'), start('b2'), both].join('\n'))).toEqual(['b1'])
})

test('only the harness structure counts: text an agent printed, read or wrote starts and ends nothing', async () => {
  const echo = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } })
  const said = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Command running in background with ID: fake1. <task-notification><task-id>b1</task-id><status>completed</status></task-notification>' }] } })
  // A Read of a test file shows the phrase after a line number; a cat of a log shows it mid-text; the assistant quotes it
  const lines = [start('b1'), echo('     12\tCommand running in background with ID: fake2'), echo('log:\nCommand running in background with ID: fake3'), said, echo(block('b1', 'completed')), JSON.stringify({ type: 'user', message: { role: 'user', content: block('b1', 'completed') } })]
  expect(liveTasks(lines.join('\n'))).toEqual(['b1'])
  // A backgroundTaskId that is not an id is ignored
  expect(liveTasks(JSON.stringify({ type: 'user', toolUseResult: { backgroundTaskId: 'a b; rm' } }))).toEqual([])
  // A torn line says nothing
  expect(liveTasks([start('b1'), '{"type":"user","toolUse'].join('\n'))).toEqual(['b1'])
})

test('noteAppendedRow reads one appended row by its structure and contentText joins its blocks', async () => {
  const live = new Set<string>()
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: 'Command running in background with ID: z1. Output is being written to: y' }] } }, live)
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'text', text: 'ordinary' }, { type: 'tool_result', content: [{ type: 'text', text: 'Command running in background with ID: z2.' }] }] } }, live)
  expect([...live]).toEqual(['z1', 'z2'])
  // An assistant row, or a user text block that only quotes the phrase, starts nothing
  noteAppendedRow({ message: { type: 'assistant', content: [{ type: 'text', text: 'Command running in background with ID: z9' }] } }, live)
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'text', text: 'Command running in background with ID: z8' }] } }, live)
  expect([...live]).toEqual(['z1', 'z2'])
  // A notification ends a task only as a queued_command attachment or a task-notification row; a tool result or reply that holds one does not
  const note = [{ type: 'text', text: block('z1', 'completed') }]
  noteAppendedRow({ message: { type: 'user', content: note }, origin: { kind: 'tool', tool: 'Read' } }, live)
  noteAppendedRow({ message: { type: 'assistant', content: note } }, live)
  expect([...live]).toEqual(['z1', 'z2'])
  noteAppendedRow({ message: { type: 'attachment', name: 'queued_command', content: note } }, live)
  expect([...live]).toEqual(['z2'])
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'text', text: block('z2', 'failed') }] }, origin: { kind: 'task-notification' } }, live)
  expect([...live]).toEqual([])
  noteTaskEntry(null, live)
  expect(contentText('plain')).toBe('plain')
  expect(contentText(undefined)).toBe('')
})

test('a command moved to the background by its timeout or by the user is a live task, in the transcript and in an appended row', async () => {
  const moved = (id: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}). Output is being written to: x` }] } })
  const manual = (id: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `Command was manually backgrounded by user with ID: ${id}. Output is being written to: x` }] } })
  expect(liveTasks([moved('m1'), manual('m2')].join('\n'))).toEqual(['m1', 'm2'])
  const live = new Set<string>()
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: 'Command did not complete within its 600s timeout and was moved to the background (ID: m3). Output is being written to: y' }] } }, live)
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: 'Command was manually backgrounded by user with ID: m4. Output is being written to: y' }] } }, live)
  expect([...live]).toEqual(['m3', 'm4'])
  // Quoted mid-text it starts nothing
  expect(liveTasks(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'log: Command was manually backgrounded by user with ID: f1.' }] } }))).toEqual([])
})

test('a task the agent stopped itself with TaskStop ends, in the transcript and in an appended row', async () => {
  // Measured on 2.1.296: the agent's own TaskStop is answered by a user row, and no task-notification follows
  const stop = (id: string) => {
    const r = { message: `Successfully stopped task: ${id} (build)`, task_id: id, task_type: 'local_bash', command: 'build' }
    return JSON.stringify({ type: 'user', toolUseResult: r, message: { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(r) }] } })
  }
  expect(liveTasks([start('b1'), start('b2'), stop('b1')].join('\n'))).toEqual(['b2'])
  const live = new Set(['b1', 'b2'])
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ message: 'Successfully stopped task: b2 (x)', task_id: 'b2' }) }] } }, live)
  expect([...live]).toEqual(['b1'])
  // A result that names another task than its message, or text that merely quotes the answer, ends nothing
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ message: 'Successfully stopped task: b9 (x)', task_id: 'b1' }) }] } }, live)
  noteAppendedRow({ message: { type: 'user', content: [{ type: 'tool_result', content: 'cat log: {"message":"Successfully stopped task: b1","task_id":"b1"}' }] } }, live)
  noteAppendedRow({ message: { type: 'assistant', content: [{ type: 'tool_result', content: JSON.stringify({ message: 'Successfully stopped task: b1 (x)', task_id: 'b1' }) }] } }, live)
  expect([...live]).toEqual(['b1'])
})

test('the model of the last request and the model an Agent call pinned are read from the transcript and the meta file', async () => {
  const entry = (at: string, model: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { model, usage: { input_tokens: 2 } } })
  expect(lastRequest([entry('2026-10-13T08:00:00.000Z', 'claude-sonnet-5-5'), entry('2026-10-13T09:00:00.000Z', 'claude-opus-5-5')].join('\n'))?.model).toBe('claude-opus-5-5')
  expect(lastRequest(entry('2026-10-13T09:00:00.000Z', '<synthetic>'))?.model).toBeUndefined()
  expect(metaModel('{"agentType":"implementer","model":"sonnet","effort":"high"}')).toBe('sonnet')
  expect(metaModel('{"agentType":"general-purpose"}')).toBeUndefined()
  expect(metaModel('not json')).toBeUndefined()
  // An agent that inherits the session's model is not pinned
  expect(metaModel('{"agentType":"implementer","model":"inherit"}')).toBeUndefined()
  expect(metaModel('{"model":" Inherit "}')).toBeUndefined()
  expect(metaModel('{"model":""}')).toBeUndefined()
})
