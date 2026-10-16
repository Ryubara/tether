// Checkpoint settings: when a session is due a handoff, how long it must be quiet first, and what the
// handoff file must hold. Defaults match the plan in HANDOFF.md; a config file overrides any of them.

export type CheckpointConfig = {
  /** Off: nothing is asked, cleared or continued. */
  enabled: boolean
  /** The main session's context, in tokens, at which a checkpoint is due. */
  contextTokens: number
  /** Seconds with no turn, no draft and no new message before the checkpoint acts. */
  quietSeconds: number
  /** Seconds between checks of the session's state. */
  tickSeconds: number
  /** The handoff file, relative to the session's folder. */
  handoffFile: string
  /** The handoff's size limit in characters: it is injected into the next session, so it must stay small. */
  maxChars: number
  /** Headings the handoff must contain, in any order. */
  sections: string[]
  /** At session start (every source), the handoff's text is added to the session as context (the 0.x behaviour). */
  injectHandoff: boolean
  /** Repair attempts before the cycle gives up and the session carries on. */
  maxRepairs: number
  /** Minutes to wait before asking again after a give-up or a clear that did not happen. */
  retryMinutes: number
}

export const CHECKPOINT_DEFAULTS: CheckpointConfig = {
  enabled: false,
  contextTokens: 200_000,
  quietSeconds: 5,
  tickSeconds: 2,
  handoffFile: 'HANDOFF.md',
  maxChars: 9_500,
  sections: ['## Where to look', '## Summary', '## Next steps', '## Open questions'],
  maxRepairs: 3,
  retryMinutes: 15,
  injectHandoff: false,
}

/** Merges a parsed `checkpoint` section over the defaults, keeping only well-typed fields. */
export function mergeCheckpoint(raw: unknown): CheckpointConfig {
  const out: CheckpointConfig = { ...CHECKPOINT_DEFAULTS, sections: [...CHECKPOINT_DEFAULTS.sections] }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.injectHandoff === 'boolean') out.injectHandoff = r.injectHandoff
  for (const k of ['contextTokens', 'quietSeconds', 'tickSeconds', 'maxChars', 'maxRepairs', 'retryMinutes'] as const) {
    if (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0) out[k] = r[k] as number
  }
  if (typeof r.handoffFile === 'string' && r.handoffFile.trim() !== '') out.handoffFile = r.handoffFile.trim()
  if (Array.isArray(r.sections) && r.sections.length > 0 && r.sections.every(s => typeof s === 'string')) {
    out.sections = r.sections as string[]
  }
  return out
}
