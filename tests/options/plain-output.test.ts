// plainOutput: no outside text reaches any place Tether writes to. Synthetic decompiler-style strings are planted in
// every input Tether reads (agent descriptions, names and types, subagent transcripts and their meta files, the
// annotate notes, command poller stdout and stderr, PR branch and check names, a health command's causes and
// details, TaskStop's error text, the model's notes and owners, the handoff file); every path that produces output
// runs; then no planted string, nor any 8-character piece of one, may appear in any sink.
//
// To cover a new sink: add a row to SINKS (its name, how to read what reached it, whether the scenario must put
// something there). To cover a new input: plant LEAK in it in `scenario`.
import { expect, test } from 'claude-code/testing'

import { MIN, command, start, step, stopHook, world, type World } from './world'

/** Text in the shape of decompiler output: Tether must never repeat any of it under plainOutput. */
const PLANTED = ['FUN_0012abcd', 'param_1', 'undefined4 local_10', 'iVar3 = *(int *)(param_2 + 0x14);']
const LEAK = PLANTED.join(' ')

/** What may not appear: each planted string shorter than 8 whole, and every 8-character piece of the longer ones. */
const NEEDLES = [...new Set(PLANTED.flatMap(p => (p.length < 8 ? [p] : Array.from({ length: p.length - 7 }, (_, i) => p.slice(i, i + 8)))))]

/** The needles found in `texts`. */
function leaks(texts: string[]): string[] {
  const all = texts.join('\n')
  return NEEDLES.filter(n => all.includes(n))
}

const ZONE = '/zone/plain-zone.json'

const CONFIG = {
  locked: true,
  plainOutput: true,
  checkpoint: { enabled: false, injectHandoff: true },
  conversations: { enabled: false },
  housekeeping: { enabled: true, createHandoff: false },
  fleet: { bigContextTokens: 1000, showSession: true, watchState: '/work/state.json', annotate: { command: ['notes'], everySeconds: 60 } },
  cacheGuard: { handoverTokens: 200_000 },
  watch: {
    stateFile: '/work/state.json',
    minWakeGapSeconds: 1,
    pollers: [
      { id: 'cmd', command: ['scan'], everySeconds: 60, codes: ['new'] },
      { id: 'cmd-fail', command: ['scan-fail'], everySeconds: 60 },
      { id: 'agents', kind: 'agents', everySeconds: 60, silentMinutes: 5, contextTokens: 100_000 },
      { id: 'prs', kind: 'prs', everySeconds: 60 },
      { id: 'health', kind: 'prs', everySeconds: 60, command: ['health'] },
    ],
  },
}

/** A background task start line in a subagent transcript, with planted text around it. */
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', toolUseResult: { backgroundTaskId: 'bt1' }, message: { role: 'user', content: [{ type: 'tool_result', content: `Command running in background with ID: bt1. ${LEAK}` }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: LEAK }] } }),
].join('\n')

/** What each command prints. */
function answer(argv: string[]) {
  const cmd = argv[0]
  if (cmd === 'notes') return { exitCode: 0, stdout: JSON.stringify({ a1: LEAK, 'FUN_0012abcd': LEAK }) }
  if (cmd === 'scan') {
    const lines = [LEAK, JSON.stringify({ key: 'k1', code: 'new' }), JSON.stringify({ key: 'k2', code: 'new', text: LEAK }), JSON.stringify({ key: 'FUN 0012', code: 'new' }), JSON.stringify({ key: 'k3', code: 'param_1' }), JSON.stringify({ items: [{ text: LEAK }] })]
    return { exitCode: 0, stdout: lines.join('\n'), stderr: LEAK }
  }
  if (cmd === 'scan-fail') return { exitCode: 2, stdout: LEAK, stderr: LEAK }
  if (cmd === 'gh') {
    const checks = [{ name: 'undefined4 local_10', conclusion: 'FAILURE' }, { name: PLANTED[3], status: 'IN_PROGRESS', startedAt: '2000-01-01T00:00:00Z' }]
    return { exitCode: 0, stdout: JSON.stringify([{ number: 12, headRefName: `FUN_0012abcd-param_1`, headRefOid: 'abc1234def', mergeable: 'CONFLICTING', statusCheckRollup: checks }]) }
  }
  if (cmd === 'health') {
    const data = {
      stuck: [{ number: 12, cause: 'FUN_0012abcd', kind: 'param_1', detail: LEAK, checks: [LEAK], branch: LEAK }, { number: 13, cause: 'checks-failed', checks: [LEAK, PLANTED[0]], sha: LEAK }],
      rerun: [{ number: 13, checks: [LEAK], reasons: [LEAK], status: 'reran', detail: LEAK, branch: LEAK, run: 7 }],
    }
    return { exitCode: 1, stdout: JSON.stringify(data), stderr: LEAK }
  }
  return { exitCode: 1, stdout: LEAK, stderr: LEAK }
}

/** Everything the scenario saw come back from Tether, besides what the world recorded. */
type Observed = { w: World; stops: string[]; tools: string[]; commands: string[]; panes: string[]; sessionStart: string[]; hookContext: string[] }

/** Runs every path that produces output, with planted text in every input. */
async function scenario($: any, on: any): Promise<Observed> {
  const w = world({
    env: { TETHER_CONFIG: ZONE },
    answer,
    agents: [
      { id: 'a1', status: 'waiting', description: LEAK, name: PLANTED[0], type: PLANTED[1] },
      { id: 'a2', status: 'running', description: '(resumed)', type: LEAK },
      { id: 'a3', status: 'completed', description: LEAK, name: PLANTED[2] },
    ],
    messages: [{ role: 'user', text: LEAK }, { role: 'assistant', text: LEAK }],
    taskStop: { deny: `${LEAK}: permission denied` },
    delivery: { isDelivered: true },
    context: 250_000,
  })
  w.files = {
    [ZONE]: JSON.stringify(CONFIG),
    'HANDOFF.md': `# HANDOFF\n\n${LEAK}\n`,
    's1/subagents/agent-a1.jsonl': TRANSCRIPT,
    's1/subagents/agent-a1.meta.json': JSON.stringify({ description: LEAK }),
    's1/subagents/agent-a2.meta.json': JSON.stringify({ description: LEAK }),
    's1/subagents/agent-a2.jsonl': JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: LEAK } }),
  }
  const o: Observed = { w, stops: [], tools: [], commands: [], panes: [], sessionStart: [], hookContext: [] }
  const tool = async (input: Record<string, unknown>) => o.tools.push(JSON.stringify((await $.tool.call(input as any)) ?? {}))
  const cmd = async (name: string, args = '') => o.commands.push(await command($, name, args))
  const stop = async () => o.stops.push(JSON.stringify((await stopHook($)) ?? {}))
  const pane = async (requestId: string) => {
    const ui: any = await $.ui.mount({ plugin: 'tether', surface: 'terminal', component: 'Pane', requestId, props: { title: requestId, isFocused: false, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
    o.panes.push(...(await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text)))
    await ui.unmount()
  }

  const clock = await start($, on, w)
  await step($, 'a1')
  await step($, 'a2')
  // The pollers and the annotate command run, findings wake the model
  await clock.advance(2 * MIN)
  await $.turn.complete({ turnId: 't', answer: '' } as any)
  // a2 goes silent; a1 (waiting, a background task, 250k) is asked to hand over before its cache expires
  await clock.advance(40 * MIN)
  // a1 hands over and stops; its task's TaskStop fails with planted text
  await step($, 'a1')
  await $.turn.complete({ turnId: 't', answer: LEAK, agentId: 'a1' } as any)
  w.agents[0]!.status = 'completed'
  await clock.advance(3 * MIN)
  await $.turn.complete({ turnId: 't', answer: '' } as any)
  // A cold wake of a2 past its cache lifetime
  await clock.advance(30 * MIN)
  await step($, 'a2')

  // The model's tools, with planted notes, owners and causes
  await tool({ tool: 'mcp__tether__agent_decision', id: 'a2', decision: 'done', note: LEAK })
  await tool({ tool: 'mcp__tether__agent_decision', id: LEAK, decision: 'done', note: LEAK })
  await tool({ tool: 'mcp__tether__agent_decision', id: 'a3', decision: 'done', note: LEAK })
  await tool({ tool: 'mcp__tether__pr_owner', pr: 12, kind: 'assign', who: LEAK, cause: LEAK, note: LEAK })
  await tool({ tool: 'SendMessage', to: 'a3', message: 'hi' })
  await tool({ tool: 'SendMessage', to: PLANTED[2], message: 'hi' })
  // The handoff checks
  await tool({ tool: 'Write', file_path: 'HANDOFF.md', content: LEAK })
  o.hookContext.push(JSON.stringify((await $.tool.call({ tool: 'Edit', file_path: 'HANDOFF.md', old_string: 'a', new_string: LEAK } as any)) ?? {}))

  await stop()
  await cmd('tether-fleet', 'text')
  await cmd('tether-fleet')
  await cmd('tether-watch')
  await cmd('tether-watch', 'run')
  await clock.advance(10 * 1000)
  await cmd('tether-watch', 'pane')
  await cmd('tether-guards')
  await pane('tether')
  const ss: any = await ($ as any).classic.SessionStart({ source: 'startup' })
  o.sessionStart.push(...(ss?.additionalContext ?? []))
  await stop()
  return o
}

/** Every place Tether's output lands; `some`: the scenario must put something there, so the check is not empty. */
const SINKS: Array<{ name: string; texts: (o: Observed) => string[]; some: boolean }> = [
  { name: 'wake prompts ($.prompt.submit)', texts: o => o.w.submits, some: true },
  { name: 'the Stop hook reason', texts: o => o.stops, some: true },
  { name: 'tool results and deny reasons', texts: o => o.tools, some: true },
  { name: 'hook context added to a tool result', texts: o => o.hookContext, some: true },
  { name: 'command answers', texts: o => o.commands, some: true },
  { name: 'toasts', texts: o => o.w.toasts, some: true },
  { name: 'the status line', texts: o => o.w.statuses, some: true },
  { name: 'pane cells', texts: o => o.panes, some: true },
  { name: 'logs ($.ui.log)', texts: o => o.w.logs, some: true },
  { name: 'files written (the state file)', texts: o => Object.entries(o.w.writes).flat(), some: true },
  { name: 'the store ($.store)', texts: o => o.w.storeWrites, some: true },
  { name: 'messages to agents ($.session.send)', texts: o => o.w.sent, some: true },
  { name: 'session start context', texts: o => o.sessionStart, some: false },
]

for (const sink of SINKS) {
  test(`plainOutput: no planted text reaches ${sink.name}`, { timeoutMs: 60_000 }, async ($, on) => {
    const o = await scenario($, on)
    const texts = sink.texts(o)
    if (sink.some) expect(texts.length > 0, `${sink.name} got nothing: the scenario does not reach it`).toBe(true)
    expect(leaks(texts), sink.name).toEqual([])
  })
}

test('plainOutput: the scenario reaches the paths it plants text in', { timeoutMs: 60_000 }, async ($, on) => {
  const o = await scenario($, on)
  const all = (xs: string[]) => xs.join('\n')
  // The command poller's one valid line is told; the rest is dropped and counted
  expect(all(o.w.submits)).toContain('k1 new')
  expect(all(o.commands)).toMatch(/- cmd \(every 60s.*\): 1 found, \d+ new, 5 dropped/)
  expect(all(o.commands)).toMatch(/- cmd-fail .*FAILED .*: exit 2/)
  // The PR problems are told by number and cause code
  expect(all(o.w.submits)).toContain('#12: conflict')
  expect(all(o.w.submits)).toContain('#12: checks-failed (1 checks)')
  expect(all(o.w.submits)).toContain('#12: other')
  // The agents poller and the agent guard, by agent id
  expect(all(o.w.submits)).toMatch(/a2 \(a2\) running, silent \d+ min/)
  expect(o.w.sent.length).toBeGreaterThan(0)
  expect(o.w.stopped).toEqual(['bt1'])
  expect(all(o.w.submits)).toContain('a1 (a1) handed over but TaskStop failed for 1 task')
  // The cold guard names the agent by id, and the fleet text is off
  expect(all(o.tools)).toContain('Agent a3 is decided done:')
  expect(all(o.commands)).toContain('/tether-fleet text is off under plainOutput')
  expect(o.w.toasts.some(t => /^a2 woke after \d+ min/.test(t))).toBe(true)
})
