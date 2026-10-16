// plainOutput: what Tether says is built from fixed templates filled only with ids, numbers and codes from closed
// sets. These helpers turn any outside value into one of those, or into a fixed stand-in when it is not one.

/** What an id looks like: a poller id, an agent id, a task id, a session id, a command poller's key. */
export const ID_LIKE = /^[A-Za-z0-9._:-]{1,64}$/

/** The value when it is id-like, else `?`. */
export function plainId(v: unknown): string {
  return typeof v === 'string' && ID_LIKE.test(v) ? v : '?'
}

/** The value when it is one of `codes`, else `other`. */
export function plainCode(v: unknown, codes: ReadonlySet<string>): string {
  return typeof v === 'string' && codes.has(v) ? v : 'other'
}

/** The agent statuses Tether names; any other status is told as `other`. */
export const AGENT_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'completed', 'failed', 'killed', 'idle', 'unknown'])

/** A rate limit's kind as told: lower-case letters, digits and `_` only, else `limit`. */
export function plainLimitKind(v: unknown): string {
  return typeof v === 'string' && /^[a-z0-9_]{1,32}$/.test(v) ? v : 'limit'
}

/** The error codes a failing poller or command is told by. */
const ERROR_CODE = /^(exit -?\d{1,6}|refused:(network|not-allowed)|not-json|bad-output|timeout|failed)$/

/** An error as told under plainOutput: one of the codes, else `failed`. */
export function plainError(v: unknown): string {
  return typeof v === 'string' && ERROR_CODE.test(v) ? v : 'failed'
}

/**
 * A dedupe key as kept in $.store under plainOutput: a hash, so no outside text is stored. Two 32-bit FNV-1a
 * passes (one over the text reversed) make collisions between a poller's own keys unlikely.
 */
export function hashKey(text: string): string {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  return 'k' + hex(fnv(text)) + hex(fnv(text.split('').reverse().join('')))
}
