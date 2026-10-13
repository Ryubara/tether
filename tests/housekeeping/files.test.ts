// Tests of the housekeeping files: the exclude lines, the starting handoff and the handoff path match.
import { expect, test } from 'claude-code/testing'

import { CHECKPOINT_DEFAULTS } from '../../src/checkpoint/config'
import { handoffProblems } from '../../src/checkpoint/handoff'
import { excludeLines, handoffTemplate, isHandoffPath, withExcludes } from '../../src/housekeeping/files'

test('excludeLines names the folder, the handoff and a project-relative config', async () => {
  expect(excludeLines({ folder: '.tether', handoffFile: 'HANDOFF.md', configFile: '.claude/tether.json', extra: [] })).toEqual(['.tether/', 'HANDOFF.md', '.claude/tether.json'])
  expect(excludeLines({ folder: '.tether/', handoffFile: 'HANDOFF.md', configFile: 'C:/cfg/tether.json', extra: ['x', 'HANDOFF.md'] })).toEqual(['.tether/', 'HANDOFF.md', 'x'])
  expect(excludeLines({ folder: '.tether', handoffFile: 'H.md', configFile: '/etc/t.json', extra: [] })).toEqual(['.tether/', 'H.md'])
})

test('withExcludes appends only the missing lines, and nothing when all are there', async () => {
  expect(withExcludes('', ['.tether/'])).toBe('.tether/\n')
  expect(withExcludes('# note\r\n.tether/', ['.tether/', 'HANDOFF.md'])).toBe('# note\r\n.tether/\nHANDOFF.md\n')
  expect(withExcludes('a\n', ['b'])).toBe('a\nb\n')
  expect(withExcludes('a\n.tether/\n', ['.tether/'])).toBeUndefined()
})

test('the starting handoff passes the checkpoint check', async () => {
  const text = handoffTemplate(CHECKPOINT_DEFAULTS.sections)
  expect(handoffProblems(text, CHECKPOINT_DEFAULTS)).toEqual([])
  expect(text.startsWith('# HANDOFF')).toBe(true)
})

test('isHandoffPath matches the file by its tail', async () => {
  expect(isHandoffPath('HANDOFF.md', 'HANDOFF.md')).toBe(true)
  expect(isHandoffPath('C:\\work\\proj\\HANDOFF.md', 'HANDOFF.md')).toBe(true)
  expect(isHandoffPath('/work/proj/OLDHANDOFF.md', 'HANDOFF.md')).toBe(false)
  expect(isHandoffPath(undefined, 'HANDOFF.md')).toBe(false)
})
