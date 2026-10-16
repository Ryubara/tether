// The one Tether pane: Fleet's table on top, Watch's poller boxes beneath, each section only while its part is on.
import { expect, test } from 'claude-code/testing'

import { command, SEC, start, world } from './world'

const POLLER = { id: 'agents', kind: 'agents', title: 'Subagents', everySeconds: 60 }

/** The texts the Tether pane draws now. */
async function paneTexts($: any): Promise<string[]> {
  const ui: any = await $.ui.mount({ plugin: 'tether', surface: 'terminal', component: 'Pane', requestId: 'tether', props: { title: 'Tether', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  await ui.unmount()
  return texts
}

test('both parts on: the table first, the boxes beneath it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ watch: { pollers: [POLLER] } }) } })
  const clock = await start($, on, w)
  await clock.advance(5 * SEC)
  const texts = await paneTexts($)
  const table = texts.indexOf('0 agents')
  const box = texts.findIndex(t => /^Subagents {2}next in/.test(t))
  expect(table).toBeGreaterThanOrEqual(0)
  expect(box).toBeGreaterThan(table)
})

test('fleet off leaves its table out: the boxes alone', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ fleet: { enabled: false }, watch: { pollers: [POLLER] } }) } })
  const clock = await start($, on, w)
  await clock.advance(5 * SEC)
  const texts = await paneTexts($)
  expect(texts).not.toContain('0 agents')
  expect(texts.some(t => /^Subagents {2}next in/.test(t))).toBe(true)
})

test('watch off leaves its boxes out', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ watch: { enabled: false, pollers: [POLLER] } }) } })
  const clock = await start($, on, w)
  await clock.advance(5 * SEC)
  const texts = await paneTexts($)
  expect(texts).toContain('0 agents')
  expect(texts.some(t => /^Subagents/.test(t))).toBe(false)
})

test('/tether-fleet and /tether-watch pane open the same pane, focused; /tether-watch opens it beside its report', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world({ files: { '.claude/tether.json': JSON.stringify({ watch: { pollers: [POLLER] } }) } })
  await start($, on, w)
  await command($, 'tether-fleet')
  await command($, 'tether-watch', 'pane')
  expect(await command($, 'tether-watch')).toMatch(/^watch: /)
  await new Promise(r => setTimeout(r, 0))
  expect(w.opened.map(o => [o.id, o.title, o.focus])).toEqual([
    ['tether', 'Tether', true],
    ['tether', 'Tether', true],
    ['tether', 'Tether', undefined],
  ])
})
