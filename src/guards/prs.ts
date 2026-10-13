// The PR guard's pure part: what counts as a problem with an open pull request, who owns it, and how it is
// told. A problem is keyed PR + cause + head commit, so a new push is a new problem. The reading of GitHub
// and of the worktrees is in hooks/register.tsx; this file only turns what was read into problems.

import { ownerCovers, rerunCovers, type GuardStore } from './store'

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
  /** An information line (a rerun the project's command reported): told, never owned, never blocks Stop. */
  info?: true
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
 * branches `gh pr list` gave for the numbers an entry does not name itself. Its `rerun` list is read by
 * `rerunsFromHealth`; anything else in the answer is ignored.
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

/** One entry of a project's `rerun` list; fields not named here are ignored. */
export type Rerun = {
  number: number
  branch?: string
  /** The workflow run that was (or would be) rerun. */
  run?: number
  /** The failed checks, sorted. */
  checks: string[]
  /** Why each check was chosen, in the order of `checks`. */
  reasons: string[]
  /** `would-rerun`, `reran`, `refused`, `capped` or `new-event`. */
  status: string
  /** Why a rerun was refused or capped; empty otherwise. */
  detail?: string
}

/** The statuses that say a rerun is under way (or would be), so it owns its PR's failed checks. The others (`refused`, `capped`, `new-event`) cannot fix it. */
export const ACTIVE_RERUN = new Set(['would-rerun', 'reran'])

/** The well-formed entries (a number and a status) of a health command's `rerun` list, checks sorted. */
export function rerunsFromHealth(data: unknown): Rerun[] {
  const list = (data as { rerun?: unknown } | null)?.rerun
  if (!Array.isArray(list)) return []
  const out: Rerun[] = []
  for (const x of list as Array<Partial<Rerun> | null>) {
    if (!x || typeof x.number !== 'number' || typeof x.status !== 'string' || x.status === '') continue
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [])
    out.push({
      number: x.number,
      checks: strings(x.checks).sort(),
      reasons: strings(x.reasons),
      status: x.status,
      ...(typeof x.branch === 'string' && x.branch !== '' ? { branch: x.branch } : {}),
      ...(typeof x.run === 'number' ? { run: x.run } : {}),
      ...(typeof x.detail === 'string' && x.detail !== '' ? { detail: x.detail } : {}),
    })
  }
  return out
}

/** The lines for a health command's reruns, with the PR heads and branches `gh pr list` gave. Every entry is told; only an active one (see ACTIVE_RERUN) also owns the problem. */
export function rerunInfo(reruns: Rerun[], heads: Map<number, { branch: string; sha: string }>): Problem[] {
  return reruns.map(r => {
    const head = heads.get(r.number)
    const why = r.detail ?? r.reasons.join('; ')
    return {
      number: r.number,
      branch: r.branch ?? head?.branch ?? '?',
      cause: `rerun-${r.status}`,
      text: ['rerun', r.checks.join(', '), r.run === undefined ? '' : `(run ${r.run})`, r.status + (why ? `: ${why}` : '')].filter(Boolean).join(' '),
      sha: head?.sha ?? '?',
      extra: `${r.run ?? ''}:${r.checks.join(',')}`,
      info: true as const,
    }
  })
}

/** Whether a rerun recorded in the store owns this problem (failed checks, every one rerun, same head). */
function rerunOwns(p: Problem, store: GuardStore, now: number): boolean {
  return rerunCovers(store.reruns[String(p.number)], p.cause, p.extra === '' ? [] : p.extra.split(','), p.sha, now)
}

/** The problems with no current owner, waiver or rerun, sorted by PR then text. Information lines never count. */
export function unowned(problems: Problem[], store: GuardStore, now: number): Problem[] {
  return problems
    .filter(p => !p.info && !ownerCovers(store.owners[String(p.number)], p.cause, now) && !rerunOwns(p, store, now))
    .sort((a, b) => a.number - b.number || a.text.localeCompare(b.text))
}

/** What a poll tells: the unowned problems and the information lines, sorted by PR then text. */
export function toldProblems(problems: Problem[], store: GuardStore, now: number): Problem[] {
  return [...unowned(problems, store, now), ...problems.filter(p => p.info)].sort((a, b) => a.number - b.number || a.text.localeCompare(b.text))
}

/** How a model is told to deal with problems nobody owns. */
export const HOW_TO = 'Fix each yourself or dispatch an agent, then record it with the mcp__tether__pr_owner tool (load it with ToolSearch if it is deferred): assign lasts a few hours; waive is a known wait, optionally for one cause.'

/** The Stop hook's reason: the unowned problems and what to do about them. */
export function stopReason(problems: Problem[]): string {
  return `PR GUARD: open pull requests are in trouble and nobody owns the fix. ${HOW_TO}\n` + problems.map(p => `- ${problemLine(p)}`).join('\n')
}
