import type { Gh, Pr, PrChecks, PrState } from '../types'
import type { Io } from './io'

export type GhResult = { ok: boolean; code: number; out: string; err: string }

/** Where gh may live when the engine's PATH is shorter than the person's shell. */
const CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh']
let bin: string | null = null

async function tryRun(io: Io, exe: string, cwd: string | undefined, args: readonly string[], timeoutMs: number): Promise<GhResult | null> {
  try {
    const ran = await io.run([exe, ...args], cwd ? { cwd, timeoutMs } : { timeoutMs })
    return { ok: ran.exitCode === 0, code: ran.exitCode, out: ran.stdout.trim(), err: ran.stderr.trim() }
  } catch {
    return null
  }
}

/** Finds a gh binary once; null when none answers `--version`. */
async function locate(io: Io): Promise<string | null> {
  if (bin) return bin
  for (const exe of CANDIDATES) {
    const ran = await tryRun(io, exe, undefined, ['--version'], 20_000)
    if (ran?.ok) {
      bin = exe
      return exe
    }
  }
  return null
}

/** Runs gh by argv in `cwd`; a missing binary answers as a failed run. */
export async function gh(io: Io, cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<GhResult> {
  const exe = await locate(io)
  if (!exe) return { ok: false, code: 127, out: '', err: 'gh is not installed' }
  return (await tryRun(io, exe, cwd, args, timeoutMs)) ?? { ok: false, code: 1, out: '', err: 'gh could not be run' }
}

/** Installed, logged in, and the repository's origin is on GitHub. */
export async function checkGh(io: Io, cwd: string): Promise<Gh> {
  if (!(await locate(io))) return { ok: false, problem: 'missing', detail: 'gh is not installed or not on the PATH' }
  const auth = await gh(io, cwd, ['auth', 'status'], 30_000)
  if (!auth.ok) return { ok: false, problem: 'unauthenticated', detail: (auth.err || auth.out).split('\n')[0] ?? 'gh auth status failed' }
  const repo = await gh(io, cwd, ['repo', 'view', '--json', 'nameWithOwner,url'], 60_000)
  if (!repo.ok) return { ok: false, problem: 'not-github', detail: (repo.err || repo.out).split('\n')[0] ?? 'gh repo view failed' }
  try {
    const got = JSON.parse(repo.out) as { nameWithOwner?: unknown; url?: unknown }
    if (typeof got.nameWithOwner === 'string' && typeof got.url === 'string') return { ok: true, repo: got.nameWithOwner, url: got.url }
  } catch {
    // fall through
  }
  return { ok: false, problem: 'not-github', detail: 'gh repo view answered without a repository' }
}

type RollupItem = { __typename?: string; status?: string; conclusion?: string; state?: string }

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Folds GitHub's check runs and commit statuses into one word; a failure wins over anything still running. */
export function checksOf(items: readonly RollupItem[]): PrChecks {
  if (items.length === 0) return 'none'
  let pending = false
  for (const it of items) {
    if (typeof it.state === 'string' && it.status === undefined) {
      if (it.state === 'FAILURE' || it.state === 'ERROR') return 'failing'
      if (it.state === 'PENDING' || it.state === 'EXPECTED') pending = true
    } else if (it.status !== 'COMPLETED') pending = true
    else if (it.conclusion && FAILED.has(it.conclusion)) return 'failing'
  }
  return pending ? 'pending' : 'passing'
}

type Listed = {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  mergeable: string
  statusCheckRollup: RollupItem[] | null
  createdAt: string
}

const FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,mergeable,statusCheckRollup,createdAt'

export function parsePrs(json: string, heads: ReadonlySet<string>): Pr[] | null {
  let list: Listed[]
  try {
    list = JSON.parse(json) as Listed[]
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const out: Pr[] = []
  for (const p of list) {
    if (!heads.has(p.headRefName)) continue
    const state: PrState = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open'
    out.push({
      number: p.number,
      url: p.url,
      title: p.title,
      state,
      checks: checksOf(p.statusCheckRollup ?? []),
      mergeable: p.mergeable === 'MERGEABLE' ? 'mergeable' : p.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
      head: p.headRefName,
      base: p.baseRefName,
      createdAt: Date.parse(p.createdAt) || 0,
    })
  }
  return out
}

/** Every pull request whose head is one of `heads`, newest first; null when gh did not answer. */
export async function listPrs(io: Io, cwd: string, heads: ReadonlySet<string>): Promise<Pr[] | null> {
  if (heads.size === 0) return []
  const ran = await gh(io, cwd, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', FIELDS], 60_000)
  if (!ran.ok) return null
  return parsePrs(ran.out, heads)
}

export type CreateOutcome = { kind: 'created'; number: number; url: string } | { kind: 'error'; message: string }

export async function createPr(io: Io, cwd: string, a: { base: string; head: string; title: string; body: string }): Promise<CreateOutcome> {
  const ran = await gh(io, cwd, ['pr', 'create', '--base', a.base, '--head', a.head, '--title', a.title, '--body', a.body])
  if (!ran.ok) return { kind: 'error', message: (ran.err || ran.out).split('\n').filter(Boolean).slice(-2).join(' ') || 'gh pr create failed' }
  const url = ran.out.split('\n').find(l => /^https?:\/\//.test(l.trim()))?.trim() ?? ''
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0)
  if (!url || !number) return { kind: 'error', message: `gh pr create answered without a pull request URL: ${ran.out.slice(0, 200)}` }
  return { kind: 'created', number, url }
}

export async function editPr(io: Io, cwd: string, number: number, title: string, body: string): Promise<GhResult> {
  return gh(io, cwd, ['pr', 'edit', `${number}`, '--title', title, '--body', body])
}

/** Merges with a merge commit titled `subject` and no body; the result says why when GitHub refuses. */
export async function mergePr(io: Io, cwd: string, number: number, method: 'merge' | 'squash', subject: string): Promise<GhResult> {
  return gh(io, cwd, ['pr', 'merge', `${number}`, `--${method}`, '--subject', subject, '--body', ''])
}

export async function closePr(io: Io, cwd: string, number: number): Promise<GhResult> {
  return gh(io, cwd, ['pr', 'close', `${number}`])
}
