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
