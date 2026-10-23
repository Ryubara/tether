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
import { buildRows, GUARD_MARK, summary, tokens, type AgentLike, type RateLimit, type Row } from '../src/fleet/rows'
import { lastRequest, liveTasks, metaDescription, metaModel, noteAppendedRow, subagentsDir } from '../src/fleet/transcript'
import { Boxes, parseState, type WatchState } from '../src/fleet/boxes'
import { headerCells, legend, rowCells, rowText } from '../src/fleet/cells'
import { DEFAULTS as WATCH_DEFAULTS, parseConfig, type CommandPoller, type IssuesPoller, type Poller, type WatchConfig } from '../src/watch/config'
import { Boxes as WatchBoxes, clockText, type BoxState, type LogLine, type WatchState as WatchStateData } from '../src/watch/boxes'
import { agentFindings, atWork, fresh, idleWakeDue, issueFindings, liveBackground, readOutput, readPlainOutput, type AgentSeen, type Finding, type Seen, type Told } from '../src/watch/findings'
import type { Notice } from '../src/notices/notice'
import { Notices, type NoticePorts, type WakeRules } from '../src/notices/queue'
import { CHECKPOINT_DEFAULTS, mergeCheckpoint, withHandoffEnv, type CheckpointConfig } from '../src/checkpoint/config'
import { handoffProblems, injectedHandoff } from '../src/checkpoint/handoff'
import { askText, backedOff, continueText, describeCycle, forceCheckpoint, initialCycle, newInformation, repairText, step as cycleStep, type Action, type CycleState, type Observed } from '../src/checkpoint/cycle'
import { alerted, decisionProblem, planActions, stopReason as agentStopReason, undecided, type AgentRules, type Plan, type Undecided } from '../src/guards/agents'
import { CACHE_GUARD_DEFAULTS, mergeCacheGuard, type CacheGuardConfig } from '../src/guards/config'
import { ACTIVE_RERUN, CAUSES, GH_FIELDS, fromGh, plainProblem, fromHealth, problemKey, problemLine, rerunInfo, rerunsFromHealth, stopReason as prStopReason, toldProblems, unowned, unpushedProblem, type Problem } from '../src/guards/prs'
import { NEW_CYCLE, pruneOwners, readStore, recordAction, recordAlert, recordDecision, recordOwner, recordRerun, type GuardStore } from '../src/guards/store'
import { layered } from '../src/options/options'
import { DEFAULT_CONFIG_FILE, HALT_TEXT, OPEN_POLICY, commandRefusal, configSource, judge, type Policy, type Refusal, type Source } from '../src/options/policy'
import { AGENT_STATUSES, hashKey, plainCode, plainError, plainId, plainLimitKind } from '../src/options/plain'
import { mergeConversations, mergeHousekeeping, mergeStop, stopBlocks, CONVERSATIONS_DEFAULTS, HOUSEKEEPING_DEFAULTS, STOP_DEFAULTS, type ConversationsConfig, type HousekeepingConfig, type StopConfig, type StopState } from '../src/housekeeping/config'
import { excludeLines, handoffTemplate, isHandoffPath, withExcludes } from '../src/housekeeping/files'
import { CHECKPOINT, FLEET, GUARDS, WATCH, registration } from '../src/commands/commands'
import { logName, renderConversation, type LogMessage } from '../src/conversation/render'

// ---- FLEET ----
// fleet: see the session's agents and what they cost, and refuse waking a big agent on a cold cache.
//
// The hooks only wire Claude Code's events to the pure functions in ../src, which the tests cover.
// State lives in module variables on purpose: they survive /clear (which resets $.state), and a
// reload of the module starts them over, which a refresh then fills in again.



/** Tether's one pane: Fleet's table on top, Watch's poller boxes beneath (each left out while its part is off). */
const PANE = 'tether'
const PANE_TITLE = 'Tether'
/** The config file when neither TETHER_CONFIG nor the `configPath` option names one, relative to the session's working directory. */
const CONFIG_FILE = DEFAULT_CONFIG_FILE
/** The config file in use: TETHER_CONFIG, else the `configPath` option, else CONFIG_FILE. */
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
  $.ui.status(halted ? HALT_TEXT : [fleetStatus, watchStatus].filter(Boolean).join('  |  ') || undefined)
}

/**
 * Reads Tether's config file (one file, a section per part); no root when it is missing or unreadable. The file is
 * picked once per load of the module (TETHER_CONFIG, else the `configPath` option, else CONFIG_FILE), so a reload
 * re-reads the same file. A file that fails closed (see src/options/policy.ts) turns every part off.
 */
let rootCache: { root?: Record<string, unknown>; problem?: string } | undefined
async function readTetherConfig($: any, reuse = false): Promise<{ root?: Record<string, unknown>; problem?: string }> {
  if (reuse && rootCache) return rootCache
  rootCache = await readTetherFile($)
  return rootCache
}
async function readTetherFile($: any): Promise<{ root?: Record<string, unknown>; problem?: string }> {
  if (!source) {
    let env: string | undefined
    try {
      // The literal name, so the engine can list what the module reads (it is CONFIG_ENV)
      env = (await $.env.get('TETHER_CONFIG')) ?? undefined
    } catch {
      // An environment Tether cannot read names no file
    }
    source = configSource(env, options.configPath)
    configFile = source.file
    watchConfigFile = source.file
  }
  let read: { text: string } | 'missing' | { error: unknown } = 'missing'
  if (source.file !== '') {
    try {
      read = (await $.fs.exists(source.file)) ? { text: String(await $.fs.read(source.file)) } : 'missing'
    } catch (err) {
      read = { error: err }
    }
  }
  const loaded = judge(source, read, lockedSeen)
  if (loaded.locked) lockedSeen = true
  policy = loaded.policy
  setHalt($, loaded.halt)
  return loaded.halt ? {} : { ...(loaded.root ? { root: loaded.root } : {}), ...(loaded.problem ? { problem: loaded.problem } : {}) }
}

/** Where the config comes from, picked at the first read of each module load. */
let source: Source | undefined
/** The config file's rules (locked, network, allowed commands, plain output). */
let policy: Policy = OPEN_POLICY
/** Every part is off: the config file failed closed. */
let halted = false
/** The halt was told (status line and toast), so it is told once, not at every read. */
let haltTold = false
/** A locked file was read in this load of the module: from then on it fails closed too. */
let lockedSeen = false

/** The plugin options as the layer under the file; a locked file's values are final, so then there is none. */
function optionLayer(): Record<string, unknown> {
  return policy.locked ? {} : options
}

/** Whether everything Tether says is built from fixed templates, ids, numbers and codes only. */
function plain(): boolean {
  return policy.plainOutput
}

/** Turns the halt on or off; going on tells it once in a toast, and the status line says it while it lasts. */
function setHalt($: any, on: boolean): void {
  halted = on
  if (!on) {
    haltTold = false
    return
  }
  if (haltTold) return
  haltTold = true
  try {
    $.ui.toast(HALT_TEXT)
  } catch {}
  showStatus($)
}

/**
 * Runs a command unless the policy refuses it (`network: false`, `allowedCommands`); a refusal answers with its
 * code in `refused` and exit code -1, and nothing runs.
 */
async function runChecked($: any, argv: string[], init: Record<string, unknown>): Promise<{ exitCode: number; stdout: string; stderr: string; refused?: Refusal }> {
  const refused = commandRefusal(argv, policy)
  if (refused) return { exitCode: -1, stdout: '', stderr: '', refused }
  return $.process.run(argv, init)
}

/**
 * Opens a pane as a session starts (`openOnStart`): beside the panes already open, without taking focus (no
 * `focus`), and without holding the start up. A pane that cannot be placed (a headless session) is left unopened.
 */
function openAtStart($: any): void {
  // Either part's openOnStart opens the one pane, while that part is on
  const wanted = (cfg.openOnStart && cfg.enabled) || (wcfg.openOnStart && wcfg.enabled)
  if (!wanted || halted) return
  openPaneQuietly($)
}

/**
 * The pane's id, title and size. One pane, so one size: `fleet.pane`, with `watch.pane` filling in a dimension
 * `fleet.pane` leaves unset (a config written for the two panes keeps its sizes).
 */
function paneSpec(): Record<string, unknown> {
  return { id: PANE, title: PANE_TITLE, ...wcfg.pane, ...cfg.pane }
}

/** The fleet settings while halted: off, no guard. */
const FLEET_OFF: FleetConfig = { ...DEFAULTS, enabled: false, coldGuard: false }

/** Reads the fleet section of the config, falling back to the defaults on any problem. */
async function loadConfig($: any): Promise<FleetConfig> {
  const { root, problem } = await readTetherConfig($, true)
  if (halted) return FLEET_OFF
  if (problem) $.ui.log(`fleet: ${problem}; using the defaults`)
  // The plugin's option is the default for `enabled`; the project's section overrides it
  return mergeConfig(layered(optionLayer(), 'fleet', root?.fleet))
}

/** Re-reads the agent list and usage, then updates the status line and the pane. */
async function refresh($: any): Promise<void> {
  if (halted) return
  try {
    agents = (await $.agent.list()) as AgentLike[]
  } catch {}
  try {
    if (cfg.showSession) limits = ((await $.session.usage())?.rateLimits ?? []) as RateLimit[]
    if (plain()) limits = limits.map(l => ({ kind: plainLimitKind(l.kind), percentUsed: Number(l.percentUsed) || 0 }))
  } catch {}
  await noteProjectDir($)
  await backfill($)
  await backfillMain($)
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
            if (last.model && !agentModels.has(a.id)) agentModels.set(a.id, last.model)
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

/** Set by a clear: the context the engine reports may still be the ended conversation's until a request is made. */
let mainClearedSinceStart = false

/**
 * The main session's context while fleet has seen no request of its own (a resumed session, a reload of the
 * module): the engine's live figure, the one the status line shows. `steps: 0` marks it, so the next real request
 * replaces it. Not after a clear: that conversation starts empty, and its first request tells the size.
 */
async function backfillMain($: any): Promise<void> {
  if (halted || mainClearedSinceStart) return
  const l = ledger.get('main')
  if (l && l.steps > 0) return
  try {
    const tokens = (await $.session.usage())?.context?.tokens
    if (typeof tokens !== 'number' || !(tokens > 0)) return
    ledger.set('main', { id: 'main', lastStepAt: l?.lastStepAt ?? (await $.clock.now()), contextTokens: tokens, cacheWritten: 0, coldWritten: 0, steps: 0 })
  } catch {
    // Without the engine's figure the main context stays unknown until the next request
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
    const r = await runChecked($, cfg.annotate.command, { timeoutMs: cfg.annotate.timeoutMs ?? 30_000 })
    if (r.refused) throw new Error(r.refused)
    const parsed = JSON.parse(r.stdout)
    if (parsed && typeof parsed === 'object') notes = parsed as Record<string, string>
  } catch (err) {
    // A failing adapter only loses its notes; fleet works without them. Say so once per new reason.
    const why = plain() ? plainError((err as Error)?.message) : String(err)
    if (why !== lastAnnotateError) $.ui.log(`fleet: annotate command failed: ${why}`)
    lastAnnotateError = why
  } finally {
    annotating = false
  }
}

/** The rows for the current agents, each named by its Agent call's `name` when the list lacks one. */
function currentRows(now: number): Row[] {
  if (plain()) {
    // Ids, numbers and codes only: no name, description, type or annotate note
    const bare = agents.map(a => {
      const end = finished.get(a.id)
      const stale = a.status === 'running' && end !== undefined && end >= (ledger.get(a.id)?.lastStepAt ?? 0) && now - end >= 30_000
      return { id: plainId(a.id), status: stale ? 'completed' : plainCode(a.status, AGENT_STATUSES) }
    })
    const byIdNotes = Object.fromEntries(agents.flatMap(a => [a.id, a.name, a.description].filter((k): k is string => !!k && notes[k] !== undefined).slice(0, 1).map(k => [plainId(a.id), notes[k]!])))
    return buildRows(bare, ledger, byIdNotes, now, cfg, Object.fromEntries(guardMarks)).map(({ note: _note, ...r }) => r)
  }
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
  return buildRows(named, ledger, notes, now, cfg, Object.fromEntries(guardMarks))
}

const fleetStart = async ($: any, e: any, next: any): Promise<any> => {
  await fleetConfigure($)
  try {
    await $.command.register({ ...registration(FLEET), immediate: true })
  } catch {}
  return next(e)
}

/** Reads fleet's settings and (re)starts its timers. */
async function fleetConfigure($: any): Promise<void> {
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
      const who = plain() ? undefined : agents.find(a => a.id === id)
      const text = `${who?.name ?? who?.description ?? plainId(id)} woke after ${Math.round(v.idleMinutes)} min and re-wrote ${tokens(v.written)} cache tokens`
      $.ui.toast(text)
      $.ui.log('fleet: ' + text)
    }
  }
  return result
}

/** What `/tether-fleet text` answers under plainOutput: the table is not put in the transcript. */
const PLAIN_FLEET_TEXT = 'tether: /tether-fleet text is off under plainOutput; open the pane with /tether-fleet'

const registerFleet: Register = (on) => {
  // The config file is picked at the first read (it needs the environment): a new load picks again
  source = undefined
  rootCache = undefined
  lockedSeen = false


  // Every model request, main loop and subagents alike: keep the ledger, and flag a cold re-write.

  // Waking a decided agent, or a big one on an expired cache: refuse, with the reason and the way to insist.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const deny = coldGuard(e as any, agents, ledger, await $.clock.now(), cfg, names, (await guardStore($)).decisions, plain())
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

  // `/tether-fleet` opens the pane; `/tether-fleet text` answers in the transcript (also what headless sessions get).
  on('command.run', { command: FLEET.name }, async ($, e) => {
    if (halted) return { text: HALT_TEXT }
    await refresh($)
    const wantsText = (e as any).args?.trim() === 'text'
    // Under plainOutput the transcript gets no table: it is a text the session keeps
    if (plain() && wantsText) return { text: PLAIN_FLEET_TEXT }
    let placed = false
    if (!wantsText) {
      try {
        placed = Boolean((await $.ui.open({ ...paneSpec(), focus: true, closeOnEscape: true }))?.isPlaced)
      } catch {}
    }
    // Where no pane can show (headless, or asked for text), answer in the transcript instead.
    if (wantsText || !placed) {
      if (plain()) return { text: PLAIN_FLEET_TEXT }
      const now = await $.clock.now()
      const rows = currentRows(now)
      return { text: [summary(rows, ledger.get('main')?.contextTokens, limits, coldToday, cfg), ...(rows.length ? [headerCells(cfg).map(c => c.text).join('').trimEnd()] : []), ...rows.map(r => rowText(r, cfg))].join('\n') }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // Each part's section only while that part is on
    const fleetOn = cfg.enabled
    const rows = fleetOn ? currentRows(now) : []
    const head = summary(rows, ledger.get('main')?.contextTokens, limits, coldToday, cfg)
    const cols = (e as any).props?.bodyColumns ?? 80
    // Watch's own pollers, live; else the boxes another session's watch wrote to fleet's watchState file
    const watchState = wcfg.enabled && wcfg.pollers.length > 0 ? stateNow(now) : undefined
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
        {!fleetOn && !wcfg.enabled && (
          <Text dimColor wrap="truncate-end">
            Fleet and Watch are off in the config.
          </Text>
        )}
        {fleetOn && (
          <Text bold wrap="truncate-end">
            {head}
          </Text>
        )}
        {fleetOn && rows.length === 0 && (
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
        {watchState && WatchBoxes($.ui.resolve(e), watchState, now, cols)}
        {!watchState && fleetOn && watchBoxes && !plain() && Boxes($.ui.resolve(e), watchBoxes, now, cols)}
      </Box>
    )
  })
}


// ---- WATCH ----
// watch: run a project's pollers inside the session and wake the model only for what is new. What is new, and what
// the agent guard raises, waits in the notice queue (src/notices), which decides when a wake goes.
//
// The hooks only wire Claude Code's events to the pure functions in ../src, which the tests cover.
// Timers and module variables survive /clear; the seen-set and the findings not yet told live in
// $.store, so a reload or a restart neither repeats a finding nor loses one.



/** The config file when the `configPath` option is empty, relative to the session's working directory. */
const WATCH_CONFIG_FILE = CONFIG_FILE
/** How often watch checks whether pending findings can be delivered. */
const DELIVER_MS = 5_000
/** Log lines kept per poller (the box shows the newest few). */
const LOG_KEEP = 50

/** What the last run of a poller came to, for /tether-watch and the status line. */
type LastRun = { at: number; ok: boolean; found: number; told: number; error?: string; /** Lines a plainOutput command printed that were not findings. */ dropped?: number }

let watchConfigFile = WATCH_CONFIG_FILE
let wcfg: WatchConfig = WATCH_DEFAULTS
let problems: string[] = []
let watchTimers: Array<{ cancel: () => void }> = []
/** Pollers with a run in flight: a slow command never runs twice at once. */
const running = new Set<string>()
const lastRun = new Map<string, LastRun>()
/** The notices waiting to be told, and the state of the wakes sent for them (src/notices). */
const notices = new Notices()
/** Subagents' last model request and context, from turn.step. */
const steps = new Map<string, { at: number; context: number }>()
/** When watch first saw each agent, for one that has made no request yet. */
const firstSeen = new Map<string, number>()
/** When a subagent was last seen at work: the idle wake counts its idle minutes from it too. */
let lastAtWork = 0
/** The main loop's own background tasks (shells, monitors) live at its last Stop: the idle wake waits for them. */
let mainBackground = 0

/** When each poller's next timed run starts (epoch ms), for the countdown. */
const nextAt = new Map<string, number>()
/** Each poller's findings log, oldest first; kept in $.store so a reload keeps it. */
let logs: Record<string, LogLine[]> = {}
/** The last state-file failure logged, so a bad path is reported once. */
let stateError = ''

/** The $.store keys of this config's seen-set and pending findings. */
const seenKey = () => `seen:${storeSpace()}`
const pendingKey = () => `pending:${storeSpace()}`
const toldKey = () => `told:${storeSpace()}`
const logKey = () => `log:${storeSpace()}`
/** The store name; plainOutput keeps its own seen-set, findings and logs, so nothing told before it is told under it. */
const storeSpace = () => (plain() ? `plain:${wcfg.storeName}` : wcfg.storeName)

/** Reads and parses the config file; problems are logged once per load. */
async function loadWatchConfig($: any, watchReuse = false): Promise<void> {
  const { root, problem } = await readTetherConfig($, watchReuse)
  if (halted) {
    wcfg = { ...WATCH_DEFAULTS, enabled: false, pollers: [] }
    problems = []
    return
  }
  if (problem) {
    wcfg = WATCH_DEFAULTS
    problems = [problem]
  } else {
    // Without a file the options alone are the settings
    // An agents poller without its own contextTokens wakes at the subagent max context, the fleet setting
    const parsed = parseConfig(layered(optionLayer(), 'watch', root?.watch), mergeConfig(layered(optionLayer(), 'fleet', root?.fleet)).retireContextTokens)
    wcfg = parsed.config
    problems = parsed.problems
    if (!policy.network) {
      // `network: false`: the PR guard reads GitHub, so its pollers do not run
      // The issues poller reads GitHub too
      for (const p of wcfg.pollers) if (p.kind === 'prs' || p.kind === 'issues') $.ui.log(`watch: ${p.id} is off (network is false)`)
      wcfg = { ...wcfg, pollers: wcfg.pollers.filter(p => p.kind !== 'prs' && p.kind !== 'issues') }
    }
  }
  if (plain() && problems.length > 0) $.ui.log(`watch: ${problems.length} config problem${problems.length === 1 ? '' : 's'}`)
  else for (const p of problems) $.ui.log(`watch: ${p}`)
  const saved = await $.store.get(logKey())
  logs = saved && typeof saved === 'object' ? (saved as Record<string, LogLine[]>) : {}
}

/** What the notice queue needs from the plugin API (it may not touch `$` itself, see src/notices/queue.ts). */
function noticePorts($: any): NoticePorts {
  return {
    now: () => $.clock.now(),
    load: () => $.store.get(pendingKey()),
    save: async list => {
      await $.store.set(pendingKey(), list)
    },
    draft: async () => (await $.prompt.read())?.text ?? '',
    submit: text => $.prompt.submit({ text }),
    log: text => $.ui.log(text),
    toast: text => $.ui.toast(text),
    changed: () => status($),
  }
}

/** The delivery settings from the watch config. */
function wakeRules(): WakeRules {
  return { gapSeconds: wcfg.minWakeGapSeconds, deferMinutes: wcfg.deferWhileTypingMinutes, resendAfterMinutes: wcfg.resendAfterMinutes, preamble: wcfg.wakePreamble, plain: plain() }
}

/** Runs one command poller and returns its findings, or an error. */
async function runCommand($: any, p: CommandPoller): Promise<{ findings?: Finding[]; error?: string; dropped?: number }> {
  try {
    const r = await runChecked($, p.command, { timeoutMs: p.timeoutMs, ...(p.cwd ? { cwd: p.cwd } : {}) })
    if (r.refused) return { error: r.refused }
    if (plain()) {
      const out = readPlainOutput(p, r)
      return out.ok ? { findings: out.findings, dropped: out.dropped } : { error: out.error }
    }
    const out = readOutput(p, r)
    return out.ok ? { findings: out.findings } : { error: out.error }
  } catch (err) {
    return { error: plain() ? 'failed' : String(err) }
  }
}

/** One run of an issues poller: every open issue carrying one of its labels, read with `gh` per label. */
async function issuesFindings($: any, p: IssuesPoller): Promise<{ findings?: Finding[]; error?: string }> {
  try {
    const findings: Finding[] = []
    for (const label of p.labels) {
      const argv = ['gh', 'issue', 'list', '--state', 'open', '--label', label, '--limit', String(p.limit), '--json', 'number']
      const r = await runChecked($, argv, { timeoutMs: p.timeoutMs, ...(p.cwd ? { cwd: p.cwd } : {}) })
      if (r.refused) return { error: r.refused }
      if (r.exitCode !== 0) {
        const why = String(r.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''
        return { error: plain() ? `exit ${r.exitCode}` : `gh issue list: exit ${r.exitCode}${why ? ': ' + why.slice(0, 200) : ''}` }
      }
      findings.push(...issueFindings(label, JSON.parse(r.stdout)))
    }
    return { findings }
  } catch (err) {
    return { error: plain() ? 'bad-output' : String(err) }
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
  await loadTasks($)
  // The background tasks of the agents that are not running: the ones that can wake themselves
  const tasks = new Map<string, string[]>()
  const pinned = new Map<string, boolean>()
  for (const a of list) {
    if (a.status !== 'running' && a.status !== 'failed' && a.status !== 'killed') tasks.set(a.id, await tasksOf($, a.id, now))
    pinned.set(a.id, await pinnedOf($, a.id, now))
  }
  return list.map(a => {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, now)
    const s = steps.get(a.id)
    const l = s ? undefined : ledger.get(a.id)
    return {
      id: a.id,
      status: a.status,
      // Under plainOutput every line about an agent names it by its id
      label: plain() ? plainId(a.id) : a.name ?? a.description ?? a.type ?? a.id,
      ...(plain() ? { status: plainCode(a.status, AGENT_STATUSES) } : {}),
      lastStepAt: s?.at ?? l?.lastStepAt ?? firstSeen.get(a.id)!,
      ...(s ? { contextTokens: s.context } : l ? { contextTokens: l.contextTokens } : {}),
      ...(finished.has(a.id) ? { finishedAt: finished.get(a.id)! } : {}),
      ...(tasks.has(a.id) ? { tasks: tasks.get(a.id)! } : {}),
      ...(agentModels.get(a.id) ? { model: agentModels.get(a.id)! } : {}),
      ...(pinned.get(a.id) ? { pinned: true } : {}),
    }
  })
}

/** Runs one poller, keeps what is new, toasts it, and tries to deliver. */
async function poll($: any, p: Poller, thenDeliver = true): Promise<void> {
  if (running.has(p.id)) return
  running.add(p.id)
  await publish($)
  try {
    let result: { findings?: Finding[]; error?: string; dropped?: number }
    if (p.kind === 'agents') {
      try {
        const at = await $.clock.now()
        const seen = await agentsSeen($, at)
        const guard = { store: await guardStore($), cacheMinutes: cfg.cacheTtlMinutes, smallTokens: cfg.bigContextTokens, leadMinutes: gCfg.leadMinutes }
        result = { findings: agentFindings(p, seen, at, guard) }
        // The Stop hook blocks over the same agents the poller tells
        lastUndecided = undecided(seen, guard.store, agentRules(), at)
      } catch (err) {
        result = { error: String(err) }
      }
    } else if (p.kind === 'prs') {
      result = await prsFindings($, p)
    } else if (p.kind === 'issues') {
      result = await issuesFindings($, p)
    } else {
      result = await runCommand($, p)
    }
    const now = await $.clock.now()
    // Under plainOutput a failure is a code, a key is kept as a hash, and the poller is named by its id
    if (plain() && result.error !== undefined) result = { error: plainError(result.error) }
    if (plain() && result.findings) result = { ...result, findings: result.findings.map(f => ({ key: hashKey(f.key), text: f.text })) }
    const title = plain() ? p.id : p.title
    if (!result.findings) {
      // Say a failure once per new reason; the status line keeps showing it
      const before = lastRun.get(p.id)
      if (before?.error !== result.error) $.ui.log(`watch: ${p.id} failed: ${result.error}`)
      lastRun.set(p.id, { at: now, ok: false, found: 0, told: 0, error: result.error ?? 'failed' })
      return
    }
    const seen = ((await $.store.get(seenKey())) ?? {}) as Seen
    const told = ((await $.store.get(toldKey())) ?? {}) as Told
    const next = fresh(seen, p, result.findings, now, told)
    await $.store.set(seenKey(), next.seen)
    // Written only when it changed, so a poll with nothing to remind does not write the store
    if (JSON.stringify(next.told) !== JSON.stringify(told)) await $.store.set(toldKey(), next.told)
    lastRun.set(p.id, { at: now, ok: true, found: result.findings.length, told: next.fresh.length, ...(result.dropped ? { dropped: result.dropped } : {}) })
    if (next.fresh.length > 0) {
      await addLog($, p.id, now, next.fresh.map(f => f.text))
      $.ui.toast(`watch: ${next.fresh.length} new from ${title}`)
      if (p.wake) {
        const add = next.fresh.map(f => ({ ...f, poller: p.id, title, wake: true, at: now }))
        // A reminder for a finding still waiting to be told joins it, not a second copy
        await notices.merge(noticePorts($), add)
      } else {
        for (const f of next.fresh) $.ui.log(`watch: ${title}: ${f.text}`)
      }
    }
  } finally {
    running.delete(p.id)
    await status($)
    await publish($)
  }
  if (thenDeliver) await deliver($)
}

/** Starts a turn for the pending notices when the session is idle, nobody is typing and the gap has passed. */
async function deliver($: any): Promise<void> {
  if (halted) return
  await notices.deliver(noticePorts($), wakeRules(), (now, held) => idleWake($, now, held))
}

/** Wakes the model when it has sat `idleWakeMinutes` idle with nothing found and no subagent at work. */
async function idleWake($: any, now: number, held: boolean): Promise<void> {
  // The cheap checks first, so an idle session with the option off reads nothing
  if (wcfg.idleWakeMinutes <= 0 || notices.busy || held) return
  if (now - Math.max(notices.idleSince, notices.lastWakeAt, lastAtWork) < wcfg.idleWakeMinutes * 60_000) return
  let working = 0
  try {
    // An agent that has stopped but still has background tasks (a build it waits on) counts as at work
    working = atWork(await agentsSeen($, now))
  } catch {
    // An agent list that cannot be read is no reason to wake
    return
  }
  if (working > 0) {
    // Its work ending is no idle time: the minutes count again from the last time it was seen at work
    lastAtWork = now
    return
  }
  const draft = (await $.prompt.read())?.text ?? ''
  const state = { minutes: wcfg.idleWakeMinutes, busy: notices.busy, held, draft, agentsAtWork: working, mainBackground, now, idleSince: notices.idleSince, lastAtWork, lastWakeAt: notices.lastWakeAt }
  if (!idleWakeDue(state)) return
  await notices.submit(noticePorts($), wakeRules(), now, wcfg.idleWakeText.split('{minutes}').join(String(wcfg.idleWakeMinutes)), [])
  await status($)
}

/** One poller's box data: its countdown, its last run and its log. */
function boxState(p: Poller): BoxState {
  const r = lastRun.get(p.id)
  const at = nextAt.get(p.id)
  return {
    id: p.id,
    title: plain() ? p.id : p.title,
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
    if (String(err) !== stateError) $.ui.log(plain() ? 'watch: the state file was not written' : `watch: state file ${wcfg.stateFile} not written: ${err}`)
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
  const pending = notices.count
  if (pending) parts.push(`${pending} to tell`)
  if (notices.refused) parts.push('wake refused')
  const failing = wcfg.pollers.filter(p => lastRun.get(p.id)?.ok === false).map(p => p.id)
  if (failing.length) parts.push(`failing: ${failing.join(', ')}`)
  if (problems.length) parts.push(`${problems.length} config problem${problems.length === 1 ? '' : 's'}`)
  watchStatus = parts.join(' · ')
  showStatus($)
}

/** Minutes ago, for /tether-watch. */
function ago(now: number, at: number): string {
  return `${Math.round((now - at) / 60_000)} min ago`
}

/** /tether-watch's report: each poller's last run, what waits to be told, the config's problems. */
async function report($: any): Promise<string> {
  const now = await $.clock.now()
  const lines = [plain() ? `watch: ${wcfg.pollers.length} pollers` : `watch: ${watchConfigFile}, ${wcfg.pollers.length} pollers`]
  for (const p of wcfg.pollers) {
    const r = lastRun.get(p.id)
    const what = !r ? 'not run yet' : r.ok ? `${r.found} found, ${r.told} new${r.dropped ? `, ${r.dropped} dropped` : ''}, ${ago(now, r.at)}` : `FAILED ${ago(now, r.at)}: ${r.error}`
    lines.push(`- ${p.id} (every ${p.everySeconds}s${p.wake ? '' : ', no wake'}${running.has(p.id) ? ', running' : ''}, next in ${remaining(p, now)}): ${what}`)
  }
  const pending = await notices.pending(noticePorts($))
  if (pending.length) lines.push(`to tell: ${pending.length} (${notices.busy ? 'a turn is running' : 'next idle moment'})`)
  if (plain() && problems.length > 0) lines.push(`config: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  else for (const p of problems) lines.push(`config: ${p}`)
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
    if ((await $.ui.panes()).some((x: any) => x.id === PANE && x.isPlaced)) $.ui.invalidate('ui.render')
  } catch {}
}

/** `/tether-watch reload`: reads the config file again and applies it to every part. */
async function reloadAll($: any): Promise<void> {
  const wasPlain = plain()
  await readTetherConfig($)
  if (plain() !== wasPlain) {
    // What was read under the other rule is not shown under this one
    lastProblems = []
    lastUndecided = []
    guardNotes.length = 0
    lastRun.clear()
  }
  await checkpointStart($)
  await guardsStart($)
  await fleetConfigure($)
  await loadWatchConfig($, true)
  await schedule($)
  await status($)
  showStatus($)
}

const watchStart = async ($: any, e: any, next: any): Promise<any> => {
  notices.idleSince = await $.clock.now()
  await loadWatchConfig($, true)
  await notices.pending(noticePorts($))
  await schedule($)
  try {
    await $.command.register({ ...registration(WATCH), immediate: true })
  } catch {}
  await status($)
  return next(e)
}

const watchComplete = async ($: any, e: any, next: any): Promise<any> => {
  const r = await next(e)
  if (!(e as any).agentId) {
    notices.turnEnded(await $.clock.now())
    void deliver($)
  } else {
    // A subagent's turn ending is work: the idle wake counts its minutes from here
    lastAtWork = await $.clock.now()
  }
  return r
}

async function* watchStep($: any, e: any, next: any): any {
  const result: any = yield* next(e)
  const id = (e as any).agentId
  const u = result?.usage
  if (id && typeof (e as any).model === 'string') agentModels.set(id, (e as any).model)
  // Each request of a subagent is work, so the idle wake counts its minutes from the last one
  if (id) lastAtWork = await $.clock.now()
  if (id && u) {
    const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    steps.set(id, { at: await $.clock.now(), context })
  }
  return result
}

const registerWatch: Register = (on) => {

  // Only the main loop's turns make the session busy; subagents run beside an idle session.
  on('turn.start', async ($, e, next) => {
    // A subagent's turn leaves the session free; a main-loop turn takes in the wake sent and lifts a refusal's hold.
    // Any main-loop turn counts, the person's too: a wake submitted while they start one is taken in by their turn
    // or the next, so it is not resent. Telling the two apart would need the turn's prompt, which may be rewritten.
    if (!(e as any).agentId) {
      notices.turnStarted()
    }
    return next(e)
  })


  // Each subagent request: when it ended and how big the context is, for the agents poller.

  // `/tether-watch` reports and opens the Tether pane; `run [id]` polls now; `forget [id]` clears the seen-set so findings are new again; `reload` re-reads the config; `pane` opens and focuses the Tether pane.
  on('command.run', { command: WATCH.name }, async ($, e) => {
    const [verb, id] = String((e as any).args ?? '').trim().split(/\s+/)
    if (verb === 'reload') {
      // Re-reads the same file (picked once per load of the module), and every part follows it
      await reloadAll($)
      return { text: halted ? HALT_TEXT : await report($) }
    }
    if (halted) return { text: HALT_TEXT }
    const chosen = (id ? wcfg.pollers.filter(p => p.id === id) : wcfg.pollers)
    if (id && chosen.length === 0) return { text: `watch: no poller "${id}"` }
    if (verb === 'run') {
      // A command cannot start a turn while it runs: the delivery tick tells what this run found
      await Promise.all(chosen.map(p => poll($, p, false)))
    } else if (verb === 'forget') {
      const seen = ((await $.store.get(seenKey())) ?? {}) as Seen
      for (const p of chosen) delete seen[p.id]
      await $.store.set(seenKey(), seen)
    } else if (verb === 'pane') {
      let placed = false
      try {
        placed = Boolean((await $.ui.open({ ...paneSpec(), focus: true, closeOnEscape: true }))?.isPlaced)
      } catch {}
      // Where no pane can show (headless), the report answers instead
      if (placed) return {}
    } else if (!verb) {
      // The report, and the Tether pane opened beside it (its boxes sit under Fleet's table)
      openPaneQuietly($)
    }
    return { text: await report($) }
  })
  // The boxes are drawn in the Tether pane, under Fleet's table (registerFleet's ui.render).
}

/** Opens the Tether pane without taking the focus; a pane that cannot be placed is left unopened. */
function openPaneQuietly($: any): void {
  try {
    void Promise.resolve($.ui.open({ ...paneSpec(), closeOnEscape: true })).catch(() => {})
  } catch {}
}

// ---- both parts ----

// ---- CHECKPOINT ----
// The checkpoint cycle (src/checkpoint): when the session is long and quiet, ask for a handoff, check it,
// then clear and continue from it. The decisions are pure (src/checkpoint/cycle.ts); this part reads the
// session and carries them out. The continue prompt waits in $.store, so a reload between the clear and
// the continue cannot lose it.

const CHECKPOINT_CONTINUE_KEY = 'checkpoint:continue'
/** How long after the clear command the new session must have started, or the clear counts as not done. */
const CLEAR_WAIT_MS = 30_000
let cpCfg: CheckpointConfig = CHECKPOINT_DEFAULTS
/** The plugin's options (`/plugin configure tether@tether`): the defaults the project file overrides. */
let options: Record<string, unknown> = {}
let cpState: CycleState = initialCycle()
let cpTimers: Array<{ cancel: () => void }> = []
/** One tick at a time: a tick awaits the prompt and the clear, and the next must not start meanwhile. */
let cpTicking = false
/** The line the pane shows for the checkpoint, refreshed each tick. */
let cpLine = ''

/**
 * The checkpoint config from the config file and the options, with this session's handoff file from
 * TETHER_HANDOFF_FILE (HANDOFF_ENV) when it is set; a bad one turns the checkpoint off and is logged.
 */
async function checkpointConfig($: any, root: Record<string, unknown> | undefined): Promise<CheckpointConfig> {
  let env: string | undefined
  try {
    // The literal name, so the engine can list what the module reads (it is HANDOFF_ENV)
    env = (await $.env.get('TETHER_HANDOFF_FILE')) ?? undefined
  } catch {
    // An environment Tether cannot read names no handoff file
  }
  const { cfg, problem } = withHandoffEnv(mergeCheckpoint(layered(optionLayer(), 'checkpoint', root?.checkpoint)), env)
  if (problem) $.ui.log(`checkpoint: off, ${problem}`)
  return cfg
}

/** Reads the checkpoint section of the config and starts the tick. */
async function checkpointStart($: any): Promise<void> {
  const { root } = await readTetherConfig($, true)
  cpCfg = halted ? { ...CHECKPOINT_DEFAULTS, enabled: false, injectHandoff: false } : await checkpointConfig($, root)
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
    const draft = notices.busy ? '' : ((await $.prompt.read())?.text ?? '')
    // A resumed session has made no request Tether saw: take the engine's figure until it does
    if (!((ledger.get('main')?.steps ?? 0) > 0)) await backfillMain($)
    const contextTokens = ledger.get('main')?.contextTokens ?? 0
    // The handoff is read only once a handoff is in progress, the messages from the tick that may ask on: the
    // count at the ask is the baseline later ticks are measured against, so it must be the real one
    const inProgress = cpState.phase !== 'idle'
    const mayAsk = !inProgress && (cpState.forced || contextTokens >= cpCfg.contextTokens)
    // New information: the person's and the main agent's messages, not the cycle's own prompts or their replies
    const messages = inProgress || mayAsk ? newInformation((await $.session.messages()) as Array<{ role: string; text?: string }>, cpCfg) : 0
    const problems = inProgress ? await handoffCheck($) : []
    const observed: Observed = { now, contextTokens, busy: notices.busy, draft, messages, problems }
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
    $.ui.log(plain() ? 'checkpoint: the clear failed' : `checkpoint: the clear failed: ${err}`)
    await clearNotDone($)
    return
  }
  // The new session's start takes the flag; it may come after the command returns, so look again later
  $.clock.after(CLEAR_WAIT_MS, async () => {
    if ((await $.store.get(CHECKPOINT_CONTINUE_KEY)) === true) await clearNotDone($)
  })
}

/** `/tether-checkpoint`: start the cycle now when it is on and idle; the next tick asks once the session is quiet. */
async function checkpointCommand($: any): Promise<{ text: string }> {
  if (halted) return { text: 'checkpoint: off, the config failed closed, so nothing was started' }
  const { state, reply } = forceCheckpoint(cpState, cpCfg)
  cpState = state
  $.ui.log(reply)
  return { text: reply }
}

/** The clear did not happen: drop the continue and wait before asking again, since the session is still long. */
async function clearNotDone($: any): Promise<void> {
  await $.store.set(CHECKPOINT_CONTINUE_KEY, false)
  cpState = backedOff(await $.clock.now(), cpCfg)
  $.ui.toast('checkpoint: the clear did not happen')
}

/**
 * Set by a clear when `injectHandoff` is on: the next prompt carries the handoff as context (no session start, and
 * so no SessionStart context, follows a clear). A session start that injects it clears this, so it is added once.
 */
let injectNext = false

/** Takes the pending injection: the handoff's context text, logged, or undefined when there is none to add. */
async function takeInjection($: any): Promise<string | undefined> {
  injectNext = false
  const text = await handoffContext($)
  if (text !== undefined) $.ui.log(`checkpoint: added ${cpCfg.handoffFile} to the session`)
  return text
}

/** How often, after a clear, Tether looks whether the process runs under the new session's id yet. */
const NEW_SESSION_POLL_MS = 250

/**
 * After any clear, Tether's or the person's (`session.end` with reason `clear`: no session start follows it):
 * the cycle starts over and the old session's context size is forgotten (it survives /clear, and would make the
 * new session look due at once). When the clear was the checkpoint's, the new session continues from the
 * handoff once the process runs under the new session's id, and a second later, so the session has settled.
 */
async function checkpointAfterClear($: any, endedId: string): Promise<void> {
  cpState = initialCycle()
  ledger.delete('main')
  mainClearedSinceStart = true
  if (halted) return
  // No session start follows a clear: reopen the pane here, and add the handoff to the next prompt
  openAtStart($)
  injectNext = cpCfg.injectHandoff
  if ((await $.store.get(CHECKPOINT_CONTINUE_KEY)) !== true) return
  await $.store.set(CHECKPOINT_CONTINUE_KEY, false)
  const started = await $.clock.now()
  const submit = async () => {
    $.ui.log(`checkpoint: cleared; continuing from ${cpCfg.handoffFile}`)
    await $.prompt.submit({ text: continueText(cpCfg) })
  }
  const look = async (): Promise<void> => {
    let id = endedId
    try {
      id = String(await $.session.id())
    } catch {
      // An id Tether cannot read counts as the old one, until the wait is over
    }
    if (id !== endedId || (await $.clock.now()) - started >= CLEAR_WAIT_MS) {
      $.clock.after(1000, submit)
      return
    }
    $.clock.after(NEW_SESSION_POLL_MS, look)
  }
  await look()
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

// ---- The agent guard's own actions ----
// A stopped agent holding a big context loses its prompt cache `cacheTtlMinutes` after its last request. One with
// live background work wakes itself when that reports, so waiting for the model to decide is not enough: every
// minute a timer asks planActions (src/guards/agents.ts) what to do, and Tether does it through the plugin API:
// `$.session.send` messages the agent (a keep-warm ping is a cache read; a handover request is the same read) and
// `$.tool.call({ tool: 'TaskStop' })` stops the background tasks it leaves behind, only after it has stopped itself.
// What the API cannot do (list an agent's tasks; know a message was acted on) is covered in the README's agent guard
// section. When nothing here can act, the agent stays a finding and the Stop hook blocks, as before.

let gCfg: CacheGuardConfig = CACHE_GUARD_DEFAULTS
let guardTimer: { cancel: () => void } | undefined
let guardTicking = false
/** When the running tick started: a tick stuck for longer than GUARD_TICK_MAX_MS no longer blocks the next one. */
let guardTickStart = 0
const GUARD_TICK_MAX_MS = 5 * 60_000
/** The longest one send or one TaskStop may take; a permission dialog nobody answers must not stall the other agents. */
const ACTION_TIMEOUT_MS = 30_000
/** Live background tasks by agent id, from the rows appended to its conversation and the last readable transcript. */
const bgTasks = new Map<string, Set<string>>()
let tasksLoaded = false
/** Task ids Tether stopped itself: not live any more, whatever the transcript still shows until its notification is written. */
const stoppedIds = new Set<string>()
/** A transcript larger than this is not read: `$.fs.read` rejects a file over 4 MiB. */
const FS_READ_LIMIT = 4_000_000
/** What a transcript showed, by agent, valid while the file's mtime stands. */
const taskCache = new Map<string, { mtime: number; tasks: string[] }>()
/** The model of each subagent's last request: from turn.step, else the transcript. */
const agentModels = new Map<string, string>()
/** Whether the Agent call pinned a model for the agent (its .meta.json names one), once looked up. */
const pinnedModels = new Map<string, boolean>()
/** The flags the pane shows for what the guard did, by agent id. */
const guardMarks = new Map<string, string[]>()
/** What the guard did, newest last, for /tether-guards. */
const guardNotes: string[] = []
/** The last failure told per agent, so a persistent one is logged once. */
const guardErrors = new Map<string, string>()
/** Alerts already told (agent, kind and cycle), so one that could not be saved is not told every tick. */
const toldAlerts = new Set<string>()
/** Serialises the guard store's read-modify-write cycles (the tick, the decision and owner tools, the prs poller). */
let storeChain: Promise<unknown> = Promise.resolve()

/** Changes the guard store under a lock, so two writers cannot overwrite each other's change. */
function updateGuardStore($: any, change: (s: GuardStore) => GuardStore): Promise<GuardStore> {
  // A hung $.store call times out, so it cannot block every later writer
  const run = storeChain.then(async () => {
    const next = change(await withTimeout($, guardStore($), ACTION_TIMEOUT_MS, 'store.get'))
    await withTimeout($, saveGuardStore($, next), ACTION_TIMEOUT_MS, 'store.set')
    return next
  })
  storeChain = run.catch(() => undefined)
  return run
}

/** Runs `p`, but gives up (rejects) after `ms`, so one blocked call cannot stall the tick. */
function withTimeout<T>($: any, p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)))
    p.then(
      v => {
        timer.cancel?.()
        resolve(v)
      },
      err => {
        timer.cancel?.()
        reject(err)
      },
    )
  })
}

/** The thresholds the agent guard works to. */
function agentRules(): AgentRules {
  return { cacheMinutes: cfg.cacheTtlMinutes, smallTokens: cfg.bigContextTokens, leadMinutes: gCfg.leadMinutes }
}

/** Clock time `HH:MM` of an epoch ms. */
function clockOf(ms: number): string {
  return localStamp(ms).slice(11, 16)
}

/** Loads the persisted background tasks once. */
async function loadTasks($: any): Promise<void> {
  if (tasksLoaded) return
  tasksLoaded = true
  const saved = await $.store.get(`guards:tasks:${wcfg.storeName}`)
  if (saved && typeof saved === 'object') {
    for (const [id, list] of Object.entries(saved as Record<string, unknown>)) {
      if (Array.isArray(list)) bgTasks.set(id, new Set(list.filter((t): t is string => typeof t === 'string')))
    }
  }
}

/** Keeps the live task sets in $.store, so a reload or a restart still knows them. */
async function persistTasks($: any): Promise<void> {
  await $.store.set(`guards:tasks:${wcfg.storeName}`, Object.fromEntries([...bgTasks].filter(([, t]) => t.size > 0).map(([k, t]) => [k, [...t]])))
}

/** Notes the background tasks a row appended to a subagent's conversation starts or ends (by the row's structure, not its words). */
async function noteRow($: any, e: any): Promise<void> {
  const id = e.agentId
  if (typeof id !== 'string' || (e.message?.type !== 'user' && e.message?.type !== 'attachment')) return
  await loadTasks($)
  const live = bgTasks.get(id) ?? new Set<string>()
  const before = [...live].join()
  noteAppendedRow(e, live)
  if ([...live].join() === before) return
  bgTasks.set(id, live)
  await persistTasks($)
}

/** Whether the Agent call pinned a model for an agent (its .meta.json): a message then wakes it on that model, not the session's. */
async function pinnedOf($: any, id: string, now: number): Promise<boolean> {
  const known = pinnedModels.get(id)
  if (known !== undefined) return known
  try {
    const bases = await transcriptsOf($, id, now)
    let looked = false
    for (const base of bases) {
      if (!(await $.fs.exists(base + '.meta.json'))) continue
      looked = true
      if (metaModel(String(await $.fs.read(base + '.meta.json'))) !== undefined) {
        pinnedModels.set(id, true)
        return true
      }
    }
    // Remember a "no" only once a meta file was actually read
    if (looked) pinnedModels.set(id, false)
  } catch {
    // Unreadable: not proven pinned
  }
  return false
}

/**
 * The live background tasks of a subagent. A transcript small enough to read is the truth and becomes the baseline
 * the appended rows go on from, so tasks seen there are kept when the file later grows past the read limit; a bigger
 * one leaves the appended rows (and that baseline) as the only source. Tasks Tether stopped itself are left out.
 */
async function tasksOf($: any, id: string, now: number): Promise<string[]> {
  let tasks: string[] | undefined
  try {
    const bases = await transcriptsOf($, id, now)
    if (bases.length > 0) {
      const file = bases[0] + '.jsonl'
      const st = await $.fs.stat(file)
      if (st.size <= FS_READ_LIMIT) {
        const known = taskCache.get(id)
        if (known && known.mtime === st.mtimeMs) tasks = known.tasks
        else {
          const text = String(await $.fs.read(file))
          tasks = liveTasks(text)
          taskCache.set(id, { mtime: st.mtimeMs, tasks })
          if (!agentModels.has(id)) {
            const last = lastRequest(text)
            if (last?.model) agentModels.set(id, last.model)
          }
        }
        if (tasks.join() !== [...(bgTasks.get(id) ?? [])].join()) {
          bgTasks.set(id, new Set(tasks))
          await persistTasks($)
        }
      }
    }
  } catch {
    // An unreadable transcript leaves the appended rows as the source
  }
  return (tasks ?? [...(bgTasks.get(id) ?? [])]).filter(t => !stoppedIds.has(t))
}

/** What the guard did, as pane flags: pinged, asked to hand over, handed over. */
function refreshMarks(store: GuardStore): void {
  guardMarks.clear()
  for (const [id, d] of Object.entries(store.decisions)) {
    const act = store.actions[id]
    if (d.decision === 'kept-warm') guardMarks.set(id, [`${GUARD_MARK}kept warm ${clockOf(d.atMs)}${act && act.warms > 1 ? ` (x${act.warms})` : ''}`])
    else if (act?.handoverAt !== undefined) guardMarks.set(id, [`${GUARD_MARK}handed over ${clockOf(act.handoverAt)}`])
  }
  for (const [id, act] of Object.entries(store.actions)) {
    if (act.handoverAt !== undefined && !guardMarks.has(id)) guardMarks.set(id, [`${GUARD_MARK}handover asked ${clockOf(act.handoverAt)}${alerted(act, 'handover-late', act.handoverAt) ? ' LATE' : ''}`])
  }
}

/** Tells the coordinator: a toast, a log line, a line for /tether-guards; an alert also wakes the model, as a notice in the queue (src/notices). */
async function reportGuard($: any, text: string, now: number, alert?: { id: string }): Promise<void> {
  guardNotes.push(`${clockOf(now)} ${text}`)
  if (guardNotes.length > 30) guardNotes.shift()
  $.ui.toast(`agent guard: ${text}`)
  $.ui.log(`agent guard: ${text}`)
  if (!alert || !wcfg.enabled) return
  const add: Notice = { key: `${alert.id}|guard|${now}`, text, poller: 'agent-guard', title: 'Agent guard', wake: true, at: now }
  await notices.append(noticePorts($), add)
  void deliver($)
}

/** Messages a subagent through the plugin API; the reason when it was not delivered. */
async function sendToAgent($: any, id: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await withTimeout($, $.session.send({ to: { agentId: id }, text }), ACTION_TIMEOUT_MS, 'session.send')
    return r?.isDelivered ? { ok: true } : { ok: false, reason: String(r?.reason ?? 'not delivered') }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/** Stops the background tasks with TaskStop; the problems (a task that is already gone is not one). */
async function stopTasks($: any, tasks: string[]): Promise<string[]> {
  const problemsOut: string[] = []
  for (const t of tasks) {
    try {
      const r: any = await withTimeout($, $.tool.call({ tool: 'TaskStop', task_id: t }), ACTION_TIMEOUT_MS, 'TaskStop')
      const why = r?.deny ?? (r?.isError ? (r?.text ?? 'error') : undefined)
      if (why !== undefined && !/not found|no such|no task|not running|already/i.test(String(why))) problemsOut.push(`${t}: ${String(why).slice(0, 120)}`)
      else stoppedIds.add(t)
    } catch (err) {
      problemsOut.push(`${t}: ${String(err).slice(0, 120)}`)
      // A call that is not answered (a permission dialog nobody sees) would hold up every task after it too
      if (/did not answer/.test(String(err))) break
    }
  }
  return problemsOut
}

/** Says a failure once per new reason, per agent; the agent stays a finding and the Stop hook blocks. */
function failedOnce($: any, id: string, text: string): void {
  if (guardErrors.get(id) === text) return
  guardErrors.set(id, text)
  $.ui.log(`agent guard: ${text}`)
}

/** A message to an agent failed: said once per reason, and the next message waits (no resend every tick). */
async function sendFailed($: any, id: string, now: number, text: string): Promise<void> {
  failedOnce($, id, text)
  await updateGuardStore($, s => recordAction(s, id, { sendFailedAt: now }))
}

/** The engine's current word on one agent (a fresh $.agent.list), or undefined when it cannot be read. */
async function agentNow($: any, id: string): Promise<{ status: string } | undefined> {
  try {
    return ((await $.agent.list()) as Array<{ id: string; status: string }>).find(a => a.id === id)
  } catch {
    return undefined
  }
}

/** Carries out one planned action; the store changes only for what succeeded. */
async function runPlan($: any, plan: Plan, now: number): Promise<void> {
  const at = localStamp(now).replace('T', ' ').slice(0, 16)
  if (plan.kind === 'warm') {
    const sent = await sendToAgent($, plan.id, gCfg.keepWarmText)
    if (!sent.ok) return sendFailed($, plan.id, now, plain() ? `keep-warm of ${plan.id} failed` : `keep-warm of ${plan.label} (${plan.id}) failed: ${sent.reason}`)
    await updateGuardStore($, s => recordAction(recordDecision(s, plan.id, 'kept-warm', `Tether pinged it (${plan.count})`, at, now), plan.id, { ...NEW_CYCLE, warms: plan.count, warmContext: plan.contextTokens, sendFailedAt: undefined }))
    await reportGuard($, `kept ${plan.label} (${plan.id}) warm (ping ${plan.count}); its background work goes on`, now)
  } else if (plan.kind === 'handover') {
    const sent = await sendToAgent($, plan.id, gCfg.handoverText)
    if (!sent.ok) return sendFailed($, plan.id, now, plain() ? `handover request to ${plan.id} failed` : `handover request to ${plan.label} (${plan.id}) failed: ${sent.reason}`)
    await updateGuardStore($, s => recordAction(s, plan.id, { ...NEW_CYCLE, warms: 0, handoverAt: now, sendFailedAt: undefined }))
    const runsOn = plain() ? 'another model' : plan.model ?? 'an unknown model'
    const why =
      plan.why === 'model'
        ? `; it runs on ${runsOn}, so a ping would wake it on the session's model and write a new cache`
        : plan.why === 'retire'
          ? `; its context is past the ${tokens(cfg.retireContextTokens)} retire line (fleet.retireContextTokens)` +
            (plan.otherModel ? `; it runs on ${runsOn}, so this message wakes it on the session's model and writes one new cache` : '')
          : ''
    await reportGuard($, `asked ${plan.label} (${plan.id}, ${tokens(plan.contextTokens)} context) to hand over and stop${why}; its background tasks are stopped once it has`, now)
  } else if (plan.kind === 'collect') {
    // The plan is a few seconds old: look again before stopping anything, as a finishing task may have woken the agent
    const live = await agentNow($, plan.id)
    if (!live || live.status === 'running') return
    const tasks = await tasksOf($, plan.id, now)
    if (tasks.length === 0) return
    const failed = await stopTasks($, tasks)
    if (failed.length > 0) {
      await updateGuardStore($, s => recordAction(s, plan.id, { stopFailedAt: now }))
      const what = plain() ? `${failed.length} task${failed.length === 1 ? '' : 's'}` : failed.join('; ')
      return reportGuard($, `${plan.label} (${plan.id}) handed over but TaskStop failed for ${what}; stop them yourself, then record it as retired`, now, { id: plan.id })
    }
    const n = tasks.length
    await updateGuardStore($, s => recordAction(s, plan.id, { tasksStoppedAt: now, stoppedCount: n }))
    await reportGuard($, `${plan.label} (${plan.id}) handed over; stopped ${n} background task${n === 1 ? '' : 's'} (${(plain() ? tasks.map(plainId) : tasks).join(', ')}). It is retired once it has settled and waits on nothing else`, now)
  } else if (plan.kind === 'retire') {
    const live = await agentNow($, plan.id)
    if (!live || live.status === 'running' || live.status === 'waiting') return
    const n = plan.stopped
    await updateGuardStore($, s => recordDecision(s, plan.id, 'retired', `handed over; ${n} background task${n === 1 ? '' : 's'} stopped`, at, now))
    await reportGuard($, `${plan.label} (${plan.id}) handed over and is retired${n ? `; ${n} background task${n === 1 ? '' : 's'} stopped` : ''}. Start a fresh agent from its STATUS.md`, now, { id: plan.id })
  } else {
    await updateGuardStore($, s => recordAlert(s, plan.id, plan.key, now))
    const told = `${plan.id}|${plan.key}|${plan.since}`
    if (toldAlerts.has(told)) return
    toldAlerts.add(told)
    await reportGuard($, plan.text, now, { id: plan.id })
  }
  guardErrors.delete(plan.id)
}

/** Recomputes who needs a decision (what the Stop hook blocks over) from the engine's list, tasks and the store. */
async function refreshUndecided($: any): Promise<Undecided[]> {
  const now = await $.clock.now()
  const seen = await agentsSeen($, now)
  const store = await guardStore($)
  refreshMarks(store)
  lastUndecided = undecided(seen, store, agentRules(), now)
  return lastUndecided
}

/**
 * One guard tick: refresh the findings, then do what planActions says; never overlaps itself (a tick stuck for
 * five minutes no longer blocks the next). The messages go out first and together, so no stop or alert can delay a
 * ping that is due; one failing plan does not stop the others.
 */
async function guardTick($: any): Promise<void> {
  const started = await $.clock.now()
  if (!cfg.enabled || (guardTicking && started - guardTickStart < GUARD_TICK_MAX_MS)) return
  guardTicking = true
  guardTickStart = started
  try {
    const now = await $.clock.now()
    const seen = await agentsSeen($, now)
    if (gCfg.auto) {
      const store = await guardStore($)
      let sessionModel: string | undefined
      try {
        sessionModel = String(await $.session.model())
      } catch {
        // Unknown: no agent is then proven safe to ping unless its Agent call pinned a model
      }
      // The retire line is fleet's one subagent max context, so the pane's flag, the poller's wake and this handover agree
      const auto = {
        handoverTokens: gCfg.handoverTokens,
        handoverWaitMinutes: gCfg.handoverWaitMinutes,
        keepWarmMax: gCfg.keepWarmMax,
        ...(sessionModel ? { sessionModel } : {}),
        ...(gCfg.sizeHandover ? { retireTokens: cfg.retireContextTokens } : {}),
      }
      const plans = planActions(seen, store, agentRules(), auto, now)
      const safely = (plan: Plan) => runPlan($, plan, now).catch(err => failedOnce($, plan.id, plain() ? `${plan.kind} of ${plan.id} failed` : `${plan.kind} of ${plan.label} (${plan.id}) failed: ${err}`))
      await Promise.all(plans.filter(x => x.kind === 'warm' || x.kind === 'handover').map(safely))
      for (const plan of plans.filter(x => x.kind !== 'warm' && x.kind !== 'handover')) await safely(plan)
    }
    const store = await guardStore($)
    refreshMarks(store)
    lastUndecided = undecided(seen, store, agentRules(), now)
  } catch (err) {
    failedOnce($, '*', plain() ? 'the tick failed' : `the tick failed: ${err}`)
  } finally {
    // A zombie tick (stuck past the limit, since taken over) must not clear the flag of the tick that owns it now
    if (guardTickStart === started) guardTicking = false
  }
}

/** Open PRs whose idle worktree holds commits origin lacks (the poller's `worktrees` setting). */
async function unpushedIn($: any, p: PrsPoller, heads: Map<number, { branch: string; sha: string }>): Promise<Problem[]> {
  const out: Problem[] = []
  for (const [number, h] of heads) {
    const wt = `${p.worktrees}/${h.branch}`
    if (!(await $.fs.exists(wt))) continue
    if (p.busyMarker && (await $.fs.exists(`${wt}/${p.busyMarker}`))) continue
    const git = async (...args: string[]): Promise<string> => {
      const r = await runChecked($, ['git', '-C', wt, ...args], { timeoutMs: 30_000 })
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
  const run = (command: string[], timeoutMs: number) => runChecked($, command, { timeoutMs, ...(p.cwd ? { cwd: p.cwd } : {}) })
  try {
    const listed = await run(['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', GH_FIELDS], 60_000)
    if (listed.refused) return { error: listed.refused }
    if (listed.exitCode !== 0) return { error: plain() ? `exit ${listed.exitCode}` : `gh pr list: exit ${listed.exitCode}` }
    const list = JSON.parse(listed.stdout) as Array<{ number: number; headRefName: string; headRefOid: string }>
    const heads = new Map(list.map(x => [x.number, { branch: x.headRefName, sha: x.headRefOid }]))
    const now = await $.clock.now()
    let found: Problem[]
    let reruns: ReturnType<typeof rerunsFromHealth> = []
    if (p.command) {
      const r = await run(p.command, p.timeoutMs)
      if (r.refused) return { error: r.refused }
      if (!p.okExitCodes.includes(r.exitCode)) return { error: plain() ? `exit ${r.exitCode}` : `health command: exit ${r.exitCode}` }
      const data = JSON.parse(r.stdout)
      found = fromHealth(data, heads)
      reruns = rerunsFromHealth(data)
      found = [...found, ...rerunInfo(reruns, heads)]
    } else {
      found = fromGh(list, { stuckMinutes: p.stuckMinutes, requireAutoMerge: p.requireAutoMerge, ignoreDrafts: p.ignoreDrafts }, now)
    }
    if (p.worktrees) found = [...found, ...(await unpushedIn($, p, heads))]
    // Under plainOutput a problem keeps its number, a cause code and hashes only (no branch, check name or detail)
    if (plain()) found = found.map(x => plainProblem(x, hashKey))
    lastProblems = found
    // A rerun the command says it made (or would make) owns that PR's failed checks for `rerunHours`.
    const apply = (s: GuardStore): GuardStore => {
      let recorded = s
      for (const x of reruns) {
        if (!ACTIVE_RERUN.has(x.status)) continue
        const sha = heads.get(x.number)?.sha ?? '?'
        recorded = plain()
          ? recordRerun(recorded, x.number, /^[0-9a-f]{7,64}$/i.test(sha) ? sha : '?', x.checks.map(hashKey), p.rerunHours, now)
          : recordRerun(recorded, x.number, sha, x.checks, p.rerunHours, now)
      }
      return pruneOwners(recorded, now)
    }
    // Written under the lock, and only when something changed, so it cannot overwrite a concurrent decision
    const before = await guardStore($)
    const pruned = apply(before) !== before ? await updateGuardStore($, apply) : before
    return { findings: toldProblems(found, pruned, now).map(x => ({ key: problemKey(x), text: problemLine(x) })) }
  } catch (err) {
    return { error: plain() ? 'bad-output' : String(err) }
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
      description: 'Record the decision about a stopped subagent that holds a big context: "kept-warm" (you sent it a short message, which re-arms its prompt cache; the warning returns after the next expiry window), "retired" (stopped, a fresh agent will take over) or "done" (its work is finished). "retired" and "done" are refused while the agent runs or has live background tasks (TaskStop them first, after the agent has handed over). Tether\'s agent guard acts by itself before the cache expires and keeps blocking the end of a turn until each such agent is dealt with.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The agent id' },
          decision: { type: 'string', enum: ['kept-warm', 'retired', 'done'] },
          note: { type: 'string' },
        },
        required: ['id', 'decision'],
      },
    })
  } catch (err) {
    $.ui.log(plain() ? 'guards: the tools were not registered' : `guards: the tools were not registered: ${err}`)
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
  const given = e.kind === 'waive' ? 'waived' : String(e.who ?? '').trim()
  if (given === '') return { deny: 'an assignment needs who' }
  const now = await $.clock.now()
  const named = typeof e.cause === 'string' && e.cause.trim() !== '' ? e.cause.trim() : undefined
  // Under plainOutput only an id-like owner and a known cause are kept, and the note is not
  const who = plain() ? plainId(given) : given
  const cause = named !== undefined && plain() ? plainCode(named, CAUSES) : named
  const note = plain() ? '' : String(e.note ?? '')
  await updateGuardStore($, s => recordOwner(s, pr, who, hours, note, now, localStamp(now).replace('T', ' ').slice(0, 16), cause))
  return toolText(`#${pr} ${e.kind === 'waive' ? 'waived' : 'assigned to ' + who} for ${hours} h${cause ? ` (cause ${cause})` : ''}.`)
}

/** Why a decision is refused, as a code with a count: the agent runs, has live tasks, or waits on background work. */
function decisionCode(a: AgentSeen): string {
  const tasks = a.tasks?.length ?? 0
  return a.status === 'running' ? 'running' : tasks > 0 ? `live-tasks ${tasks}` : 'waiting'
}

/**
 * Serves agent_decision: records that a stopped agent is kept warm, retired or done. Retired and done are refused
 * while the agent runs or has live background work, because it would wake itself and re-write its cache.
 */
async function agentDecisionCall($: any, e: any): Promise<any> {
  if (typeof e.id !== 'string' || e.id.trim() === '') return { deny: 'id must be an agent id' }
  if (e.decision !== 'retired' && e.decision !== 'done' && e.decision !== 'kept-warm') return { deny: 'decision must be "kept-warm", "retired" or "done"' }
  const id = plain() ? plainId(e.id.trim()) : e.id.trim()
  const now = await $.clock.now()
  let known: AgentSeen | undefined
  try {
    known = (await agentsSeen($, now)).find(a => a.id === id || a.label === id)
  } catch {
    // Without the engine's list nothing can be checked; the decision is recorded as given
  }
  const problem = decisionProblem(e.decision, known)
  if (problem) return { deny: plain() ? `agent_decision refused: ${known!.id} ${decisionCode(known!)}; TaskStop it first, then record it as ${e.decision}.` : `agent_decision refused: ${problem}` }
  const key = known?.id ?? id
  await updateGuardStore($, s => {
    const recorded = recordDecision(s, key, e.decision, plain() ? '' : String(e.note ?? ''), localStamp(now).replace('T', ' ').slice(0, 16), now)
    if (e.decision !== 'kept-warm') return recorded
    // Kept-warm is a new cycle: an earlier handover (late, or failed) no longer applies to an agent that goes on working.
    // After a handover request, or past the retire line, it is the coordinator keeping the agent: the size handover stops asking
    const pastLine = s.actions[key]?.handoverAt !== undefined || (known?.contextTokens !== undefined && known.contextTokens >= cfg.retireContextTokens)
    return recordAction(recorded, key, {
      ...NEW_CYCLE,
      warms: (s.actions[key]?.warms ?? 0) + 1,
      ...(known?.contextTokens !== undefined ? { warmContext: known.contextTokens } : {}),
      ...(pastLine ? { retireKept: now } : {}),
    })
  })
  await refreshUndecided($).catch(() => lastUndecided)
  return toolText(`${id} recorded as ${e.decision}.`)
}

/** What /tether-guards prints: the PR problems nobody owns, the owners and waivers, the agents awaiting a decision. */
async function guardsReport($: any): Promise<string> {
  if (halted) return HALT_TEXT
  const now = await $.clock.now()
  const store = await guardStore($)
  const open = unowned(lastProblems, store, now)
  const real = lastProblems.filter(p => !p.info)
  const lines = [`guards: ${real.length} PR problem${real.length === 1 ? '' : 's'} at the last poll, ${open.length} without an owner`]
  for (const p of open) lines.push(`- ${problemLine(p)}`)
  for (const p of lastProblems.filter(x => x.info)) lines.push(`info: ${problemLine(p)}`)
  for (const [pr, o] of Object.entries(store.owners)) {
    if (o.until <= now) continue
    const hoursLeft = Math.round((o.until - now) / 3_600_000)
    if (plain()) lines.push(`owner #${Number(pr) || '?'}: ${plainId(o.who)}${o.cause ? ` (${plainCode(o.cause, CAUSES)})` : ''} for ${hoursLeft} h more`)
    else lines.push(`owner #${pr}: ${o.who}${o.cause ? ` (${o.cause})` : ''} for ${hoursLeft} h more, ${o.note}`)
  }
  lines.push(`agents awaiting a decision: ${lastUndecided.length}`)
  for (const u of lastUndecided) lines.push(`- ${u.text}`)
  lines.push(`agent guard: ${gCfg.auto ? 'acts by itself' : 'asks only'}, ${gCfg.leadMinutes} min before the cache expires; hands over from ${tokens(gCfg.handoverTokens)}`)
  for (const n of guardNotes.slice(-10)) lines.push(`- ${n}`)
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
  hkCfg = mergeHousekeeping(layered(optionLayer(), 'housekeeping', root?.housekeeping))
  convCfg = mergeConversations(layered(optionLayer(), 'conversations', root?.conversations))
  stopCfg = mergeStop(layered(optionLayer(), 'stop', root?.stop))
  gCfg = mergeCacheGuard(layered(optionLayer(), 'cacheGuard', root?.cacheGuard))
  guardTimer?.cancel()
  guardTimer = undefined
  if (halted) {
    // Failed closed: no guard, no housekeeping, no logs
    hkCfg = { ...HOUSEKEEPING_DEFAULTS, enabled: false }
    convCfg = { ...CONVERSATIONS_DEFAULTS, enabled: false }
    stopCfg = { ...STOP_DEFAULTS, enabled: false }
    gCfg = { ...CACHE_GUARD_DEFAULTS, auto: false }
    return
  }
  // The guard acts on its own clock, whether or not a poller is configured
  guardTimer = $.clock.every(60_000, () => guardTick($)) as any
}

/** The handoff as session-start context when `checkpoint.injectHandoff` is on and the file exists; undefined otherwise. */
async function handoffContext($: any): Promise<string | undefined> {
  try {
    // Read again: this event may come before the session.start that loads the settings
    const { root } = await readTetherConfig($, true)
    // Failed closed, or plainOutput: the handoff's text is not put in the session
    if (halted || plain()) return undefined
    const cfg = await checkpointConfig($, root)
    if (!cfg.injectHandoff || !(await $.fs.exists(cfg.handoffFile))) return undefined
    return injectedHandoff(cfg.handoffFile, String(await $.fs.read(cfg.handoffFile)))
  } catch (err) {
    $.ui.log(plain() ? 'checkpoint: the handoff was not added to the session' : `checkpoint: the handoff was not added to the session: ${err}`)
    return undefined
  }
}

/** Adds Tether's lines to the repository's exclude file, makes a missing handoff, and reports a failing one. */
async function housekeepingStart($: any): Promise<void> {
  if (!hkCfg.enabled) return
  try {
    const where = await runChecked($, ['git', 'rev-parse', '--git-path', 'info/exclude'], { timeoutMs: 10_000 })
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
    $.ui.log(plain() ? 'housekeeping: failed' : `housekeeping: ${err}`)
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
    if (String(err) !== lastLogError) $.ui.log(plain() ? 'conversations: the log was not written' : `conversations: the log was not written: ${err}`)
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
    if (!halted && gCfg.registerTools) await registerGuardTools($)
    try {
      await $.command.register({ ...registration(GUARDS), immediate: true })
    } catch {}
    try {
      await $.command.register({ ...registration(CHECKPOINT), immediate: true })
    } catch {}
    const r = await fleetStart($, e, (e2: any) => watchStart($, e2, next))
    // Once both parts have read their settings: the one pane, when either part asks for it
    openAtStart($)
    mainClearedSinceStart = false
    void backfillMain($)
    return r
  })

  // The background tasks a subagent starts and ends are in the rows appended to its conversation.
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!halted) await noteRow($, e)
    } catch {
      // Only the task list is lost
    }
    return r
  })

  // The model records an owner, a waiver or a decision with these tools.
  on('tool.call', { tool: `mcp__tether__${TOOL_PR}` }, async ($, e) => (halted ? { deny: HALT_TEXT } : prOwnerCall($, e)))
  on('tool.call', { tool: `mcp__tether__${TOOL_AGENT}` }, async ($, e) => (halted ? { deny: HALT_TEXT } : agentDecisionCall($, e)))
  on('command.run', { command: GUARDS.name }, async ($) => ({ text: await guardsReport($) }))
  on('command.run', { command: CHECKPOINT.name }, async ($) => checkpointCommand($))

  // The end of a turn is blocked while a PR problem or a stopped big agent has no owner or decision, at most
  // `stop.maxBlocks` times in a row for the same reason.
  on('classic.Stop', async ($, e, next) => {
    const r: any = await next(e)
    // The main loop's own background work in flight as its turn ends: the idle wake waits for it
    mainBackground = liveBackground((e as any).background_tasks)
    // Without the guard tools nothing can clear the reason, so it never blocks
    if (!stopCfg.enabled || !gCfg.registerTools) return r
    const now = await $.clock.now()
    const store = await guardStore($)
    // Look again, so a ping or a decision since the last tick counts
    const open = await refreshUndecided($).catch(() => lastUndecided)
    const reasons = [
      unowned(lastProblems, store, now).length > 0 ? prStopReason(unowned(lastProblems, store, now)) : '',
      open.length > 0 ? agentStopReason(open) : '',
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
  // A clear ends the conversation, and no session start follows it: continue from the handoff if a checkpoint
  // asked for it. Looked at before the rest, so a failing hook beneath cannot keep it from happening.
  on('session.end', async ($, e, next) => {
    if ((e as any).reason === 'clear') await checkpointAfterClear($, String((e as any).sessionId))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    const r: any = await next(e)
    const text = await handoffContext($)
    if (text === undefined) return r
    // Added here, so the next prompt does not add it a second time
    injectNext = false
    $.ui.log(`checkpoint: added ${cpCfg.handoffFile} to the session`)
    return { ...(r ?? {}), additionalContext: [...(r?.additionalContext ?? []), text] }
  }).catch(($, e, next) => next(e))
  // After a clear, the first prompt carries the handoff as context. A prompt the person submits passes Tether's
  // prompt.submit; Tether's own continue does not (a plugin's call runs beneath its own hooks), so the engine's
  // UserPromptSubmit, raised for every prompt it takes, adds it there. Whichever comes first adds it, once.
  on('prompt.submit', async ($, e, next) => {
    if (!injectNext || (e as any).command) return next(e)
    const text = await takeInjection($)
    return next(text === undefined ? e : ({ ...e, context: [...((e as any).context ?? []), text] } as any))
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r: any = await next(e)
    if (!injectNext) return r
    const text = await takeInjection($)
    return text === undefined ? r : { ...(r ?? {}), additionalContext: [...(r?.additionalContext ?? []), text] }
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
