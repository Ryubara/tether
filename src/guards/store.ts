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

/** A rerun of a PR's failed checks that the project's health command reported making; it owns those checks until `until`. */
export type RerunRecord = {
  pr: number
  /** The head commit the rerun was for; `?` when unknown (then any head matches). */
  sha: string
  /** The checks that were rerun. */
  checks: string[]
  /** Epoch ms after which the rerun no longer owns the problem, finished or not. */
  until: number
}

export type GuardStore = {
  /** By PR number as text. */
  owners: Record<string, Owner>
  /** By PR number as text: the latest rerun the health command reported for it. */
  reruns: Record<string, RerunRecord>
  /** By agent id. */
  decisions: Record<string, Decision>
}

export const EMPTY_STORE: GuardStore = { owners: {}, reruns: {}, decisions: {} }

/** Reads a stored value into a GuardStore, dropping anything of the wrong shape. */
export function readStore(raw: unknown): GuardStore {
  const out: GuardStore = { owners: {}, reruns: {}, decisions: {} }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const [k, v] of Object.entries((r.owners as object) ?? {})) {
    const o = v as Partial<Owner> | null
    if (o && typeof o.until === 'number' && typeof o.who === 'string') {
      out.owners[k] = { until: o.until, who: o.who, note: String(o.note ?? ''), at: String(o.at ?? ''), ...(o.cause ? { cause: o.cause } : {}) }
    }
  }
  for (const [k, v] of Object.entries((r.reruns as object) ?? {})) {
    const x = v as Partial<RerunRecord> | null
    if (x && typeof x.pr === 'number' && typeof x.until === 'number' && Array.isArray(x.checks)) {
      out.reruns[k] = { pr: x.pr, sha: typeof x.sha === 'string' ? x.sha : '?', checks: x.checks.filter(c => typeof c === 'string'), until: x.until }
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

/** The store with a rerun recorded for a PR (the latest replaces the earlier), owning its checks for `hours`. */
export function recordRerun(store: GuardStore, pr: number, sha: string, checks: string[], hours: number, now: number): GuardStore {
  const record: RerunRecord = { pr, sha, checks: [...checks].sort(), until: now + hours * 3_600_000 }
  return { ...store, reruns: { ...store.reruns, [String(pr)]: record } }
}

/**
 * Whether a recorded, unexpired rerun owns a failed-checks problem: there are failing checks, every one of
 * them was rerun, and the head commit is the one rerun (when both are known).
 */
export function rerunCovers(record: RerunRecord | undefined, cause: string, failed: string[], sha: string, now: number): boolean {
  if (!record || record.until <= now || cause !== 'checks-failed' || failed.length === 0) return false
  if (record.sha !== '?' && sha !== '?' && record.sha !== sha) return false
  return failed.every(c => record.checks.includes(c))
}

/** The store without expired owners and reruns, so it does not grow for ever. */
export function pruneOwners(store: GuardStore, now: number): GuardStore {
  const owners = Object.fromEntries(Object.entries(store.owners).filter(([, o]) => o.until > now))
  const reruns = Object.fromEntries(Object.entries(store.reruns).filter(([, x]) => x.until > now))
  if (Object.keys(owners).length === Object.keys(store.owners).length && Object.keys(reruns).length === Object.keys(store.reruns).length) return store
  return { ...store, owners, reruns }
}
