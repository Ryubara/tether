// Tests of the guards' pure logic: the store, PR problems from GitHub and from a project's health command,
// owners and waivers, and the stopped-agent decisions.
import { expect, test } from 'claude-code/testing'

import { DEFAULTS } from '../../src/fleet/config'
import { coldGuard } from '../../src/fleet/guard'
import { actAfterMinutes, decisionProblem, planActions, stopReason as agentStop, undecided, type StoppedCandidate } from '../../src/guards/agents'
import { CACHE_GUARD_DEFAULTS, mergeCacheGuard } from '../../src/guards/config'
import { fromGh, fromHealth, problemKey, problemLine, rerunInfo, rerunsFromHealth, stopReason, toldProblems, unowned, unpushedProblem } from '../../src/guards/prs'
import { EMPTY_STORE, ownerCovers, pruneOwners, readStore, recordAction, recordDecision, recordOwner, recordRerun } from '../../src/guards/store'
import { parseConfig, type AgentsPoller, type PrsPoller } from '../../src/watch/config'
import { agentFindings } from '../../src/watch/findings'

const MIN = 60_000
const RULES = { stuckMinutes: 90, requireAutoMerge: false, ignoreDrafts: true }
const NOW = Date.parse('2026-10-13T12:00:00Z')

test('fromGh finds conflicts, failed checks and stuck CI, and skips drafts', async () => {
  const list = [
    { number: 1, headRefName: 'a', headRefOid: 'aaa', mergeable: 'CONFLICTING', statusCheckRollup: [] },
    {
      number: 2,
      headRefName: 'b',
      headRefOid: 'bbb',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [
        { name: 'lint', conclusion: 'FAILURE' },
        { name: 'build', conclusion: 'SUCCESS' },
        { context: 'ci/x', state: 'ERROR' },
        { name: 'slow', status: 'IN_PROGRESS', startedAt: new Date(NOW - 120 * MIN).toISOString() },
        { name: 'fresh', status: 'IN_PROGRESS', startedAt: new Date(NOW - 5 * MIN).toISOString() },
      ],
    },
    { number: 3, headRefName: 'c', headRefOid: 'ccc', isDraft: true, mergeable: 'CONFLICTING' },
    'junk',
  ]
  const found = fromGh(list, RULES, NOW)
  expect(found.map(p => [p.number, p.cause])).toEqual([[1, 'conflict'], [2, 'checks-failed'], [2, 'ci-stuck']])
  expect(found[1]?.text).toBe('checks failed: ci/x, lint')
  expect(problemKey(found[1]!)).toBe('2|checks-failed|bbb|ci/x,lint')
  expect(problemLine(found[0]!)).toBe('#1 a: conflicts with the base branch')
  expect(fromGh([{ number: 4, headRefName: 'd', autoMergeRequest: null }], { ...RULES, requireAutoMerge: true }, NOW).map(p => p.cause)).toEqual(['auto-merge-off'])
  expect(fromGh({ not: 'a list' }, RULES, NOW)).toEqual([])
})

test('fromHealth reads a project health command and fills heads from the PR list', async () => {
  const heads = new Map([[7, { branch: 'fix-x', sha: 'abc' }]])
  const found = fromHealth({ stuck: [{ number: 7, cause: 'checks-failed', kind: 'required', detail: 'python-ok', checks: ['b', 'a'] }, { number: 'x' }], rerun: [{ ignored: true }] }, heads)
  expect(found).toEqual([{ number: 7, branch: 'fix-x', cause: 'checks-failed', text: 'checks-failed required python-ok', sha: 'abc', extra: 'a,b' }])
  expect(fromHealth(null, heads)).toEqual([])
})

test('owners and waivers cover a problem until they expire, by cause', async () => {
  let store = recordOwner(EMPTY_STORE, 5, 'agent-1', 4, 'fixing', NOW, '2026-10-13 12:00')
  store = recordOwner(store, 6, 'waived', 720, 'kept off', NOW, '2026-10-13 12:00', 'auto-merge-off')
  const problems = [
    unpushedProblem(5, 'x', 2, 's1'),
    { number: 6, branch: 'y', cause: 'auto-merge-off', text: 'off', sha: 's', extra: '' },
    { number: 6, branch: 'y', cause: 'conflict', text: 'c', sha: 's', extra: '' },
  ]
  expect(unowned(problems, store, NOW + MIN).map(p => `${p.number}:${p.cause}`)).toEqual(['6:conflict'])
  // The assignment expires after its hours: the problem is raised again
  expect(unowned(problems, store, NOW + 5 * 60 * MIN).map(p => `${p.number}:${p.cause}`)).toEqual(['5:unpushed', '6:conflict'])
  expect(ownerCovers(store.owners['6'], 'auto-merge-off', NOW)).toBe(true)
  expect(ownerCovers(store.owners['6'], 'conflict', NOW)).toBe(false)
  expect(Object.keys(pruneOwners(store, NOW + 5 * 60 * MIN).owners)).toEqual(['6'])
  expect(stopReason(unowned(problems, store, NOW))).toContain('#6 y: c')
})

test('readStore keeps well-formed records and drops the rest', async () => {
  const s = readStore({ owners: { '1': { until: 5, who: 'a' }, '2': 'bad' }, decisions: { x: { decision: 'done' }, y: { decision: 'maybe' } } })
  expect(Object.keys(s.owners)).toEqual(['1'])
  expect(Object.keys(s.decisions)).toEqual(['x'])
  expect(readStore('nope')).toEqual(EMPTY_STORE)
})

test('undecided lists stopped big agents past the act-after time, until decided', async () => {
  const rules = { cacheMinutes: 60, smallTokens: 60_000, leadMinutes: 15 }
  const agent = (id: string, status: string, minutes: number, ctx: number) => ({ id, status, label: id, lastStepAt: NOW - minutes * MIN, contextTokens: ctx })
  const agents = [
    agent('soon', 'completed', 50, 200_000),
    agent('expired', 'waiting', 70, 100_000),
    agent('early', 'completed', 10, 200_000),
    agent('small', 'completed', 50, 1_000),
    agent('old', 'completed', 300, 200_000),
    agent('edge', 'completed', 44, 200_000),
    agent('busy', 'running', 50, 200_000),
  ]
  const found = undecided(agents, EMPTY_STORE, rules, NOW)
  // Not before 45 minutes ('edge' at 44), and an agent quiet for hours is not forgotten
  expect(found.map(u => u.id)).toEqual(['soon', 'expired', 'old'])
  expect(found[0]?.text).toContain('cache expires in ~10 min')
  expect(found[1]?.text).toContain('cache EXPIRED')
  const decided = recordDecision(EMPTY_STORE, 'soon', 'retired', 'n', 't')
  expect(undecided(agents, decided, rules, NOW).map(u => u.id)).toEqual(['expired', 'old'])
  // At exactly 45 minutes it is demanded
  expect(undecided([agent('edge', 'completed', 45, 200_000)], EMPTY_STORE, rules, NOW).map(u => u.id)).toEqual(['edge'])
  expect(agentStop(found)).toContain('agent_decision')
})

test('the agents poller adds undecided agents when given the guard, and prs pollers parse', async () => {
  const { config, problems } = parseConfig({
    pollers: [
      { id: 'agents', kind: 'agents', silentMinutes: 30 },
      { id: 'prs', kind: 'prs', command: ['x'], requireAutoMerge: true, worktrees: 'wt', assignHours: 2 },
      { id: 'bad', kind: 'prs', command: [] },
    ],
  })
  expect(problems).toEqual(['bad: command must be a non-empty list of strings'])
  const agents = config.pollers[0] as AgentsPoller
  const prs = config.pollers[1] as PrsPoller
  expect(agents.silentMinutes).toBe(30)
  // The removed actAfterMinutes is read without error and ignored (the lead time is cacheGuard.leadMinutes)
  expect(parseConfig({ pollers: [{ id: 'agents', kind: 'agents', actAfterMinutes: 5 }] }).problems).toEqual([])
  // The removed forgetAgentMinutes is read without error and ignored
  expect(parseConfig({ pollers: [{ id: 'agents', kind: 'agents', forgetAgentMinutes: 5 }] }).problems).toEqual([])
  expect([prs.command, prs.requireAutoMerge, prs.ignoreDrafts, prs.worktrees, prs.assignHours, prs.rerunHours, prs.stuckMinutes, prs.everySeconds]).toEqual([['x'], true, true, 'wt', 2, 3, 90, 300])
  const seen = [{ id: 'a1', status: 'completed', label: 'worker', lastStepAt: NOW - 50 * MIN, contextTokens: 100_000 }]
  expect(agentFindings(agents, seen, NOW)).toEqual([])
  expect(agentFindings(agents, seen, NOW, { store: EMPTY_STORE, cacheMinutes: 60, smallTokens: 60_000, leadMinutes: 15 }).map(f => f.key)).toEqual(['a1|undecided'])
})

test('rerunsFromHealth reads well-formed entries and rerunInfo makes information lines that never block', async () => {
  const heads = new Map([[7, { branch: 'fix-x', sha: 'abc' }]])
  const reruns = rerunsFromHealth({ rerun: [{ number: 7, run: 5, checks: ['b', 'a'], reasons: ['r1', 'r2'], status: 'would-rerun', detail: '', future: 1 }, { number: 8 }, { status: 'x' }, null] })
  expect(reruns).toEqual([{ number: 7, run: 5, checks: ['a', 'b'], reasons: ['r1', 'r2'], status: 'would-rerun' }])
  expect(rerunsFromHealth({ stuck: [] })).toEqual([])
  const info = rerunInfo(reruns, heads)
  expect(info).toEqual([{ number: 7, branch: 'fix-x', cause: 'rerun-would-rerun', text: 'rerun a, b (run 5) would-rerun: r1; r2', sha: 'abc', extra: '5:a,b', info: true }])
  // Information lines are never unowned, but are told
  expect(unowned(info, EMPTY_STORE, NOW)).toEqual([])
  expect(toldProblems(info, EMPTY_STORE, NOW).length).toBe(1)
})

test('a recorded rerun owns a failed-checks problem only for the checks it reran, the same head, and until it expires', async () => {
  const failed = { number: 7, branch: 'b', cause: 'checks-failed', text: 'checks-failed', sha: 'abc', extra: 'a,b' }
  const store = recordRerun(EMPTY_STORE, 7, 'abc', ['b', 'a', 'c'], 3, NOW)
  expect(unowned([failed], store, NOW + MIN)).toEqual([])
  // A check the rerun did not cover, a new head, other causes, another PR, and the end of the rerun's hours
  expect(unowned([{ ...failed, extra: 'a,z' }], store, NOW + MIN).length).toBe(1)
  expect(unowned([{ ...failed, sha: 'def' }], store, NOW + MIN).length).toBe(1)
  expect(unowned([{ ...failed, cause: 'conflict' }], store, NOW + MIN).length).toBe(1)
  expect(unowned([{ ...failed, number: 8 }], store, NOW + MIN).length).toBe(1)
  expect(unowned([failed], store, NOW + 4 * 60 * MIN).length).toBe(1)
  expect(unowned([{ ...failed, extra: '' }], store, NOW + MIN).length).toBe(1)
  expect(Object.keys(pruneOwners(store, NOW + 4 * 60 * MIN).reruns)).toEqual([])
  expect(readStore(JSON.parse(JSON.stringify(store))).reruns['7']?.checks).toEqual(['a', 'b', 'c'])
})

const RULES_30 = { cacheMinutes: 60, smallTokens: 60_000, leadMinutes: 20 }
const AUTO = { handoverTokens: 250_000, handoverWaitMinutes: 10, keepWarmMax: 3 }
const waiting = (id: string, minutes: number, ctx: number, over: Partial<StoppedCandidate> = {}): StoppedCandidate => ({ id, status: 'waiting', label: id, lastStepAt: NOW - minutes * MIN, contextTokens: ctx, tasks: ['t1'], ...over })

test('the lead is 20 minutes by default and never more than half a short cache', async () => {
  expect(actAfterMinutes(RULES_30)).toBe(40)
  expect(actAfterMinutes({ ...RULES_30, cacheMinutes: 5 })).toBe(2.5)
  expect(undecided([waiting('a', 39, 100_000)], EMPTY_STORE, RULES_30, NOW)).toEqual([])
  const [due] = undecided([waiting('a', 41, 100_000)], EMPTY_STORE, RULES_30, NOW)
  expect(due?.text).toContain('1 live background task (it wakes itself when they report)')
  expect(due?.text).toContain('cache expires in ~19 min')
  // Waiting in the engine's status only (no task ids known) is still flagged as background work
  expect(undecided([waiting('b', 41, 100_000, { tasks: undefined })], EMPTY_STORE, RULES_30, NOW)[0]?.text).toContain('waiting on background work')
  // A stopped agent with an idle status is guarded too
  expect(undecided([waiting('c', 41, 100_000, { status: 'idle', tasks: [] })], EMPTY_STORE, RULES_30, NOW).length).toBe(1)
})

test('kept-warm quiets the agent for one window from the later of its last activity and the record; retired is final', async () => {
  const a = waiting('a', 45, 100_000)
  const kept = recordDecision(EMPTY_STORE, 'a', 'kept-warm', 'pinged', 't', NOW - 5 * MIN)
  // Pinged 5 minutes ago: quiet until 40 minutes after the ping
  expect(undecided([a], kept, RULES_30, NOW)).toEqual([])
  expect(undecided([a], kept, RULES_30, NOW + 34 * MIN)).toEqual([])
  expect(undecided([a], kept, RULES_30, NOW + 36 * MIN).length).toBe(1)
  // The ping woke the agent, so its activity is newer than the record: the window starts there
  const active = waiting('a', 3, 100_000)
  expect(undecided([active], kept, RULES_30, NOW + 36 * MIN)).toEqual([])
  expect(undecided([active], kept, RULES_30, NOW + 38 * MIN).length).toBe(1)
  expect(undecided([a], recordDecision(EMPTY_STORE, 'a', 'retired', '', 't', NOW - 5 * MIN), RULES_30, NOW + 600 * MIN)).toEqual([])
  expect(readStore(JSON.parse(JSON.stringify(kept))).decisions['a']).toEqual({ decision: 'kept-warm', note: 'pinged', at: 't', atMs: NOW - 5 * MIN })
})

test('planActions keeps a small waiting agent warm, hands a big one over, and leaves an agent with nothing to wake it to the model', async () => {
  const plan = (agents: StoppedCandidate[], store = EMPTY_STORE, now = NOW) => planActions(agents, store, RULES_30, AUTO, now).map(p => `${p.kind}:${p.id}`)
  expect(plan([waiting('small', 41, 100_000), waiting('big', 41, 300_000), waiting('early', 30, 300_000), waiting('tiny', 41, 1_000)])).toEqual(['warm:small', 'handover:big'])
  expect(plan([{ id: 'done', status: 'completed', label: 'done', lastStepAt: NOW - 50 * MIN, contextTokens: 300_000 }])).toEqual([])
  expect(plan([{ id: 'busy', status: 'running', label: 'busy', lastStepAt: NOW - 50 * MIN, contextTokens: 300_000, tasks: ['t'] }])).toEqual([])
  // Once pinged it is quiet; the count goes up with the next window
  const pinged = recordAction(recordDecision(EMPTY_STORE, 'small', 'kept-warm', '', 't', NOW), 'small', { warms: 1 })
  expect(plan([waiting('small', 41, 100_000)], pinged)).toEqual([])
  expect(planActions([waiting('small', 41, 100_000, { lastStepAt: NOW })], pinged, RULES_30, AUTO, NOW + 41 * MIN)).toEqual([{ kind: 'warm', id: 'small', label: 'small', count: 2 }])
  // Too many pings: the model is told, once
  const worn = recordAction(EMPTY_STORE, 'small', { warms: 3 })
  expect(plan([waiting('small', 41, 100_000)], worn)).toEqual(['alert:small'])
  expect(plan([waiting('small', 41, 100_000)], recordAction(worn, 'small', { alertedAt: NOW }))).toEqual([])
  // An expired cache is never pinged: that would be the re-write itself
  expect(plan([waiting('late', 65, 100_000)])).toEqual(['alert:late'])
})

test('a handover is collected once the agent has stopped, alerted when late, and Tether keeps the agent out of the findings while it works', async () => {
  const asked = recordAction(EMPTY_STORE, 'big', { handoverAt: NOW - 3 * MIN })
  const plan = (a: StoppedCandidate, store = asked, now = NOW) => planActions([a], store, RULES_30, AUTO, now)
  // Still running its handover, or no turn ended since the ask: nothing yet
  expect(plan(waiting('big', 41, 300_000, { status: 'running', lastStepAt: NOW - MIN }))).toEqual([])
  expect(plan(waiting('big', 41, 300_000, { finishedAt: NOW - 10 * MIN, lastStepAt: NOW - 10 * MIN }))).toEqual([])
  // It stopped after the ask: its leftover tasks are collected
  const done = waiting('big', 41, 300_000, { finishedAt: NOW - MIN, lastStepAt: NOW - 2 * MIN, tasks: ['t1', 't2'] })
  expect(plan(done)).toEqual([{ kind: 'collect', id: 'big', label: 'big', tasks: ['t1', 't2'], unknown: false }])
  // Waiting on background work whose ids are unknown is said, not guessed
  expect(plan({ ...done, tasks: [] })).toEqual([{ kind: 'collect', id: 'big', label: 'big', tasks: [], unknown: true }])
  // After a failed stop it is not retried
  expect(plan(done, recordAction(asked, 'big', { stopFailedAt: NOW }))).toEqual([])
  // Late: an alert, once, naming that it is not stopped
  const late = waiting('big', 55, 300_000, { status: 'running' })
  const [alert] = plan(late, recordAction(EMPTY_STORE, 'big', { handoverAt: NOW - 11 * MIN }))
  expect(alert).toMatchObject({ kind: 'alert' })
  expect((alert as { text: string }).text).toContain('NOT stopped')
  expect(plan(late, recordAction(EMPTY_STORE, 'big', { handoverAt: NOW - 11 * MIN, alertedAt: NOW }))).toEqual([])
  // Findings: not while Tether has it in hand; yes once late or when the stop failed
  const idle = waiting('big', 45, 300_000)
  expect(undecided([idle], asked, RULES_30, NOW)).toEqual([])
  expect(undecided([idle], recordAction(asked, 'big', { alertedAt: NOW }), RULES_30, NOW)[0]?.text).toContain('NOT stopped')
  expect(undecided([{ ...idle, status: 'running' }], recordAction(asked, 'big', { alertedAt: NOW }), RULES_30, NOW).length).toBe(1)
  expect(undecided([idle], recordAction(asked, 'big', { stopFailedAt: NOW }), RULES_30, NOW)[0]?.text).toContain('could not be stopped')
  // Retired ends it all
  const retired = recordDecision(asked, 'big', 'retired', '', 't', NOW)
  expect(plan(done, retired)).toEqual([])
  expect(undecided([idle], recordAction(retired, 'big', { alertedAt: NOW }), RULES_30, NOW)).toEqual([])
})

test('decisionProblem refuses retired and done for an agent that is running or will wake itself, and says TaskStop it first', async () => {
  expect(decisionProblem('retired', { status: 'running', label: 'w' })).toContain('TaskStop it first')
  expect(decisionProblem('done', { status: 'running', label: 'w' })).toContain('still running')
  expect(decisionProblem('retired', { status: 'completed', label: 'w', tasks: ['b1'] })).toMatch(/1 live background task \(b1\).*TaskStop it first/)
  expect(decisionProblem('done', { status: 'idle', label: 'w', tasks: ['b1', 'b2'] })).toMatch(/2 live background tasks.*TaskStop them first/)
  expect(decisionProblem('retired', { status: 'waiting', label: 'w' })).toContain('TaskStop it first')
  expect(decisionProblem('retired', { status: 'completed', label: 'w', tasks: [] })).toBeUndefined()
  // Kept-warm is always allowed, and an agent the engine does not list is not judged
  expect(decisionProblem('kept-warm', { status: 'running', label: 'w' })).toBeUndefined()
  expect(decisionProblem('retired', undefined)).toBeUndefined()
})

test('the blocking reason names the two ways out, and the store keeps the actions', async () => {
  const text = agentStop([{ id: 'a', text: 'a: stopped 45 min' }])
  expect(text).toMatch(/keep it warm.*SendMessage.*kept-warm/)
  expect(text).toMatch(/hand it over and stop it.*TaskStop.*retired/)
  const store = recordAction(recordAction(EMPTY_STORE, 'a', { handoverAt: 5 }), 'a', { warms: 2, alertedAt: 9 })
  expect(readStore(JSON.parse(JSON.stringify(store))).actions['a']).toEqual({ warms: 2, handoverAt: 5, alertedAt: 9 })
  expect(readStore({ actions: { x: { warms: 'many' }, y: { warms: 1, handoverAt: 'soon' } } }).actions).toEqual({ y: { warms: 1 } })
})

test('mergeCacheGuard reads the section over the defaults and ignores what is not valid', async () => {
  expect(mergeCacheGuard(undefined)).toEqual(CACHE_GUARD_DEFAULTS)
  expect(CACHE_GUARD_DEFAULTS).toMatchObject({ auto: true, leadMinutes: 20, handoverTokens: 250_000, handoverWaitMinutes: 10 })
  expect(mergeCacheGuard({ auto: false, leadMinutes: 30, handoverTokens: -1, keepWarmMax: 2.7, keepWarmText: ' ping ', handoverText: '' })).toMatchObject({ auto: false, leadMinutes: 30, handoverTokens: 250_000, keepWarmMax: 2, keepWarmText: 'ping' })
  expect(CACHE_GUARD_DEFAULTS.handoverText).toMatch(/Commit your work, update STATUS\.md.*next exact command.*stop.*Do not start new work/)
})

test('the cold guard refuses a decided agent but not a kept-warm one', async () => {
  const input = { to: 'a1', message: 'go' }
  const agents = [{ id: 'a1', status: 'completed', description: 'd' }]
  const ledger = new Map()
  expect(coldGuard(input, agents, ledger, NOW, DEFAULTS, new Map(), recordDecision(EMPTY_STORE, 'a1', 'kept-warm', '', 't', NOW).decisions)).toBeUndefined()
  expect(coldGuard(input, agents, ledger, NOW, DEFAULTS, new Map(), recordDecision(EMPTY_STORE, 'a1', 'retired', '', 't', NOW).decisions)).toContain('decided retired')
})
