// Tests of the checkpoint cycle and handoff check: when to ask, when to clear, and what never happens.
import { expect, test } from 'claude-code/testing'

import { CHECKPOINT_DEFAULTS, mergeCheckpoint, type CheckpointConfig } from '../../src/checkpoint/config'
import { handoffProblems } from '../../src/checkpoint/handoff'
import { askText, initialCycle, isCyclePrompt, newInformation, repairText, step, type Observed } from '../../src/checkpoint/cycle'

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
