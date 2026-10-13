// The agent guard's pure part. A stopped subagent holding a big context loses its prompt cache `cacheMinutes` after
// its last request, and waking it later re-writes the whole context. Worst is a stopped agent with live background
// work: it wakes itself when that work reports, so its cache can expire with nobody having decided anything.
//
// The rule has two layers. Tether acts by itself `leadMinutes` before the cache expires (`planActions`): a
// ping keeps a smaller agent warm, and a big one is asked to hand over, after which its leftover background
// tasks are stopped and it is recorded as retired. When Tether cannot act (off, or the engine refused), the agent
// stays a finding, the Stop hook blocks, and the model decides (`undecided`, `decisionProblem`). A decided
// (retired or done) agent is never woken: the cold guard (src/fleet/guard.ts) refuses any message to it.

import type { GuardStore } from './store'

/** The thresholds, shared with fleet so one number decides what "big" and "expired" mean. */
export type AgentRules = {
  /** The prompt cache lives about this long (`fleet.cacheTtlMinutes`; a lower setting adds a safety margin). */
  cacheMinutes: number
  /** Below this a re-write is cheap enough to ignore. */
  smallTokens: number
  /** The guard acts this long before the cache expires (`cacheGuard.leadMinutes`). */
  leadMinutes: number
}

/** What the automatic actions need besides the rules. */
export type AutoRules = {
  /** At least this context: hand over instead of keeping warm. */
  handoverTokens: number
  /** Minutes the agent gets for its handover before the coordinator is alerted. */
  handoverWaitMinutes: number
  /** Keep-warm messages to one agent before the coordinator is alerted. */
  keepWarmMax: number
}

/** One agent as the guard needs it. */
export type StoppedCandidate = {
  id: string
  status: string
  label: string
  lastStepAt: number
  contextTokens?: number
  /** The ids of its live background tasks (read from its transcript); absent: unknown. */
  tasks?: string[]
  /** When its last turn ended (`turn.complete`), when known. */
  finishedAt?: number
}

/** Statuses of an agent whose turn ended and that a message would wake. */
const STOPPED = new Set(['completed', 'waiting', 'idle'])

const MIN = 60_000

/** The lead actually used: never more than half the cache lifetime, so a short cache still leaves time to be big and idle. */
export function leadOf(rules: AgentRules): number {
  return Math.min(rules.leadMinutes, rules.cacheMinutes / 2)
}

/** Minutes of idleness from which the guard acts: the cache lifetime less the lead. */
export function actAfterMinutes(rules: AgentRules): number {
  return rules.cacheMinutes - leadOf(rules)
}

/** Whether an agent has background work that will wake it: its status says `waiting`, or its transcript shows a live task. */
export function hasBackground(a: Pick<StoppedCandidate, 'status' | 'tasks'>): boolean {
  return a.status === 'waiting' || (a.tasks?.length ?? 0) > 0
}

/** Whether Tether has an agent in hand: a handover is under way and nobody needs to be told yet. */
function handled(store: GuardStore, id: string): boolean {
  const a = store.actions[id]
  return a?.handoverAt !== undefined && a.alertedAt === undefined && a.stopFailedAt === undefined
}

/**
 * Whether a decision still covers an agent now. Retired and done are final. Kept-warm lasts one expiry window,
 * measured from the later of the agent's last activity and the record (the ping refreshes the activity).
 */
function covered(store: GuardStore, a: StoppedCandidate, rules: AgentRules, now: number): boolean {
  const d = Object.hasOwn(store.decisions, a.id) ? store.decisions[a.id] : undefined
  if (!d) return false
  if (d.decision !== 'kept-warm') return true
  return now - Math.max(a.lastStepAt, d.atMs) < actAfterMinutes(rules) * MIN
}

/** A stopped agent that needs a decision, with the line that says why. */
export type Undecided = { id: string; text: string }

/**
 * The stopped, big agents past their act-after time that nobody has dealt with (an expired one stays until
 * decided). An agent Tether is handing over is not listed; one the handover failed for, or that was pinged too
 * often, is.
 */
export function undecided(agents: StoppedCandidate[], store: GuardStore, rules: AgentRules, now: number): Undecided[] {
  const out: Undecided[] = []
  for (const a of agents) {
    if (covered(store, a, rules, now)) continue
    const act = store.actions[a.id]
    if (act?.handoverAt !== undefined && (act.alertedAt !== undefined || act.stopFailedAt !== undefined)) {
      // The handover Tether asked for did not finish, or its tasks would not stop: the model decides, whatever the status
      const why = act.stopFailedAt !== undefined ? 'its background tasks could not be stopped (TaskStop them yourself)' : 'it has not finished in time and is NOT stopped'
      out.push({ id: a.id, text: `${a.label} (${a.id}): handover asked, ${why}` })
      continue
    }
    if (!STOPPED.has(a.status) || handled(store, a.id)) continue
    const idle = (now - a.lastStepAt) / MIN
    if (idle < actAfterMinutes(rules) || (a.contextTokens ?? 0) < rules.smallTokens) continue
    const left = rules.cacheMinutes - idle
    const cache = left > 0 ? `cache expires in ~${Math.floor(left)} min` : 'cache EXPIRED (waking it re-writes all)'
    const tasks = a.tasks?.length ?? 0
    const wait = tasks > 0 ? `, ${tasks} live background task${tasks === 1 ? '' : 's'} (it wakes itself when they report)` : a.status === 'waiting' ? ', waiting on background work (it wakes itself when that reports)' : ''
    out.push({ id: a.id, text: `${a.label} (${a.id}): stopped ${Math.floor(idle)} min, context ${Math.round((a.contextTokens ?? 0) / 1000)}k, ${cache}${wait}` })
  }
  return out
}

/** The Stop hook's reason: the agents and the two ways to deal with each. */
export function stopReason(items: Undecided[]): string {
  return (
    'CACHE GUARD: stopped subagents with a large context are about to lose their prompt cache (a wake-up re-writes the whole ' +
    'context), and one with background work wakes itself when that reports. For each, do one of two things: ' +
    '(a) keep it warm: send it a short message with SendMessage (a cache read re-arms the expiry), then record it as kept-warm; ' +
    '(b) hand it over and stop it: ask it to write its status and stop, TaskStop its background tasks, hand the wait to a fresh agent, ' +
    'then record it as retired (or done, when its work is finished). All with the mcp__tether__agent_decision tool (load it with ToolSearch if it is deferred); ' +
    'retired and done are refused while the agent runs or has live background tasks.\n' +
    items.map(i => `- ${i.text}`).join('\n')
  )
}

/**
 * Why the agent_decision tool refuses a decision, or undefined when it is allowed. An agent that is running, or
 * has live background work, can still wake itself: retiring or finishing it would only record a falsehood.
 * `agent` is undefined for an id the engine does not list (nothing to check).
 */
export function decisionProblem(decision: string, agent: Pick<StoppedCandidate, 'status' | 'tasks' | 'label'> | undefined): string | undefined {
  if (!agent || decision === 'kept-warm') return undefined
  if (agent.status === 'running') return `${agent.label} is still running: TaskStop it first, or wait for it to stop, then record it as ${decision}.`
  const tasks = agent.tasks?.length ?? 0
  if (tasks > 0) {
    return `${agent.label} still has ${tasks} live background task${tasks === 1 ? '' : 's'} (${agent.tasks!.join(', ')}) and wakes itself when ${tasks === 1 ? 'it reports' : 'they report'}: TaskStop ${tasks === 1 ? 'it' : 'them'} first (after the agent has handed over), then record it as ${decision}.`
  }
  if (agent.status === 'waiting') return `${agent.label} is waiting on background work and wakes itself when that reports: TaskStop it first (after the agent has handed over), then record it as ${decision}.`
  return undefined
}

/** One thing Tether does by itself for a stopped agent. */
export type Plan =
  | { kind: 'warm'; id: string; label: string; count: number }
  | { kind: 'handover'; id: string; label: string; contextTokens: number }
  | { kind: 'collect'; id: string; label: string; tasks: string[]; /** Still waiting on background work whose task ids Tether does not know. */ unknown: boolean }
  | { kind: 'alert'; id: string; label: string; text: string }

/**
 * What to do now, per agent.
 *
 * - An agent being handed over that has stopped (a turn ended after the message, with a request in it) is
 *   collected: its leftover background tasks are stopped and it is recorded as retired.
 * - One that has not stopped within `handoverWaitMinutes` is an alert, once; it is never stopped silently.
 * - A stopped agent with background work, past the act-after time and big enough to matter, is handed over when
 *   its context reaches `handoverTokens` and kept warm otherwise (an alert once `keepWarmMax` pings were sent).
 * - A stopped agent with no background work cannot wake itself, so it is left to the model's decision.
 */
export function planActions(agents: StoppedCandidate[], store: GuardStore, rules: AgentRules, auto: AutoRules, now: number): Plan[] {
  const out: Plan[] = []
  for (const a of agents) {
    const act = store.actions[a.id]
    if (act?.handoverAt !== undefined && !covered(store, a, rules, now)) {
      const stopped = a.status !== 'running' && a.finishedAt !== undefined && a.finishedAt >= act.handoverAt && a.lastStepAt > act.handoverAt
      if (stopped && act.stopFailedAt === undefined) out.push({ kind: 'collect', id: a.id, label: a.label, tasks: a.tasks ?? [], unknown: a.status === 'waiting' && (a.tasks?.length ?? 0) === 0 })
      else if (!stopped && act.alertedAt === undefined && now - act.handoverAt >= auto.handoverWaitMinutes * MIN) {
        out.push({ kind: 'alert', id: a.id, label: a.label, text: `${a.label} (${a.id}) has not finished its handover ${auto.handoverWaitMinutes} min after Tether asked; it is NOT stopped. Its cache expires in ~${Math.max(0, Math.floor(rules.cacheMinutes - (now - a.lastStepAt) / MIN))} min.` })
      }
      continue
    }
    if (!STOPPED.has(a.status) || covered(store, a, rules, now) || !hasBackground(a)) continue
    const idle = (now - a.lastStepAt) / MIN
    if (idle < actAfterMinutes(rules) || (a.contextTokens ?? 0) < rules.smallTokens) continue
    if (idle >= rules.cacheMinutes) {
      // Too late: a message now would itself re-write the whole context, so the model decides
      if (act?.alertedAt === undefined) out.push({ kind: 'alert', id: a.id, label: a.label, text: `${a.label} (${a.id}) has background work and its cache EXPIRED ${Math.floor(idle)} min after its last request; Tether did not ping it (that would re-write ~${Math.round((a.contextTokens ?? 0) / 1000)}k tokens). Decide whether to hand it over.` })
    } else if ((a.contextTokens ?? 0) >= auto.handoverTokens) {
      out.push({ kind: 'handover', id: a.id, label: a.label, contextTokens: a.contextTokens ?? 0 })
    } else if ((act?.warms ?? 0) >= auto.keepWarmMax) {
      if (act?.alertedAt === undefined) out.push({ kind: 'alert', id: a.id, label: a.label, text: `${a.label} (${a.id}) was kept warm ${act?.warms} times and still waits on background work; decide whether it should be handed over.` })
    } else {
      out.push({ kind: 'warm', id: a.id, label: a.label, count: (act?.warms ?? 0) + 1 })
    }
  }
  return out
}
