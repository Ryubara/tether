// The plugin's options (`/plugin configure tether@tether`): every scalar setting, as the defaults a project's
// `.claude/tether.json` overrides. One table says which option feeds which field of which section, so the
// manifest (`userConfig` in .claude-plugin/plugin.json), the code and the tests cannot drift apart. Structured
// settings (the poller list, the annotate command, colours, the handoff's required headings, extra exclude
// lines) have no option: they live in the config file only.

/** What kind of value an option holds; the form shows booleans as on/off, numbers and strings as text. */
type Kind = 'boolean' | 'number' | 'string'

/** The config sections an option can feed. */
export type Section = 'checkpoint' | 'fleet' | 'watch' | 'housekeeping' | 'conversations' | 'stop' | 'cacheGuard'

/**
 * One option: its name, the section and field it feeds, how to read it, and what the form shows (title,
 * description, default). `.claude-plugin/plugin.json`'s `userConfig` is generated from this table
 * (`node scripts/sync-options.mjs`), and a test holds every default to the section's own default.
 */
export type Entry = { option: string; section: Section; field: string; kind: Kind; title: string; description: string; default: boolean | number | string }

/** The option that names the config file; it feeds no section. */
export const CONFIG_PATH = {
  option: 'configPath',
  title: 'Config file',
  description: "Path of Tether's JSON config. Empty: .claude/tether.json in the session's folder.",
  default: '',
}

/** Every option, in the order the form shows them. */
export const OPTIONS: Entry[] = [
  { option: 'checkpointEnabled', section: 'checkpoint', field: 'enabled', kind: 'boolean', title: 'Checkpoint on', description: 'Ask for a handoff, check it, clear and continue when the session is long and quiet.', default: false },
  { option: 'checkpointContextTokens', section: 'checkpoint', field: 'contextTokens', kind: 'number', title: 'Checkpoint at this many tokens', description: 'The main session context at which a checkpoint is due.', default: 200_000 },
  { option: 'checkpointQuietSeconds', section: 'checkpoint', field: 'quietSeconds', kind: 'number', title: 'Quiet seconds before a checkpoint', description: 'Seconds with no typing and no new message of yours before the checkpoint acts. A new message of yours re-queues it.', default: 5 },
  { option: 'checkpointTickSeconds', section: 'checkpoint', field: 'tickSeconds', kind: 'number', title: 'Checkpoint check interval (seconds)', description: "Seconds between checks of the session's state.", default: 2 },
  { option: 'checkpointHandoffFile', section: 'checkpoint', field: 'handoffFile', kind: 'string', title: 'Handoff file', description: 'The handoff file, relative to the session folder.', default: 'HANDOFF.md' },
  { option: 'checkpointMaxChars', section: 'checkpoint', field: 'maxChars', kind: 'number', title: 'Handoff size limit (characters)', description: 'The handoff is injected into the next session, so it must stay under this size.', default: 9500 },
  { option: 'checkpointInjectHandoff', section: 'checkpoint', field: 'injectHandoff', kind: 'boolean', title: 'Add the handoff at session start', description: 'When a session starts (new, resumed, cleared or compacted) and the handoff file exists, add its text to the session as context.', default: false },
  { option: 'checkpointMaxRepairs', section: 'checkpoint', field: 'maxRepairs', kind: 'number', title: 'Handoff repair attempts', description: 'Repair attempts before the cycle gives up and the session carries on.', default: 3 },
  { option: 'fleetEnabled', section: 'fleet', field: 'enabled', kind: 'boolean', title: 'Fleet on', description: 'The agents pane, the status line and the SendMessage guard.', default: true },
  { option: 'fleetCacheTtlMinutes', section: 'fleet', field: 'cacheTtlMinutes', kind: 'number', title: 'Agent cache lifetime (minutes)', description: "How long the prompt cache is taken to live after an agent's last request (5, or 60 with subagentPromptCacheTtl 1h). It is also the idle time from which waking an undecided big agent is refused, so a lower value adds a safety margin before the real expiry.", default: 60 },
  { option: 'fleetBigContextTokens', section: 'fleet', field: 'bigContextTokens', kind: 'number', title: 'Big agent context (tokens)', description: 'Context size from which an agent is guarded: the agent guard acts on it before its cache expires, and a wake-up is refused once its cache has expired.', default: 60_000 },
  { option: 'fleetRetireContextTokens', section: 'fleet', field: 'retireContextTokens', kind: 'number', title: 'Retire agent at (tokens)', description: 'Context size at which an agent is flagged for retirement.', default: 300_000 },
  { option: 'fleetBigWaitTokens', section: 'fleet', field: 'bigWaitTokens', kind: 'number', title: 'BIG-WAIT at (tokens)', description: 'An agent with at least this context and a matching note (see the note pattern) is flagged BIG-WAIT. 0: off.', default: 0 },
  { option: 'fleetBigWaitNote', section: 'fleet', field: 'bigWaitNote', kind: 'string', title: 'BIG-WAIT note pattern', description: "A regular expression matched case-insensitively against the agent's annotation note. Empty: any note.", default: '' },
  { option: 'fleetColdGuard', section: 'fleet', field: 'coldGuard', kind: 'boolean', title: 'Cold-cache guard', description: 'Refuse SendMessage to an agent with a recorded decision, and to an undecided big agent whose cache has expired, unless the message starts with the override token.', default: true },
  { option: 'fleetOverrideToken', section: 'fleet', field: 'overrideToken', kind: 'string', title: 'Cold-cache override token', description: 'The text a message starts with to pass the cold-cache guard on purpose.', default: '[cache-ok]' },
  { option: 'fleetShowSession', section: 'fleet', field: 'showSession', kind: 'boolean', title: 'Show session context', description: 'Also show the main session context and the tightest rate limit in the status line.', default: false },
  { option: 'fleetUsageWarnPercent', section: 'fleet', field: 'usageWarnPercent', kind: 'number', title: 'Rate limit warning (percent)', description: 'A rate limit at or above this percent gets a !. Only shown with Show session context.', default: 90 },
  { option: 'fleetRefreshSeconds', section: 'fleet', field: 'refreshSeconds', kind: 'number', title: 'Fleet refresh (seconds)', description: 'Seconds between refreshes of the agent list, usage and annotations.', default: 15 },
  { option: 'fleetCacheWarnMinutes', section: 'fleet', field: 'cacheWarnMinutes', kind: 'number', title: 'Cache warning (minutes left)', description: 'Cache minutes left at or under which the cache cell turns to the warning colour.', default: 15 },
  { option: 'fleetEmoji', section: 'fleet', field: 'emoji', kind: 'boolean', title: 'Emoji in the pane', description: 'An emoji per state and flag in the pane and /tether-fleet text; off for plain text.', default: true },
  { option: 'fleetColumnTint', section: 'fleet', field: 'columnTint', kind: 'string', title: 'Column tint', description: 'true bands alternate columns with the theme colour, false divides columns with a bar, or give a colour. Empty: true.', default: '' },
  { option: 'fleetWatchState', section: 'fleet', field: 'watchState', kind: 'string', title: 'Watch state file shown in the pane', description: 'A state file watch writes; when set the pane draws watch boxes under the table. Empty: none.', default: '' },
  { option: 'watchEnabled', section: 'watch', field: 'enabled', kind: 'boolean', title: 'Watch on', description: 'The pollers and the findings they wake the model for.', default: true },
  { option: 'watchMinWakeGapSeconds', section: 'watch', field: 'minWakeGapSeconds', kind: 'number', title: 'Seconds between wakes', description: 'At least this long between two wakes; findings in between join the next one.', default: 60 },
  { option: 'watchDeferWhileTypingMinutes', section: 'watch', field: 'deferWhileTypingMinutes', kind: 'number', title: 'Defer wake while typing (minutes)', description: 'While you have a draft, a wake waits up to this long, then goes anyway.', default: 10 },
  { option: 'watchTickSeconds', section: 'watch', field: 'tickSeconds', kind: 'number', title: 'Countdown redraw (seconds)', description: 'Seconds between redraws of the countdowns; 0 turns the live countdown off.', default: 1 },
  { option: 'watchBoxRows', section: 'watch', field: 'boxRows', kind: 'number', title: 'Log lines per poller box', description: 'Log lines each poller box shows.', default: 6 },
  { option: 'watchWakePreamble', section: 'watch', field: 'wakePreamble', kind: 'string', title: 'Wake message first line', description: 'The first line of the wake prompt.', default: 'watch found something new. Handle it or say why it can wait:' },
  { option: 'watchStoreName', section: 'watch', field: 'storeName', kind: 'string', title: 'Watch store name', description: 'Names this project seen-set in the store, so two projects keep their own.', default: 'default' },
  { option: 'watchStateFile', section: 'watch', field: 'stateFile', kind: 'string', title: 'Watch state file', description: 'A file watch writes the boxes data to, for fleet to draw. Empty: none.', default: '' },
  { option: 'housekeepingEnabled', section: 'housekeeping', field: 'enabled', kind: 'boolean', title: 'Housekeeping on', description: 'Tether folder, exclude lines, handoff template and handoff checks.', default: true },
  { option: 'housekeepingFolder', section: 'housekeeping', field: 'folder', kind: 'string', title: 'Tether folder', description: 'Tether folder in the project (conversation logs live in its conversations folder).', default: '.tether' },
  { option: 'housekeepingCreateHandoff', section: 'housekeeping', field: 'createHandoff', kind: 'boolean', title: 'Create a missing handoff', description: 'Create the handoff from the template when it is missing.', default: true },
  { option: 'housekeepingEnforceHandoff', section: 'housekeeping', field: 'enforceHandoff', kind: 'boolean', title: 'Enforce the handoff template', description: 'Refuse a Write of the handoff that fails its check; report an Edit that leaves it failing.', default: true },
  { option: 'conversationsEnabled', section: 'conversations', field: 'enabled', kind: 'boolean', title: 'Conversation logs on', description: 'Write each session to a log under the Tether folder.', default: true },
  { option: 'conversationsMinSeconds', section: 'conversations', field: 'minSeconds', kind: 'number', title: 'Seconds between log writes', description: 'Seconds between log writes while turns complete; a log is always written before a clear.', default: 30 },
  { option: 'cacheGuardAuto', section: 'cacheGuard', field: 'auto', kind: 'boolean', title: 'Agent guard acts by itself', description: "Before a stopped agent with live background work loses its prompt cache, Tether messages it (keep waiting, or hand over) and stops the leftover background tasks after a handover. Off: it only blocks the end of a turn and asks the model.", default: true },
  { option: 'cacheGuardLeadMinutes', section: 'cacheGuard', field: 'leadMinutes', kind: 'number', title: 'Agent guard lead (minutes)', description: 'Act this many minutes before the cache expires (at most half the cache lifetime).', default: 20 },
  { option: 'cacheGuardHandoverTokens', section: 'cacheGuard', field: 'handoverTokens', kind: 'number', title: 'Hand over at (tokens)', description: 'A stopped agent with live background work and at least this context is asked to hand over and is then stopped; a smaller one is kept warm, if it runs on the session model (else it is handed over too).', default: 250_000 },
  { option: 'cacheGuardHandoverWaitMinutes', section: 'cacheGuard', field: 'handoverWaitMinutes', kind: 'number', title: 'Handover wait (minutes)', description: 'Minutes an agent gets to finish its handover (at most half the lead); later the coordinator is alerted. The agent is never stopped silently.', default: 10 },
  { option: 'cacheGuardKeepWarmMax', section: 'cacheGuard', field: 'keepWarmMax', kind: 'number', title: 'Keep-warm limit', description: 'Keep-warm messages to one agent in a row (real work between two starts a new run) before the coordinator is asked to decide.', default: 12 },
  { option: 'cacheGuardKeepWarmText', section: 'cacheGuard', field: 'keepWarmText', kind: 'string', title: 'Keep-warm message', description: 'The message that keeps a waiting agent warm.', default: "Tether cache guard: keep waiting, no action needed. Reply with one word, then wait as before." },
  { option: 'cacheGuardHandoverText', section: 'cacheGuard', field: 'handoverText', kind: 'string', title: 'Handover message', description: 'The message that asks an agent to hand over and stop.', default: "Tether cache guard: hand over now. Commit your work, update STATUS.md (tip, done, left, running background jobs and their logs or result files, the next exact command), then stop. Do not start new work." },
  { option: 'stopEnabled', section: 'stop', field: 'enabled', kind: 'boolean', title: 'Stop guard on', description: 'Block the end of a turn while PR problems or stopped agents nobody has dealt with are known.', default: true },
  { option: 'stopMaxBlocks', section: 'stop', field: 'maxBlocks', kind: 'number', title: 'Stop guard block limit', description: 'The same block this many times in a row, then let the turn end.', default: 3 },
]

/** The pane size options, which feed a nested `pane` object (fleet and watch each have one); 0 means not set. */
export const PANES: Array<Omit<Entry, 'section' | 'kind'> & { section: 'fleet' | 'watch'; field: 'rows' | 'columns' }> = [
  { option: 'fleetPaneRows', section: 'fleet', field: 'rows', title: 'Fleet pane rows', description: 'Rows asked for the pane when inline above the prompt. 0: Claude Code decides.', default: 0 },
  { option: 'fleetPaneColumns', section: 'fleet', field: 'columns', title: 'Fleet pane columns', description: 'Columns asked for the pane when docked beside a fullscreen transcript. 0: Claude Code decides.', default: 0 },
  { option: 'watchPaneRows', section: 'watch', field: 'rows', title: 'Watch pane rows', description: 'Rows asked for the pane when inline above the prompt. 0: Claude Code decides.', default: 0 },
  { option: 'watchPaneColumns', section: 'watch', field: 'columns', title: 'Watch pane columns', description: 'Columns asked for the pane when docked beside a fullscreen transcript. 0: Claude Code decides.', default: 0 },
]

/** `fleet.columnTint` takes true, false or a colour; the form holds text, so "true" and "false" are read as booleans. */
function tint(v: string): boolean | string {
  return v === 'true' ? true : v === 'false' ? false : v
}

/**
 * The raw settings one section takes from the options. Only well-typed, non-empty values are kept (an empty
 * string or a zero means "not set"), so the section's own defaults and validation still decide; the project's file
 * is spread over this, so the file wins.
 */
export function fromOptions(options: Record<string, unknown>, section: Section): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of OPTIONS) {
    if (e.section !== section) continue
    const v = options[e.option]
    if (e.kind === 'boolean' && typeof v === 'boolean') out[e.field] = v
    else if (e.kind === 'number' && typeof v === 'number' && Number.isFinite(v) && (v > 0 || (v === 0 && e.option === 'watchTickSeconds'))) out[e.field] = v
    else if (e.kind === 'string' && typeof v === 'string' && v.trim() !== '') out[e.field] = e.option === 'fleetColumnTint' ? tint(v.trim()) : v
  }
  if (section === 'fleet' || section === 'watch') {
    const pane: Record<string, number> = {}
    for (const p of PANES) {
      const v = options[p.option]
      if (p.section === section && typeof v === 'number' && Number.isInteger(v) && v > 0) pane[p.field] = v
    }
    if (Object.keys(pane).length > 0) out.pane = pane
  }
  return out
}

/**
 * A section's raw settings: the options as defaults, the project file's section over them (a field the file
 * names replaces the option's; a `pane` the file names replaces the option's whole). A file section that is not a
 * plain object is ignored.
 */
export function layered(options: Record<string, unknown>, section: Section, file: unknown): Record<string, unknown> {
  const own = file !== null && typeof file === 'object' && !Array.isArray(file) ? (file as Record<string, unknown>) : {}
  return { ...fromOptions(options, section), ...own }
}
