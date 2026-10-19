// Tests of the checkpoint cycle and handoff check: when to ask, when to clear, and what never happens.
import { expect, test } from 'claude-code/testing'

import { CHECKPOINT_DEFAULTS, HANDOFF_ENV, mergeCheckpoint, withHandoffEnv, type CheckpointConfig } from '../../src/checkpoint/config'
import { handoffProblems, injectedHandoff } from '../../src/checkpoint/handoff'
import { askText, backedOff, clock, describeCycle, forceCheckpoint, initialCycle, isCyclePrompt, newInformation, repairText, step, type Observed } from '../../src/checkpoint/cycle'

const cfg: CheckpointConfig = { ...CHECKPOINT_DEFAULTS, enabled: true, contextTokens: 1000, quietSeconds: 10, maxRepairs: 2 }
const GOOD = '## Where to look\nx\n## Summary\nx\n## Next steps\nx\n## Open questions\nx\n'

/** An observation of a quiet session at `now` (ms), with overrides. */
function obs(now: number, over: { [K in keyof Observed]?: Observed[K] } = {}): Observed {
  return { now, contextTokens: 5000, busy: false, draft: '', messages: 3, problems: [], ...over }
}

test('nothing happens below the context threshold', () => {
  const r = step(initialCycle(), obs(0, { contextTokens: 999 }), cfg)
  expect(r.action).toBe('none')
  expect(r.state.phase).toBe('idle')
})

test('a due, quiet session is asked for its handoff once', () => {
  const a = step(initialCycle(), obs(0), cfg)
  expect(a.action).toBe('ask')
  expect(a.state.phase).toBe('asked')
  expect(step(a.state, obs(1000), cfg).action).toBe('none')
})

test('a busy or drafting session is never asked, and the quiet clock restarts when it becomes busy', () => {
  expect(step(initialCycle(), obs(0, { busy: true }), cfg).action).toBe('none')
  expect(step(initialCycle(), obs(0, { draft: 'half typed' }), cfg).action).toBe('none')
  const asked = step(initialCycle(), obs(0), cfg).state
  const busy = step(asked, obs(9000, { busy: true }), cfg)
  expect(busy.action).toBe('none')
  // 10 s of quiet is counted from when the busy turn ended, not from the ask
  expect(step(busy.state, obs(15000), cfg).action).toBe('none')
  expect(step(busy.state, obs(19000), cfg).action).toBe('clear')
})

test('after quiet with a passing handoff the cycle clears; a failing handoff gets repairs, never a clear', () => {
  const asked = step(initialCycle(), obs(0), cfg).state
  const bad = step(asked, obs(10000, { problems: ['missing the heading "## Summary"'] }), cfg)
  expect(bad.action).toBe('repair')
  expect(bad.state.phase).toBe('asked')
  const good = step(bad.state, obs(20000, { problems: [] }), cfg)
  expect(good.action).toBe('clear')
  expect(good.state.phase).toBe('clearing')
})

test('new messages while the handoff is written make the cycle update it before clearing', () => {
  const asked = step(initialCycle(), obs(0, { messages: 3 }), cfg).state
  const more = step(asked, obs(5000, { messages: 5 }), cfg)
  expect(more.action).toBe('none')
  expect(more.state.dirty).toBe(true)
  const upd = step(more.state, obs(15000, { messages: 5 }), cfg)
  expect(upd.action).toBe('update')
  expect(upd.state.dirty).toBe(false)
  expect(step(upd.state, obs(30000, { messages: 5, problems: [] }), cfg).action).toBe('clear')
})

test('a handoff that never passes stops after its repairs and gives up instead of clearing', () => {
  let s = step(initialCycle(), obs(0), cfg).state
  const failing = { problems: ['the handoff is empty'] }
  let t = 10000
  expect(step(s, obs(t, failing), cfg).action).toBe('repair')
  s = step(s, obs(t, failing), cfg).state
  t += 10000
  expect(step(s, obs(t, failing), cfg).action).toBe('repair')
  s = step(s, obs(t, failing), cfg).state
  t += 10000
  const last = step(s, obs(t, failing), cfg)
  expect(last.action).toBe('give-up')
  expect(last.state.phase).toBe('idle')
})

test('after a give-up the still-long session is asked again only after retryMinutes', () => {
  const c = { ...cfg, retryMinutes: 10 }
  const given = backedOff(0, c)
  expect(step(given, obs(9 * 60_000), c).action).toBe('none')
  expect(describeCycle(given, obs(9 * 60_000), c)).toBe('checkpoint due: asking again in 1:00')
  const again = step(given, obs(10 * 60_000), c)
  expect(again.action).toBe('ask')
  expect(again.state.retryAt).toBe(0)
})

test('a forced checkpoint asks below the context threshold, once quiet, and the flag is gone after the ask', () => {
  const forced = forceCheckpoint(initialCycle(), cfg)
  expect(forced.state.forced).toBe(true)
  expect(forced.reply).toBe('checkpoint: asking for HANDOFF.md once the session is quiet')
  expect(step(forced.state, obs(0, { contextTokens: 10, busy: true }), cfg).action).toBe('none')
  expect(describeCycle(forced.state, obs(0, { contextTokens: 10, busy: true }), cfg)).toMatch(/requested: waiting for the turn/)
  const asked = step(forced.state, obs(0, { contextTokens: 10 }), cfg)
  expect(asked.action).toBe('ask')
  expect(asked.state.forced).toBe(false)
  // From the ask on it is the automatic path: a passing handoff after quiet clears
  expect(step(asked.state, obs(10000, { contextTokens: 10, problems: [] }), cfg).action).toBe('clear')
})

test('a forced checkpoint asks during a back-off', () => {
  const c = { ...cfg, retryMinutes: 10 }
  const given = backedOff(0, c)
  expect(step(given, obs(60_000), c).action).toBe('none')
  expect(step(forceCheckpoint(given, c).state, obs(60_000), c).action).toBe('ask')
})

test('a forced checkpoint does nothing while checkpoints are off, or while a cycle runs', () => {
  const off = { ...cfg, enabled: false }
  const r = forceCheckpoint(initialCycle(), off)
  expect(r.reply).toBe('checkpoint: off, so nothing was started')
  expect(r.state.forced).toBe(false)
  expect(step({ ...initialCycle(), forced: true }, obs(0), off).action).toBe('none')
  const asked = step(initialCycle(), obs(0), cfg).state
  expect(forceCheckpoint(asked, cfg)).toEqual({ state: asked, reply: 'checkpoint: already running (HANDOFF.md requested)' })
  const clearing = { ...asked, phase: 'clearing' as const }
  expect(forceCheckpoint(clearing, cfg).reply).toBe('checkpoint: already running (clearing)')
})

test('a missing handoff file is never cleared over', () => {
  const asked = step(initialCycle(), obs(0), cfg).state
  expect(step(asked, obs(10000, { problems: undefined }), cfg).action).toBe('repair')
})

test('disabled checkpoints never ask', () => {
  expect(step(initialCycle(), obs(0), { ...cfg, enabled: false }).action).toBe('none')
})

test('a handoff passes only with every heading, within the size limit', () => {
  expect(handoffProblems(GOOD, cfg)).toEqual([])
  expect(handoffProblems('## Summary\nx\n', cfg).length).toBeGreaterThan(0)
  expect(handoffProblems(GOOD + 'x'.repeat(2000), { ...cfg, maxChars: 500 })[0]).toMatch(/characters/)
  expect(handoffProblems('', cfg)).toContain('the handoff is empty')
})

test('the cycle recognises its own prompts, so they never re-queue it; a person\'s message does', () => {
  expect(isCyclePrompt(askText(cfg, false), cfg)).toBe(true)
  expect(isCyclePrompt(askText(cfg, true), cfg)).toBe(true)
  expect(isCyclePrompt(repairText(cfg, ['missing the heading "## Summary"']), cfg)).toBe(true)
  expect(isCyclePrompt('Continue from HANDOFF.md.', cfg)).toBe(true)
  // The transcript's framed copy of the same prompt is still a cycle prompt
  expect(isCyclePrompt('The tether plugin sent a message:\n' + askText(cfg, true), cfg)).toBe(true)
  expect(isCyclePrompt('The tether plugin sent a message: Checkpoint: this session is long, so', cfg)).toBe(true)
  expect(isCyclePrompt('Update the README for me', cfg)).toBe(false)
  expect(isCyclePrompt('the build is green, go on', cfg)).toBe(false)
})

test('new information is the person\'s and the main agent\'s messages, not the cycle\'s prompts or their replies', () => {
  const msgs = [
    { role: 'user', text: 'fix the build' },
    { role: 'assistant', text: 'on it' },
    { role: 'user', text: askText(cfg, false) },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'HANDOFF.md is written.' },
    { role: 'user', text: 'and also the tests' },
    { role: 'assistant', text: 'the subagent reported the build is green' },
  ]
  // four counted: the first request, the follow-up, the subagent's report, and the first request from before the prompt
  expect(newInformation(msgs, cfg)).toBe(4)
  expect(newInformation(msgs.slice(0, 3), cfg)).toBe(2)
})

test('every message the model writes in reply to a cycle prompt is ignored, until the person writes again', () => {
  const msgs = [
    { role: 'user', text: askText(cfg, false) },
    { role: 'assistant', text: 'Writing it now.' },
    { role: 'assistant', text: 'Checked it, one more line.' },
    { role: 'assistant', text: 'HANDOFF.md is written.' },
  ]
  expect(newInformation(msgs, cfg)).toBe(0)
  expect(newInformation([...msgs, { role: 'user', text: 'thanks' }], cfg)).toBe(1)
})

test('the defaults wait five quiet seconds, checked every two', () => {
  expect(mergeCheckpoint({}).quietSeconds).toBe(5)
  expect(mergeCheckpoint({}).tickSeconds).toBe(2)
})

test('mergeCheckpoint keeps defaults and takes only well-typed fields', () => {
  expect(mergeCheckpoint({}).contextTokens).toBe(200000)
  expect(mergeCheckpoint({}).enabled).toBe(false)
  expect(mergeCheckpoint({ quietSeconds: 30, enabled: false, contextTokens: 'big' }).contextTokens).toBe(200000)
  expect(mergeCheckpoint({ quietSeconds: 30, enabled: false }).quietSeconds).toBe(30)
  expect(mergeCheckpoint({ sections: [] }).sections.length).toBe(4)
})

test('the pane line counts down the quiet window, and says what waits', () => {
  expect(clock(8000)).toBe('0:08')
  expect(clock(65000)).toBe('1:05')
  const asked = step(initialCycle(), obs(0), cfg).state
  expect(describeCycle(asked, obs(3000), cfg)).toBe('checkpoint: clearing in 0:07 (quiet)')
  expect(describeCycle(asked, obs(3000, { draft: 'half typed' }), cfg)).toMatch(/your draft/)
  expect(describeCycle(asked, obs(3000, { busy: true }), cfg)).toMatch(/turn to end/)
  expect(describeCycle(initialCycle(), obs(0, { contextTokens: 500 }), cfg)).toMatch(/due at/)
  expect(describeCycle(initialCycle(), obs(0, { contextTokens: 5000 }), { ...cfg, enabled: false })).toBe('checkpoint: off')
})

test('the pane line says clearing only over a handoff that passes: a missing one is waited for, a failing one repaired', () => {
  const asked = step(initialCycle(), obs(0), cfg).state
  expect(describeCycle(asked, obs(3000, { problems: undefined }), cfg)).toBe(`checkpoint: waiting for the handoff file (${cfg.handoffFile}), asking again in 0:07 (quiet)`)
  expect(describeCycle(asked, obs(3000, { problems: ['missing the heading "## Summary"'] }), cfg)).toBe('checkpoint: repairing the handoff in 0:07 (quiet)')
  expect(describeCycle(asked, obs(3000, { problems: [] }), cfg)).toBe('checkpoint: clearing in 0:07 (quiet)')
  // And the cycle agrees: a missing file is never cleared over
  expect(step(asked, obs(11_000, { problems: undefined }), cfg).action).toBe('repair')
})

test('injectedHandoff adds a header, cuts at 400 lines with a note, and skips an empty file', async () => {
  expect(injectedHandoff('H.md', '  \n')).toBeUndefined()
  expect(injectedHandoff('H.md', 'a\nb\n')).toBe('Project state from the handoff file (Tether): H.md\n\na\nb')
  const long = injectedHandoff('H.md', Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n'))!
  expect(long).toContain('l399')
  expect(long).not.toContain('l400')
  expect(long).toContain('H.md is 450 lines')
  expect(mergeCheckpoint({ injectHandoff: true }).injectHandoff).toBe(true)
  expect(CHECKPOINT_DEFAULTS.injectHandoff).toBe(false)
})

test('TETHER_HANDOFF_FILE unset or empty leaves the handoff file as configured', () => {
  expect(withHandoffEnv(cfg, undefined).cfg.handoffFile).toBe(cfg.handoffFile)
  expect(withHandoffEnv(cfg, '  ').cfg).toEqual(cfg)
})

test('TETHER_HANDOFF_FILE names the handoff file, over the configured one', () => {
  const r = withHandoffEnv({ ...cfg, handoffFile: 'notes/HANDOFF.md' }, ' jobs/20260101T000000Z-abc123.handoff.md ')
  expect(r.problem).toBeUndefined()
  expect(r.cfg.handoffFile).toBe('jobs/20260101T000000Z-abc123.handoff.md')
  expect(r.cfg.enabled).toBe(true)
  expect(withHandoffEnv(cfg, 'jobs\\one.md').cfg.handoffFile).toBe('jobs\\one.md')
})

test('a TETHER_HANDOFF_FILE outside the session folder turns the checkpoint off', () => {
  for (const bad of ['/etc/x.md', 'C:\\x.md', 'c:x.md', '\\\\host\\x.md', '../x.md', 'notes/../../x.md', 'jobs//x.md', 'jobs/x.md/', 'a\u0007.md']) {
    const r = withHandoffEnv({ ...cfg, injectHandoff: true }, bad)
    expect(r.problem).toBe(`${HANDOFF_ENV} must be a path inside the session's folder`)
    expect(r.cfg.enabled).toBe(false)
    expect(r.cfg.injectHandoff).toBe(false)
  }
})
