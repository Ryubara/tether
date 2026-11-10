// The lost-agent record: which subagents Tether saw at work, and which of them ended without a report.
//
// An agent ends with its report when its last turn ends with nothing left to wake it: that last message is its
// answer. One that stops to wait on background work (a build, CI, a monitor) expects that work to wake it. When the
// work ends and no request of the agent follows, or the agent leaves the list, or the session that ran it ends while
// it is at work, it never reports: it is lost. The record lives in $.store per session, so a /clear, a restart or a
// resume still knows what the session before had at work, and a lost agent is told once, at the next session start.

/** Where an agent stood when Tether last looked: at work (running, or waiting on its background work), ended, lost. */
export type RosterState = 'running' | 'waiting' | 'ended' | 'lost'

/** One agent in the record. */
export type RosterAgent = {
  id: string
  /** Its name, else the Agent call's description, else its type (its id under plainOutput). */
  label: string
  state: RosterState
  /** When Tether last saw it. */
  seenAt: number
  /** When it was first seen waiting in its current wait: a request after this means its work woke it. */
  waitingAt?: number
  /** For a lost agent: what it was doing when last seen at work. */
  was?: 'running' | 'waiting'
  /** Its last message at a SubagentStop, for a transcript too big to read. */
  line?: string
  /** A lost agent that was told. */
  told?: boolean
}

/** One session's record: its folder, when it was last heard from, when it ended, and its agents by id. */
export type Roster = { session: string; cwd: string; aliveAt: number; endedAt?: number; /** How often it is written while alive. */ everyMs?: number; agents: Record<string, RosterAgent> }

/** One agent as the engine lists it now. `tasks` counts its live background tasks; a teammate is never judged. */
export type Listed = { id: string; status: string; label: string; tasks?: number; teammate?: boolean }

/** The store key of a session's record. */
export const ROSTER_PREFIX = 'fleet:roster:'
/** A record not heard from for this long belongs to a session that ended without saying so (a crash, a kill). */
export const STALE_MS = 5 * 60_000
/** Ended and told entries are kept this long, then dropped. */
export const KEEP_MS = 24 * 60 * 60_000
/** Records of any folder not heard from for this long are dropped. */
export const FORGET_MS = 7 * 24 * 60 * 60_000

const RUNNING = new Set(['running', 'pending'])

const atWork = (s: RosterState): s is 'running' | 'waiting' => s === 'running' || s === 'waiting'

/**
 * The record after one look at the engine's list at `now`. `lastStepAt` is the time of an agent's last model request,
 * when known. An agent first seen finished is not recorded: Tether never saw it at work.
 */
export function observe(agents: Record<string, RosterAgent>, list: Listed[], lastStepAt: (id: string) => number | undefined, now: number): Record<string, RosterAgent> {
  const out: Record<string, RosterAgent> = { ...agents }
  const listed = new Set<string>()
  for (const a of list) {
    if (a.teammate) continue
    listed.add(a.id)
    const prev = out[a.id]
    // Back at work (resumed after it was told, say): a later loss is news again
    const base = { id: a.id, label: a.label, seenAt: now, ...(prev?.line !== undefined ? { line: prev.line } : {}) }
    if (RUNNING.has(a.status)) {
      out[a.id] = { ...base, state: 'running' }
    } else if (a.status === 'waiting' || (a.tasks ?? 0) > 0) {
      out[a.id] = { ...base, state: 'waiting', waitingAt: prev?.state === 'waiting' && prev.waitingAt !== undefined ? prev.waitingAt : now }
    } else if (prev && atWork(prev.state)) {
      // It stopped with nothing left to wake it. A kill is on purpose; a failure is no report; a waiting agent whose
      // work ended with no request of its own since was never woken
      const lost = a.status === 'killed' ? false : a.status === 'failed' || (prev.state === 'waiting' && !((lastStepAt(a.id) ?? -Infinity) > (prev.waitingAt ?? now)))
      out[a.id] = lost ? { ...base, state: 'lost', was: prev.state } : { ...base, state: 'ended' }
    }
  }
  // An agent at work that left the list ended where Tether could not see it end
  for (const [id, a] of Object.entries(out)) if (!listed.has(id) && atWork(a.state)) out[id] = { ...a, state: 'lost', was: a.state }
  return out
}

/** The record once its session has ended: every agent still at work died with it. */
export function endRoster(agents: Record<string, RosterAgent>): Record<string, RosterAgent> {
  return Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, atWork(a.state) ? { ...a, state: 'lost' as const, was: a.state } : a]))
}

/** The lost agents not told yet, oldest seen first; `skip` names agents known to be dealt with (handed over, retired, done). */
export function toTell(agents: Record<string, RosterAgent>, skip: Set<string>): RosterAgent[] {
  return Object.values(agents)
    .filter(a => a.state === 'lost' && !a.told && !skip.has(a.id))
    .sort((x, y) => x.seenAt - y.seenAt)
}

/** The record with these agents marked told. */
export function markTold(agents: Record<string, RosterAgent>, ids: string[]): Record<string, RosterAgent> {
  const out = { ...agents }
  for (const id of ids) if (out[id]) out[id] = { ...out[id]!, told: true }
  return out
}

/** The record without entries that ended, or were told, longer than `keepMs` ago. */
export function prune(agents: Record<string, RosterAgent>, now: number, keepMs: number): Record<string, RosterAgent> {
  return Object.fromEntries(Object.entries(agents).filter(([, a]) => atWork(a.state) || (a.state === 'lost' && !a.told) || now - a.seenAt < keepMs))
}

/** Whether a record belongs to a session of this folder that is over: it ended, or went quiet for `staleMs` (at least three of its writes). */
export function isOver(r: Roster, current: { session: string; cwd: string; now: number }, staleMs: number): boolean {
  if (r.session === current.session || r.cwd !== current.cwd) return false
  return r.endedAt !== undefined || current.now - r.aliveAt >= Math.max(staleMs, 3 * (r.everyMs ?? 0))
}

/** Reads a stored record; undefined for anything that is not one. */
export function readRoster(v: unknown): Roster | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Partial<Roster>
  if (typeof r.session !== 'string' || typeof r.cwd !== 'string' || typeof r.aliveAt !== 'number' || !r.agents || typeof r.agents !== 'object') return undefined
  const agents: Record<string, RosterAgent> = {}
  for (const [id, a] of Object.entries(r.agents)) {
    if (a && typeof a === 'object' && typeof a.state === 'string' && typeof a.seenAt === 'number') agents[id] = { ...a, id, label: typeof a.label === 'string' ? a.label : id }
  }
  return { session: r.session, cwd: r.cwd, aliveAt: r.aliveAt, ...(typeof r.endedAt === 'number' ? { endedAt: r.endedAt } : {}), ...(typeof r.everyMs === 'number' ? { everyMs: r.everyMs } : {}), agents }
}

/** The last assistant text in a JSONL transcript, read from the end; undefined when there is none. */
export function lastAssistantText(text: string): string | undefined {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end).trim()
    end = start - 1
    if (!line.includes('"assistant"') || !line.includes('"text"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
      const said = (entry.message!.content as Array<{ type?: string; text?: unknown }>)
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('\n')
        .trim()
      if (said !== '') return said
    } catch {
      // A partly written last line: look further back
    }
  }
  return undefined
}

/** A message as one line, cut at `max` characters. */
export function statusLine(text: string, max = 600): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 3) + '...'
}

/** The heading the lost agents are told under. */
export const LOST_TITLE =
  'Subagents that ended without a report (they stopped to wait and nothing woke them, or left while at work, or the session that ran them ended). SendMessage cannot resume one whose session ended: start a fresh agent from its notes and this last status'

/** One lost agent, as told: under plainOutput its id and what it was doing, nothing else. */
export function lostLine(a: RosterAgent, line: string | undefined, plain: boolean): string {
  const was = a.was ?? 'running'
  if (plain) return `${a.id} ${was}`
  const doing = was === 'waiting' ? 'waiting on background work' : 'running'
  return `${a.label} (${a.id}), ${doing} when last seen. Last status: ${line ? `"${line}"` : 'none found'}`
}

/** The session-start context: the heading and one line per lost agent. */
export function lostContext(lines: string[]): string {
  return `Tether: ${LOST_TITLE}:\n` + lines.map(l => `- ${l}`).join('\n')
}
