import type { Io } from './io'

export type GitResult = { ok: boolean; code: number; out: string; err: string }

/** Runs git by argv in `cwd` and folds the result; never throws on a non-zero exit. */
export async function git(io: Io, cwd: string, args: readonly string[]): Promise<GitResult> {
  const ran = await io.run(['git', ...args], { cwd, timeoutMs: 120_000 })
  return { ok: ran.exitCode === 0, code: ran.exitCode, out: ran.stdout.trim(), err: ran.stderr.trim() }
}

export async function mkdirp(io: Io, path: string): Promise<void> {
  await io.run(['mkdir', '-p', path])
}

/** The repository's top level for `cwd`, or null outside a repository. */
export async function repoRoot(io: Io, cwd: string): Promise<string | null> {
  const r = await git(io, cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.out : null
}

export async function branchExists(io: Io, root: string, branch: string): Promise<boolean> {
  return (await git(io, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok
}

export async function remoteBranchExists(io: Io, root: string, branch: string): Promise<boolean> {
  const r = await git(io, root, ['ls-remote', '--heads', 'origin', branch])
  return r.ok && r.out.length > 0
}

/** Lines `.workspaces/` and `.context/` in the repository's `.git/info/exclude`, added once. */
export async function ensureExclude(io: Io, root: string): Promise<void> {
  const common = await git(io, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return
  const dir = `${common.out}/info`
  await mkdirp(io, dir)
  const file = `${dir}/exclude`
  const had = (await io.exists(file)) ? await io.read(file) : ''
  const lines = had.split('\n')
  const wanted = ['.workspaces/', '.context/', '.dacapo.conf']
  const missing = wanted.filter(w => !lines.some(l => l.trim() === w || l.trim() === w.replace(/\/$/, '')))
  if (missing.length === 0) return
  const sep = had.length === 0 || had.endsWith('\n') ? '' : '\n'
  await io.write(file, `${had}${sep}# dacapo\n${missing.join('\n')}\n`)
}

export type Worktree = { path: string; branch: string | null; head: string }

export async function listWorktrees(io: Io, root: string): Promise<Worktree[]> {
  const r = await git(io, root, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const trees: Worktree[] = []
  let cur: Partial<Worktree> = {}
  for (const line of `${r.out}\n`.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9), branch: null, head: '' }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === '' && cur.path) {
      trees.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '' })
      cur = {}
    }
  }
  return trees
}

/**
 * Brings the local base branch up to date with origin: fetched, then fast-forwarded where it is checked out
 * (or its ref moved when it is checked out nowhere). Anything but a fast-forward is reported, never forced.
 */
export async function refreshBase(io: Io, root: string, base: string): Promise<{ fetched: boolean; note: string }> {
  const fetched = await git(io, root, ['fetch', 'origin', base])
  if (!fetched.ok) return { fetched: false, note: `origin/${base} not fetched: ${(fetched.err || fetched.out).split('\n')[0] ?? ''}` }
  const tree = (await listWorktrees(io, root)).find(w => w.branch === base)
  if (tree) {
    const ff = await git(io, tree.path, ['merge', '--ff-only', `origin/${base}`])
    return { fetched: true, note: ff.ok ? `${base} is up to date with origin` : `${base} at ${tree.path} was not fast-forwarded: ${(ff.err || ff.out).split('\n')[0] ?? ''}` }
  }
  const moved = await git(io, root, ['fetch', 'origin', `${base}:${base}`])
  return { fetched: true, note: moved.ok ? `${base} is up to date with origin` : `${base} was not moved to origin/${base}: ${(moved.err || moved.out).split('\n')[0] ?? ''}` }
}

/** The worktree where `branch` is checked out, created under `.workspaces/<branch>` when none has it. */
export async function worktreeFor(io: Io, root: string, branch: string): Promise<string> {
  const found = (await listWorktrees(io, root)).find(w => w.branch === branch)
  if (found) return found.path
  const path = `${root}/.workspaces/${branch}`
  await mkdirp(io, `${root}/.workspaces`)
  const r = await git(io, root, ['worktree', 'add', path, branch])
  if (!r.ok) throw new Error(`git worktree add ${path} ${branch}: ${r.err || r.out}`)
  return path
}

/** A new branch and its worktree off `base`; a name taken locally (or on origin, when asked) gets a numeric suffix. */
export async function addBranchWorktree(
  io: Io,
  root: string,
  wanted: string,
  base: string,
  checkRemote = false,
): Promise<{ branch: string; path: string }> {
  const taken = async (name: string) => (await branchExists(io, root, name)) || (checkRemote && (await remoteBranchExists(io, root, name)))
  let branch = wanted
  for (let n = 2; await taken(branch); n += 1) branch = `${wanted}-${n}`
  const path = `${root}/.workspaces/${branch}`
  await mkdirp(io, `${root}/.workspaces/${branch.split('/').slice(0, -1).join('/')}`)
  const r = await git(io, root, ['worktree', 'add', '-b', branch, path, base])
  if (!r.ok) throw new Error(`git worktree add -b ${branch}: ${r.err || r.out}`)
  return { branch, path }
}

/** A detached worktree at `path` on `base`, for a QA round. */
export async function addDetachedWorktree(io: Io, root: string, path: string, base: string): Promise<void> {
  await mkdirp(io, path.split('/').slice(0, -1).join('/'))
  const r = await git(io, root, ['worktree', 'add', '--detach', path, base])
  if (!r.ok) throw new Error(`git worktree add --detach ${path}: ${r.err || r.out}`)
}

export async function removeWorktree(io: Io, root: string, path: string, branch?: string): Promise<string[]> {
  const notes: string[] = []
  if (await io.exists(path)) {
    const plain = await git(io, root, ['worktree', 'remove', path])
    if (!plain.ok) {
      const forced = await git(io, root, ['worktree', 'remove', '--force', path])
      if (!forced.ok) notes.push(`worktree ${path} not removed: ${forced.err || forced.out}`)
    }
    // the parent (`.workspaces/qa`) goes once it is empty; rmdir refuses otherwise
    await io.run(['rmdir', path.split('/').slice(0, -1).join('/')])
  }
  await git(io, root, ['worktree', 'prune'])
  if (branch) {
    const del = await git(io, root, ['branch', '-D', branch])
    if (!del.ok) notes.push(`branch ${branch} not deleted: ${del.err || del.out}`)
  }
  return notes
}

/** Deletes `branch` on origin; a branch already gone is no error. */
export async function deleteRemoteBranch(io: Io, root: string, branch: string): Promise<string | null> {
  if (!(await remoteBranchExists(io, root, branch))) return null
  const del = await git(io, root, ['push', 'origin', '--delete', branch])
  return del.ok ? null : `origin/${branch} not deleted: ${(del.err || del.out).split('\n')[0] ?? ''}`
}

export type PullOutcome = { kind: 'pulled'; commits: number } | { kind: 'error'; message: string }

/** Fast-forwards the worktree's branch to origin; never merges. */
export async function pullFf(io: Io, worktree: string, branch: string): Promise<PullOutcome> {
  const before = await git(io, worktree, ['rev-parse', 'HEAD'])
  const pulled = await git(io, worktree, ['pull', '--ff-only', 'origin', branch])
  if (!pulled.ok) {
    const message = (pulled.err || pulled.out).split('\n').filter(l => l.trim() && !/^\s*(From |hint:)/.test(l)).join(' ').slice(0, 300)
    return { kind: 'error', message: message || 'pull failed' }
  }
  const count = await git(io, worktree, ['rev-list', '--count', `${before.out}..HEAD`])
  return { kind: 'pulled', commits: count.ok ? Number(count.out) || 0 : 0 }
}

export type PushOutcome = { kind: 'pushed' } | { kind: 'no-remote' } | { kind: 'failed'; message: string }

/** Pushes `branch` to `origin`, setting the upstream on the first push; never throws. */
export async function pushBranch(io: Io, cwd: string, branch: string): Promise<PushOutcome> {
  const remote = await git(io, cwd, ['remote', 'get-url', 'origin'])
  if (!remote.ok || !remote.out) return { kind: 'no-remote' }
  const pushed = await git(io, cwd, ['push', '--set-upstream', 'origin', branch])
  if (pushed.ok) return { kind: 'pushed' }
  const message = (pushed.err || pushed.out).split('\n').filter(l => l.trim() && !/^\s*(To |remote: |hint:)/.test(l)).join(' ').slice(0, 300)
  return { kind: 'failed', message: message || 'push failed' }
}
