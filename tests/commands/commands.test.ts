// Tests of the slash commands Tether registers: each is named with the tether- prefix and its description
// says (PANE) exactly when the command opens or shows something in the pane.
import { expect, mock, test } from 'claude-code/testing'

import { CHECKPOINT, COMMANDS, FLEET, GUARDS, PANE_MARK, WATCH } from '../../src/commands/commands'

type Registered = { name: string; description: string; argumentHint?: string }

/** Starts Tether with the smallest world that lets session.start finish, and answers what was registered. */
async function registered($: any, on: any): Promise<Registered[]> {
  const seen: Registered[] = []
  mock.clock(on)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($: any, e: any) => {
    seen.push(e)
    return { value: undefined }
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', exitCode: 1 } }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return seen
}

test('the table names every command with the tether- prefix and marks pane commands with (PANE)', async () => {
  expect(COMMANDS.map(c => c.name)).toEqual(['tether-fleet', 'tether-watch', 'tether-guards', 'tether-checkpoint'])
  for (const c of COMMANDS) expect([c.name, c.description.includes('(PANE)')]).toEqual([c.name, c.pane])
  expect(PANE_MARK).toBe('(PANE)')
  // $.command.register takes letters, digits, _ and - only, up to 64
  for (const c of COMMANDS) expect(c.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
})

test('tether-fleet is registered, and its description says (PANE)', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = await registered($, on)
  const c = seen.filter(x => x.name === 'tether-fleet')
  expect(c.length).toBe(1)
  expect(c[0]?.description).toContain('(PANE)')
  expect(c[0]?.description).toBe(FLEET.description)
})

test('tether-watch is registered, and its description says (PANE)', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = await registered($, on)
  const c = seen.filter(x => x.name === 'tether-watch')
  expect(c.length).toBe(1)
  expect(c[0]?.description).toContain('(PANE)')
  expect(c[0]?.description).toBe(WATCH.description)
})

test('tether-guards is registered, and its description does not say (PANE) because it only prints text', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = await registered($, on)
  const c = seen.filter(x => x.name === 'tether-guards')
  expect(c.length).toBe(1)
  expect(c[0]?.description).not.toContain('(PANE)')
  expect(c[0]?.description).toBe(GUARDS.description)
})

test('tether-checkpoint is registered, and its description does not say (PANE) because it only prints text', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = await registered($, on)
  const c = seen.filter(x => x.name === 'tether-checkpoint')
  expect(c.length).toBe(1)
  expect(c[0]?.description).not.toContain('(PANE)')
  expect(c[0]?.description).toBe(CHECKPOINT.description)
})

test('no command is registered under an unprefixed name', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = await registered($, on)
  expect(seen.map(x => x.name).sort()).toEqual(['tether-checkpoint', 'tether-fleet', 'tether-guards', 'tether-watch'])
})

test('each command answers to its prefixed name only', { timeoutMs: 30_000 }, async ($, on) => {
  await registered($, on)
  const guards: any = await $.command.run({ command: 'tether-guards' } as any)
  expect(guards.text).toContain('guards:')
  const fleet: any = await $.command.run({ command: 'tether-fleet', args: 'text' } as any)
  expect(fleet.text).toContain('agent')
  const watch: any = await $.command.run({ command: 'tether-watch', args: '' } as any)
  expect(typeof watch.text).toBe('string')
  const old: any = await $.command.run({ command: 'guards' } as any).catch(() => undefined)
  expect(old?.text).toBeUndefined()
})
