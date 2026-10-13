// Tether: the agents pane, the pollers and the guards, as one hooks module (a plugin names exactly one, and
// `$` is followed only within the file it is passed in, so every part that touches `$` lives here).
//
// The file has two parts, FLEET and WATCH, each registering its own events; an event both use (session
// start, a turn step, a turn complete) is registered once at the bottom and runs each part's handler in
// turn. State lives in module variables on purpose: they survive /clear.

import type { Register } from 'claude-code'
import { DEFAULTS, mergeConfig, type FleetConfig } from '../src/fleet/config'
import { coldGuard } from '../src/fleet/guard'
import { recordStep, type Ledger } from '../src/fleet/ledger'
import { buildRows, summary, tokens, type AgentLike, type RateLimit, type Row } from '../src/fleet/rows'
import { lastRequest, metaDescription, subagentsDir } from '../src/fleet/transcript'
import { Boxes, parseState, type WatchState } from '../src/fleet/boxes'
import { headerCells, legend, rowCells, rowText } from '../src/fleet/cells'
import { DEFAULTS as WATCH_DEFAULTS, parseConfig, type CommandPoller, type Poller, type WatchConfig } from '../src/watch/config'
import { Boxes as WatchBoxes, clockText, type BoxState, type LogLine, type WatchState as WatchStateData } from '../src/watch/boxes'
import { agentFindings, fresh, readOutput, wakeText, wakeVerdict, type AgentSeen, type Finding, type Pending, type Seen } from '../src/watch/findings'

// ---- FLEET ----
// fleet: see the session's agents and what they cost, and refuse waking a big agent on a cold cache.
//
// The hooks only wire Claude Code's events to the pure functions in ../src, which the tests cover.
// State lives in module variables on purpose: they survive /clear (which resets $.state), and a
// reload of the module starts them over, which a refresh then fills in again.



const PANE = 'fleet'
/** The config file when the `configPath` option is empty, relative to the session's working directory. */
const CONFIG_FILE = '.claude/tether.json'
/** The config file in use: the `configPath` option, else CONFIG_FILE. */
let configFile = CONFIG_FILE

let cfg: FleetConfig = DEFAULTS
const ledger: Ledger = new Map()
let agents: AgentLike[] = []
let notes: Record<string, string> = {}
/** When each subagent's last turn completed, from turn.complete. */
const finished = new Map<string, number>()
/** Agent names from Agent calls, to their ids. */
const names = new Map<string, string>()
let limits: RateLimit[] = []
let coldToday = 0
let timers: Array<{ cancel: () => void }> = []
/** What watch last wrote to its state file (`watchState`), and that file's mtime when read. */
let watchBoxes: WatchState | undefined
let watchMtime = 0

/** Re-reads watch's state file when it changed; a missing or unreadable file only hides the boxes. */
async function loadWatchState($: any): Promise<void> {
  if (!cfg.watchState) return
  try {
    const mtime = (await $.fs.stat(cfg.watchState)).mtimeMs
    if (mtime === watchMtime) return
    watchMtime = mtime
    watchBoxes = parseState(await $.fs.read(cfg.watchState))
  } catch {
    watchBoxes = undefined
  }
}

/** One countdown tick: pick up watch's latest state and redraw the pane while one is placed. */
async function tickBoxes($: any): Promise<void> {
  await loadWatchState($)
  try {
    if (watchBoxes && (await $.ui.panes()).some((p: any) => p.id === PANE && p.isPlaced)) $.ui.invalidate('ui.render')
  } catch {}
}

/** The day key for the cold-write tally in $.store, in UTC so every session agrees. */
function dayKey(now: number): string {
  return 'cold:' + new Date(now).toISOString().slice(0, 10)
}

/** The status line is one line for the whole plugin: each part's text, joined. */
let fleetStatus: string | undefined
let watchStatus: string | undefined
function showStatus($: any): void {
  $.ui.status([fleetStatus, watchStatus].filter(Boolean).join('  |  ') || undefined)
}

/** Reads Tether's config file (one file, a section per part); undefined when it is missing or unreadable. */
let rootCache: { root?: Record<string, unknown>; problem?: string } | undefined
async function readTetherConfig($: any, reuse = false): Promise<{ root?: Record<string, unknown>; problem?: string }> {
  if (reuse && rootCache) return rootCache
  rootCache = await readTetherFile($)
  return rootCache
}
async function readTetherFile($: any): Promise<{ root?: Record<string, unknown>; problem?: string }> {
  try {
    if (!(await $.fs.exists(configFile))) {
      // A missing file is normal for the default path, but a configured one should exist
      return configFile === CONFIG_FILE ? {} : { problem: `${configFile} not found` }
    }
    const root = JSON.parse(await $.fs.read(configFile))
    return root && typeof root === 'object' ? { root } : { problem: `${configFile} is not an object` }
  } catch (err) {
    return { problem: `${configFile} not used: ${err}` }
  }
}

/** Reads the fleet section of the config, falling back to the defaults on any problem. */
async function loadConfig($: any): Promise<FleetConfig> {
  const { root, problem } = await readTetherConfig($)
  if (problem) $.ui.log(`fleet: ${problem}; using the defaults`)
  return root ? mergeConfig(root.fleet ?? {}) : DEFAULTS
}

/** Re-reads the agent list and usage, then updates the status line and the pane. */
async function refresh($: any): Promise<void> {
  try {
    agents = (await $.agent.list()) as AgentLike[]
  } catch {}
  try {
    if (cfg.showSession) limits = ((await $.session.usage())?.rateLimits ?? []) as RateLimit[]
  } catch {}
  await noteProjectDir($)
  await backfill($)
  const now = await $.clock.now()
  fleetStatus = summary(currentRows(now), ledger.get('main')?.contextTokens, limits, coldToday, cfg)
  showStatus($)
  $.ui.invalidate('ui.render')
}

/** The project's transcript folder (one sub-folder per session; a /clear starts a new one). */
let projectDir: string | undefined
/** Per agent: the transcript's mtime last read, so an unchanged file is not read again. */
const transcriptRead = new Map<string, number>()
/** Per agent: the Agent call's description from a .meta.json (a resumed agent lists as "(resumed)"). */
const descriptions = new Map<string, string>()
/** Per agent: the transcript files found for it (a resumed agent has one per session), and when looked. */
const found = new Map<string, { at: number; bases: string[] }>()

/** Notes the project's transcript folder from the session's config folder and cwd. */
async function noteProjectDir($: any): Promise<void> {
  if (projectDir) return
  try {
    const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.claude`
    projectDir = subagentsDir(home, await $.session.cwd(), '').replace(/\/+subagents$/, '').replace(/\/+$/, '')
  } catch {}
}

/** The transcript bases (`<dir>/agent-<id>`) of an agent, newest first; looked up again at most every 5 min. */
async function transcriptsOf($: any, id: string, now: number): Promise<string[]> {
  const known = found.get(id)
  if (known && (known.bases.length > 0 || now - known.at < 5 * 60_000)) return known.bases
  const bases: Array<{ base: string; mtime: number }> = []
  try {
    const sessions = ((await $.fs.list(projectDir)) as Array<{ name: string; kind: string }>).filter(d => d.kind === 'dir')
    for (const s of sessions) {
      const base = `${projectDir}/${s.name}/subagents/agent-${id}`
      if (await $.fs.exists(base + '.jsonl')) bases.push({ base, mtime: (await $.fs.stat(base + '.jsonl')).mtimeMs })
    }
  } catch {}
  const sorted = bases.sort((x, y) => y.mtime - x.mtime).map(b => b.base)
  found.set(id, { at: now, bases: sorted })
  return sorted
}

/**
 * Fills in what fleet did not see itself, from Claude Code's transcript files: the last request
 * (time and context) of an agent with no ledger entry, and the description of a resumed agent,
 * which only the session that first started it recorded.
 */
async function backfill($: any): Promise<void> {
  if (!projectDir) return
  const now = await $.clock.now()
  for (const a of agents) {
    const needsUsage = !ledger.has(a.id) || ledger.get(a.id)!.steps === 0
    const needsName = !descriptions.has(a.id) && (!a.description || a.description === '(resumed)')
    if (!needsUsage && !needsName) continue
    const bases = await transcriptsOf($, a.id, now)
    try {
      if (needsName) {
        for (const base of bases) {
          const d = (await $.fs.exists(base + '.meta.json')) ? metaDescription(await $.fs.read(base + '.meta.json')) : undefined
          if (d) {
            descriptions.set(a.id, d)
            break
          }
        }
      }
      if (needsUsage && bases.length > 0) {
        const st = await $.fs.stat(bases[0] + '.jsonl')
        if (transcriptRead.get(a.id) === st.mtimeMs) continue
        transcriptRead.set(a.id, st.mtimeMs)
        // The newest file with a request: a resumed agent's newest copy may hold none yet
        for (const base of bases) {
          const last = lastRequest(await $.fs.read(base + '.jsonl'))
          // steps 0 marks an entry read from the transcript; the next real request replaces it
          if (last) {
            ledger.set(a.id, { id: a.id, lastStepAt: last.at, contextTokens: last.contextTokens, cacheWritten: 0, coldWritten: 0, steps: 0 })
            break
          }
        }
      }
    } catch {
      // A transcript fleet cannot read only leaves the row's numbers blank
    }
  }
}

/** True while an annotate run is in flight, so a slow adapter never runs twice at once. */
let annotating = false
/** The last annotate failure logged, so a broken adapter is reported once, not every minute. */
let lastAnnotateError = ''

/** Runs the configured annotate command and keeps its JSON object of notes. */
async function annotate($: any): Promise<void> {
  if (!cfg.annotate || annotating) return
  annotating = true
  try {
    const r = await $.process.run(cfg.annotate.command, { timeoutMs: cfg.annotate.timeoutMs ?? 30_000 })
    const parsed = JSON.parse(r.stdout)
    if (parsed && typeof parsed === 'object') notes = parsed as Record<string, string>
  } catch (err) {
    // A failing adapter only loses its notes; fleet works without them. Say so once per new reason.
    const why = String(err)
    if (why !== lastAnnotateError) $.ui.log(`fleet: annotate command failed: ${why}`)
    lastAnnotateError = why
  } finally {
    annotating = false
  }
}

/** The rows for the current agents, each named by its Agent call's `name` when the list lacks one. */
function currentRows(now: number): Row[] {
  const byId = new Map([...names].map(([name, id]) => [id, name]))
  const named = agents.map(a => ({
    ...a,
    ...(!a.name && byId.has(a.id) ? { name: byId.get(a.id) } : {}),
    ...(descriptions.has(a.id) && (!a.description || a.description === '(resumed)') ? { description: descriptions.get(a.id) } : {}),
  }))
    .map(a => {
      // The list can say running for a while after an agent's last turn ended; trust that end after 30 s
      const end = finished.get(a.id)
      const stale = a.status === 'running' && end !== undefined && end >= (ledger.get(a.id)?.lastStepAt ?? 0) && now - end >= 30_000
      return stale ? { ...a, status: 'completed' } : a
    })
  return buildRows(named, ledger, notes, now, cfg)
}

const fleetStart = async ($: any, e: any, next: any): Promise<any> => {
  cfg = await loadConfig($)
  const now = await $.clock.now()
  coldToday = Number((await $.store.get(dayKey(now))) ?? 0)
  for (const t of timers) t.cancel()
  timers = cfg.enabled ? [$.clock.every(cfg.refreshSeconds * 1000, () => refresh($)) as any] : []
  // watch's boxes count down by the second, so the pane redraws that often while they exist
  if (cfg.enabled && cfg.watchState) timers.push($.clock.every(1000, () => tickBoxes($)) as any)
  if (cfg.enabled && cfg.annotate) {
    timers.push($.clock.every(cfg.annotate.everySeconds * 1000, () => annotate($)) as any)
    // The first notes come soon after start rather than a whole interval later
    timers.push($.clock.after(1000, () => annotate($).then(() => refresh($))) as any)
  }
  try {
    await $.command.register({ name: 'fleet', description: 'Agents, context, cache and usage (fleet)', argumentHint: '[text]', immediate: true })
  } catch {}
  return next(e)
}

const fleetComplete = async ($: any, e: any, next: any): Promise<any> => {
  const r = await next(e)
  const id = (e as any).agentId
  if (typeof id === 'string') finished.set(id, await $.clock.now())
  return r
}

async function* fleetStep($: any, e: any, next: any): any {
  const result: any = yield* next(e)
  if (result?.usage) {
    const now = await $.clock.now()
    const id = (e as any).agentId ?? 'main'
    const v = recordStep(ledger, id, now, result.usage, cfg.cacheTtlMinutes, cfg.bigContextTokens)
    if (v.isColdWake && cfg.enabled) {
      coldToday += v.written
      void $.store.set(dayKey(now), coldToday)
      const who = agents.find(a => a.id === id)
      const text = `${who?.name ?? who?.description ?? id} woke after ${Math.round(v.idleMinutes)} min and re-wrote ${tokens(v.written)} cache tokens`
      $.ui.toast(text)
      $.ui.log('fleet: ' + text)
    }
  }
  return result
}

const registerFleet: Register = (on, options) => {
  const path = (options as { configPath?: unknown } | undefined)?.configPath
  configFile = typeof path === 'string' && path.trim() !== '' ? path.trim() : CONFIG_FILE


  // Every model request, main loop and subagents alike: keep the ledger, and flag a cold re-write.

  // Waking a big agent on an expired cache: refuse, with the numbers and the way to insist.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const deny = coldGuard(e as any, agents, ledger, await $.clock.now(), cfg, names)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  // Remember the name an Agent call gives, since SendMessage addresses agents by it.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const r: any = await next(e)
    const id = r?.result?.agentId ?? r?.result?.agent_id
    const name = (e as any).name
    if (typeof name === 'string' && typeof id === 'string') names.set(name, id)
    return r
  })

  // A subagent's turn ended: note when, for an agent the list keeps calling running.

  // A spawned agent shows at once, not at the next refresh.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
    return r
  })

  // `/fleet` opens the pane; `/fleet text` answers in the transcript (also what headless sessions get).
  on('command.run', { command: 'fleet' }, async ($, e) => {
    await refresh($)
    const wantsText = (e as any).args?.trim() === 'text'
    let placed = false
    if (!wantsText) {
      try {
        placed = Boolean((await $.ui.open({ id: PANE, title: 'Fleet', focus: true, closeOnEscape: true, ...cfg.pane }))?.isPlaced)
      } catch {}
    }
    // Where no pane can show (headless, or asked for text), answer in the transcript instead.
    if (wantsText || !placed) {
      const now = await $.clock.now()
      const rows = currentRows(now)
      return { text: [summary(rows, ledger.get('main')?.contextTokens, limits, coldToday, cfg), ...(rows.length ? [headerCells(cfg).map(c => c.text).join('').trimEnd()] : []), ...rows.map(r => rowText(r, cfg))].join('\n') }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const rows = currentRows(now)
    const head = summary(rows, ledger.get('main')?.contextTokens, limits, coldToday, cfg)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={cfg.enabled ? 'green' : undefined} dimColor={!cfg.enabled}>{`${cfg.enabled ? (cfg.emoji ? '✅' : '✓') : cfg.emoji ? '❌' : '✗'} Fleet`}</Text>
          <Text>{'   '}</Text>
          <Text color={wcfg.enabled ? 'green' : undefined} dimColor={!wcfg.enabled}>{`${wcfg.enabled ? (cfg.emoji ? '✅' : '✓') : cfg.emoji ? '❌' : '✗'} Watch`}</Text>
        </Text>
        <Text bold wrap="truncate-end">
          {cfg.enabled ? head : 'Fleet is off (fleet.enabled is false in the config).'}
        </Text>
        {rows.length === 0 && (
          <Text dimColor>
            No agents in this session yet.
          </Text>
        )}
        {rows.length > 0 && (
          <Text wrap="truncate-end">
            {headerCells(cfg).map(c => (
              <Text dimColor backgroundColor={c.bg}>{c.text}</Text>
            ))}
          </Text>
        )}
        {rows.map(r => (
          <Text wrap="truncate-end">
            {rowCells(r, cfg).map(c => (
              <Text color={c.color} dimColor={c.dim} backgroundColor={c.bg}>
                {c.text}
              </Text>
            ))}
          </Text>
        ))}
        {legend(rows, cfg) !== undefined && (
          <Text dimColor wrap="truncate-end">
            {legend(rows, cfg)}
          </Text>
        )}
        {watchBoxes && Boxes($.ui.resolve(e), watchBoxes, now, (e as any).props?.bodyColumns ?? 80)}
      </Box>
    )
  })
}


// ---- WATCH ----
// watch: run a project's pollers inside the session and wake the model only for what is new.
//
// The hooks only wire Claude Code's events to the pure functions in ../src, which the tests cover.
// Timers and module variables survive /clear; the seen-set and the findings not yet told live in
// $.store, so a reload or a restart neither repeats a finding nor loses one.



/** The config file when the `configPath` option is empty, relative to the session's working directory. */
const WATCH_CONFIG_FILE = CONFIG_FILE
/** How often watch checks whether pending findings can be delivered. */
const DELIVER_MS = 5_000
/** The pane's id (`/watch pane`). */
const WATCH_PANE = 'watch'
/** Log lines kept per poller (the box shows the newest few). */
const LOG_KEEP = 50

/** What the last run of a poller came to, for /watch and the status line. */
type LastRun = { at: number; ok: boolean; found: number; told: number; error?: string }

let watchConfigFile = WATCH_CONFIG_FILE
let wcfg: WatchConfig = WATCH_DEFAULTS
let problems: string[] = []
let watchTimers: Array<{ cancel: () => void }> = []
/** Pollers with a run in flight: a slow command never runs twice at once. */
const running = new Set<string>()
const lastRun = new Map<string, LastRun>()
/** Whether a main-loop turn is running. */
let busy = false
let lastWakeAt = -Infinity
/** True while a delivery is deciding or submitting, so two ticks cannot send the same findings. */
let delivering = false
/** Subagents' last model request and context, from turn.step. */
const steps = new Map<string, { at: number; context: number }>()
/** When watch first saw each agent, for one that has made no request yet. */
const firstSeen = new Map<string, number>()

/** When each poller's next timed run starts (epoch ms), for the countdown. */
const nextAt = new Map<string, number>()
/** Each poller's findings log, oldest first; kept in $.store so a reload keeps it. */
let logs: Record<string, LogLine[]> = {}
/** How many findings wait to be told, cached so the countdown tick need not read $.store. */
let pendingCount = 0
/** The last state-file failure logged, so a bad path is reported once. */
let stateError = ''

/** The $.store keys of this config's seen-set and pending findings. */
const seenKey = () => `seen:${wcfg.storeName}`
const pendingKey = () => `pending:${wcfg.storeName}`
const logKey = () => `log:${wcfg.storeName}`

/** Reads and parses the config file; problems are logged once per load. */
async function loadWatchConfig($: any, watchReuse = false): Promise<void> {
  const { root, problem } = await readTetherConfig($, watchReuse)
  if (problem) {
    wcfg = WATCH_DEFAULTS
    problems = [problem]
  } else if (!root) {
    wcfg = WATCH_DEFAULTS
    problems = []
  } else {
    const parsed = parseConfig(root.watch ?? {})
    wcfg = parsed.config
    problems = parsed.problems
  }
  for (const p of problems) $.ui.log(`watch: ${p}`)
  const saved = await $.store.get(logKey())
  logs = saved && typeof saved === 'object' ? (saved as Record<string, LogLine[]>) : {}
}

/** The findings not yet told, from $.store. */
async function getPending($: any): Promise<Pending[]> {
  const v = await $.store.get(pendingKey())
  const list = Array.isArray(v) ? (v as Pending[]) : []
  pendingCount = list.length
  return list
}

/** Runs one command poller and returns its findings, or an error. */
async function runCommand($: any, p: CommandPoller): Promise<{ findings?: Finding[]; error?: string }> {
  try {
    const r = await $.process.run(p.command, { timeoutMs: p.timeoutMs, ...(p.cwd ? { cwd: p.cwd } : {}) })
    const out = readOutput(p, r)
    return out.ok ? { findings: out.findings } : { error: out.error }
  } catch (err) {
    return { error: String(err) }
  }
}

/** The session's subagents with what their requests showed, for the agents poller. */
async function agentsSeen($: any, now: number): Promise<AgentSeen[]> {
  const list = ((await $.agent.list()) ?? []) as Array<{ id: string; status: string; name?: string; description?: string; type?: string }>
  return list.map(a => {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, now)
    const s = steps.get(a.id)
    return {
      id: a.id,
      status: a.status,
      label: a.name ?? a.description ?? a.type ?? a.id,
      lastStepAt: s?.at ?? firstSeen.get(a.id)!,
      ...(s ? { contextTokens: s.context } : {}),
    }
  })
}

/** Runs one poller, keeps what is new, toasts it, and tries to deliver. */
async function poll($: any, p: Poller, thenDeliver = true): Promise<void> {
  if (running.has(p.id)) return
  running.add(p.id)
  await publish($)
  try {
    let result: { findings?: Finding[]; error?: string }
    if (p.kind === 'agents') {
      try {
        result = { findings: agentFindings(p, await agentsSeen($, await $.clock.now()), await $.clock.now()) }
      } catch (err) {
        result = { error: String(err) }
      }
    } else {
      result = await runCommand($, p)
    }
    const now = await $.clock.now()
    if (!result.findings) {
      // Say a failure once per new reason; the status line keeps showing it
      const before = lastRun.get(p.id)
      if (before?.error !== result.error) $.ui.log(`watch: ${p.id} failed: ${result.error}`)
      lastRun.set(p.id, { at: now, ok: false, found: 0, told: 0, error: result.error ?? 'failed' })
      return
    }
    const seen = ((await $.store.get(seenKey())) ?? {}) as Seen
    const next = fresh(seen, p, result.findings, now)
    await $.store.set(seenKey(), next.seen)
    lastRun.set(p.id, { at: now, ok: true, found: result.findings.length, told: next.fresh.length })
    if (next.fresh.length > 0) {
      await addLog($, p.id, now, next.fresh.map(f => f.text))
      $.ui.toast(`watch: ${next.fresh.length} new from ${p.title}`)
      if (p.wake) {
        const add = next.fresh.map(f => ({ ...f, poller: p.id, title: p.title, wake: true, at: now }))
        await $.store.set(pendingKey(), [...(await getPending($)), ...add])
      } else {
        for (const f of next.fresh) $.ui.log(`watch: ${p.title}: ${f.text}`)
      }
    }
  } finally {
    running.delete(p.id)
    await status($)
    await publish($)
  }
  if (thenDeliver) await deliver($)
}

/** Starts a turn for the pending findings when the session is idle, nobody is typing and the gap has passed. */
async function deliver($: any): Promise<void> {
  if (delivering) return
  delivering = true
  try {
    await deliverOnce($)
  } finally {
    delivering = false
  }
}

/** One delivery attempt; deliver() keeps two from overlapping. */
async function deliverOnce($: any): Promise<void> {
  const pending = await getPending($)
  if (pending.length === 0) return
  const now = await $.clock.now()
  const draft = busy ? '' : ((await $.prompt.read())?.text ?? '')
  const verdict = wakeVerdict(pending, { busy, draft, now, lastWakeAt, gapSeconds: wcfg.minWakeGapSeconds, deferMinutes: wcfg.deferWhileTypingMinutes })
  if (verdict !== 'go') return
  const before = lastWakeAt
  lastWakeAt = now
  // Clear first, so a second tick during the submit cannot send the same findings twice
  await $.store.set(pendingKey(), [])
  try {
    await $.prompt.submit({ text: wakeText(wcfg.wakePreamble, pending) })
  } catch (err) {
    // Put them back for the next try, which the gap must not hold up
    await $.store.set(pendingKey(), [...pending, ...(await getPending($))])
    lastWakeAt = before
    $.ui.log(`watch: wake failed: ${err}`)
  }
  await status($)
}

/** One poller's box data: its countdown, its last run and its log. */
function boxState(p: Poller): BoxState {
  const r = lastRun.get(p.id)
  const at = nextAt.get(p.id)
  return {
    id: p.id,
    title: p.title,
    everySeconds: p.everySeconds,
    ...(at !== undefined ? { nextAt: at } : {}),
    running: running.has(p.id),
    ok: r?.ok !== false,
    ...(r?.error ? { error: r.error } : {}),
    rows: p.boxRows ?? wcfg.boxRows,
    log: logs[p.id] ?? [],
  }
}

/** Every poller's box data, for the pane and the state file. */
function stateNow(now: number): WatchStateData {
  return { version: 1, updatedAt: now, pollers: wcfg.pollers.map(boxState) }
}

/** Writes the state file fleet reads (when `stateFile` is set); a failure is logged once. */
async function publish($: any): Promise<void> {
  if (!wcfg.stateFile) return
  try {
    await $.fs.write(wcfg.stateFile, JSON.stringify(stateNow(await $.clock.now())))
    stateError = ''
  } catch (err) {
    if (String(err) !== stateError) $.ui.log(`watch: state file ${wcfg.stateFile} not written: ${err}`)
    stateError = String(err)
  }
}

/** Adds findings to a poller's log (a text already among the last 20 lines is not repeated), keeps the newest LOG_KEEP, and saves. */
async function addLog($: any, id: string, now: number, texts: string[]): Promise<void> {
  const log = logs[id] ?? []
  for (const text of texts) if (!log.slice(-20).some(l => l.text === text)) log.push({ at: now, text })
  logs[id] = log.slice(-LOG_KEEP)
  await $.store.set(logKey(), logs)
}

/** M:SS until a poller's next run, for the status line. */
function remaining(p: Poller, now: number): string {
  const at = nextAt.get(p.id)
  return running.has(p.id) ? 'running' : at === undefined ? '-' : clockText(at - now)
}

/** The status line: each poller's countdown, pending count, failing pollers, config problems. */
async function status($: any): Promise<void> {
  if (wcfg.pollers.length === 0 && problems.length === 0) {
    watchStatus = undefined
    return showStatus($)
  }
  const now = await $.clock.now()
  const parts = wcfg.tickSeconds > 0 ? wcfg.pollers.map(p => `${p.id} ${remaining(p, now)}`) : [`${wcfg.pollers.length} poller${wcfg.pollers.length === 1 ? '' : 's'}`]
  const pending = pendingCount
  if (pending) parts.push(`${pending} to tell`)
  const failing = wcfg.pollers.filter(p => lastRun.get(p.id)?.ok === false).map(p => p.id)
  if (failing.length) parts.push(`failing: ${failing.join(', ')}`)
  if (problems.length) parts.push(`${problems.length} config problem${problems.length === 1 ? '' : 's'}`)
  watchStatus = parts.join(' · ')
  showStatus($)
}

/** Minutes ago, for /watch. */
function ago(now: number, at: number): string {
  return `${Math.round((now - at) / 60_000)} min ago`
}

/** /watch's report: each poller's last run, what waits to be told, the config's problems. */
async function report($: any): Promise<string> {
  const now = await $.clock.now()
  const lines = [`watch: ${watchConfigFile}, ${wcfg.pollers.length} pollers`]
  for (const p of wcfg.pollers) {
    const r = lastRun.get(p.id)
    const what = !r ? 'not run yet' : r.ok ? `${r.found} found, ${r.told} new, ${ago(now, r.at)}` : `FAILED ${ago(now, r.at)}: ${r.error}`
    lines.push(`- ${p.id} (every ${p.everySeconds}s${p.wake ? '' : ', no wake'}${running.has(p.id) ? ', running' : ''}, next in ${remaining(p, now)}): ${what}`)
  }
  const pending = await getPending($)
  if (pending.length) lines.push(`to tell: ${pending.length} (${busy ? 'a turn is running' : 'next idle moment'})`)
  for (const p of problems) lines.push(`config: ${p}`)
  return lines.join('\n')
}

/** (Re)starts every poller's timer, staggered so they do not all start at once, and the countdown tick. */
async function schedule($: any): Promise<void> {
  for (const t of watchTimers) t.cancel()
  nextAt.clear()
  const start = await $.clock.now()
  if (!wcfg.enabled) {
    watchTimers = []
    watchStatus = undefined
    return showStatus($)
  }
  watchTimers = [$.clock.every(DELIVER_MS, () => deliver($))]
  wcfg.pollers.forEach((p, i) => {
    nextAt.set(p.id, start + 2_000 + i * 3_000)
    // The first run comes soon after start; the regular ones count from the start
    watchTimers.push($.clock.after(2_000 + i * 3_000, async () => {
      nextAt.set(p.id, start + p.everySeconds * 1000)
      await poll($, p)
    }))
    watchTimers.push($.clock.every(p.everySeconds * 1000, async () => {
      nextAt.set(p.id, (await $.clock.now()) + p.everySeconds * 1000)
      await poll($, p)
    }))
  })
  // The countdown: redraw the status line, and the pane when it is up
  if (wcfg.tickSeconds > 0) watchTimers.push($.clock.every(wcfg.tickSeconds * 1000, () => tick($)))
  await publish($)
}

/** One countdown tick: the status line, and the pane while one is placed. */
async function tick($: any): Promise<void> {
  await status($)
  try {
    if ((await $.ui.panes()).some((x: any) => x.id === WATCH_PANE && x.isPlaced)) $.ui.invalidate('ui.render')
  } catch {}
}

const watchStart = async ($: any, e: any, next: any): Promise<any> => {
  await loadWatchConfig($, true)
  await getPending($)
  await schedule($)
  try {
    await $.command.register({ name: 'watch', description: 'Pollers and what they found (watch)', argumentHint: '[run [id] | forget [id] | reload | pane]', immediate: true })
  } catch {}
  await status($)
  return next(e)
}

const watchComplete = async ($: any, e: any, next: any): Promise<any> => {
  const r = await next(e)
  if (!(e as any).agentId) {
    busy = false
    void deliver($)
  }
  return r
}

async function* watchStep($: any, e: any, next: any): any {
  const result: any = yield* next(e)
  const id = (e as any).agentId
  const u = result?.usage
  if (id && u) {
    const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    steps.set(id, { at: await $.clock.now(), context })
  }
  return result
}

const registerWatch: Register = (on, options) => {
  const path = (options as { configPath?: unknown } | undefined)?.configPath
  watchConfigFile = typeof path === 'string' && path.trim() !== '' ? path.trim() : WATCH_CONFIG_FILE


  // Only the main loop's turns make the session busy; subagents run beside an idle session.
  on('turn.start', async ($, e, next) => {
    busy = true
    return next(e)
  })


  // Each subagent request: when it ended and how big the context is, for the agents poller.

  // `/watch` reports; `run [id]` polls now; `forget [id]` clears the seen-set so findings are new again; `reload` re-reads the config; `pane` opens the pane of boxes.
  on('command.run', { command: 'watch' }, async ($, e) => {
    const [verb, id] = String((e as any).args ?? '').trim().split(/\s+/)
    const chosen = (id ? wcfg.pollers.filter(p => p.id === id) : wcfg.pollers)
    if (id && chosen.length === 0) return { text: `watch: no poller "${id}"` }
    if (verb === 'run') {
      // A command cannot start a turn while it runs: the delivery tick tells what this run found
      await Promise.all(chosen.map(p => poll($, p, false)))
    } else if (verb === 'forget') {
      const seen = ((await $.store.get(seenKey())) ?? {}) as Seen
      for (const p of chosen) delete seen[p.id]
      await $.store.set(seenKey(), seen)
    } else if (verb === 'reload') {
      await loadWatchConfig($)
      await schedule($)
    } else if (verb === 'pane') {
      let placed = false
      try {
        placed = Boolean((await $.ui.open({ id: WATCH_PANE, title: 'Watch', closeOnEscape: true, ...wcfg.pane }))?.isPlaced)
      } catch {}
      // Where no pane can show (headless), the report answers instead
      if (placed) return {}
    }
    return { text: await report($) }
  })

  // The pane: one box per poller, side by side, each with its countdown and its log.
  on('ui.render', { component: 'Pane', requestId: WATCH_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const now = await $.clock.now()
    const state = stateNow(now)
    if (state.pollers.length === 0) return <ui.Text dimColor>No pollers configured: see the config file.</ui.Text>
    return WatchBoxes(ui, state, now, (e as any).props?.bodyColumns ?? 80)
  })
}

// ---- both parts ----

export const register: Register = (on, options) => {
  registerFleet(on, options)
  registerWatch(on, options)

  on('session.start', async ($, e, next) => fleetStart($, e, (e2: any) => watchStart($, e2, next)))
  on('turn.complete', async ($, e, next) => fleetComplete($, e, (e2: any) => watchComplete($, e2, next)))
  on('turn.step', async function* ($, e, next) {
    return yield* fleetStep($, e, (e2: any) => watchStep($, e2, next))
  })
}
