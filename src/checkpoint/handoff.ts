// Checks a handoff against its template: every required heading present, and within the size limit.
// The check is what makes "the handoff is good" true rather than hoped for.

import type { CheckpointConfig } from './config'

/** The problems with a handoff's text; an empty list means it passes. */
export function handoffProblems(text: string, cfg: CheckpointConfig): string[] {
  const problems: string[] = []
  if (text.trim() === '') problems.push('the handoff is empty')
  if (text.length > cfg.maxChars) problems.push(`the handoff is ${text.length} characters; the limit is ${cfg.maxChars}`)
  for (const heading of cfg.sections) {
    if (!new RegExp('^' + escapeRegExp(heading) + '\\s*$', 'm').test(text)) problems.push(`missing the heading "${heading}"`)
  }
  return problems
}

/** Escapes a string so it matches literally inside a regular expression. */
function escapeRegExp(s: string): string {
  return s.split('').map(c => ('.*+?^${}()|[]\\/'.includes(c) ? '\\' + c : c)).join('')
}

/** The most lines of a handoff that are injected into a session. */
export const INJECT_MAX_LINES = 400

/** The line above the injected handoff. */
export const INJECT_HEADER = 'Project state from the handoff file (Tether)'

/**
 * The context text for an injected handoff: a header line, then the file, cut at `INJECT_MAX_LINES` with a
 * note to trim it. Undefined for an empty file.
 */
export function injectedHandoff(file: string, text: string): string | undefined {
  if (text.trim() === '') return undefined
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  const body = lines.length > INJECT_MAX_LINES
    ? [...lines.slice(0, INJECT_MAX_LINES), `[${file} is ${lines.length} lines; only the first ${INJECT_MAX_LINES} are shown. Trim it.]`]
    : lines
  return [`${INJECT_HEADER}: ${file}`, '', ...body].join('\n')
}
