// Turning a poller's output into findings, and telling each finding once.

import type { AgentsPoller, CommandPoller } from './config'
import { undecided, type AgentRules } from '../guards/agents'
import type { GuardStore } from '../guards/store'
import { ID_LIKE } from '../options/plain'

/** One thing a poller reports. `key` is what dedupe remembers (e.g. PR + cause + head sha). */
export type Finding = { key: string; text: string }

/** What one run of a command came to. */
export type RunOutcome =
  | { ok: true; findings: Finding[] }
  | { ok: false; error: string }

/** The dedupe key of a finding's text under the poller's `key` regex (first group, else the match, else the text). */
function keyOf(text: string, keyRegex: string | undefined): string {
  if (!keyRegex) return text
  const m = new RegExp(keyRegex).exec(text)
  if (!m) return text
  return m[1] ?? m[0]
}

/** Reads a command's result into findings by the poller's format, exit codes and regexes. */
export function readOutput(p: CommandPoller, run: { exitCode: number; stdout: string; stderr: string }): RunOutcome {
  if (p.quietExitCodes.includes(run.exitCode)) return { ok: true, findings: [] }
  if (!p.okExitCodes.includes(run.exitCode)) {
    const why = (run.stderr.trim() || run.stdout.trim()).split('\n').slice(-1)[0] ?? ''
    return { ok: false, error: `exit ${run.exitCode}${why ? ': ' + why.slice(0, 200) : ''}` }
  }
  if (p.format === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(run.stdout)
    } catch {
      return { ok: false, error: 'stdout is not JSON' }
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items
    if (!Array.isArray(list)) return { ok: false, error: 'JSON is neither a list nor { items: [...] }' }
    const findings: Finding[] = []
    for (const item of list) {
      const text = typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text
      if (typeof text !== 'string' || text.trim() === '') continue
      const own = (item as { key?: unknown } | null)?.key
      findings.push({ key: typeof own === 'string' && own !== '' ? own : keyOf(text, p.key), text: text.trim() })
    }
    return { ok: true, findings }
  }
  const match = p.match ? new RegExp(p.match) : undefined
  const findings: Finding[] = []
  for (const raw of run.stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let text = line
    if (match) {
      const m = match.exec(line)
      if (!m) continue
      text = (m[1] ?? line).trim()
    }
    findings.push({ key: keyOf(text, p.key), text })
  }
  return { ok: true, findings }
}

/**
 * Reads a command's result under `plainOutput`: only JSON lines `{ "key": <id>, "code": <one of the poller's codes> }`
 * are findings, told as `<key> <code>`; every other line is dropped and only counted. A failure is told by its exit
 * code alone, never by what the command printed.
 */
export function readPlainOutput(p: CommandPoller, run: { exitCode: number; stdout: string }): { ok: true; findings: Finding[]; dropped: number } | { ok: false; error: string } {
  if (p.quietExitCodes.includes(run.exitCode)) return { ok: true, findings: [], dropped: 0 }
  if (!p.okExitCodes.includes(run.exitCode)) return { ok: false, error: `exit ${Number.isInteger(run.exitCode) ? run.exitCode : -1}` }
  const allowed = new Set(p.codes)
  const findings: Finding[] = []
  let dropped = 0
  for (const raw of String(run.stdout).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch {
      dropped++
      continue
    }
    const o = item as Record<string, unknown> | null
    const ok = o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 2 &&
      typeof o.key === 'string' && ID_LIKE.test(o.key) && typeof o.code === 'string' && allowed.has(o.code)
    if (!ok) {
      dropped++
      continue
    }
    findings.push({ key: `${o!.key}|${o!.code}`, text: `${o!.key} ${o!.code}` })
  }
  return { ok: true, findings, dropped }
}

/** One subagent as watch sees it: the engine's list entry plus what its model requests showed. */
export type AgentSeen = {
  id: string
  status: string
  label: string
  /** When its last model request ended (or when watch first saw it, before any). */
  lastStepAt: number
  contextTokens?: number
  /** Its live background tasks (read from its transcript), and when its last turn ended; see StoppedCandidate. */
  tasks?: string[]
  finishedAt?: number
  /** The model of its last request, and whether the Agent call pinned one (a wake keeps a pinned model); see StoppedCandidate. */
  model?: string
  pinned?: boolean
}

/** What the agent guard needs besides the poller: the decisions made, and the thresholds fleet shares. */
export type AgentGuard = { store: GuardStore; cacheMinutes: number; smallTokens: number; leadMinutes: number }

/**
 * The agents poller's findings: running agents silent too long, agents past the context size and, with a
 * `guard`, stopped big agents nobody has dealt with as their cache runs out (see src/guards/agents.ts).
 */
export function agentFindings(p: AgentsPoller, agents: AgentSeen[], now: number, guard?: AgentGuard): Finding[] {
  const out: Finding[] = []
  for (const a of agents) {
    const live = a.status === 'running' || (p.includeWaiting && a.status === 'waiting')
    const silent = (now - a.lastStepAt) / 60_000
    // Keyed by the last request's time, so each new silence is told once and a recovered agent can be told again
    if (live && silent >= p.silentMinutes) {
      out.push({ key: `${a.id}|silent|${a.lastStepAt}`, text: `${a.label} (${a.id}) ${a.status}, silent ${Math.floor(silent)} min` })
    }
    if (a.contextTokens !== undefined && a.contextTokens >= p.contextTokens && a.status !== 'completed' && a.status !== 'failed' && a.status !== 'killed') {
      out.push({ key: `${a.id}|context`, text: `${a.label} (${a.id}) context ${Math.round(a.contextTokens / 1000)}k, past ${Math.round(p.contextTokens / 1000)}k` })
    }
  }
  if (guard) {
    const rules: AgentRules = { cacheMinutes: guard.cacheMinutes, smallTokens: guard.smallTokens, leadMinutes: guard.leadMinutes }
    for (const u of undecided(agents, guard.store, rules, now)) out.push({ key: `${u.id}|undecided`, text: u.text })
  }
  return out
}

/** Keys told, per poller: key -> when it was last seen in a run. Kept in $.store. */
export type Seen = Record<string, Record<string, number>>

/**
 * Picks the findings not told before and updates the seen-set: keys seen now are refreshed, keys of
 * this poller unseen for `forgetMinutes` are dropped (fixed, or a blip), so a return is new again.
 * A poller without dedupe tells everything it reports.
 */
export function fresh(
  seen: Seen,
  poller: { id: string; dedupe: boolean; forgetMinutes: number },
  findings: Finding[],
  now: number,
): { fresh: Finding[]; seen: Seen } {
  if (!poller.dedupe) return { fresh: findings, seen }
  const mine = { ...(seen[poller.id] ?? {}) }
  const out: Finding[] = []
  const inRun = new Set<string>()
  for (const f of findings) {
    if (inRun.has(f.key)) continue
    inRun.add(f.key)
    if (!(f.key in mine)) out.push(f)
    mine[f.key] = now
  }
  for (const [k, at] of Object.entries(mine)) {
    if (now - at >= poller.forgetMinutes * 60_000) delete mine[k]
  }
  return { fresh: out, seen: { ...seen, [poller.id]: mine } }
}

/** A finding waiting to be told, with the poller it came from. */
export type Pending = Finding & { poller: string; title: string; wake: boolean; at: number }

/** Why a wake does not go now, or `go`. */
export type WakeVerdict = 'go' | 'nothing' | 'busy' | 'typing' | 'gap'

/**
 * Whether to start a turn now for the pending findings: never during a turn, not within the gap
 * after the last wake, and not while the person has a draft (until the oldest waited `deferMinutes`).
 */
export function wakeVerdict(
  pending: Pending[],
  s: { busy: boolean; draft: string; now: number; lastWakeAt: number; gapSeconds: number; deferMinutes: number },
): WakeVerdict {
  const waking = pending.filter(p => p.wake)
  if (waking.length === 0) return 'nothing'
  if (s.busy) return 'busy'
  if (s.now - s.lastWakeAt < s.gapSeconds * 1000) return 'gap'
  const oldest = Math.min(...waking.map(p => p.at))
  if (s.draft.trim() !== '' && s.now - oldest < s.deferMinutes * 60_000) return 'typing'
  return 'go'
}

/** The wake prompt: the preamble, then each poller's findings under its title. */
export function wakeText(preamble: string, pending: Pending[]): string {
  const groups = new Map<string, string[]>()
  for (const p of pending) groups.set(p.title, [...(groups.get(p.title) ?? []), p.text])
  const parts = [preamble]
  for (const [title, texts] of groups) parts.push(`\n${title}:\n` + texts.map(t => `- ${t}`).join('\n'))
  return parts.join('\n')
}
