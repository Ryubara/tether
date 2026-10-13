// The agent guard's pure part: a stopped subagent holding a big context must be decided (retired or marked
// done) before its prompt cache expires, because waking it later re-writes the whole context. Until a
// decision is recorded, the agent is a finding (and the Stop hook blocks).

import type { GuardStore } from './store'

/** The thresholds, shared with fleet so one number decides what "big" and "expired" mean. */
export type AgentRules = {
  /** The prompt cache lives about this long. */
  cacheMinutes: number
  /** Below this a re-write is cheap enough to ignore. */
  smallTokens: number
  /** A stopped agent is due for a decision this long after its last request. */
  actAfterMinutes: number
  /** Quiet longer than this: forgotten, not reported for ever. */
  forgetMinutes: number
}

export const AGENT_RULES_DEFAULTS = { actAfterMinutes: 45, forgetMinutes: 180 }

/** One agent as the guard needs it. */
export type StoppedCandidate = { id: string; status: string; label: string; lastStepAt: number; contextTokens?: number }

/** Statuses of an agent whose turn ended and that a message would wake. */
const STOPPED = new Set(['completed', 'waiting'])

/** A stopped agent that needs a decision, with the line that says why. */
export type Undecided = { id: string; text: string }

/** The stopped, big, undecided agents past their act-after time. */
export function undecided(agents: StoppedCandidate[], store: GuardStore, rules: AgentRules, now: number): Undecided[] {
  const out: Undecided[] = []
  for (const a of agents) {
    if (!STOPPED.has(a.status) || a.id in store.decisions) continue
    const idle = (now - a.lastStepAt) / 60_000
    if (idle < rules.actAfterMinutes || idle >= rules.forgetMinutes || (a.contextTokens ?? 0) < rules.smallTokens) continue
    const left = rules.cacheMinutes - idle
    const cache = left > 0 ? `cache expires in ~${Math.floor(left)} min` : 'cache EXPIRED (waking it re-writes all)'
    out.push({ id: a.id, text: `${a.label} (${a.id}): stopped ${Math.floor(idle)} min, context ${Math.round((a.contextTokens ?? 0) / 1000)}k, ${cache}` })
  }
  return out
}

/** The Stop hook's reason: the agents and what to do about them. */
export function stopReason(items: Undecided[]): string {
  return (
    'CACHE GUARD: stopped subagents with a large context are due for a decision before their cache expires (a wake-up ' +
    're-writes the whole context). Never wake one with an expired cache: start a fresh agent from its notes. For each, ' +
    'if it waits on something or has work left, stop it and record it as retired with the mcp__tether__agent_decision tool (load it with ToolSearch if it is deferred); ' +
    'if it is finished, record it as done.\n' +
    items.map(i => `- ${i.text}`).join('\n')
  )
}
