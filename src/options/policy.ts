// The config file's top-level rules: where the file comes from (`TETHER_CONFIG`, the `configPath` option, or the
// project's `.claude/tether.json`), whether its values are final (`locked`), what Tether may run (`network`,
// `allowedCommands`) and what it may say (`plainOutput`). A file named by the environment, or one that says
// `locked`, fails closed: when it is missing, unreadable or not valid, Tether turns every part off instead of
// falling back to the options or the defaults.

import { OPTIONS, PANES, type Section } from './options'
import { parseConfig } from '../watch/config'

/** The environment variable that names the config file (an absolute path); it wins over the `configPath` option. */
export const CONFIG_ENV = 'TETHER_CONFIG'

/** The config file when neither the environment nor the option names one, relative to the session's folder. */
export const DEFAULT_CONFIG_FILE = '.claude/tether.json'

/** The one text Tether shows (status line, toast, every command) while it is off because its config failed closed. */
export const HALT_TEXT = 'tether: off, the config file is missing or not valid'

/** What the top-level keys say. */
export type Policy = {
  /** The file's values are final: the plugin options are not read, and no other file is. */
  locked: boolean
  /** Off: no `prs` poller and no command whose program reaches the network. */
  network: boolean
  /** When set, a command runs only if its argv starts with one of these lists. */
  allowedCommands?: string[][]
  /** Everything Tether says is built from fixed templates, ids, numbers and codes only. */
  plainOutput: boolean
}

/** The rules of a session with no file, or a file that names none of these keys: everything as before. */
export const OPEN_POLICY: Policy = { locked: false, network: true, plainOutput: false }

/** The config sections. */
export const SECTIONS: readonly Section[] = ['checkpoint', 'fleet', 'watch', 'housekeeping', 'conversations', 'stop', 'cacheGuard']

/** Every top-level key a config file may hold. */
export const TOP_KEYS: readonly string[] = ['locked', 'network', 'allowedCommands', 'plainOutput', ...SECTIONS]

/** Where the config file comes from. */
export type Source = {
  /** The path read; empty when the environment named a path that is not absolute (nothing is read then). */
  file: string
  /** Named by `TETHER_CONFIG`: the file must be there and valid, or Tether is off. */
  fromEnv: boolean
  /** The project's default file, which may be missing. */
  isDefault: boolean
}

/** Whether a path is absolute (a drive or a leading separator). */
export function isAbsolute(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
}

/** Picks the config file: `TETHER_CONFIG` when set, else the `configPath` option, else the project's default file. */
export function configSource(env: string | undefined, configPath: unknown): Source {
  if (typeof env === 'string' && env.trim() !== '') {
    const file = env.trim()
    return { file: isAbsolute(file) ? file : '', fromEnv: true, isDefault: false }
  }
  if (typeof configPath === 'string' && configPath.trim() !== '') return { file: configPath.trim(), fromEnv: false, isDefault: false }
  return { file: DEFAULT_CONFIG_FILE, fromEnv: false, isDefault: true }
}

/** Whether a value is a list of argv prefixes: each a non-empty list of strings. */
function isPrefixList(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every(p => Array.isArray(p) && p.length > 0 && p.every(s => typeof s === 'string' && s !== ''))
}

/** Whether `v` is a value an option of `kind` takes. */
function fits(kind: 'boolean' | 'number' | 'string', v: unknown, option: string): boolean {
  if (kind === 'boolean') return typeof v === 'boolean'
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= 0
  // A column tint is true, false or a colour
  return typeof v === 'string' || (option === 'fleetColumnTint' && typeof v === 'boolean')
}

/**
 * The file's policy, and why the file is not valid. The policy keys must have their types; under `strict` (a file
 * named by the environment, or a locked one) every top-level key must be known, every section an object, every
 * field an option feeds of the option's type, and the watch section free of problems.
 */
export function readPolicy(root: Record<string, unknown>, strict: boolean): { policy: Policy; problems: string[] } {
  const problems: string[] = []
  const policy: Policy = { ...OPEN_POLICY }
  for (const k of ['locked', 'network', 'plainOutput'] as const) {
    if (root[k] === undefined) continue
    if (typeof root[k] === 'boolean') policy[k] = root[k] as boolean
    else problems.push(`${k} must be true or false`)
  }
  if (root.allowedCommands !== undefined) {
    if (isPrefixList(root.allowedCommands)) policy.allowedCommands = root.allowedCommands.map(p => [...p])
    else problems.push('allowedCommands must be a list of non-empty lists of strings')
  }
  if (strict || policy.locked) {
    for (const k of Object.keys(root)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key ${k}`)
    for (const s of SECTIONS) {
      const v = root[s]
      if (v === undefined) continue
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        problems.push(`${s} must be an object`)
        continue
      }
      const sec = v as Record<string, unknown>
      for (const e of OPTIONS) if (e.section === s && sec[e.field] !== undefined && !fits(e.kind, sec[e.field], e.option)) problems.push(`${s}.${e.field} has the wrong type`)
      if ((s === 'fleet' || s === 'watch') && sec.pane !== undefined) {
        const pane = sec.pane as Record<string, unknown> | null
        const ok = pane !== null && typeof pane === 'object' && PANES.every(p => p.section !== s || pane[p.field] === undefined || Number.isInteger(pane[p.field]))
        if (!ok) problems.push(`${s}.pane has the wrong type`)
      }
    }
    if (root.watch !== undefined) problems.push(...parseConfig(root.watch).problems.map(p => `watch: ${p}`))
  }
  return { policy, problems }
}

/** What reading the config file came to. */
export type Loaded = {
  /** The file's content, when it is used. */
  root?: Record<string, unknown>
  /** Why the file is not used (it then falls back, unless `halt`). */
  problem?: string
  policy: Policy
  /** Every part is off: the file failed closed. */
  halt: boolean
  /** The file was read and is locked. */
  locked: boolean
}

/**
 * Judges what was read. `read` is the file's text, or `missing`, or an error. A file named by the environment, a
 * file that says `locked`, and any file once seen locked in this session (`wasLocked`) fail closed (`halt`) when
 * missing, unreadable or not valid; a file that sets a policy key to a wrong type fails closed too. Any other file
 * that cannot be used falls back as before: the default file may be missing, a configured one is a problem.
 */
export function judge(source: Source, read: { text: string } | 'missing' | { error: unknown }, wasLocked: boolean): Loaded {
  const strict = source.fromEnv || wasLocked
  const closed = (problem: string): Loaded => ({ problem, policy: { ...OPEN_POLICY }, halt: true, locked: wasLocked })
  const open = (problem?: string): Loaded => ({ ...(problem ? { problem } : {}), policy: { ...OPEN_POLICY }, halt: false, locked: false })
  if (source.fromEnv && source.file === '') return closed(`${CONFIG_ENV} is not an absolute path`)
  if (read === 'missing') return strict ? closed(`${source.file} not found`) : source.isDefault ? open() : open(`${source.file} not found`)
  if ('error' in read) return strict ? closed(`${source.file} not readable`) : open(`${source.file} not used: ${read.error}`)
  let root: unknown
  try {
    root = JSON.parse(read.text)
  } catch (err) {
    return strict ? closed(`${source.file} is not JSON`) : open(`${source.file} not used: ${err}`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return strict ? closed(`${source.file} is not an object`) : open(`${source.file} is not an object`)
  const r = root as Record<string, unknown>
  const locked = r.locked === true
  const { policy, problems } = readPolicy(r, strict || locked)
  const policyBroken = problems.some(p => /^(locked|network|plainOutput|allowedCommands) /.test(p))
  if (problems.length > 0 && (strict || locked || policyBroken)) return closed(`${source.file} is not valid (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  return { root: r, policy, halt: false, locked }
}

/** The programs that reach the network by themselves. */
const NETWORK_PROGRAMS = new Set(['gh', 'curl', 'wget', 'ssh', 'scp'])
/** The git subcommands that reach the network. */
const GIT_NETWORK = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule'])
/** git's options that take the next argument as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path', '--list-cmds', '--attr-source'])

/** A program's name as compared: its last path part, lower case, without `.exe` (or `.cmd`, `.bat`, `.com`). */
export function programName(program: string): string {
  return (program.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

/** Whether a git argv (after `git`) runs a network subcommand, or defines an alias that could hide one. */
function gitReachesNetwork(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const opt = a.split('=')[0]!
    if (GIT_VALUE_OPTIONS.has(opt)) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i] ?? ''
      if ((opt === '-c' || opt === '--config-env') && /^alias\./i.test(value)) return true
      continue
    }
    if (a.startsWith('-')) continue
    return GIT_NETWORK.has(a.toLowerCase())
  }
  return false
}

/** The codes a refused command is reported by (never its text). */
export type Refusal = 'refused:network' | 'refused:not-allowed'

/** Why a command may not run under the policy, or undefined when it may. */
export function commandRefusal(argv: readonly string[], policy: Policy): Refusal | undefined {
  if (policy.allowedCommands && !policy.allowedCommands.some(p => p.length <= argv.length && p.every((s, i) => argv[i] === s))) return 'refused:not-allowed'
  if (!policy.network && argv.length > 0) {
    const name = programName(argv[0]!)
    if (NETWORK_PROGRAMS.has(name) || (name === 'git' && gitReachesNetwork(argv.slice(1)))) return 'refused:network'
  }
  return undefined
}
