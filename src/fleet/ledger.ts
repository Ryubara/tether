// Per-agent token accounting built from each model request (`turn.step`), and the cold-cache maths.

/** The token counts the Claude API reports for one request. */
export type StepUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** What fleet knows about one agent loop; `main` is the session's own loop. */
export type AgentLedger = {
  id: string
  /** Time of the last request's end, in ms since the epoch. */
  lastStepAt: number
  /** Context size at the last request: everything the model read. */
  contextTokens: number
  /** Cache tokens written over the agent's life. */
  cacheWritten: number
  /** Cache tokens written by requests that came after the cache had expired. */
  coldWritten: number
  steps: number
}

/** All agents, by id. Kept in a module variable, so it survives /clear. */
export type Ledger = Map<string, AgentLedger>

/** What one recorded step meant. */
export type StepVerdict = {
  /** The request came after the cache expired and re-wrote at least `bigContextTokens`. */
  isColdWake: boolean
  /** Minutes the agent had been idle before this request. */
  idleMinutes: number
  written: number
}

/** The context an API request read: fresh input plus what came from or went into the cache. */
export function contextOf(u: StepUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/** Records one finished request for `id`, and says whether it was a costly wake on a cold cache. */
export function recordStep(
  ledger: Ledger,
  id: string,
  now: number,
  usage: StepUsage,
  ttlMinutes: number,
  bigContextTokens: number,
): StepVerdict {
  const prev = ledger.get(id)
  const written = usage.cache_creation_input_tokens ?? 0
  const idleMinutes = prev ? (now - prev.lastStepAt) / 60_000 : 0
  // A first request writes its cache by nature; only a re-write after expiry is waste.
  const isColdWake = prev !== undefined && idleMinutes >= ttlMinutes && written >= bigContextTokens
  ledger.set(id, {
    id,
    lastStepAt: now,
    contextTokens: contextOf(usage),
    cacheWritten: (prev?.cacheWritten ?? 0) + written,
    coldWritten: (prev?.coldWritten ?? 0) + (isColdWake ? written : 0),
    steps: (prev?.steps ?? 0) + 1,
  })
  return { isColdWake, idleMinutes, written }
}

/** Minutes of cache left for an agent (negative once expired), or undefined when fleet has seen no request. */
export function cacheMinutesLeft(entry: AgentLedger | undefined, now: number, ttlMinutes: number): number | undefined {
  if (!entry) return undefined
  return ttlMinutes - (now - entry.lastStepAt) / 60_000
}
