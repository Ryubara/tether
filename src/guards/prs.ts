// The PR guard's pure part: what counts as a problem with an open pull request, who owns it, and how it is
// told. A problem is keyed PR + cause + head commit, so a new push is a new problem. The reading of GitHub
// and of the worktrees is in hooks/register.tsx; this file only turns what was read into problems.

import { ownerCovers, type GuardStore } from './store'

/** One problem with an open PR. */
export type Problem = {
  number: number
  branch: string
  /** `conflict`, `checks-failed`, `ci-stuck`, `auto-merge-off`, `unpushed`, or a project's own (health command). */
  cause: string
  /** What follows "#<n> <branch>: " in the line. */
  text: string
  /** The PR's head commit (the worktree's for `unpushed`); `?` when unknown. */
  sha: string
  /** More identity for the key (the failing checks). */
  extra: string
}

/** The identity a problem is told by: PR + cause + head commit (+ extra). */
export function problemKey(p: Problem): string {
  const base = `${p.number}|${p.cause}|${p.sha}`
  return p.extra ? `${base}|${p.extra}` : base
}

/** The line a problem is told as. */
export function problemLine(p: Problem): string {
  return `#${p.number} ${p.branch}: ${p.text}`
}

/** What the built-in GitHub read asks `gh pr list` for. */
export const GH_FIELDS = 'number,headRefName,headRefOid,isDraft,mergeable,autoMergeRequest,statusCheckRollup'

/** The settings the built-in read needs. */
export type GhRules = { stuckMinutes: number; requireAutoMerge: boolean; ignoreDrafts: boolean }

type Check = { name?: string; context?: string; status?: string; state?: string; conclusion?: string; startedAt?: string }

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])
const RUNNING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'EXPECTED'])

/** The problems in `gh pr list --json <GH_FIELDS>` output; an entry that is not an object is skipped. */
export function fromGh(list: unknown, rules: GhRules, now: number): Problem[] {
  if (!Array.isArray(list)) return []
  const out: Problem[] = []
  for (const raw of list) {
    const pr = raw as Record<string, unknown> | null
    if (!pr || typeof pr.number !== 'number') continue
    if (rules.ignoreDrafts && pr.isDraft === true) continue
    const branch = typeof pr.headRefName === 'string' ? pr.headRefName : '?'
    const sha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '?'
    const make = (cause: string, text: string, extra = ''): Problem => ({ number: pr.number as number, branch, cause, text, sha, extra })
    if (pr.mergeable === 'CONFLICTING') out.push(make('conflict', 'conflicts with the base branch'))
    const checks = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []) as Check[]
    const failed = checks.filter(c => FAILED.has(String(c.conclusion ?? c.state ?? '').toUpperCase())).map(c => c.name ?? c.context ?? '?').sort()
    if (failed.length > 0) out.push(make('checks-failed', `checks failed: ${failed.join(', ')}`, failed.join(',')))
    const stuck = checks.filter(c => {
      const state = String(c.status ?? c.state ?? '').toUpperCase()
      const started = c.startedAt ? Date.parse(c.startedAt) : NaN
      return RUNNING.has(state) && Number.isFinite(started) && now - started >= rules.stuckMinutes * 60_000
    })
    if (stuck.length > 0) out.push(make('ci-stuck', `CI running over ${rules.stuckMinutes} min: ${stuck.map(c => c.name ?? c.context ?? '?').sort().join(', ')}`))
    if (rules.requireAutoMerge && pr.autoMergeRequest == null) out.push(make('auto-merge-off', 'auto-merge is off'))
  }
  return out
}

/** One entry of a project's health command: `{ number, cause, kind?, detail?, checks?, branch?, sha? }`. */
export type Stuck = { number: number; cause: string; kind?: string; detail?: string; checks?: string[]; branch?: string; sha?: string }

/**
 * The problems in a project's own health command's JSON (`{ "stuck": [...] }`), with the PR heads and
 * branches `gh pr list` gave for the numbers an entry does not name itself. Anything else in the answer
 * (a project's rerun lines, say) is ignored.
 */
export function fromHealth(data: unknown, heads: Map<number, { branch: string; sha: string }>): Problem[] {
  const stuck = (data as { stuck?: unknown } | null)?.stuck
  if (!Array.isArray(stuck)) return []
  const out: Problem[] = []
  for (const s of stuck as Stuck[]) {
    if (!s || typeof s.number !== 'number' || typeof s.cause !== 'string') continue
    const head = heads.get(s.number)
    const checks = Array.isArray(s.checks) ? [...s.checks].sort() : []
    out.push({
      number: s.number,
      branch: s.branch ?? head?.branch ?? '?',
      cause: s.cause,
      text: [s.cause, s.kind, s.detail].filter(Boolean).join(' '),
      sha: s.sha ?? head?.sha ?? '?',
      extra: s.cause === 'checks-failed' ? checks.join(',') : '',
    })
  }
  return out
}

/** An open PR whose idle worktree holds commits origin lacks: work done but never released. */
export function unpushedProblem(number: number, branch: string, ahead: number, sha: string): Problem {
  return { number, branch, cause: 'unpushed', text: `worktree ${branch} is ${ahead} commits ahead of origin, not pushed`, sha, extra: '' }
}

/** The problems with no current owner or waiver, sorted by PR then text. */
export function unowned(problems: Problem[], store: GuardStore, now: number): Problem[] {
  return problems.filter(p => !ownerCovers(store.owners[String(p.number)], p.cause, now)).sort((a, b) => a.number - b.number || a.text.localeCompare(b.text))
}

/** How a model is told to deal with problems nobody owns. */
export const HOW_TO = 'Fix each yourself or dispatch an agent, then record it with the mcp__tether__pr_owner tool (load it with ToolSearch if it is deferred): assign lasts a few hours; waive is a known wait, optionally for one cause.'

/** The Stop hook's reason: the unowned problems and what to do about them. */
export function stopReason(problems: Problem[]): string {
  return `PR GUARD: open pull requests are in trouble and nobody owns the fix. ${HOW_TO}\n` + problems.map(p => `- ${problemLine(p)}`).join('\n')
}
