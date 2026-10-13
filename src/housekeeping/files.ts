// The files Tether keeps in a project besides its config: the lines it adds to .git/info/exclude (so nothing
// it makes is ever committed and no tracked file is edited), and the starting HANDOFF.md.

/** The lines Tether needs git to ignore, from the settings: its folder, the handoff and (inside the project) its config. */
export function excludeLines(opts: { folder: string; handoffFile: string; configFile: string; extra: string[] }): string[] {
  const lines = [opts.folder.replace(/\/?$/, '/'), opts.handoffFile]
  // A config outside the project (an absolute path) is not git's business
  if (!/^([a-zA-Z]:|[\\/])/.test(opts.configFile)) lines.push(opts.configFile.replace(/\\/g, '/'))
  return [...new Set([...lines, ...opts.extra])]
}

/** `existing` with the missing `lines` appended; undefined when all are there already (nothing to write). */
export function withExcludes(existing: string, lines: string[]): string | undefined {
  const have = new Set(existing.split(/\r?\n/).map(l => l.trim()))
  const missing = lines.filter(l => !have.has(l))
  if (missing.length === 0) return undefined
  const head = existing === '' || existing.endsWith('\n') ? existing : existing + '\n'
  return head + missing.join('\n') + '\n'
}

/** The starting handoff: a title, then every required heading with a placeholder (which passes the check). */
export function handoffTemplate(sections: string[]): string {
  return ['# HANDOFF', '', ...sections.flatMap(s => [s, '', '(nothing yet)', ''])].join('\n')
}

/** Whether a tool's file path is the handoff file: equal to it, or ending in it after a folder separator. */
export function isHandoffPath(path: unknown, handoffFile: string): boolean {
  if (typeof path !== 'string') return false
  const p = path.replace(/\\/g, '/')
  const h = handoffFile.replace(/\\/g, '/')
  return p === h || p.endsWith('/' + h)
}
