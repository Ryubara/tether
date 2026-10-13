// watch's poller boxes under fleet's table: parsing the state file, the countdown text and the drawing.
import { expect, mock, test } from 'claude-code/testing'

import { boxLines, clockText, countdownText, parseState, type BoxState } from '../../src/fleet/boxes'

const BOX: BoxState = { id: 'prs', title: 'pr-guard', everySeconds: 300, nextAt: 192_000, running: false, ok: true, rows: 3, log: [{ at: 0, text: '#7 conflict' }] }

test('countdown text reads M:SS, running and failed states', async () => {
  expect(clockText(192_000)).toBe('3:12')
  expect(clockText(-5)).toBe('0:00')
  expect(clockText(3_725_000)).toBe('1:02:05')
  expect(countdownText(BOX, 0)).toBe('next in 3:12')
  expect(countdownText({ ...BOX, running: true }, 0)).toBe('running…')
  expect(countdownText({ ...BOX, ok: false }, 0)).toBe('failed · next in 3:12')
})

test('a box shows its newest lines padded to its height, and says when it has nothing', async () => {
  expect(boxLines(BOX)).toHaveLength(3)
  expect(boxLines(BOX)[0]).toMatch(/^[0-9][0-9]:[0-9][0-9] #7 conflict$/)
  const many = { ...BOX, log: Array.from({ length: 10 }, (_, i) => ({ at: 0, text: 'f' + i })) }
  expect(boxLines(many).map(l => l.slice(6))).toEqual(['f7', 'f8', 'f9'])
  expect(boxLines({ ...BOX, log: [] })[0]).toBe('nothing found yet')
})

test('parseState accepts watch\'s file and nothing else', async () => {
  expect(parseState(JSON.stringify({ version: 1, updatedAt: 0, pollers: [BOX] }))?.pollers).toHaveLength(1)
  expect(parseState('{}')).toBeUndefined()
  expect(parseState('nope')).toBeUndefined()
})

test('the pane draws watch\'s boxes under the table when watchState names its file', async ($, on: any) => {
  const state = { version: 1, updatedAt: 0, pollers: [BOX, { ...BOX, id: 'agents', title: 'Agents', nextAt: 41_000 }] }
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', ($: any, e: any) => ({ value: String(e.path).includes('watch-state') ? JSON.stringify(state) : JSON.stringify({ fleet: { watchState: '/x/watch-state.json' } }) }))
  on('fs.stat', () => ({ value: { mtimeMs: 1, size: 1, kind: 'file' } }))
  on('fs.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'fleet', title: 'Fleet', isShown: true, isFocused: false, isPlaced: true }] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  const ui: any = await $.ui.mount({
    plugin: 'fleet',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'fleet',
    props: { title: 'Fleet', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as any)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts).toContain('pr-guard  next in 3:10')
  expect(texts).toContain('Agents  next in 0:39')
})
