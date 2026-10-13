// Reading what Claude Code's own transcript files say about a subagent fleet has not seen run:
// one started before fleet loaded has made no request fleet saw, and a resumed one lists as "(resumed)".

/** The folder name Claude Code keeps a project's transcripts under: the path with every other character a dash. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where a session's subagent transcripts live, under Claude Code's config folder. */
export function subagentsDir(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir.replace(/[\\/]+$/, '')}/projects/${projectKey(cwd)}/${sessionId}/subagents`
}

/** What the last model request in a transcript showed: when it was and how big the context was. */
export type LastRequest = { at: number; contextTokens: number }

/**
 * The last assistant entry with usage, read from the end of a JSONL transcript.
 * Undefined when there is none (or no line parses).
 */
export function lastRequest(text: string): LastRequest | undefined {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end).trim()
    end = start - 1
    if (!line.includes('"usage"')) continue
    try {
      const entry = JSON.parse(line) as { timestamp?: string; message?: { usage?: Record<string, number> } }
      const u = entry.message?.usage
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (!u || !Number.isFinite(at)) continue
      const contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      return { at, contextTokens }
    } catch {
      // A partly written last line: look further back
    }
  }
  return undefined
}

/** The Agent call's description from a subagent's `.meta.json`, if it has one. */
export function metaDescription(text: string): string | undefined {
  try {
    const d = (JSON.parse(text) as { description?: unknown }).description
    return typeof d === 'string' && d.trim() !== '' ? d.trim() : undefined
  } catch {
    return undefined
  }
}

/** How a background task ends in the notification Claude Code queues for its owner. */
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed'])

/** A start: the text a background Bash call is answered with, or the id its stored result names. */
const STARTED = /running in background with ID: ([A-Za-z0-9_-]+)|"backgroundTaskId":"([A-Za-z0-9_-]+)"/g

/** An end: a task notification names the task and, later in it, how it ended. */
const ENDED = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([a-z_]+)<\/status>/g

/**
 * Applies the background-task starts and ends found in `text` (a transcript, or the text of one appended row) to
 * `live`, the set of task ids a subagent has running, in the order they appear. Measured on Claude Code 2.1.296: a
 * background Bash is answered "Command running in background with ID: <id>" and its stored result holds
 * `backgroundTaskId`; its end arrives as a queued `<task-notification>` with `<task-id>` and a final `<status>`
 * (completed, failed or killed). A task of another kind (a monitor, a background agent) is not recognised.
 */
export function scanTasks(text: string, live: Set<string>): void {
  const events: Array<{ at: number; id: string; ended: boolean }> = []
  for (const m of text.matchAll(STARTED)) events.push({ at: m.index ?? 0, id: (m[1] ?? m[2])!, ended: false })
  for (const m of text.matchAll(ENDED)) if (ENDED_STATUSES.has(m[2]!)) events.push({ at: m.index ?? 0, id: m[1]!, ended: true })
  for (const e of events.sort((x, y) => x.at - y.at)) {
    if (e.ended) live.delete(e.id)
    else live.add(e.id)
  }
}

/** The ids of the background tasks a whole transcript started and has not seen end, oldest first. */
export function liveTasks(text: string): string[] {
  const live = new Set<string>()
  scanTasks(text, live)
  return [...live]
}

/** The text of an appended row's blocks (text blocks and tool results), each cut short: the task phrases sit at the start. */
export function appendedText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (typeof b?.text === 'string') parts.push(b.text.slice(0, 4000))
    else if (b?.type === 'tool_result' || b?.content !== undefined) parts.push(appendedText(b.content))
  }
  return parts.join('\n')
}
