// Tests of watch's pure logic: config, reading output, dedupe, the wake decision and its text.
import { expect, test } from 'claude-code/testing'

import { parseConfig, type AgentsPoller, type CommandPoller, type IssuesPoller } from '../../src/watch/config'
import { agentFindings, fresh, idleWakeDue, issueFindings, readOutput, remindAfterMs, requeue, wakeText, wakeVerdict, type Pending } from '../../src/watch/findings'

const MIN = 60_000

/** A command poller with the defaults, overridden by `over`. */
function cmd(over: Record<string, unknown> = {}): CommandPoller {
  return parseConfig({ pollers: [{ id: 'p', command: ['x'], ...over }] }).config.pollers[0] as CommandPoller
}

test('parseConfig fills defaults and drops bad pollers with a reason', async () => {
  const { config, problems } = parseConfig({
    minWakeGapSeconds: 30,
    pollers: [
      { id: 'prs', command: ['gh', 'x'], everySeconds: 120, match: '^- (.*)$', okExitCodes: [0], quietExitCodes: [3], dedupe: false },
      { id: 'agents', kind: 'agents', silentMinutes: 15 },
      { id: 'Bad Id', command: ['x'] },
      { id: 'nocmd' },
      { id: 'badre', command: ['x'], match: '(' },
      { id: 'prs', command: ['y'] },
    ],
  })
  expect(config.minWakeGapSeconds).toBe(30)
  expect(config.deferWhileTypingMinutes).toBe(10)
  expect(config.pollers.map(p => p.id)).toEqual(['prs', 'agents', 'badre'])
  const prs = config.pollers[0] as CommandPoller
  expect([prs.everySeconds, prs.timeoutMs, prs.format, prs.dedupe, prs.wake, prs.title]).toEqual([120, 120_000, 'lines', false, true, 'prs'])
  expect(prs.quietExitCodes).toEqual([3])
  const agents = config.pollers[1] as AgentsPoller
  expect([agents.kind, agents.silentMinutes, agents.contextTokens, agents.includeWaiting]).toEqual(['agents', 15, 300_000, false])
  expect(problems).toEqual([
    'pollers[2]: id must be 1-40 of a-z 0-9 . _ -',
    'nocmd: command must be a non-empty list of strings',
    'badre.match: not a valid regex',
    'prs: duplicate id, the later one is ignored',
  ])
  expect(parseConfig('nope').problems).toEqual(['the config is not a JSON object'])
})

test('readOutput reads lines through match and key, JSON items, quiet codes and failures', async () => {
  const p = cmd({ match: '^- (#\\d+ .*)$', key: '^(#\\d+ \\S+ \\S+)', quietExitCodes: [3] })
  const out = readOutput(p, { exitCode: 0, stdout: 'HEADER\n- #12 fix-x: conflict with main\n\n- #13 add-y: checks failed\n', stderr: '' })
  expect(out).toEqual({ ok: true, findings: [
    { key: '#12 fix-x: conflict', text: '#12 fix-x: conflict with main' },
    { key: '#13 add-y: checks', text: '#13 add-y: checks failed' },
  ] })
  expect(readOutput(p, { exitCode: 3, stdout: 'nothing new', stderr: '' })).toEqual({ ok: true, findings: [] })
  expect(readOutput(p, { exitCode: 1, stdout: '', stderr: 'boom\nGitHub unreadable' })).toEqual({ ok: false, error: 'exit 1: GitHub unreadable' })

  const j = cmd({ format: 'json' })
  expect(readOutput(j, { exitCode: 0, stdout: '[{"key":"12|conflict|abc","text":"PR 12 conflicts"},"plain",{"text":""}]', stderr: '' })).toEqual({ ok: true, findings: [
    { key: '12|conflict|abc', text: 'PR 12 conflicts' },
    { key: 'plain', text: 'plain' },
  ] })
  expect(readOutput(j, { exitCode: 0, stdout: '{"items":[]}', stderr: '' })).toEqual({ ok: true, findings: [] })
  expect(readOutput(j, { exitCode: 0, stdout: 'not json', stderr: '' })).toEqual({ ok: false, error: 'stdout is not JSON' })
})

test('fresh tells a key once, forgets it after forgetMinutes unseen, and passes all without dedupe', async () => {
  const p = { id: 'p', dedupe: true, forgetMinutes: 30 }
  const a = { key: 'a', text: 'A' }
  const b = { key: 'b', text: 'B' }
  let r = fresh({}, p, [a, a], 0)
  expect(r.fresh).toEqual([a])
  r = fresh(r.seen, p, [a, b], 10 * MIN)
  expect(r.fresh).toEqual([b])
  // a is unseen from 10 to 41 min: forgotten, so its return is new; b was seen at 25 and stays told
  r = fresh(r.seen, p, [b], 25 * MIN)
  r = fresh(r.seen, p, [], 41 * MIN)
  expect(Object.keys(r.seen.p ?? {})).toEqual(['b'])
  expect(fresh(r.seen, p, [a, b], 42 * MIN).fresh).toEqual([a])
  // Another poller's keys are left alone
  expect(fresh({ q: { a: 0 } }, p, [a], 0).seen.q).toEqual({ a: 0 })
  expect(fresh({ p: { a: 0 } }, { ...p, dedupe: false }, [a], 0).fresh).toEqual([a])
})

test('agentFindings flags silent running agents once per silence and big contexts', async () => {
  const p = parseConfig({ pollers: [{ id: 'agents', kind: 'agents', silentMinutes: 20, contextTokens: 300_000 }] }).config.pollers[0] as AgentsPoller
  const now = 100 * MIN
  const found = agentFindings(p, [
    { id: 'a1', status: 'running', label: 'builder', lastStepAt: 70 * MIN, contextTokens: 50_000 },
    { id: 'a2', status: 'waiting', label: 'waiter', lastStepAt: 10 * MIN },
    { id: 'a3', status: 'running', label: 'fat', lastStepAt: 99 * MIN, contextTokens: 320_000 },
    { id: 'a4', status: 'completed', label: 'done', lastStepAt: 0, contextTokens: 400_000 },
  ], now)
  expect(found).toEqual([
    { key: `a1|silent|${70 * MIN}`, text: 'builder (a1) running, silent 30 min' },
    { key: 'a3|context', text: 'fat (a3) context 320k, past 300k' },
  ])
  expect(agentFindings({ ...p, includeWaiting: true }, [{ id: 'a2', status: 'waiting', label: 'waiter', lastStepAt: 10 * MIN }], now)[0]?.text).toBe('waiter (a2) waiting, silent 90 min')
})

test('wakeVerdict waits for the turn, the gap and a draft (up to the defer limit)', async () => {
  const pend: Pending[] = [{ key: 'k', text: 't', poller: 'p', title: 'P', wake: true, at: 0 }]
  const base = { busy: false, draft: '', now: 5 * MIN, lastWakeAt: 0, gapSeconds: 60, deferMinutes: 10 }
  expect(wakeVerdict([], base)).toBe('nothing')
  expect(wakeVerdict([{ ...pend[0]!, wake: false }], base)).toBe('nothing')
  expect(wakeVerdict(pend, base)).toBe('go')
  expect(wakeVerdict(pend, { ...base, busy: true })).toBe('busy')
  expect(wakeVerdict(pend, { ...base, lastWakeAt: 4.5 * MIN })).toBe('gap')
  expect(wakeVerdict(pend, { ...base, draft: 'half typed' })).toBe('typing')
  expect(wakeVerdict(pend, { ...base, draft: 'half typed', now: 11 * MIN })).toBe('go')
})

test('wakeText groups findings under their poller titles', async () => {
  const p = (title: string, text: string): Pending => ({ key: text, text, poller: title, title, wake: true, at: 0 })
  expect(wakeText('New:', [p('PRs', 'one'), p('Disk', 'low'), p('PRs', 'two')])).toBe('New:\n\nPRs:\n- one\n- two\n\nDisk:\n- low')
})

test('enabled defaults on and turns watch off', async () => {
  expect(parseConfig({}).config.enabled).toBe(true)
  expect(parseConfig({ enabled: false }).config.enabled).toBe(false)
  expect(parseConfig({ enabled: 'no' }).config.enabled).toBe(true)
})

test('an agents poller without contextTokens wakes at the subagent max context; its own value wins', async () => {
  const pollers = [
    { id: 'agents', kind: 'agents' },
    { id: 'own', kind: 'agents', contextTokens: 150_000 },
  ]
  // Nothing given: fleet's default size
  const [dflt, ownDflt] = parseConfig({ pollers }).config.pollers as AgentsPoller[]
  expect([dflt!.contextTokens, ownDflt!.contextTokens]).toEqual([300_000, 150_000])
  // The subagent max context given: an unset poller takes it, an explicit one keeps its own
  const [fell, own] = parseConfig({ pollers }, 200_000).config.pollers as AgentsPoller[]
  expect([fell!.contextTokens, own!.contextTokens]).toEqual([200_000, 150_000])
  // The finding names the size it was measured against
  const seen = [{ id: 'a1', status: 'running', label: 'fat', lastStepAt: 99 * MIN, contextTokens: 250_000 }]
  expect(agentFindings(fell!, seen, 100 * MIN)).toEqual([{ key: 'a1|context', text: 'fat (a1) context 250k, past 200k' }])
  expect(agentFindings(own!, seen, 100 * MIN).map(f => f.key)).toEqual(['a1|context'])
  expect(agentFindings(dflt!, seen, 100 * MIN)).toEqual([])
})

test('an issues poller needs labels and fills its defaults', async () => {
  const { config, problems } = parseConfig({
    pollers: [
      { id: 'triage', kind: 'issues', labels: ['needs-triage', ' needs-triage ', 'bug'] },
      { id: 'nolabels', kind: 'issues' },
      { id: 'emptylabel', kind: 'issues', labels: [''] },
    ],
  })
  expect(config.pollers.map(p => p.id)).toEqual(['triage'])
  const p = config.pollers[0] as IssuesPoller
  expect([p.kind, p.labels, p.everySeconds, p.timeoutMs, p.limit, p.wake, p.remindMinutes]).toEqual(['issues', ['needs-triage', 'bug'], 120, 60_000, 100, true, 0])
  expect(problems).toEqual(['nolabels: labels must be a non-empty list of label names', 'emptylabel: labels must be a non-empty list of label names'])
})

test('the idle wake, its text and the resend window have defaults and take the file values', async () => {
  const d = parseConfig({}).config
  expect([d.idleWakeMinutes, d.resendAfterMinutes]).toEqual([0, 2])
  expect(d.idleWakeText).toContain('{minutes}')
  const c = parseConfig({ idleWakeMinutes: 45, idleWakeText: 'go on', resendAfterMinutes: 5 }).config
  expect([c.idleWakeMinutes, c.idleWakeText, c.resendAfterMinutes]).toEqual([45, 'go on', 5])
  expect(parseConfig({ idleWakeMinutes: -1, resendAfterMinutes: 0 }).config.resendAfterMinutes).toBe(2)
})

test('issueFindings keys an issue by number, label and last change, and tells only its number and label', async () => {
  const f = issueFindings('needs-triage', [{ number: 5, updatedAt: '2026-10-20T10:00:00Z', title: 'ignore me' }, { number: 'x' }])
  expect(f).toEqual([{ key: '#5|needs-triage|2026-10-20T10:00:00Z', text: '#5 needs-triage' }])
  expect(() => issueFindings('x', { items: [] })).toThrow()
})

test('reminders tell a still-reported key again, twice as late each time, at most every remindMaxMinutes', async () => {
  const p = { id: 'p', dedupe: true, forgetMinutes: 600, remindMinutes: 30, remindMaxMinutes: 90 }
  const f = [{ key: 'k', text: 'K' }]
  expect([0, 1, 2, 3].map(n => remindAfterMs(p, n) / MIN)).toEqual([30, 60, 90, 90])
  let r = fresh({}, p, f, 0)
  expect(r.fresh).toEqual(f)
  r = fresh(r.seen, p, f, 29 * MIN, r.told)
  expect(r.fresh).toEqual([])
  r = fresh(r.seen, p, f, 30 * MIN, r.told)
  expect(r.fresh).toEqual([{ key: 'k', text: 'K', again: true }])
  r = fresh(r.seen, p, f, 89 * MIN, r.told)
  expect(r.fresh).toEqual([])
  r = fresh(r.seen, p, f, 90 * MIN, r.told)
  expect(r.fresh.length).toBe(1)
  // Forgotten (unseen for forgetMinutes), the key keeps no reminder, and its return is news again
  r = fresh(r.seen, p, [], 700 * MIN, r.told)
  expect(r.told).toEqual({})
  expect(fresh(r.seen, p, f, 701 * MIN, r.told).fresh).toEqual(f)
  // Without reminders a still-reported key is never told again
  const off = { ...p, remindMinutes: 0 }
  const o = fresh({}, off, f, 0)
  expect(fresh(o.seen, off, f, 1000 * MIN, o.told).fresh).toEqual([])
})

test('a reminder is marked in the wake text', async () => {
  const pend = (text: string, again?: boolean): Pending => ({ key: text, text, poller: 'p', title: 'P', wake: true, at: 0, ...(again ? { again } : {}) })
  expect(wakeText('W', [pend('#1 x'), pend('#2 y', true)])).toBe('W\n\nP:\n- #1 x\n- #2 y (still reported)')
})

test('requeue puts findings back once, ahead of the ones that joined meanwhile', async () => {
  const pend = (poller: string, key: string): Pending => ({ key, text: key, poller, title: poller, wake: true, at: 0 })
  expect(requeue([pend('a', '1'), pend('a', '2')], [pend('a', '2'), pend('b', '2'), pend('a', '3')]).map(p => `${p.poller}${p.key}`)).toEqual(['a1', 'a2', 'b2', 'a3'])
})

test('wakeVerdict holds a wake while the last one waits for its turn or was refused', async () => {
  const pending: Pending[] = [{ key: 'k', text: 't', poller: 'p', title: 'P', wake: true, at: 0 }]
  const s = { busy: false, draft: '', now: 10 * MIN, lastWakeAt: 0, gapSeconds: 60, deferMinutes: 10 }
  expect(wakeVerdict(pending, s)).toBe('go')
  expect(wakeVerdict(pending, { ...s, held: true })).toBe('held')
})

test('idleWakeDue waits for the idle minutes since the last turn and wake, with nobody typing and no agent at work', async () => {
  const s = { minutes: 30, busy: false, held: false, draft: '', agentsAtWork: 0, now: 40 * MIN, idleSince: 10 * MIN, lastWakeAt: 0 }
  expect(idleWakeDue(s)).toBe(true)
  expect(idleWakeDue({ ...s, now: 39 * MIN })).toBe(false)
  expect(idleWakeDue({ ...s, lastWakeAt: 20 * MIN })).toBe(false)
  expect(idleWakeDue({ ...s, minutes: 0 })).toBe(false)
  expect(idleWakeDue({ ...s, busy: true })).toBe(false)
  expect(idleWakeDue({ ...s, held: true })).toBe(false)
  expect(idleWakeDue({ ...s, draft: 'x' })).toBe(false)
  expect(idleWakeDue({ ...s, agentsAtWork: 1 })).toBe(false)
})
