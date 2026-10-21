// Turning a poller's output into findings, and telling each finding once.

import type { AgentsPoller, CommandPoller } from './config'
import { undecided, type AgentRules } from '../guards/agents'
import type { GuardStore } from '../guards/store'
import { ID_LIKE } from '../options/plain'

/**
 * One thing a poller reports. `key` is what dedupe remembers (e.g. PR + cause + head sha). `again` marks a finding
 * told before and still reported, told once more by the poller's reminders.
 */
export type Finding = { key: string; text: string; again?: boolean }

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

/** Reminders, per poller: key -> when it was last told and how many reminders followed. Kept in $.store. */
export type Told = Record<string, Record<string, { at: number; n: number }>>

/** How long after its last telling a still-reported key is told again: the base, doubled per reminder, capped. */
export function remindAfterMs(poller: { remindMinutes: number; remindMaxMinutes: number }, n: number): number {
  return Math.min(poller.remindMinutes * 2 ** n, Math.max(poller.remindMinutes, poller.remindMaxMinutes)) * 60_000
}

/**
 * Picks the findings not told before and updates the seen-set: keys seen now are refreshed, keys of
 * this poller unseen for `forgetMinutes` are dropped (fixed, or a blip), so a return is new again.
 * With `remindMinutes`, a key still reported is told again (marked `again`) once its reminder is due.
 * A poller without dedupe tells everything it reports.
 */
export function fresh(
  seen: Seen,
  poller: { id: string; dedupe: boolean; forgetMinutes: number; remindMinutes?: number; remindMaxMinutes?: number },
  findings: Finding[],
  now: number,
  told: Told = {},
): { fresh: Finding[]; seen: Seen; told: Told } {
  if (!poller.dedupe) return { fresh: findings, seen, told }
  const mine = { ...(seen[poller.id] ?? {}) }
  const remind = { remindMinutes: poller.remindMinutes ?? 0, remindMaxMinutes: poller.remindMaxMinutes ?? 240 }
  const reminders = { ...(told[poller.id] ?? {}) }
  const out: Finding[] = []
  const inRun = new Set<string>()
  for (const f of findings) {
    if (inRun.has(f.key)) continue
    inRun.add(f.key)
    if (!(f.key in mine)) {
      out.push(f)
      if (remind.remindMinutes > 0) reminders[f.key] = { at: now, n: 0 }
    } else if (remind.remindMinutes > 0) {
      const r = reminders[f.key]
      // A key told before reminders were on starts its count now
      if (!r) reminders[f.key] = { at: now, n: 0 }
      else if (now - r.at >= remindAfterMs(remind, r.n)) {
        out.push({ ...f, again: true })
        reminders[f.key] = { at: now, n: r.n + 1 }
      }
    }
    mine[f.key] = now
  }
  for (const [k, at] of Object.entries(mine)) {
    if (now - at >= poller.forgetMinutes * 60_000) delete mine[k]
  }
  // A key forgotten, or no longer reported in a poller with reminders off, keeps no reminder
  for (const k of Object.keys(reminders)) if (!(k in mine) || remind.remindMinutes === 0) delete reminders[k]
  const nextTold = { ...told }
  if (Object.keys(reminders).length > 0) nextTold[poller.id] = reminders
  else delete nextTold[poller.id]
  return { fresh: out, seen: { ...seen, [poller.id]: mine }, told: nextTold }
}

/** One open issue as `gh issue list --json number` gives it. */
export type IssueSeen = { number: number }

/**
 * The issues poller's findings for one label: each open issue carrying it, keyed by number and label (so the woken
 * session's own comment does not wake it again; `remindMinutes` tells it again while it waits), told by its number
 * and the label only, never its title or body.
 */
export function issueFindings(label: string, issues: unknown): Finding[] {
  if (!Array.isArray(issues)) throw new Error('gh issue list did not give a list')
  const out: Finding[] = []
  for (const i of issues) {
    const n = (i as IssueSeen | null)?.number
    if (!Number.isInteger(n)) continue
    out.push({ key: `#${n}|${label}`, text: `#${n} ${label}` })
  }
  return out
}

/** A finding waiting to be told, with the poller it came from. */
export type Pending = Finding & { poller: string; title: string; wake: boolean; at: number }

/** Why a wake does not go now, or `go`. */
export type WakeVerdict = 'go' | 'nothing' | 'busy' | 'typing' | 'gap' | 'held'

/**
 * Whether to start a turn now for the pending findings: never during a turn, nor while `held` (a wake sent waits
 * for its turn, or one refused waits to be tried again), not within the gap
 * after the last wake, and not while the person has a draft (until the oldest waited `deferMinutes`).
 */
export function wakeVerdict(
  pending: Pending[],
  s: { busy: boolean; draft: string; now: number; lastWakeAt: number; gapSeconds: number; deferMinutes: number; held?: boolean },
): WakeVerdict {
  const waking = pending.filter(p => p.wake)
  if (waking.length === 0) return 'nothing'
  if (s.busy) return 'busy'
  if (s.held) return 'held'
  if (s.now - s.lastWakeAt < s.gapSeconds * 1000) return 'gap'
  const oldest = Math.min(...waking.map(p => p.at))
  if (s.draft.trim() !== '' && s.now - oldest < s.deferMinutes * 60_000) return 'typing'
  return 'go'
}

/** The wake prompt: the preamble, then each poller's findings under its title (a reminder marked as one). */
export function wakeText(preamble: string, pending: Pending[]): string {
  const groups = new Map<string, string[]>()
  // A reminder says so, so the model can tell it from news
  for (const p of pending) groups.set(p.title, [...(groups.get(p.title) ?? []), p.again ? `${p.text} (still reported)` : p.text])
  const parts = [preamble]
  for (const [title, texts] of groups) parts.push(`\n${title}:\n` + texts.map(t => `- ${t}`).join('\n'))
  return parts.join('\n')
}

/**
 * Puts findings back in the pending list (a wake that was refused or started no turn), keeping the ones that
 * joined meanwhile and telling each poller's key once.
 */
export function requeue(back: Pending[], now: Pending[]): Pending[] {
  const out: Pending[] = []
  const keys = new Set<string>()
  for (const p of [...back, ...now]) {
    const k = `${p.poller} ${p.key}`
    if (keys.has(k)) continue
    keys.add(k)
    out.push(p)
  }
  return out
}

/** What decides whether the idle wake goes now; see idleWakeDue. */
export type IdleState = {
  minutes: number
  busy: boolean
  held: boolean
  draft: string
  agentsAtWork: number
  /** The main loop's own background tasks in flight. */
  mainBackground: number
  now: number
  idleSince: number
  /** When a subagent was last seen at work (0: never). */
  lastAtWork: number
  lastWakeAt: number
}

/**
 * Whether the idle wake goes now: it is on, no turn runs, no wake is held, nobody is typing, no subagent and no
 * background task of the main loop is at work, and the session has sat `minutes` since its last turn ended, since a
 * subagent was last at work and since the last wake.
 */
export function idleWakeDue(s: IdleState): boolean {
  if (s.minutes <= 0 || s.busy || s.held || s.draft.trim() !== '' || s.agentsAtWork > 0 || s.mainBackground > 0) return false
  return s.now - Math.max(s.idleSince, s.lastAtWork, s.lastWakeAt) >= s.minutes * 60_000
}

/** Subagent states that count as at work. */
const AT_WORK = new Set(['pending', 'running', 'waiting'])

/** How many subagents are at work: pending, running or waiting, or stopped with live background tasks. */
export function atWork(agents: Array<{ status: string; tasks?: string[] }>): number {
  return agents.filter(a => AT_WORK.has(a.status) || (a.tasks?.length ?? 0) > 0).length
}

/**
 * The main loop's own background tasks in flight, from the Stop hook's `background_tasks` (subagents are left out:
 * the agent list counts them).
 */
export function liveBackground(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0
  return tasks.filter(t => t !== null && typeof t === 'object' && (t as { type?: unknown }).type !== 'subagent').length
}
