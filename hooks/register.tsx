// Tether: the agents pane, the pollers and the guards, as one hooks module (a plugin names exactly one, and
// `$` is followed only within the file it is passed in, so every part that touches `$` lives here).
//
// The file has two parts, FLEET and WATCH, each registering its own events; an event both use (session
// start, a turn step, a turn complete) is registered once at the bottom and runs each part's handler in
// turn. State lives in module variables on purpose: they survive /clear.

import type { Register } from 'claude-code'
import type { PrsPoller } from '../src/watch/config'
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
import { CHECKPOINT_DEFAULTS, mergeCheckpoint, type CheckpointConfig } from '../src/checkpoint/config'
import { handoffProblems } from '../src/checkpoint/handoff'
import { askText, continueText, describeCycle, initialCycle, newInformation, repairText, step as cycleStep, type Action, type CycleState, type Observed } from '../src/checkpoint/cycle'
import { stopReason as agentStopReason, undecided, type Undecided } from '../src/guards/agents'
import { GH_FIELDS, fromGh, fromHealth, problemKey, problemLine, stopReason as prStopReason, unowned, unpushedProblem, type Problem } from '../src/guards/prs'
import { pruneOwners, readStore, recordDecision, recordOwner, type GuardStore } from '../src/guards/store'
import { layered } from '../src/options/options'
import { mergeConversations, mergeHousekeeping, mergeStop, stopBlocks, CONVERSATIONS_DEFAULTS, HOUSEKEEPING_DEFAULTS, STOP_DEFAULTS, type ConversationsConfig, type HousekeepingConfig, type StopConfig, type StopState } from '../src/housekeeping/config'
import { excludeLines, handoffTemplate, isHandoffPath, withExcludes } from '../src/housekeeping/files'
import { logName, renderConversation, type LogMessage } from '../src/conversation/render'

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
  const { root, problem } = await readTetherConfig($, true)
  if (problem) $.ui.log(`fleet: ${problem}; using the defaults`)
  // The plugin's option is the default for `enabled`; the project's section overrides it
  return mergeConfig(layered(options, 'fleet', root?.fleet))
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
        {cpLine !== '' && (
          <Text dimColor wrap="truncate-end">
            {cpLine}
          </Text>
        )}
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
  } else {
    // Without a file the options alone are the settings
    const parsed = parseConfig(layered(options, 'watch', root?.watch))
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
  // An agent that stepped before this session of Tether (a reload, a restart) has no entry in `steps`: read its last
  // request from Claude Code's transcript, the way the fleet pane does, so the agent guard still knows its context.
  agents = list as AgentLike[]
  await noteProjectDir($)
  await backfill($)
  return list.map(a => {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, now)
    const s = steps.get(a.id)
    const l = s ? undefined : ledger.get(a.id)
    return {
      id: a.id,
      status: a.status,
      label: a.name ?? a.description ?? a.type ?? a.id,
      lastStepAt: s?.at ?? l?.lastStepAt ?? firstSeen.get(a.id)!,
      ...(s ? { contextTokens: s.context } : l ? { contextTokens: l.contextTokens } : {}),
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
        const at = await $.clock.now()
        const seen = await agentsSeen($, at)
        const guard = { store: await guardStore($), cacheMinutes: cfg.cacheTtlMinutes, smallTokens: cfg.bigContextTokens }
        result = { findings: agentFindings(p, seen, at, guard) }
        // The Stop hook blocks over the same agents the poller tells
        lastUndecided = undecided(seen, guard.store, { cacheMinutes: guard.cacheMinutes, smallTokens: guard.smallTokens, actAfterMinutes: p.actAfterMinutes, forgetMinutes: p.forgetAgentMinutes }, at)
      } catch (err) {
        result = { error: String(err) }
      }
    } else if (p.kind === 'prs') {
      result = await prsFindings($, p)
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

// ---- CHECKPOINT ----
// The checkpoint cycle (src/checkpoint): when the session is long and quiet, ask for a handoff, check it,
// then clear and continue from it. The decisions are pure (src/checkpoint/cycle.ts); this part reads the
// session and carries them out. The continue prompt waits in $.store, so a reload between the clear and
// the continue cannot lose it.

const CHECKPOINT_CONTINUE_KEY = 'checkpoint:continue'
let cpCfg: CheckpointConfig = CHECKPOINT_DEFAULTS
/** The plugin's options (`/plugin configure tether@tether`): the defaults the project file overrides. */
let options: Record<string, unknown> = {}
let cpState: CycleState = initialCycle()
let cpTimers: Array<{ cancel: () => void }> = []
/** One tick at a time: a tick awaits the prompt and the clear, and the next must not start meanwhile. */
let cpTicking = false
/** The line the pane shows for the checkpoint, refreshed each tick. */
let cpLine = ''

/** Reads the checkpoint section of the config and starts the tick. */
async function checkpointStart($: any): Promise<void> {
  const { root } = await readTetherConfig($, true)
  cpCfg = mergeCheckpoint(layered(options, 'checkpoint', root?.checkpoint))
  for (const t of cpTimers) t.cancel()
  cpTimers = cpCfg.enabled ? [$.clock.every(cpCfg.tickSeconds * 1000, () => checkpointTick($)) as any] : []
}

/** One tick: read the session's state, step the cycle, and carry out what it decides. */
async function checkpointTick($: any): Promise<void> {
  if (!cpCfg.enabled || cpTicking) return
  cpTicking = true
  try {
    const now = await $.clock.now()
    // A draft is the person typing: it holds the cycle as a wake does (only the main loop's turns count as busy)
    const draft = busy ? '' : ((await $.prompt.read())?.text ?? '')
    const contextTokens = ledger.get('main')?.contextTokens ?? 0
    // Messages and the handoff are read only once a handoff is in progress; an idle session needs neither
    const inProgress = cpState.phase !== 'idle'
    // New information: the person's and the main agent's messages, not the cycle's own prompts or their replies
    const messages = inProgress ? newInformation((await $.session.messages()) as Array<{ role: string; text?: string }>, cpCfg) : 0
    const problems = inProgress ? await handoffCheck($) : []
    const observed: Observed = { now, contextTokens, busy, draft, messages, problems }
    const { state, action } = cycleStep(cpState, observed, cpCfg)
    cpState = state
    const line = describeCycle(cpState, observed, cpCfg)
    if (line !== cpLine) {
      cpLine = line
      $.ui.invalidate('ui.render')
    }
    await carryOut($, action, problems)
  } finally {
    cpTicking = false
  }
}

/** The handoff's problems now: undefined when the file is missing, else the template check's list. */
async function handoffCheck($: any): Promise<string[] | undefined> {
  try {
    if (!(await $.fs.exists(cpCfg.handoffFile))) return undefined
    return handoffProblems(await $.fs.read(cpCfg.handoffFile), cpCfg)
  } catch {
    return undefined
  }
}

/** Carries out one action of the cycle: a prompt to the model, or the clear. */
async function carryOut($: any, action: Action, problems: string[] | undefined): Promise<void> {
  if (action === 'none') return
  if (action === 'ask' || action === 'update') {
    $.ui.log(`checkpoint: ${action === 'ask' ? 'asking for' : 'updating'} ${cpCfg.handoffFile}`)
    await $.prompt.submit({ text: askText(cpCfg, action === 'update') })
    return
  }
  if (action === 'repair') {
    await $.prompt.submit({ text: repairText(cpCfg, problems ?? [`${cpCfg.handoffFile} is missing`]) })
    return
  }
  if (action === 'give-up') {
    $.ui.toast(`checkpoint: ${cpCfg.handoffFile} failed its check; not cleared`)
    $.ui.log(`checkpoint: gave up; ${cpCfg.handoffFile} never passed its check`)
    return
  }
  // clear: remember the continue first, so a reload between here and the new session cannot lose it
  await $.store.set(CHECKPOINT_CONTINUE_KEY, true)
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    $.ui.log(`checkpoint: the clear failed: ${err}`)
  }
  // The new session's start normally clears the flag before this returns; a flag still set means no clear happened
  if ((await $.store.get(CHECKPOINT_CONTINUE_KEY)) === true) {
    await $.store.set(CHECKPOINT_CONTINUE_KEY, false)
    cpState = initialCycle()
    $.ui.toast('checkpoint: the clear did not happen')
  }
}

/** After a clear, the new session continues from the handoff (after a second, so the session has settled). */
async function checkpointAfterClear($: any): Promise<void> {
  if ((await $.store.get(CHECKPOINT_CONTINUE_KEY)) !== true) return
  await $.store.set(CHECKPOINT_CONTINUE_KEY, false)
  cpState = initialCycle()
  $.clock.after(1000, () => $.prompt.submit({ text: continueText(cpCfg) }))
}

// ---- GUARDS ----
// The PR guard and the agent guard: problems nobody owns are told by the pollers (kind `prs`, and the agents
// poller's undecided agents), recorded by the model with two tools, and block the end of a turn until dealt
// with. One store (src/guards/store.ts) holds the owners, waivers and decisions.

const TOOL_PR = 'pr_owner'
const TOOL_AGENT = 'agent_decision'
/** Every PR problem the last `prs` poll saw, owned or not; the Stop hook filters it by the store. */
let lastProblems: Problem[] = []
/** The stopped, big, undecided agents at the last agents poll. */
let lastUndecided: Undecided[] = []
let stopCfg: StopConfig = STOP_DEFAULTS
let stopState: StopState | undefined

/** The guards' store from $.store. */
async function guardStore($: any): Promise<GuardStore> {
  return readStore(await $.store.get(`guards:${wcfg.storeName}`))
}

/** Saves the guards' store. */
async function saveGuardStore($: any, store: GuardStore): Promise<void> {
  await $.store.set(`guards:${wcfg.storeName}`, store)
}

/** Local time as `YYYY-MM-DDTHH:MM:SS`, for log names and headers. */
function localStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Open PRs whose idle worktree holds commits origin lacks (the poller's `worktrees` setting). */
async function unpushedIn($: any, p: PrsPoller, heads: Map<number, { branch: string; sha: string }>): Promise<Problem[]> {
  const out: Problem[] = []
  for (const [number, h] of heads) {
    const wt = `${p.worktrees}/${h.branch}`
    if (!(await $.fs.exists(wt))) continue
    if (p.busyMarker && (await $.fs.exists(`${wt}/${p.busyMarker}`))) continue
    const git = async (...args: string[]): Promise<string> => {
      const r = await $.process.run(['git', '-C', wt, ...args], { timeoutMs: 30_000 })
      return r.exitCode === 0 ? String(r.stdout).trim() : ''
    }
    if ((await git('rev-parse', '--abbrev-ref', 'HEAD')) !== h.branch) continue
    const ahead = await git('rev-list', '--count', `origin/${h.branch}..HEAD`)
    if (ahead && ahead !== '0') out.push(unpushedProblem(number, h.branch, Number(ahead), (await git('rev-parse', 'HEAD')) || '?'))
  }
  return out
}

/** One run of a `prs` poller: the problems with no owner, as findings; the Stop hook gets all problems. */
async function prsFindings($: any, p: PrsPoller): Promise<{ findings?: Finding[]; error?: string }> {
  const run = (command: string[], timeoutMs: number) => $.process.run(command, { timeoutMs, ...(p.cwd ? { cwd: p.cwd } : {}) })
  try {
    const listed = await run(['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', GH_FIELDS], 60_000)
    if (listed.exitCode !== 0) return { error: `gh pr list: exit ${listed.exitCode}` }
    const list = JSON.parse(listed.stdout) as Array<{ number: number; headRefName: string; headRefOid: string }>
    const heads = new Map(list.map(x => [x.number, { branch: x.headRefName, sha: x.headRefOid }]))
    const now = await $.clock.now()
    let found: Problem[]
    if (p.command) {
      const r = await run(p.command, p.timeoutMs)
      if (!p.okExitCodes.includes(r.exitCode)) return { error: `health command: exit ${r.exitCode}` }
      found = fromHealth(JSON.parse(r.stdout), heads)
    } else {
      found = fromGh(list, { stuckMinutes: p.stuckMinutes, requireAutoMerge: p.requireAutoMerge, ignoreDrafts: p.ignoreDrafts }, now)
    }
    if (p.worktrees) found = [...found, ...(await unpushedIn($, p, heads))]
    lastProblems = found
    const store = await guardStore($)
    const pruned = pruneOwners(store, now)
    if (pruned !== store) await saveGuardStore($, pruned)
    return { findings: unowned(found, pruned, now).map(x => ({ key: problemKey(x), text: problemLine(x) })) }
  } catch (err) {
    return { error: String(err) }
  }
}

/** The result of a Tether tool: its text. The harness takes a string, an array or nothing, never an object. */
function toolText(text: string): any {
  return { result: text }
}

/** Registers the two tools the model records owners and decisions with. */
async function registerGuardTools($: any): Promise<void> {
  try {
    await $.tool.register({
      name: TOOL_PR,
      description: 'Record who fixes a problem with an open pull request (kind "assign": an owner for a few hours), or a known wait (kind "waive": hours and a reason; with "cause" only that cause is covered). Tether\'s PR guard keeps blocking the end of a turn until every problem has an owner or a waiver.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'The pull request number' },
          kind: { type: 'string', enum: ['assign', 'waive'] },
          who: { type: 'string', description: 'For assign: who fixes it (an agent id or name)' },
          hours: { type: 'number', description: 'For waive: how long the wait lasts; for assign: optional, the poller\'s assignHours by default' },
          cause: { type: 'string', description: 'Only this cause is covered (conflict, checks-failed, ci-stuck, auto-merge-off, unpushed, ...); absent: every cause of the PR' },
          note: { type: 'string', description: 'What is being done, or why it waits' },
        },
        required: ['pr', 'kind', 'note'],
      },
    })
    await $.tool.register({
      name: TOOL_AGENT,
      description: 'Record the decision about a stopped subagent that holds a big context: "retired" (stopped, a fresh agent will take over) or "done" (its work is finished). Tether\'s agent guard keeps blocking the end of a turn until each such agent is decided before its prompt cache expires.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The agent id' },
          decision: { type: 'string', enum: ['retired', 'done'] },
          note: { type: 'string' },
        },
        required: ['id', 'decision'],
      },
    })
  } catch (err) {
    $.ui.log(`guards: the tools were not registered: ${err}`)
  }
}

/** Serves pr_owner: records an owner or a waiver. */
async function prOwnerCall($: any, e: any): Promise<any> {
  const pr = Number(e.pr)
  if (!Number.isInteger(pr) || pr <= 0) return { deny: 'pr must be a pull request number' }
  if (e.kind !== 'assign' && e.kind !== 'waive') return { deny: 'kind must be "assign" or "waive"' }
  const prsPoller = wcfg.pollers.find((x): x is PrsPoller => x.kind === 'prs')
  const hours = Number(e.hours) > 0 ? Number(e.hours) : e.kind === 'assign' ? (prsPoller?.assignHours ?? 4) : 0
  if (hours <= 0) return { deny: 'a waiver needs hours' }
  const who = e.kind === 'waive' ? 'waived' : String(e.who ?? '').trim()
  if (who === '') return { deny: 'an assignment needs who' }
  const now = await $.clock.now()
  const cause = typeof e.cause === 'string' && e.cause.trim() !== '' ? e.cause.trim() : undefined
  await saveGuardStore($, recordOwner(await guardStore($), pr, who, hours, String(e.note ?? ''), now, localStamp(now).replace('T', ' ').slice(0, 16), cause))
  return toolText(`#${pr} ${e.kind === 'waive' ? 'waived' : 'assigned to ' + who} for ${hours} h${cause ? ` (cause ${cause})` : ''}.`)
}

/** Serves agent_decision: records that a stopped agent is retired or done. */
async function agentDecisionCall($: any, e: any): Promise<any> {
  if (typeof e.id !== 'string' || e.id.trim() === '') return { deny: 'id must be an agent id' }
  if (e.decision !== 'retired' && e.decision !== 'done') return { deny: 'decision must be "retired" or "done"' }
  const now = await $.clock.now()
  await saveGuardStore($, recordDecision(await guardStore($), e.id.trim(), e.decision, String(e.note ?? ''), localStamp(now).replace('T', ' ').slice(0, 16)))
  return toolText(`${e.id.trim()} recorded as ${e.decision}.`)
}

/** What /guards prints: the PR problems nobody owns, the owners and waivers, the agents awaiting a decision. */
async function guardsReport($: any): Promise<string> {
  const now = await $.clock.now()
  const store = await guardStore($)
  const open = unowned(lastProblems, store, now)
  const lines = [`guards: ${lastProblems.length} PR problem${lastProblems.length === 1 ? '' : 's'} at the last poll, ${open.length} without an owner`]
  for (const p of open) lines.push(`- #${p.number} ${p.branch}: ${p.text}`)
  for (const [pr, o] of Object.entries(store.owners)) {
    if (o.until > now) lines.push(`owner #${pr}: ${o.who}${o.cause ? ` (${o.cause})` : ''} for ${Math.round((o.until - now) / 3_600_000)} h more, ${o.note}`)
  }
  const waiting = lastUndecided.filter(u => !(u.id in store.decisions))
  lines.push(`agents awaiting a decision: ${waiting.length}`)
  for (const u of waiting) lines.push(`- ${u.text}`)
  return lines.join('\n')
}

// ---- HOUSEKEEPING and CONVERSATION LOGS ----
// Tether keeps its folder and the handoff out of git (.git/info/exclude, so no tracked file is edited), makes
// the handoff from the template when it is missing, holds every write of it to the template, and keeps a
// Markdown log of each session in <folder>/conversations.

let hkCfg: HousekeepingConfig = HOUSEKEEPING_DEFAULTS
let convCfg: ConversationsConfig = CONVERSATIONS_DEFAULTS
let lastLogAt = -Infinity
let logTimer: { cancel: () => void } | undefined
let lastLogError = ''

/** Reads the guards', housekeeping and conversation settings. */
async function guardsStart($: any): Promise<void> {
  const { root } = await readTetherConfig($, true)
  hkCfg = mergeHousekeeping(layered(options, 'housekeeping', root?.housekeeping))
  convCfg = mergeConversations(layered(options, 'conversations', root?.conversations))
  stopCfg = mergeStop(layered(options, 'stop', root?.stop))
}

/** Adds Tether's lines to the repository's exclude file, makes a missing handoff, and reports a failing one. */
async function housekeepingStart($: any): Promise<void> {
  if (!hkCfg.enabled) return
  try {
    const where = await $.process.run(['git', 'rev-parse', '--git-path', 'info/exclude'], { timeoutMs: 10_000 })
    if (where.exitCode === 0) {
      const path = String(where.stdout).trim()
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      const next = withExcludes(existing, excludeLines({ folder: hkCfg.folder, handoffFile: cpCfg.handoffFile, configFile, extra: hkCfg.exclude }))
      if (next !== undefined) await $.fs.write(path, next)
    }
    if (hkCfg.createHandoff && !(await $.fs.exists(cpCfg.handoffFile))) {
      await $.fs.write(cpCfg.handoffFile, handoffTemplate(cpCfg.sections))
      $.ui.log(`housekeeping: made ${cpCfg.handoffFile} from the template`)
    }
    const problems = await handoffCheck($)
    if (problems && problems.length > 0) {
      $.ui.toast(`${cpCfg.handoffFile} fails its check`)
      $.ui.log(`housekeeping: ${cpCfg.handoffFile} fails its check: ${problems.join('; ')}`)
    }
  } catch (err) {
    $.ui.log(`housekeeping: ${err}`)
  }
}

/** Writes this session's conversation log (whole each time); unless forced, at most every `minSeconds`, with a trailing write. */
async function writeLog($: any, force = false): Promise<void> {
  if (!hkCfg.enabled || !convCfg.enabled) return
  const now = await $.clock.now()
  if (!force && now - lastLogAt < convCfg.minSeconds * 1000) {
    // Too soon: write once the gap has passed, so the last turns are not left out
    if (!logTimer) logTimer = $.clock.after(convCfg.minSeconds * 1000, () => { logTimer = undefined; return writeLog($, true) }) as any
    return
  }
  lastLogAt = now
  try {
    const id = String(await $.session.id())
    const key = `conversation:start:${id}`
    let started = await $.store.get(key)
    if (typeof started !== 'string') {
      started = localStamp(now)
      await $.store.set(key, started)
    }
    const messages = (await $.session.messages()) as LogMessage[]
    if (messages.length === 0) return
    await $.fs.write(`${hkCfg.folder}/conversations/${logName(started as string, id)}`, renderConversation(messages, { sessionId: id, startedAt: (started as string).replace('T', ' ').slice(0, 16) }))
    lastLogError = ''
  } catch (err) {
    if (String(err) !== lastLogError) $.ui.log(`conversations: the log was not written: ${err}`)
    lastLogError = String(err)
  }
}

export const register: Register = (on, opts) => {
  options = (opts ?? {}) as Record<string, unknown>
  registerFleet(on, opts)
  registerWatch(on, opts)

  on('session.start', async ($, e, next) => {
    await checkpointStart($)
    await guardsStart($)
    await housekeepingStart($)
    await registerGuardTools($)
    try {
      await $.command.register({ name: 'guards', description: 'PR problems and stopped agents nobody has dealt with (guards)', immediate: true })
    } catch {}
    return fleetStart($, e, (e2: any) => watchStart($, e2, next))
  })

  // The model records an owner, a waiver or a decision with these tools.
  on('tool.call', { tool: `mcp__tether__${TOOL_PR}` }, async ($, e) => prOwnerCall($, e))
  on('tool.call', { tool: `mcp__tether__${TOOL_AGENT}` }, async ($, e) => agentDecisionCall($, e))
  on('command.run', { command: 'guards' }, async ($) => ({ text: await guardsReport($) }))

  // The end of a turn is blocked while a PR problem or a stopped big agent has no owner or decision, at most
  // `stop.maxBlocks` times in a row for the same reason.
  on('classic.Stop', async ($, e, next) => {
    const r: any = await next(e)
    if (!stopCfg.enabled) return r
    const now = await $.clock.now()
    const store = await guardStore($)
    const reasons = [
      unowned(lastProblems, store, now).length > 0 ? prStopReason(unowned(lastProblems, store, now)) : '',
      lastUndecided.some(u => !(u.id in store.decisions)) ? agentStopReason(lastUndecided.filter(u => !(u.id in store.decisions))) : '',
    ].filter(Boolean)
    if (reasons.length === 0) {
      stopState = undefined
      return r
    }
    const reason = reasons.join('\n\n')
    const verdict = stopBlocks(stopState, reason, stopCfg.maxBlocks, now)
    stopState = verdict.next
    return verdict.block ? { ...(r ?? {}), block: reason } : r
  }).catch(($, e, next) => next(e))

  // The handoff follows its template: a Write that breaks it is refused; an Edit that leaves it broken is told.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (hkCfg.enabled && hkCfg.enforceHandoff && isHandoffPath((e as any).file_path, cpCfg.handoffFile)) {
      const problems = handoffProblems(String((e as any).content ?? ''), cpCfg)
      if (problems.length > 0) return { deny: `Tether: ${cpCfg.handoffFile} must follow its template (${problems.join('; ')}). Write it again with those fixed.` }
    }
    return next(e)
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r: any = await next(e)
    if (!(hkCfg.enabled && hkCfg.enforceHandoff && isHandoffPath((e as any).file_path, cpCfg.handoffFile))) return r
    const problems = await handoffCheck($)
    if (!problems || problems.length === 0) return r
    $.ui.toast(`${cpCfg.handoffFile} fails its check`)
    return { ...r, context: [...(r?.context ?? []), `Tether: ${cpCfg.handoffFile} now fails its template check (${problems.join('; ')}). Fix it.`] }
  })

  // The conversation log is also written after each main-loop turn (in turn.complete below) and when the session ends.
  on('classic.SessionEnd', async ($, e, next) => {
    await writeLog($, true)
    return next(e)
  }).catch(($, e, next) => next(e))
  // A clear starts a new session: continue from the handoff if a checkpoint asked for it
  on('classic.SessionStart', async ($, e, next) => {
    if ((e as any).source === 'clear') await checkpointAfterClear($)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    const r = await fleetComplete($, e, (e2: any) => watchComplete($, e2, next))
    if (!(e as any).agentId) void writeLog($)
    return r
  })
  on('turn.step', async function* ($, e, next) {
    return yield* fleetStep($, e, (e2: any) => watchStep($, e2, next))
  })
}
