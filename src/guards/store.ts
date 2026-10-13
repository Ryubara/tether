// The guards' one store: who owns each open-PR problem, and what was decided about each stopped agent.
// Both are "somebody has dealt with this" records, so both live in one value kept in $.store.

/** A PR's owner (someone dispatched to fix it) or a waiver (a known wait), valid until `until`. */
export type Owner = {
  /** Epoch ms after which the problem counts as unowned again, so a fix that stalls cannot hide. */
  until: number
  /** Who fixes it, or `waived`. */
  who: string
  note: string
  /** When it was recorded, as text for the reader. */
  at: string
  /** Only this cause is covered; absent, every cause of the PR is. */
  cause?: string
}

/** What was decided about a stopped agent with a big context. */
export type Decision = { decision: 'retired' | 'done'; note: string; at: string }

export type GuardStore = {
  /** By PR number as text. */
  owners: Record<string, Owner>
  /** By agent id. */
  decisions: Record<string, Decision>
}

export const EMPTY_STORE: GuardStore = { owners: {}, decisions: {} }

/** Reads a stored value into a GuardStore, dropping anything of the wrong shape. */
export function readStore(raw: unknown): GuardStore {
  const out: GuardStore = { owners: {}, decisions: {} }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const [k, v] of Object.entries((r.owners as object) ?? {})) {
    const o = v as Partial<Owner> | null
    if (o && typeof o.until === 'number' && typeof o.who === 'string') {
      out.owners[k] = { until: o.until, who: o.who, note: String(o.note ?? ''), at: String(o.at ?? ''), ...(o.cause ? { cause: o.cause } : {}) }
    }
  }
  for (const [k, v] of Object.entries((r.decisions as object) ?? {})) {
    const d = v as Partial<Decision> | null
    if (d && (d.decision === 'retired' || d.decision === 'done')) out.decisions[k] = { decision: d.decision, note: String(d.note ?? ''), at: String(d.at ?? '') }
  }
  return out
}

/** The store with an owner recorded for a PR (an assignment lasts `hours`; a waiver says `waived`). */
export function recordOwner(store: GuardStore, pr: number, who: string, hours: number, note: string, now: number, at: string, cause?: string): GuardStore {
  const owner: Owner = { until: now + hours * 3_600_000, who, note, at, ...(cause ? { cause } : {}) }
  return { ...store, owners: { ...store.owners, [String(pr)]: owner } }
}

/** The store with a decision recorded for an agent. */
export function recordDecision(store: GuardStore, id: string, decision: Decision['decision'], note: string, at: string): GuardStore {
  return { ...store, decisions: { ...store.decisions, [id]: { decision, note, at } } }
}

/** Whether an owner record is current and covers `cause` (one with no cause covers every cause). */
export function ownerCovers(owner: Owner | undefined, cause: string, now: number): boolean {
  if (!owner || owner.until <= now) return false
  return !owner.cause || owner.cause === cause
}

/** The store without expired owners, so it does not grow for ever. */
export function pruneOwners(store: GuardStore, now: number): GuardStore {
  const owners = Object.fromEntries(Object.entries(store.owners).filter(([, o]) => o.until > now))
  return Object.keys(owners).length === Object.keys(store.owners).length ? store : { ...store, owners }
}
