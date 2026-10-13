// Tests of the conversation log: what is kept, what is dropped, and the file name.
import { expect, test } from 'claude-code/testing'

import { cleanText, logName, renderConversation, toolLine, turnTitle } from '../../src/conversation/render'

test('cleanText drops reminders and command echoes', async () => {
  expect(cleanText('hi <system-reminder>secret\nmore</system-reminder> there <local-command-stdout>x</local-command-stdout>')).toBe('hi  there')
})

test('toolLine picks the most telling input and cuts it short', async () => {
  expect(toolLine('Bash', { command: 'git   status\n-s' }, 100)).toBe('- Bash: git status -s')
  expect(toolLine('Read', { file_path: 'a'.repeat(200) }, 10)).toBe('- Read: aaaaaaaaa…')
  expect(toolLine('Agent', {}, 10)).toBe('- Agent')
})

test('turnTitle takes the first non-empty line without heading marks', async () => {
  expect(turnTitle('\n## Fix the bug\nmore', 70)).toBe('Fix the bug')
  expect(turnTitle('   ', 70)).toBe('(no text)')
  expect(turnTitle('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
})

test('renderConversation numbers the turns of the person and keeps tool calls as bullets', async () => {
  const md = renderConversation(
    [
      { role: 'user', text: 'Fix the bug <system-reminder>noise</system-reminder>' },
      { role: 'assistant', text: 'Looking.\n# not a heading', toolUses: [{ tool: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'user', text: '<system-reminder>only noise</system-reminder>' },
      { role: 'user', text: 'Thanks' },
      { role: 'assistant', text: 'Done.' },
    ],
    { sessionId: 's1', startedAt: '2026-10-13 12:00' },
  )
  expect(md).toBe(
    [
      '# Conversation s1', '', 'Started 2026-10-13 12:00.', '',
      '## 1. Fix the bug', '', '**You:**', '', 'Fix the bug', '',
      '**Claude:**', '', 'Looking.', '\\# not a heading', '', '- Read: a.ts', '',
      '## 2. Thanks', '', '**You:**', '', 'Thanks', '',
      '**Claude:**', '', 'Done.', '',
    ].join('\n'),
  )
})

test('logName is the start time and the first eight characters of the session id', async () => {
  expect(logName('2026-10-13T12:34:56Z', 'abcdef12-3456')).toBe('2026-10-13-1234-abcdef12.md')
  expect(logName('2026-10-13T12:34:56Z', '///')).toBe('2026-10-13-1234-session.md')
})
