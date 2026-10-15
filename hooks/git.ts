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

/** Lines `.workspaces/` and `.context/` in the repository's `.git/info/exclude`, added once. */
export async function ensureExclude(io: Io, root: string): Promise<void> {
  const common = await git(io, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return
  const dir = `${common.out}/info`
  await mkdirp(io, dir)
  const file = `${dir}/exclude`
  const had = (await io.exists(file)) ? await io.read(file) : ''
  const lines = had.split('\n')
  const wanted = ['.workspaces/', '.context/']
  const missing = wanted.filter(w => !lines.some(l => l.trim() === w || l.trim() === w.replace(/\/$/, '')))
  if (missing.length === 0) return
  const sep = had.length === 0 || had.endsWith('\n') ? '' : '\n'
  await io.write(file, `${had}${sep}# dacapo\n${missing.join('\n')}\n`)
}

/** Creates `dev` from `main` (or HEAD when `main` is missing) if it does not exist yet. */
export async function ensureBranch(io: Io, root: string, branch: string, from: string): Promise<void> {
  if (await branchExists(io, root, branch)) return
  const base = (await branchExists(io, root, from)) ? from : 'HEAD'
  const r = await git(io, root, ['branch', branch, base])
  if (!r.ok) throw new Error(`git branch ${branch} ${base}: ${r.err || r.out}`)
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

/** A new branch and its worktree off `base`; a taken name gets a numeric suffix. */
export async function addBranchWorktree(
  io: Io,
  root: string,
  wanted: string,
  base: string,
): Promise<{ branch: string; path: string }> {
  let branch = wanted
  for (let n = 2; await branchExists(io, root, branch); n += 1) branch = `${wanted}-${n}`
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
    // the parent (`.workspaces/task`, `.workspaces/qa`) goes once it is empty; rmdir refuses otherwise
    await io.run(['rmdir', path.split('/').slice(0, -1).join('/')])
  }
  await git(io, root, ['worktree', 'prune'])
  if (branch) {
    const del = await git(io, root, ['branch', '-D', branch])
    if (!del.ok) notes.push(`branch ${branch} not deleted: ${del.err || del.out}`)
  }
  return notes
}

export type SquashOutcome =
  | { kind: 'merged'; commit: string }
  | { kind: 'empty' }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'error'; message: string }

/** `git merge --squash <branch>` then one commit titled `title`, run in the worktree that holds the target branch. */
export async function squashMerge(
  io: Io,
  devWorktree: string,
  branch: string,
  title: string,
): Promise<SquashOutcome> {
  const merge = await git(io, devWorktree, ['-c', 'merge.ff=true', 'merge', '--squash', branch])
  if (!merge.ok) {
    const conflicted = await git(io, devWorktree, ['diff', '--name-only', '--diff-filter=U'])
    const files = conflicted.out ? conflicted.out.split('\n') : []
    await git(io, devWorktree, ['reset', '--merge'])
    return files.length > 0 ? { kind: 'conflict', files } : { kind: 'error', message: merge.err || merge.out }
  }
  const staged = await git(io, devWorktree, ['diff', '--cached', '--quiet'])
  if (staged.ok) return { kind: 'empty' }
  const commit = await git(io, devWorktree, ['commit', '-m', title])
  if (!commit.ok) return { kind: 'error', message: commit.err || commit.out }
  const sha = await git(io, devWorktree, ['rev-parse', '--short', 'HEAD'])
  return { kind: 'merged', commit: sha.out }
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

export type ReleaseOutcome =
  | { kind: 'fast-forward' }
  | { kind: 'up-to-date' }
  /** `main` holds commits `dev` lacks, so no fast-forward is possible; nothing was changed. */
  | { kind: 'diverged'; ahead: number }
  | { kind: 'error'; message: string }

/** Fast-forwards `main` to `dev`, and only that: a diverged `main` is reported untouched. */
export async function releaseToMain(
  io: Io,
  root: string,
  dev: string,
  main: string,
): Promise<{ outcome: ReleaseOutcome; notes: string[] }> {
  const notes: string[] = []
  const trees = await listWorktrees(io, root)
  let mainTree = trees.find(w => w.branch === main)?.path
  let isTemp = false
  if (!mainTree) {
    mainTree = `${root}/.workspaces/${main}`
    try {
      mainTree = await worktreeFor(io, root, main)
      isTemp = true
    } catch (error) {
      return { outcome: { kind: 'error', message: String(error) }, notes }
    }
  }
  const behind = await git(io, mainTree, ['rev-list', '--count', `${main}..${dev}`])
  const ahead = await git(io, mainTree, ['rev-list', '--count', `${dev}..${main}`])
  const aheadBy = ahead.ok ? Number(ahead.out) || 0 : 0
  let outcome: ReleaseOutcome
  if (behind.ok && behind.out === '0') outcome = { kind: 'up-to-date' }
  else if (aheadBy > 0) outcome = { kind: 'diverged', ahead: aheadBy }
  else {
    const ff = await git(io, mainTree, ['merge', '--ff-only', dev])
    outcome = ff.ok ? { kind: 'fast-forward' } : { kind: 'error', message: ff.err || ff.out }
  }
  if (isTemp) notes.push(...(await removeWorktree(io, root, mainTree)))
  return { outcome, notes }
}
