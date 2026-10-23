// A notice: one thing to tell the model, and the pure rules for when and how a wake goes.

/**
 * One thing waiting to be told to the model. `key` is what the producer's dedupe remembers (e.g. PR + cause + head
 * sha); `again` marks one told before and still reported, told once more by a reminder. `poller` names the producer
 * (a poller's id, or `agent-guard`), `title` the heading its notices are grouped under, `wake` whether it may start
 * a turn, and `at` when it was raised.
 */
export type Notice = { key: string; text: string; again?: boolean; poller: string; title: string; wake: boolean; at: number }

/** Why a wake does not go now, or `go`. */
export type WakeVerdict = 'go' | 'nothing' | 'busy' | 'typing' | 'gap' | 'held'

/**
 * Whether to start a turn now for the pending notices: never during a turn, nor while `held` (a wake sent waits
 * for its turn, or one refused waits to be tried again), not within the gap
 * after the last wake, and not while the person has a draft (until the oldest waited `deferMinutes`).
 */
export function wakeVerdict(
  pending: Notice[],
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

/** The wake prompt: the preamble, then each producer's notices under its title (a reminder marked as one). */
export function wakeText(preamble: string, pending: Notice[]): string {
  const groups = new Map<string, string[]>()
  // A reminder says so, so the model can tell it from news
  for (const p of pending) groups.set(p.title, [...(groups.get(p.title) ?? []), p.again ? `${p.text} (still reported)` : p.text])
  const parts = [preamble]
  for (const [title, texts] of groups) parts.push(`\n${title}:\n` + texts.map(t => `- ${t}`).join('\n'))
  return parts.join('\n')
}

/**
 * Puts notices back in the pending list (a wake that was refused or started no turn), keeping the ones that
 * joined meanwhile and telling each producer's key once.
 */
export function requeue(back: Notice[], now: Notice[]): Notice[] {
  const out: Notice[] = []
  const keys = new Set<string>()
  for (const p of [...back, ...now]) {
    const k = `${p.poller} ${p.key}`
    if (keys.has(k)) continue
    keys.add(k)
    out.push(p)
  }
  return out
}
