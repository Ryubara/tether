// The config file's top-level rules: where it comes from, when it fails closed, what a locked file sets, and which
// commands the network and allowedCommands rules refuse.
import { expect, test } from 'claude-code/testing'

import { mergeCheckpoint } from '../../src/checkpoint/config'
import { mergeConfig } from '../../src/fleet/config'
import { mergeCacheGuard } from '../../src/guards/config'
import { mergeConversations, mergeHousekeeping, mergeStop } from '../../src/housekeeping/config'
import { OPTIONS, PANES, layered, type Section } from '../../src/options/options'
import { CONFIG_ENV, DEFAULT_CONFIG_FILE, OPEN_POLICY, SECTIONS, commandRefusal, configSource, judge, programName, readPolicy } from '../../src/options/policy'
import { parseConfig } from '../../src/watch/config'

const env = (file: string) => configSource(file, '')
const text = (v: unknown) => ({ text: JSON.stringify(v) })

test('TETHER_CONFIG wins over the configPath option, which wins over the project file', async () => {
  expect(CONFIG_ENV).toBe('TETHER_CONFIG')
  expect(configSource('/zone/tether.json', 'other.json')).toEqual({ file: '/zone/tether.json', fromEnv: true, isDefault: false })
  expect(configSource('C:\\zone\\tether.json', '')).toMatchObject({ file: 'C:\\zone\\tether.json', fromEnv: true })
  expect(configSource(undefined, ' other.json ')).toEqual({ file: 'other.json', fromEnv: false, isDefault: false })
  expect(configSource('', '')).toEqual({ file: DEFAULT_CONFIG_FILE, fromEnv: false, isDefault: true })
  // A relative path in the environment names nothing: it fails closed instead of reading a folder's file
  expect(configSource('zone/tether.json', 'other.json')).toEqual({ file: '', fromEnv: true, isDefault: false })
})

test('a file named by the environment fails closed when missing, unreadable, not JSON, not an object or not valid', async () => {
  const src = env('/zone/tether.json')
  expect(judge(src, 'missing', false)).toMatchObject({ halt: true, policy: OPEN_POLICY })
  expect(judge(src, { error: new Error('denied') }, false).halt).toBe(true)
  expect(judge(src, { text: '{ nope' }, false).halt).toBe(true)
  expect(judge(src, text([1, 2]), false).halt).toBe(true)
  expect(judge(src, text({ fleet: { enabld: true }, netwrok: false }), false).halt).toBe(true)
  expect(judge(src, text({ stop: { maxBlocks: 'three' } }), false).halt).toBe(true)
  expect(judge(src, text({ watch: { pollers: [{ id: 'Bad Id', command: ['x'] }] } }), false).halt).toBe(true)
  expect(judge(env('relative.json'), 'missing', false).halt).toBe(true)
  // A valid one is used, with its policy
  expect(judge(src, text({ network: false, plainOutput: true, fleet: { enabled: false } }), false)).toMatchObject({ halt: false, locked: false, policy: { network: false, plainOutput: true } })
})

test('a locked file fails closed on any problem; once seen locked, a later missing or broken read fails closed too', async () => {
  const src = configSource(undefined, 'team.json')
  expect(judge(src, text({ locked: true, fleet: { emoji: 'yes' } }), false).halt).toBe(true)
  expect(judge(src, text({ locked: true, extra: 1 }), false).halt).toBe(true)
  const ok = judge(src, text({ locked: true, stop: { enabled: false } }), false)
  expect(ok).toMatchObject({ halt: false, locked: true, policy: { locked: true } })
  expect(judge(src, 'missing', true).halt).toBe(true)
  expect(judge(src, { text: 'not json' }, true).halt).toBe(true)
})

test('an unlocked file from the option or the project falls back as before, unless a policy key has a wrong type', async () => {
  expect(judge(configSource(undefined, ''), 'missing', false)).toEqual({ policy: OPEN_POLICY, halt: false, locked: false })
  expect(judge(configSource(undefined, 'team.json'), 'missing', false)).toMatchObject({ halt: false, problem: 'team.json not found' })
  expect(judge(configSource(undefined, ''), { text: '{ nope' }, false)).toMatchObject({ halt: false })
  // Unknown keys and loose field types are tolerated in an unlocked file
  expect(judge(configSource(undefined, ''), text({ extra: 1, fleet: { emoji: 'yes' } }), false).halt).toBe(false)
  for (const bad of [{ network: 'no' }, { plainOutput: 1 }, { locked: 'true' }, { allowedCommands: ['git'] }, { allowedCommands: [[]] }]) {
    expect(judge(configSource(undefined, ''), text(bad), false).halt, JSON.stringify(bad)).toBe(true)
  }
})

test('the policy keys default to the open rules', async () => {
  expect(readPolicy({}, false)).toEqual({ policy: { locked: false, network: true, plainOutput: false }, problems: [] })
  expect(readPolicy({ allowedCommands: [['git', 'status']] }, false).policy.allowedCommands).toEqual([['git', 'status']])
})

/** A value for an option's field that differs from the option's default and is valid for its section. */
function other(e: (typeof OPTIONS)[number]): unknown {
  if (e.option === 'watchStoreName') return 'zone-store'
  if (e.option === 'housekeepingFolder') return '.zone'
  if (e.option === 'fleetColumnTint') return '#202020'
  if (e.kind === 'boolean') return !e.default
  if (e.kind === 'number') return (e.default as number) + 7
  return `${e.default}-zone`
}

/** A section's merged settings, with the given option layer under the file's section. */
function merged(section: Section, options: Record<string, unknown>, file: unknown): Record<string, unknown> {
  const raw = layered(options, section, file)
  const merge: Record<Section, (r: unknown) => unknown> = {
    checkpoint: mergeCheckpoint,
    fleet: mergeConfig,
    watch: r => parseConfig(r).config,
    housekeeping: mergeHousekeeping,
    conversations: mergeConversations,
    stop: mergeStop,
    cacheGuard: mergeCacheGuard,
  }
  return merge[section](raw) as Record<string, unknown>
}

test('every option can be set from the file alone, with no option layer (a locked file)', async () => {
  expect([...new Set(OPTIONS.map(e => e.section))].sort()).toEqual([...SECTIONS].sort())
  for (const e of OPTIONS) {
    const value = other(e)
    expect(merged(e.section, {}, { [e.field]: value })[e.field], e.option).toEqual(value)
    // The file passes the locked file's checks too
    expect(readPolicy({ locked: true, [e.section]: { [e.field]: value } }, true).problems, e.option).toEqual([])
  }
  for (const p of PANES) expect((merged(p.section, {}, { pane: { [p.field]: 9 } }).pane as Record<string, number>)[p.field], p.option).toBe(9)
  // Every section can be turned off from the file; the agent guard's own actions too
  for (const s of ['checkpoint', 'fleet', 'watch', 'housekeeping', 'conversations', 'stop'] as const) expect(merged(s, {}, { enabled: false }).enabled, s).toBe(false)
  expect(merged('cacheGuard', {}, { auto: false }).auto).toBe(false)
})

test('the network rule refuses gh, curl, wget, ssh, scp and git network subcommands, by program name in any case', async () => {
  const closed = { ...OPEN_POLICY, network: false }
  expect(programName('C:\\Tools\\GH.EXE')).toBe('gh')
  expect(programName('/usr/bin/curl')).toBe('curl')
  for (const argv of [['gh', 'pr', 'list'], ['C:\\Tools\\GH.EXE', 'api'], ['Curl.exe', 'x'], ['wget', 'x'], ['ssh', 'h'], ['scp', 'a', 'b'], ['git', 'fetch'], ['git', '-C', 'wt', 'push'], ['GIT.exe', '--git-dir=x', 'ls-remote'], ['git', '-c', 'alias.x=fetch', 'x'], ['git', 'remote', '-v'], ['git', 'submodule', 'update'], ['git', 'pull'], ['git', 'clone', 'u']]) {
    expect(commandRefusal(argv, closed), argv.join(' ')).toBe('refused:network')
  }
  for (const argv of [['git', 'status'], ['git', '-C', 'fetch', 'log'], ['git', 'rev-parse', '--git-path', 'info/exclude'], ['node', 'check.js'], ['ghost']]) {
    expect(commandRefusal(argv, closed), argv.join(' ')).toBeUndefined()
  }
  // With the network on, nothing is refused for its program
  expect(commandRefusal(['gh', 'pr', 'list'], OPEN_POLICY)).toBeUndefined()
})

test('allowedCommands runs only commands that start with one of its prefixes, with or without the network rule', async () => {
  const allow = { ...OPEN_POLICY, allowedCommands: [['node', 'check.js'], ['git', 'rev-parse']] }
  expect(commandRefusal(['node', 'check.js', '--quick'], allow)).toBeUndefined()
  expect(commandRefusal(['git', 'rev-parse', '--git-path', 'info/exclude'], allow)).toBeUndefined()
  expect(commandRefusal(['node', 'other.js'], allow)).toBe('refused:not-allowed')
  expect(commandRefusal(['node'], allow)).toBe('refused:not-allowed')
  expect(commandRefusal(['gh', 'pr', 'list'], allow)).toBe('refused:not-allowed')
  expect(commandRefusal(['gh', 'pr', 'list'], { ...allow, allowedCommands: [['gh']], network: false })).toBe('refused:network')
  expect(commandRefusal(['x'], { ...OPEN_POLICY, allowedCommands: [] })).toBe('refused:not-allowed')
})
