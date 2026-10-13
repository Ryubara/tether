// Conversation logs: a session's messages as a Markdown file in .tether/conversations, for the person who wants
// to look back at what was said before a /clear. The log is never loaded into a session (that would refill the
// context a clear freed); an agent may grep one for a detail the handoff lost.
//
// Kept: the person's messages and the model's text, in order, one heading per person's turn; each tool call as
// a one-line bullet. Dropped: tool results, thinking, system reminders and every other housekeeping entry.

/** The parts of a session message the log reads (`$.session.messages()`). */
export type LogMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: Array<{ tool: string; input?: Record<string, unknown> }>
}

export type LogLimits = {
  /** Characters of one message kept; a pasted log should not bloat the file. */
  maxText: number
  /** Characters of a tool call's description. */
  maxTool: number
  /** Characters of a turn heading. */
  maxTitle: number
}

export const LOG_LIMITS: LogLimits = { maxText: 20_000, maxTool: 100, maxTitle: 70 }

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const LOCAL_COMMAND = /<local-command-(?:caveat|stdout|stderr)>[\s\S]*?<\/local-command-(?:caveat|stdout|stderr)>/g
const PASTED = /<\/?pasted_content[^>]*>/g
/** The input keys that say most about a tool call, in the order tried. */
const TOOL_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill', 'name']

/** A message's text without the harness's reminders and command echoes. */
export function cleanText(text: string): string {
  return text.replace(REMINDER, '').replace(LOCAL_COMMAND, '').replace(PASTED, '').trim()
}

/** One line for a tool call: its name and the most telling input, cut short. */
export function toolLine(tool: string, input: Record<string, unknown> | undefined, max: number): string {
  for (const k of TOOL_KEYS) {
    const v = input?.[k]
    if (typeof v === 'string' && v.trim() !== '') {
      const one = v.trim().replace(/\s+/g, ' ')
      return `- ${tool}: ${one.length > max ? one.slice(0, max - 1) + '…' : one}`
    }
  }
  return `- ${tool}`
}

/** A turn's heading from the person's first line, cut short. */
export function turnTitle(text: string, max: number): string {
  const first = (text.split('\n').find(l => l.trim() !== '') ?? '').replace(/^\s{0,3}#{1,6}\s+/, '').trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first || '(no text)'
}

/** Indents Markdown headings inside a message so they cannot be mistaken for the log's own. */
function demote(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .map(line => {
      if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced
      return !fenced && /^\s{0,3}#{1,6}\s/.test(line) ? '\\' + line.trimStart() : line
    })
    .join('\n')
}

/** The log for a session: a header, then each of the person's turns with the model's replies and tool calls. */
export function renderConversation(messages: readonly LogMessage[], meta: { sessionId: string; startedAt: string }, limits: LogLimits = LOG_LIMITS): string {
  const out = [`# Conversation ${meta.sessionId}`, '', `Started ${meta.startedAt}.`, '']
  let turn = 0
  for (const m of messages) {
    let text = cleanText(m.text ?? '')
    if (text.length > limits.maxText) text = text.slice(0, limits.maxText) + '\n[…cut]'
    if (m.role === 'user') {
      if (text === '') continue
      turn += 1
      out.push(`## ${turn}. ${turnTitle(text, limits.maxTitle)}`, '', '**You:**', '', demote(text), '')
    } else {
      if (turn === 0) turn = 1 // a session can open with the model speaking (a hook's wake)
      if (text !== '') out.push('**Claude:**', '', demote(text), '')
      const tools = (m.toolUses ?? []).map(t => toolLine(t.tool, t.input, limits.maxTool))
      if (tools.length > 0) out.push(...tools, '')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** The log's file name: start date and time, then the first eight characters of the session id. */
export function logName(startedAtIso: string, sessionId: string): string {
  const d = startedAtIso.slice(0, 10)
  const t = startedAtIso.slice(11, 16).replace(':', '')
  const id = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session'
  return `${d}-${t}-${id}.md`
}
