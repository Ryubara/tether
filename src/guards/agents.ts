// The agent guard's pure part. A stopped subagent holding a big context loses its prompt cache `cacheMinutes` after
// its last request, and waking it later re-writes the whole context. Worst is a stopped agent with live background
// work: it wakes itself when that work reports, so its cache can expire with nobody having decided anything.
//
// The rule has two layers. Tether acts by itself `leadMinutes` before the cache expires (`planActions`): a
// ping keeps a smaller agent warm, and a big one is asked to hand over, after which its leftover background
// tasks are stopped and, once it is quiet, it is recorded as retired. A message wakes an agent on the parent
// session's model unless the Agent call pinned one (measured, see `metaModel`), and the cache is per model: an agent on
// another model is never pinged (that would write a new cache and switch its model) but handed over. When Tether cannot act (off, or the engine refused), the agent
// stays a finding, the Stop hook blocks, and the model decides (`undecided`, `decisionProblem`). A decided
// (retired or done) agent is never woken: the cold guard (src/fleet/guard.ts) refuses any message to it.

import type { AgentAction, AlertKind, GuardStore } from './store'

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
  /** Keep-warm messages to one agent (in a row, with no real work between) before the coordinator is alerted. */
  keepWarmMax: number
  /** The session's (parent's) model, which a message wakes an unpinned agent on; absent: unknown. */
  sessionModel?: string
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
  /** The model of its last request, when known. */
  model?: string
  /** The Agent call pinned a model (its `.meta.json` names one): a wake keeps it. */
  pinned?: boolean
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

/** A model name reduced to compare: no `claude-` prefix, no `[1m]` suffix, no date, dots as dashes. */
function normModel(m: string): string {
  return m
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-')
}

/** Whether two model names mean the same model: equal once normalised, or one is only a family alias (`opus`) of the other. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = normModel(a)
  const y = normModel(b)
  if (x === y) return true
  const alias = (s: string) => /^[a-z]+$/.test(s)
  return (alias(x) && y.startsWith(x + '-')) || (alias(y) && x.startsWith(y + '-'))
}

/**
 * Whether a message can wake the agent without switching its model (and so without writing a new cache): the Agent
 * call pinned a model, or the agent's last request was on the session's model. Anything unknown counts as no.
 */
export function wakeKeepsModel(a: Pick<StoppedCandidate, 'model' | 'pinned'>, sessionModel: string | undefined): boolean {
  return a.pinned === true || sameModel(a.model, sessionModel)
}

/** The minutes a handover may take: the setting, but at most half the lead so the alert comes before the cache expires. */
export function handoverWaitOf(rules: AgentRules, auto: AutoRules): number {
  return Math.min(auto.handoverWaitMinutes, leadOf(rules) / 2)
}

/** Whether Tether has an agent in hand: a handover is under way and nobody needs to be told yet. */
function handled(store: GuardStore, id: string): boolean {
  const a = store.actions[id]
  return a?.handoverAt !== undefined && handoverProblem(a) === undefined
}

/** Why a handover Tether asked for went wrong, as the line the model reads; undefined while it is going fine. */
function handoverProblem(a: AgentAction): string | undefined {
  const since = a.handoverAt ?? 0
  if (a.stopFailedAt !== undefined) return 'its background tasks could not be stopped (TaskStop them yourself)'
  if (alerted(a, 'still-waiting', since)) return 'it is still waiting on background work Tether cannot identify (stop it yourself, see /tasks)'
  if (alerted(a, 'handover-late', since)) return 'it has not finished in time and is NOT stopped'
  return undefined
}

/** Whether the problem `kind` was already told since `since` (an alert is told once per cycle, not once for ever). */
export function alerted(a: AgentAction | undefined, kind: AlertKind, since: number): boolean {
  const t = a?.alerts[kind]
  return t !== undefined && t >= since
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
    const problem = act?.handoverAt !== undefined ? handoverProblem(act) : undefined
    if (problem) {
      // The handover Tether asked for went wrong: the model decides, whatever the status
      out.push({ id: a.id, text: `${a.label} (${a.id}): handover asked, ${problem}` })
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
    '(a) keep it warm: send it a short message with SendMessage (a cache read re-arms the expiry), then record it as kept-warm; do this only for an agent on the same model as this session (a message wakes an agent whose Agent call pinned no model on the session model, and that writes a new cache at the session model rates); ' +
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
  | { kind: 'warm'; id: string; label: string; count: number; contextTokens: number }
  | { kind: 'handover'; id: string; label: string; contextTokens: number; /** Why a handover and not a ping: the context is big, or a wake would switch the agent's model. */ why: 'size' | 'model'; model?: string }
  | { kind: 'collect'; id: string; label: string; tasks: string[] }
  | { kind: 'retire'; id: string; label: string; stopped: number }
  | { kind: 'alert'; id: string; label: string; key: AlertKind; /** The alert is told once until the agent has done something after this time. */ since: number; text: string }

/** A real piece of work between two pings: the context grew by at least this much (a ping's answer adds a few hundred tokens). */
const WORK_TOKENS = 10_000
/** After the leftover tasks were stopped, how long the agent gets to show it is quiet before it is retired. */
const SETTLE_MS = 45_000

/**
 * What to do now, per agent.
 *
 * - An agent being handed over that has stopped (a turn ended after the message, with a request in it) is
 *   collected: its leftover background tasks are stopped. It is retired only on a later tick, once it is quiet
 *   (not running, not waiting); one still waiting then, on work Tether cannot see, is an alert and stays unretired.
 * - One that has not stopped within the handover wait is an alert, once; it is never stopped silently.
 * - A stopped agent with background work, past the act-after time and big enough to matter, is handed over when
 *   its context reaches `handoverTokens` or a message would switch its model, and kept warm otherwise (an alert once
 *   `keepWarmMax` pings were sent with no real work between).
 * - A stopped agent with no background work cannot wake itself, so it is left to the model's decision.
 * The plans are ordered so the messages (cache-critical) come before the task stops.
 */
export function planActions(agents: StoppedCandidate[], store: GuardStore, rules: AgentRules, auto: AutoRules, now: number): Plan[] {
  const out: Plan[] = []
  const wait = handoverWaitOf(rules, auto)
  for (const a of agents) {
    const act = store.actions[a.id]
    const left = Math.max(0, Math.floor(rules.cacheMinutes - (now - a.lastStepAt) / MIN))
    if (act?.handoverAt !== undefined && !covered(store, a, rules, now)) {
      const since = act.handoverAt
      const stopped = a.status !== 'running' && a.finishedAt !== undefined && a.finishedAt >= since && a.lastStepAt > since
      if (!stopped) {
        if (now - since >= wait * MIN && !alerted(act, 'handover-late', since)) {
          out.push({ kind: 'alert', id: a.id, label: a.label, key: 'handover-late', since, text: `${a.label} (${a.id}) has not finished its handover ${wait} min after Tether asked; it is NOT stopped. Its cache expires in ~${left} min.` })
        }
        continue
      }
      if (act.stopFailedAt !== undefined) continue
      const blind = a.status === 'waiting' || (a.tasks?.length ?? 0) > 0
      if (act.tasksStoppedAt === undefined) {
        if ((a.tasks?.length ?? 0) > 0) out.push({ kind: 'collect', id: a.id, label: a.label, tasks: a.tasks ?? [] })
        else if (a.status === 'waiting') {
          if (!alerted(act, 'still-waiting', since)) out.push({ kind: 'alert', id: a.id, label: a.label, key: 'still-waiting', since, text: `${a.label} (${a.id}) handed over but is still waiting on background work Tether cannot identify; TaskStop its tasks yourself (see /tasks), then record it as retired` })
        } else out.push({ kind: 'retire', id: a.id, label: a.label, stopped: 0 })
      } else if (now - act.tasksStoppedAt >= SETTLE_MS) {
        // The stops are done. Only a quiet agent is retired: a task Tether cannot see (a monitor, a background agent) wakes it again
        if (blind) {
          if (!alerted(act, 'still-waiting', since)) out.push({ kind: 'alert', id: a.id, label: a.label, key: 'still-waiting', since, text: `${a.label} (${a.id}) handed over and its known tasks were stopped, but it is still ${a.status === 'waiting' ? 'waiting on background work Tether cannot identify' : 'holding live tasks'}; it is NOT retired (it wakes itself). TaskStop what is left yourself (see /tasks), then record it as retired` })
        } else if (a.status !== 'running') out.push({ kind: 'retire', id: a.id, label: a.label, stopped: act.stoppedCount ?? 0 })
      }
      continue
    }
    if (!STOPPED.has(a.status) || covered(store, a, rules, now) || !hasBackground(a)) continue
    const idle = (now - a.lastStepAt) / MIN
    const context = a.contextTokens ?? 0
    if (idle < actAfterMinutes(rules) || context < rules.smallTokens) continue
    // Real work since the last ping starts a new run of pings
    const warms = act?.warmContext !== undefined && context - act.warmContext >= WORK_TOKENS ? 0 : (act?.warms ?? 0)
    if (idle >= rules.cacheMinutes) {
      // Too late: a message now would itself re-write the whole context, so the model decides
      if (!alerted(act, 'expired', a.lastStepAt)) out.push({ kind: 'alert', id: a.id, label: a.label, key: 'expired', since: a.lastStepAt, text: `${a.label} (${a.id}) has background work and its cache EXPIRED ${Math.floor(idle)} min after its last request; Tether did not ping it (that would re-write ~${Math.round(context / 1000)}k tokens). Decide whether to hand it over.` })
    } else if (context >= auto.handoverTokens || !wakeKeepsModel(a, auto.sessionModel)) {
      out.push({ kind: 'handover', id: a.id, label: a.label, contextTokens: context, why: context >= auto.handoverTokens ? 'size' : 'model', ...(a.model ? { model: a.model } : {}) })
    } else if (warms >= auto.keepWarmMax) {
      if (!alerted(act, 'warm-max', a.lastStepAt)) out.push({ kind: 'alert', id: a.id, label: a.label, key: 'warm-max', since: a.lastStepAt, text: `${a.label} (${a.id}) was kept warm ${warms} times without doing any work and still waits on background work; decide whether it should be handed over.` })
    } else {
      out.push({ kind: 'warm', id: a.id, label: a.label, count: warms + 1, contextTokens: context })
    }
  }
  // Messages first: a stop that blocks must not delay a ping that is due
  const order = { warm: 0, handover: 0, alert: 1, retire: 2, collect: 3 } as const
  return out.sort((x, y) => order[x.kind] - order[y.kind])
}
