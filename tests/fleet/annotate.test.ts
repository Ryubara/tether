// The configPath option and the annotate adapter: notes reach the row of the agent they name.
import { expect, mock, test } from 'claude-code/testing'

const CONFIG = '/elsewhere/fleet.json'

/** The engine hands paths on in the platform's own spelling (`C:\elsewhere\fleet.json` on Windows). */
function isConfig(path: string): boolean {
  return path.replace(/\\/g, '/').endsWith(CONFIG)
}

test('configPath picks the config file, and annotate notes find an agent by its Agent-call name', { timeoutMs: 30_000, options: { configPath: CONFIG } }, async ($, on) => {
  // The stubs answer with partial values, so they skip the engine's result types
  const stub = on as any
  const clock = mock.clock(on)
  const read: string[] = []
  const ran: string[][] = []
  stub('session.start', () => ({ cwd: '/work' }))
  stub('command.register', () => ({ value: undefined }))
  stub('tool.register', () => ({ value: { tool: 'x' } }))
  stub('ui.log', () => ({ value: undefined }))
  stub('store.get', () => ({ value: undefined }))
  stub('fs.exists', ($: any, e: any) => ({ value: isConfig(e.path) }))
  stub('fs.read', ($: any, e: any) => {
    read.push(isConfig(e.path) ? 'config' : e.path)
    return { value: JSON.stringify({ fleet: { refreshSeconds: 5, annotate: { command: ['notes', '--json'], everySeconds: 60 } }, housekeeping: { enabled: false } }) }
  })
  stub('process.run', ($: any, e: any) => {
    ran.push(e.argv)
    return { value: { stdout: '{"builder": "queued: main 2/3, 4m"}', stderr: '', exitCode: 0 } }
  })
  // The list carries no name; only the Agent call did
  stub('agent.list', () => ({ value: [{ id: 'a9', status: 'waiting', description: 'build wait' }] }))
  stub('session.usage', () => ({ value: { rateLimits: [] } }))
  stub('ui.status', () => ({ value: undefined }))
  stub('ui.invalidate', () => ({ value: undefined }))
  stub('tool.call', () => ({ result: { agentId: 'a9' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Agent', name: 'builder', description: 'build wait', prompt: 'build it', subagent_type: 'general-purpose' } as any)

  await clock.advance(1_500)
  expect(read).toEqual(['config'])
  expect(ran).toEqual([['notes', '--json']])
  const text: any = await $.command.run({ command: 'tether-fleet', args: 'text' } as any)
  expect(text.text).toMatch(/^⏳ builder\s+waiting \(bg work\).*· queued: main 2\/3, 4m$/m)
})
