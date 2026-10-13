// The poller boxes: one per poller, side by side, each a title with a live countdown and the log of
// what it found. watch draws them in its own pane and writes the data to a state file; fleet reads
// that file and draws the same boxes under its table. This file is the same in both plugins (a plugin
// cannot import another's code), so change both together.

/** One finding in a poller's log. */
export type LogLine = { at: number; text: string }

/** What a box shows of one poller: written by watch, read by watch's pane and by fleet. */
export type BoxState = {
  id: string
  title: string
  everySeconds: number
  /** When the next run starts (epoch ms); absent while the poller is running or has not started. */
  nextAt?: number
  running: boolean
  /** False when the last run failed (`error` says why). */
  ok: boolean
  error?: string
  /** Log lines the box shows: its height is this plus the title row. */
  rows: number
  /** Findings, oldest first. */
  log: LogLine[]
}

/** The state file's content. */
export type WatchState = { version: 1; updatedAt: number; pollers: BoxState[] }

/** Reads a state file's text; undefined when it is not one. */
export function parseState(text: string): WatchState | undefined {
  try {
    const v = JSON.parse(text) as WatchState
    return v && v.version === 1 && Array.isArray(v.pollers) ? v : undefined
  } catch {
    return undefined
  }
}

/** Milliseconds as `M:SS` (`H:MM:SS` from an hour), never negative. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** A box's countdown text: `next in 3:12`, `running…`, with `failed ·` in front after a failed run. */
export function countdownText(b: BoxState, now: number): string {
  const when = b.running ? 'running…' : b.nextAt === undefined ? 'starting…' : `next in ${clockText(b.nextAt - now)}`
  return b.ok ? when : `failed · ${when}`
}

/** `HH:MM` in the person's local time. */
export function stamp(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The log lines a box shows: the newest `rows`, oldest first, padded with blanks so every box is as tall as asked. */
export function boxLines(b: BoxState): string[] {
  const shown = b.log.slice(-b.rows).map(l => `${stamp(l.at)} ${l.text}`)
  if (shown.length === 0 && b.rows > 0) shown.push(b.ok ? 'nothing found yet' : (b.error ?? 'failed'))
  while (shown.length < b.rows) shown.push(' ')
  return shown
}

/**
 * The boxes as a tree: a rule across, then the boxes side by side split by a vertical rule. `columns`
 * is the room across (the pane's body); each box gets an equal share, and a long line is cut to it.
 */
export function Boxes(ui: { Box: any; Text: any }, state: WatchState, now: number, columns: number): any {
  const { Box, Text } = ui
  const n = state.pollers.length
  if (n === 0) return null
  const gap = 3
  const width = Math.max(10, Math.floor((columns - (n - 1) * gap) / n))
  const height = Math.max(...state.pollers.map(p => p.rows)) + 1
  const sep = Array.from({ length: height }, () => ' │ ')
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(Math.max(1, columns))}
      </Text>
      <Box flexDirection="row">
        {state.pollers.map((p, i) => (
          <Box flexDirection="row">
            {i > 0 && (
              <Box flexDirection="column" width={gap}>
                {sep.map(s => (
                  <Text dimColor>{s}</Text>
                ))}
              </Box>
            )}
            <Box flexDirection="column" width={width}>
              <Text bold color={p.ok ? undefined : 'red'} wrap="truncate-end">
                {`${p.title}  ${countdownText(p, now)}`}
              </Text>
              {boxLines(p).map(l => (
                <Text wrap="truncate-end">{l}</Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
