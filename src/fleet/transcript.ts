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

/** What the last model request in a transcript showed: when it was, how big the context was and which model answered. */
export type LastRequest = { at: number; contextTokens: number; model?: string }

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
      const entry = JSON.parse(line) as { timestamp?: string; message?: { model?: string; usage?: Record<string, number> } }
      const u = entry.message?.usage
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (!u || !Number.isFinite(at)) continue
      const contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      const model = entry.message?.model
      return { at, contextTokens, ...(typeof model === 'string' && model !== '' && model !== '<synthetic>' ? { model } : {}) }
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

/**
 * The model the Agent call pinned for a subagent, from its `.meta.json` (`"model":"sonnet"`), if it has one. A
 * subagent with one keeps that model when a message wakes it; one without (it ran on a default) is woken on the
 * parent session's model (`inherit` is not a pin). Measured on 2.1.296 transcripts: 55 of 55 wakes of pinned agents kept their model, 12 of 12
 * wakes of unpinned sonnet or haiku agents ran on the parent's opus.
 */
export function metaModel(text: string): string | undefined {
  try {
    const m = (JSON.parse(text) as { model?: unknown }).model
    // `inherit` is the Agent call's default: the agent follows the session, so nothing is pinned
    return typeof m === 'string' && m.trim() !== '' && m.trim().toLowerCase() !== 'inherit' ? m.trim() : undefined
  } catch {
    return undefined
  }
}

/** How a background task ends in the notification Claude Code queues for its owner. */
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed'])

/**
 * What a Bash call that went to the background is answered with; a tool result block starts with it. Three forms,
 * measured on 2.1.296: started with `run_in_background`, moved there by its timeout, and backgrounded by the user.
 */
const STARTED = /^Command (?:running in background with ID: |was manually backgrounded by user with ID: |did not complete within its \d+s timeout and was moved to the background \(ID: )([A-Za-z0-9_-]+)/

/** What the agent's own TaskStop is answered with (JSON in the tool result); no task-notification follows it. */
const STOPPED_PREFIX = 'Successfully stopped task: '

/** A task id as the harness spells it (letters, digits, dash, underscore). */
const TASK_ID = /^[A-Za-z0-9_-]+$/

/** One notification block; bounded by its own closing tag so a block without a status cannot swallow the next one. */
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

/** The text of a row's content: a string, or the text blocks of an array (tool_result contents included, each cut short). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (typeof b?.text === 'string') parts.push(b.text.slice(0, 4000))
    else if (b?.type === 'tool_result' || b?.content !== undefined) parts.push(contentText(b.content))
  }
  return parts.join('\n')
}

/** The ids of the background tasks started by the tool_result blocks of a user row's content (a block's text starts with the harness's answer). */
function startedIn(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type !== 'tool_result') continue
    const m = STARTED.exec(contentText(b.content).trimStart())
    if (m) out.push(m[1]!)
  }
  return out
}

/** The id a TaskStop answer stopped, when `r` is one: its message names the same id as its `task_id`. */
function stoppedBy(r: unknown): string | undefined {
  const x = r as { message?: unknown; task_id?: unknown } | null
  if (!x || typeof x !== 'object' || typeof x.message !== 'string' || typeof x.task_id !== 'string' || !TASK_ID.test(x.task_id)) return undefined
  return x.message.startsWith(STOPPED_PREFIX + x.task_id) ? x.task_id : undefined
}

/** The ids the tool_result blocks of a user row's content say TaskStop stopped (a block is the answer's JSON, nothing else). */
function stoppedIn(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type !== 'tool_result') continue
    const text = contentText(b.content).trim()
    if (!text.startsWith('{')) continue
    try {
      const id = stoppedBy(JSON.parse(text))
      if (id) out.push(id)
    } catch {
      // Not the answer's JSON
    }
  }
  return out
}

/** Ends the tasks whose notification block in `text` carries a final status (completed, failed, killed). */
function endedIn(text: string, live: Set<string>): void {
  for (const block of text.matchAll(NOTIFICATION)) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(block[1]!)?.[1]?.trim()
    const status = /<status>([a-z_]+)<\/status>/.exec(block[1]!)?.[1]
    if (id !== undefined && status !== undefined && ENDED_STATUSES.has(status)) live.delete(id)
  }
}

/**
 * Applies one transcript entry to `live`, the set of background task ids a subagent has running. Only the
 * harness's own structure counts, never free text an agent printed or read: a background Bash is answered by a user
 * entry whose `toolUseResult.backgroundTaskId` names the task (or whose tool_result block starts with one of the
 * answers in STARTED: run in the background, moved there by its timeout, or backgrounded by the user), and its end is a `<task-notification>` block with a final
 * `<status>` in a user entry whose origin is `task-notification` or in a `queued_command` attachment, or the answer
 * to the agent's own TaskStop of it (`toolUseResult` `{ message: "Successfully stopped task: <id> ...", task_id }`,
 * which no notification follows). Measured on Claude Code 2.1.296. A task of another kind (a monitor, a background
 * agent) is not recognised.
 */
export function noteTaskEntry(entry: unknown, live: Set<string>): void {
  const e = entry as { type?: unknown; toolUseResult?: { backgroundTaskId?: unknown }; message?: { content?: unknown }; origin?: { kind?: unknown }; attachment?: { type?: unknown; prompt?: unknown } } | null
  if (!e || typeof e !== 'object') return
  if (e.type === 'user') {
    const id = e.toolUseResult?.backgroundTaskId
    if (typeof id === 'string' && TASK_ID.test(id)) live.add(id)
    else for (const s of startedIn(e.message?.content)) live.add(s)
    // The agent's own TaskStop: the answer is the only trace, no notification follows
    const stopped = stoppedBy(e.toolUseResult)
    if (stopped) live.delete(stopped)
    else for (const s of stoppedIn(e.message?.content)) live.delete(s)
    if (e.origin?.kind === 'task-notification') endedIn(contentText(e.message?.content), live)
  } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string') {
    endedIn(e.attachment.prompt, live)
  }
}

/**
 * Applies one row appended to a subagent's conversation (`session.append`: `message`, `origin`) to `live`, by the
 * same structure as a transcript entry: a user row's tool_result block that starts with the background-start
 * answer, and a `queued_command` attachment or a task-notification-origin row holding a notification block.
 */
export function noteAppendedRow(row: { message?: { type?: unknown; name?: unknown; content?: unknown }; origin?: { kind?: unknown } }, live: Set<string>): void {
  const m = row.message
  if (!m || typeof m !== 'object') return
  if (m.type === 'user') {
    for (const s of startedIn(m.content)) live.add(s)
    for (const s of stoppedIn(m.content)) live.delete(s)
  }
  if ((m.type === 'attachment' && m.name === 'queued_command') || row.origin?.kind === 'task-notification') endedIn(contentText(m.content), live)
}

/** The ids of the background tasks a whole transcript (JSONL text) started and has not seen end, oldest first. */
export function liveTasks(text: string): string[] {
  const live = new Set<string>()
  for (const line of text.split('\n')) {
    // Cheap filter first: most lines name no task
    if (!line.includes('background') && !line.includes('task-notification') && !line.includes(STOPPED_PREFIX)) continue
    try {
      noteTaskEntry(JSON.parse(line), live)
    } catch {
      // A torn or foreign line says nothing
    }
  }
  return [...live]
}
