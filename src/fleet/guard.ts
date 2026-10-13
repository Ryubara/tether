// The cold-cache guard: refuse to wake a big agent whose prompt cache has expired.

import type { FleetConfig } from './config'
import { cacheMinutesLeft, type Ledger } from './ledger'
import { tokens, type AgentLike } from './rows'

/** The SendMessage fields the guard reads. */
export type SendMessageInput = { to?: unknown; message?: unknown }

/**
 * Finds the agent a SendMessage `to` means: its id, the name the Agent call gave it (which
 * `$.agent.list()` does not always carry, so fleet records it from the Agent call), or a description
 * no other agent shares.
 */
export function resolveAgent(to: string, agents: AgentLike[], names: Map<string, string>): AgentLike | undefined {
  const byId = agents.find(a => a.id === to || a.name === to)
  if (byId) return byId
  const named = names.get(to)
  if (named) return agents.find(a => a.id === named) ?? { id: named, status: 'unknown', name: to }
  const byDescription = agents.filter(a => a.description === to)
  return byDescription.length === 1 ? byDescription[0] : undefined
}

/**
 * Decides a SendMessage call. Returns the refusal text for the model, or undefined to let it through.
 *
 * A message to an agent fleet has no request for (spawned before fleet loaded) passes: there is no
 * evidence its cache is cold. A message that starts with the override token passes on purpose.
 */
export function coldGuard(
  input: SendMessageInput,
  agents: AgentLike[],
  ledger: Ledger,
  now: number,
  cfg: FleetConfig,
  names: Map<string, string> = new Map(),
): string | undefined {
  if (!cfg.coldGuard || typeof input.to !== 'string') return undefined
  const message = typeof input.message === 'string' ? input.message : ''
  if (message.trimStart().startsWith(cfg.overrideToken)) return undefined
  const agent = resolveAgent(input.to, agents, names)
  const entry = ledger.get(agent?.id ?? input.to)
  if (!entry) return undefined
  const left = cacheMinutesLeft(entry, now, cfg.cacheTtlMinutes)
  if (left === undefined || left > 0 || entry.contextTokens < cfg.bigContextTokens) return undefined
  const idle = Math.round((now - entry.lastStepAt) / 60_000)
  return (
    `fleet: not sent. Agent ${agent?.name ?? (input.to !== agent?.id ? input.to : agent?.description ?? input.to)} has been idle ${idle} min, past the ` +
    `${cfg.cacheTtlMinutes} min prompt-cache lifetime, so waking it re-writes about ${tokens(entry.contextTokens)} ` +
    `tokens of cache. Prefer a fresh agent started from its written status. If the wake is worth that cost, ` +
    `send again with the message starting "${cfg.overrideToken}".`
  )
}
