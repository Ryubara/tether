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
