// Reading Claude Code's transcript files for agents fleet did not see start.
import { expect, mock, test } from 'claude-code/testing'

import { lastRequest, metaDescription, projectKey, subagentsDir } from '../../src/fleet/transcript'

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
