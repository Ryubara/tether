// The checkpoint cycle as a pure step: given the session's state now, say what to do. The hooks module
// reads the session (context, busy, draft, messages, the handoff file), calls `step`, and carries out the
// action. Keeping the decision pure lets the tests hold the rules: act only when quiet, update after new
// messages, never clear over an unchecked handoff.

import type { CheckpointConfig } from './config'

/** Where the cycle is: idle, a handoff requested and being written, or the clear is issued. */
export type Phase = 'idle' | 'asked' | 'clearing'

export type CycleState = {
  phase: Phase
  /** When the session last stopped being busy, had a draft or got a new message (ms). */
  quietSince: number
  /** The session's message count when the handoff was last requested. */
  askedMessages: number
  /** Messages arrived since the last request, so the handoff must be updated before the clear. */
  dirty: boolean
  /** Repair requests sent for the current handoff. */
  repairs: number
}

/** What the session looked like at one tick. */
export type Observed = {
  now: number
  contextTokens: number
  busy: boolean
  draft: string
  messages: number
  /** The handoff's problems now (empty when it passes); undefined when the file is missing. */
  problems: string[] | undefined
}

/** What the caller should do this tick. */
export type Action = 'none' | 'ask' | 'update' | 'repair' | 'clear' | 'give-up'

/** A cycle that is idle and has asked for nothing. */
export const initialCycle = (): CycleState => ({ phase: 'idle', quietSince: 0, askedMessages: 0, dirty: false, repairs: 0 })

/** One tick of the cycle: the next state and the action to carry out. */
export function step(state: CycleState, o: Observed, cfg: CheckpointConfig): { state: CycleState; action: Action } {
  const quiet = !o.busy && o.draft === ''
  const quietMs = cfg.quietSeconds * 1000

  if (state.phase === 'idle') {
    // Due, and the person is not in the middle of anything: ask for the handoff
    if (cfg.enabled && o.contextTokens >= cfg.contextTokens && quiet) {
      return { state: { phase: 'asked', quietSince: o.now, askedMessages: o.messages, dirty: false, repairs: 0 }, action: 'ask' }
    }
    return { state, action: 'none' }
  }

  if (state.phase === 'clearing') return { state, action: 'none' }

  // The handoff was requested: wait for quiet, then check it
  if (!quiet) return { state: { ...state, quietSince: o.now, dirty: state.dirty || o.messages !== state.askedMessages }, action: 'none' }
  if (o.messages !== state.askedMessages) {
    return { state: { ...state, quietSince: o.now, dirty: true, askedMessages: o.messages }, action: 'none' }
  }
  if (o.now - state.quietSince < quietMs) return { state, action: 'none' }

  // Quiet long enough. New messages arrived while the handoff was written: update it first.
  if (state.dirty) return { state: { ...state, dirty: false, quietSince: o.now }, action: 'update' }

  if (o.problems !== undefined && o.problems.length === 0) {
    return { state: { ...state, phase: 'clearing' }, action: 'clear' }
  }
  if (state.repairs < cfg.maxRepairs) {
    return { state: { ...state, repairs: state.repairs + 1, quietSince: o.now }, action: 'repair' }
  }
  // The handoff never passed: give up and let the session carry on rather than clear over a bad handoff
  return { state: initialCycle(), action: 'give-up' }
}

/** The prompt that asks the model to write the handoff, or to update it after new messages. */
export function askText(cfg: CheckpointConfig, update: boolean): string {
  const what = update ? `Update ${cfg.handoffFile} with what changed since you last wrote it.` : `Write ${cfg.handoffFile} now.`
  return [
    `Checkpoint: this session is long, so it will be cleared and continued from ${cfg.handoffFile}.`,
    what,
    `It must have these headings: ${cfg.sections.join(', ')}. Keep it under ${cfg.maxChars} characters.`,
    'Where to look: point to files and the notes that hold the detail, do not copy them in.',
    'Summary: the current state in a few lines. Next steps: what the user expects next. Open questions: what only the user can answer.',
    'Reply with one line when it is written.',
  ].join('\n')
}

/** The prompt that sends the model back to fix a handoff that failed its check. */
export function repairText(cfg: CheckpointConfig, problems: string[]): string {
  return `${cfg.handoffFile} failed its check: ${problems.join('; ')}. Fix it and reply with one line.`
}

/** Whether a user message is one of the cycle's own prompts (which are not new information). */
export function isCyclePrompt(text: string, cfg: CheckpointConfig): boolean {
  const h = cfg.handoffFile
  return (
    text.startsWith('Checkpoint: this session is long') ||
    text === `Write ${h} now.` ||
    text.startsWith(`Update ${h} with what changed`) ||
    text.startsWith(`${h} failed its check:`) ||
    text === `Continue from ${h}.`
  )
}

/** The prompt sent after the clear, so the new session picks the work up at once. */
export function continueText(cfg: CheckpointConfig): string {
  return `Continue from ${cfg.handoffFile}.`
}
