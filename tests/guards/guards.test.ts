// Tests of the guards' pure logic: the store, PR problems from GitHub and from a project's health command,
// owners and waivers, and the stopped-agent decisions.
import { expect, test } from 'claude-code/testing'

import { stopReason as agentStop, undecided } from '../../src/guards/agents'
import { fromGh, fromHealth, problemKey, problemLine, rerunInfo, rerunsFromHealth, stopReason, toldProblems, unowned, unpushedProblem } from '../../src/guards/prs'
import { EMPTY_STORE, ownerCovers, pruneOwners, readStore, recordDecision, recordOwner, recordRerun } from '../../src/guards/store'
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
  const rules = { cacheMinutes: 60, smallTokens: 60_000, actAfterMinutes: 45 }
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
      { id: 'agents', kind: 'agents', actAfterMinutes: 30 },
      { id: 'prs', kind: 'prs', command: ['x'], requireAutoMerge: true, worktrees: 'wt', assignHours: 2 },
      { id: 'bad', kind: 'prs', command: [] },
    ],
  })
  expect(problems).toEqual(['bad: command must be a non-empty list of strings'])
  const agents = config.pollers[0] as AgentsPoller
  const prs = config.pollers[1] as PrsPoller
  expect(agents.actAfterMinutes).toBe(30)
  // The removed forgetAgentMinutes is read without error and ignored
  expect(parseConfig({ pollers: [{ id: 'agents', kind: 'agents', forgetAgentMinutes: 5 }] }).problems).toEqual([])
  expect([prs.command, prs.requireAutoMerge, prs.ignoreDrafts, prs.worktrees, prs.assignHours, prs.rerunHours, prs.stuckMinutes, prs.everySeconds]).toEqual([['x'], true, true, 'wt', 2, 3, 90, 300])
  const seen = [{ id: 'a1', status: 'completed', label: 'worker', lastStepAt: NOW - 50 * MIN, contextTokens: 100_000 }]
  expect(agentFindings(agents, seen, NOW)).toEqual([])
  expect(agentFindings(agents, seen, NOW, { store: EMPTY_STORE, cacheMinutes: 60, smallTokens: 60_000 }).map(f => f.key)).toEqual(['a1|undecided'])
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
