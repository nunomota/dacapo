import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { QaRow, Row, Run, UserRow, WorkerRow } from '../types'
import * as git from './git'
import type { Io } from './io'
import { drawBand, drawPane, elapsed, hhmm, scoreLine, statusWord, type Actions, type Els, type Snapshot } from './pane'
import { QA_SYSTEM, WORKER_SYSTEM, qaBrief, workerBrief } from './prompts'
import { validateReport, validateRubric, type RubricItem } from './report'

const PANE = 'task-loop'
const WORKER_AGENT = 'task-loop:worker'
const QA_AGENT = 'task-loop:qa'
const tool = (name: string) => `mcp__task-loop__${name}`

const STALE_MS = 30 * 60_000
const TIMEOUT_MS = 2 * 60 * 60_000
const TICK_MS = 1_000
const WAKE_PREFIX = '[task-loop]'

const runAtom = atom({ plugin: 'task-loop', key: 'run' } as const, null)
const rowsAtom = atom({ plugin: 'task-loop', key: 'rows' } as const, [])
const uiAtom = atom({ plugin: 'task-loop', key: 'ui' } as const, {
  collapsed: [],
  expanded: [],
  tick: 0,
  isBandHidden: false,
})

type Args = Record<string, unknown>

/** The engine as closures, made once in `session.start`; every helper below reaches the engine through it. */
let io: Io
/** Prompts this module queued itself, so `prompt.submit` does not log them as the person's. */
const ownPrompts = new Set<string>()
/** Rubrics by QA row id, for validation; the run folder holds the copy that survives a reload. */
const rubrics = new Map<string, RubricItem[]>()

// ---------- small helpers ----------

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'

function normalize(path: string, cwd: string): string {
  const joined = path.startsWith('/') ? path : `${cwd}/${path}`
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const isUnder = (path: string, base: string, cwd: string) => {
  const p = normalize(path, cwd)
  const b = normalize(base, cwd)
  return p === b || p.startsWith(`${b}/`)
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const isTerminal = (row: WorkerRow | QaRow) => row.status !== 'running' && row.status !== 'stale'

const isAgent = (id: string) => (r: Row): r is WorkerRow | QaRow => r.kind !== 'user' && r.id === id

const patchRow = (id: string, fn: (row: WorkerRow | QaRow) => WorkerRow | QaRow) =>
  io.setRows(rows => rows.map(r => (r.kind !== 'user' && r.id === id ? fn(r) : r)))
const patchWorker = (id: string, fn: (row: WorkerRow) => WorkerRow) =>
  io.setRows(rows => rows.map(r => (r.kind === 'worker' && r.id === id ? fn(r) : r)))
const patchQa = (id: string, fn: (row: QaRow) => QaRow) =>
  io.setRows(rows => rows.map(r => (r.kind === 'qa' && r.id === id ? fn(r) : r)))

async function snapshot(): Promise<Snapshot> {
  const [run, rows, ui] = await Promise.all([io.getRun(), io.getRows(), io.getUi()])
  return { run, rows, ui }
}

function wake(text: string) {
  const full = `${WAKE_PREFIX} ${text}`
  ownPrompts.add(full)
  void io.submit(full).catch(() => ownPrompts.delete(full))
}

const fail = (text: string) => ({ isError: true as const, result: { error: text }, text })
const ok = (result: Record<string, unknown>, text: string) => ({ result, text })
/** A tool handler that threw answers the call with the error instead of failing silently. */
const crashed = (_: unknown, e: { tool: string }, next: { error: { kind: string; message?: string } }) =>
  fail(`${e.tool} failed (${next.error.kind}): ${next.error.message ?? 'no message'}`)

// ---------- the run ----------

async function openRun(task: string, devBranch: string, mainBranch: string): Promise<Run> {
  const cwd = await io.cwd()
  const root = (await git.repoRoot(io, cwd)) ?? cwd
  const now = await io.now()
  const id = `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${slug(task).slice(0, 24)}`
  const run: Run = {
    id,
    task,
    startedAt: now,
    status: 'planning',
    iteration: 1,
    root,
    devBranch,
    mainBranch,
    runDir: `${root}/.workspaces/.task-loop/${id}`,
    devWorktree: '',
  }
  await io.setRun(() => run)
  await io.setRows(() => [])
  await io.setUi(() => ({ collapsed: [], expanded: [], tick: now, isBandHidden: false }))
  return run
}

/** Git prerequisites, done once per run: excludes, the dev branch, its worktree, the run folder. */
async function ensureSetup(run: Run): Promise<Run> {
  if (run.devWorktree) return run
  if (!(await git.repoRoot(io, run.root))) throw new Error(`${run.root} is not a git repository`)
  await git.ensureExclude(io, run.root)
  await git.ensureBranch(io, run.root, run.devBranch, run.mainBranch)
  const devWorktree = await git.worktreeFor(io, run.root, run.devBranch)
  await git.mkdirp(io, run.runDir)
  const next = { ...run, devWorktree }
  await io.setRun(() => next)
  return next
}

async function currentRun(): Promise<Run | null> {
  const run = await io.getRun()
  return run && (run.status === 'planning' || run.status === 'active') ? run : null
}

// ---------- status text for the orchestrator ----------

function statusText(snap: Snapshot): string {
  const { run, rows, ui } = snap
  if (!run) return 'No task-loop run.'
  const lines = [`Run ${run.id}: ${run.status}, iteration ${run.iteration}, dev=${run.devBranch}, main=${run.mainBranch}`]
  for (let n = 1; n <= run.iteration; n += 1) {
    lines.push(`Iteration ${n}:`)
    for (const row of rows.filter(r => r.iteration === n).sort((a, b) => a.at - b.at)) {
      const t = hhmm(row.at)
      if (row.kind === 'user') lines.push(`  ${t} user: ${row.text.replace(/\s+/g, ' ').slice(0, 120)}`)
      else if (row.kind === 'worker') {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        lines.push(`  ${t} worker ${row.taskId} [${row.id}] ${statusWord[row.status]} (${span}, ${row.model}, ${row.branch})${row.note ? `: ${row.note.slice(0, 200)}` : ''}`)
      } else {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        lines.push(`  ${t} QA round ${row.round} [${row.id}] ${statusWord[row.status]} (${span}): ${scoreLine(row)}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------- tool handlers ----------

async function start(a: Args) {
  const task = str(a.task).trim()
  if (!task) return fail('start: "task" is required')
  let run = await currentRun()
  if (!run) run = await openRun(task, str(a.devBranch, 'dev'), str(a.mainBranch, 'main'))
  else {
    const next: Run = { ...run, task, devBranch: str(a.devBranch, run.devBranch), mainBranch: str(a.mainBranch, run.mainBranch) }
    await io.setRun(() => next)
    run = next
  }
  try {
    run = await ensureSetup(run)
  } catch (error) {
    return fail(`start: ${String(error)}`)
  }
  void io.openPane()
  return ok(
    { runId: run.id, root: run.root, devBranch: run.devBranch, mainBranch: run.mainBranch, devWorktree: run.devWorktree, runDir: run.runDir },
    `Run ${run.id} ready. Repository ${run.root}; dev branch "${run.devBranch}" checked out at ${run.devWorktree}; run folder ${run.runDir}. Plan the work, then call ${tool('dispatch')}.`,
  )
}

const COMMIT_TITLE = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|revert)!?: \S/

async function dispatch(a: Args) {
  let run = await currentRun()
  if (!run) return fail(`dispatch: no active run; call ${tool('start')} first`)
  const tasks = Array.isArray(a.tasks) ? (a.tasks as Args[]) : []
  if (tasks.length === 0) return fail('dispatch: "tasks" must hold at least one task')
  const ids = new Set<string>()
  for (const t of tasks) {
    const id = str(t.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail(`dispatch: task id ${JSON.stringify(t.id)} must be a kebab-case slug`)
    if (ids.has(id)) return fail(`dispatch: task id "${id}" repeats`)
    ids.add(id)
    if (!str(t.title).trim() || !str(t.prompt).trim()) return fail(`dispatch: task "${id}" needs a title and a prompt`)
    if (t.model !== 'opus' && t.model !== 'sonnet') return fail(`dispatch: task "${id}" model must be "opus" or "sonnet"`)
    const commit = str(t.commit).trim()
    if (!COMMIT_TITLE.test(commit) || /^\w+\(/.test(commit)) {
      return fail(`dispatch: task "${id}" commit title "${commit}" must be "<type>: <description>" with an allowed type and no scope`)
    }
  }
  try {
    run = await ensureSetup(run)
  } catch (error) {
    return fail(`dispatch: ${String(error)}`)
  }

  const rows = await io.getRows()
  const iteration = run.iteration
  const hadWork = rows.some(r => r.kind !== 'user' && r.iteration === iteration)
  const unfinished = rows.filter((r): r is WorkerRow | QaRow => r.kind !== 'user' && !isTerminal(r))
  if (unfinished.length > 0) return fail(`dispatch: ${unfinished.length} agent(s) still running; wait for the wake-up prompt or cancel them first`)
  if (hadWork) {
    run = { ...run, iteration: iteration + 1, status: 'active' }
    await io.setUi(ui => ({ ...ui, collapsed: ui.collapsed.includes(iteration) ? ui.collapsed : [...ui.collapsed, iteration] }))
  } else run = { ...run, status: 'active' }
  const active = run
  await io.setRun(() => active)

  const started: Array<{ taskId: string; agentId: string; branch: string; worktree: string; model: string }> = []
  const problems: string[] = []
  for (const t of tasks) {
    const taskId = str(t.id)
    const title = str(t.title).trim()
    const model = str(t.model)
    try {
      const { branch, path } = await git.addBranchWorktree(io, active.root, `task/${active.iteration}-${slug(taskId)}`, active.devBranch)
      await git.mkdirp(io, `${path}/.context`)
      const extras = Array.isArray(t.context) ? (t.context as Args[]) : []
      const names: string[] = []
      for (const c of extras) {
        const name = str(c.name).replace(/[^A-Za-z0-9._-]/g, '_')
        if (!name || name === 'brief.md') continue
        await io.write(`${path}/.context/${name}`, str(c.text))
        names.push(name)
      }
      const brief = workerBrief({ title, prompt: str(t.prompt), worktree: path, branch, build: str(t.build) || undefined, test: str(t.test) || undefined, extras: names })
      await io.write(`${path}/.context/brief.md`, brief)
      await io.write(`${active.runDir}/iteration-${active.iteration}-${taskId}.md`, brief)
      const spawned = await io.spawn({
        subagentType: WORKER_AGENT,
        model,
        description: title,
        cwd: path,
        prompt: `${brief}\n\nStart now. Your working directory is the worktree above.`,
      })
      const agentId = 'agentId' in spawned ? spawned.agentId : undefined
      if (!agentId) {
        problems.push(`${taskId}: spawn refused${'deny' in spawned ? ` (${String(spawned.deny)})` : ''}`)
        continue
      }
      const now = await io.now()
      const row: WorkerRow = {
        kind: 'worker',
        id: agentId,
        iteration: active.iteration,
        at: now,
        lastActivityAt: now,
        taskId,
        title,
        branch,
        worktree: path,
        model,
        commit: str(t.commit).trim(),
        status: 'running',
      }
      await io.setRows(list => [...list, row])
      started.push({ taskId, agentId, branch, worktree: path, model })
    } catch (error) {
      problems.push(`${taskId}: ${String(error)}`)
    }
  }
  void io.openPane()
  const text = [
    `Iteration ${active.iteration}: ${started.length} worker(s) started.`,
    ...started.map(s => `- ${s.taskId}: agent ${s.agentId} (${s.model}) on ${s.branch}`),
    ...(problems.length > 0 ? ['Problems:', ...problems.map(p => `- ${p}`)] : []),
    started.length > 0 ? 'End your turn now. A prompt wakes you when every worker has ended, or when one goes stale.' : 'Nothing is running.',
  ].join('\n')
  return ok({ iteration: active.iteration, started, problems }, text)
}

async function merge() {
  let run = await currentRun()
  if (!run) return fail('merge: no active run')
  try {
    run = await ensureSetup(run)
  } catch (error) {
    return fail(`merge: ${String(error)}`)
  }
  const iteration = run.iteration
  const rows = await io.getRows()
  const candidates = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === iteration && r.status === 'finished')
  const running = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === iteration && !isTerminal(r))
  if (running.length > 0) return fail(`merge: ${running.length} worker(s) still running; wait or cancel them first`)
  if (candidates.length === 0) return fail('merge: no finished worker branches in this iteration')
  const merged: string[] = []
  const skipped: string[] = []
  for (const w of candidates.sort((a, b) => a.at - b.at)) {
    const outcome = await git.squashMerge(io, run.devWorktree, w.branch, w.commit)
    if (outcome.kind === 'merged' || outcome.kind === 'empty') {
      const notes = await git.removeWorktree(io, run.root, w.worktree, w.branch)
      const sha = outcome.kind === 'merged' ? outcome.commit : 'no changes'
      await patchWorker(w.id, r => ({ ...r, status: 'merged', note: `${sha}${notes.length ? `; ${notes.join('; ')}` : ''}` }))
      merged.push(`${w.taskId}: ${outcome.kind === 'merged' ? `${w.commit} (${sha})` : 'branch had no changes'}${notes.length ? ` [${notes.join('; ')}]` : ''}`)
    } else if (outcome.kind === 'conflict') {
      skipped.push(`${w.taskId}: conflicts in ${outcome.files.join(', ')} (branch ${w.branch} kept at ${w.worktree})`)
    } else skipped.push(`${w.taskId}: ${outcome.message} (branch ${w.branch} kept)`)
  }
  const text = [
    `Merged ${merged.length} of ${candidates.length} branch(es) into ${run.devBranch}.`,
    ...merged.map(m => `- ${m}`),
    ...(skipped.length > 0
      ? ['Not merged:', ...skipped.map(s => `- ${s}`), 'Resolve by dispatching a worker whose task is to redo the conflicting branch on top of dev, then merge again.']
      : []),
    merged.length > 0 ? `Next: call ${tool('qa')}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return ok({ merged, skipped }, text)
}

const qaPrompt = (worktree: string) =>
  `Read ${worktree}/.context/qa-brief.md and ${worktree}/.context/rubric.json, then test the deliverable as its user and write the report where the brief says. Your working directory is ${worktree}.`

async function spawnQa(worktree: string, model: string, prompt: string): Promise<string | null> {
  const spawned = await io.spawn({ subagentType: QA_AGENT, model, description: 'QA as end user', cwd: worktree, prompt })
  return 'agentId' in spawned && spawned.agentId ? spawned.agentId : null
}

async function qa(a: Args) {
  let run = await currentRun()
  if (!run) return fail('qa: no active run')
  const rubric = validateRubric(a.rubric)
  if (!rubric.ok) return fail(`qa: ${rubric.problem}`)
  const harness = str(a.harness).trim()
  if (!harness) return fail('qa: "harness" must say how to run and use the deliverable')
  const model = a.model === 'sonnet' ? 'sonnet' : 'opus'
  try {
    run = await ensureSetup(run)
  } catch (error) {
    return fail(`qa: ${String(error)}`)
  }
  const iteration = run.iteration
  const rows = await io.getRows()
  const unfinished = rows.filter((r): r is WorkerRow | QaRow => r.kind !== 'user' && !isTerminal(r))
  if (unfinished.length > 0) return fail(`qa: ${unfinished.length} agent(s) still running; wait or cancel them first`)
  const round = rows.filter(r => r.kind === 'qa' && r.iteration === iteration).length + 1
  const worktree = `${run.root}/.workspaces/qa/${iteration}-${round}`
  const reportPath = `${worktree}/.context/qa-report.json`
  try {
    await git.addDetachedWorktree(io, run.root, worktree, run.devBranch)
    await git.mkdirp(io, `${worktree}/.context`)
    await io.write(`${worktree}/.context/rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    const brief = qaBrief({ task: run.task, harness, brief: str(a.brief), reportPath, worktree })
    await io.write(`${worktree}/.context/qa-brief.md`, brief)
    await io.write(`${run.runDir}/qa-${iteration}-${round}-rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    await io.write(`${run.runDir}/qa-${iteration}-${round}-brief.md`, brief)
  } catch (error) {
    return fail(`qa: ${String(error)}`)
  }
  const agentId = await spawnQa(worktree, model, qaPrompt(worktree))
  if (!agentId) return fail('qa: the QA agent could not be started')
  const now = await io.now()
  const row: QaRow = {
    kind: 'qa',
    id: agentId,
    iteration,
    round,
    attempt: 1,
    at: now,
    lastActivityAt: now,
    worktree,
    reportPath,
    status: 'running',
  }
  rubrics.set(row.id, rubric.rubric)
  await io.setRows(list => [...list, row])
  void io.openPane()
  return ok(
    { agentId, round, worktree },
    `QA round ${round} for iteration ${iteration} started (agent ${agentId}, ${model}). End your turn now; a prompt wakes you with the verdict and overview.`,
  )
}

async function cancel(a: Args) {
  const agentId = str(a.agentId)
  const rows = await io.getRows()
  const row = rows.find(isAgent(agentId))
  if (!row) return fail(`cancel: no agent ${agentId} in this run`)
  if (isTerminal(row)) return fail(`cancel: agent ${agentId} already ${statusWord[row.status]}`)
  let stopNote = ''
  try {
    await io.stop(agentId)
  } catch (error) {
    stopNote = ` (stop reported: ${String(error)})`
  }
  const now = await io.now()
  await patchRow(agentId, r => ({ ...r, status: 'cancelled', endedAt: now, note: str(a.reason) || 'cancelled by the orchestrator' }))
  return ok({ agentId }, `Agent ${agentId} cancelled${stopNote}.`)
}

async function finish(a: Args) {
  const run = await currentRun()
  if (!run) return fail('finish: no active run')
  const rows = await io.getRows()
  const unfinished = rows.filter((r): r is WorkerRow | QaRow => r.kind !== 'user' && !isTerminal(r))
  if (unfinished.length > 0) return fail(`finish: ${unfinished.length} agent(s) still running; wait or cancel them first`)
  const lines: string[] = []
  if (a.abort === true) {
    await io.setRun(() => ({ ...run, status: 'aborted' }))
    lines.push(`Run ${run.id} aborted; ${run.devBranch} keeps what was merged. Leftover worktrees under .workspaces/ are kept for inspection.`)
    return ok({ runId: run.id }, lines.join('\n'))
  }
  if (!run.devWorktree) return fail('finish: nothing was ever dispatched; call finish with abort=true to close the run')
  const { outcome, notes } = await git.releaseToMain(io, run.root, run.devBranch, run.mainBranch)
  if (outcome.kind === 'conflict') {
    return fail(`finish: merging ${run.devBranch} into ${run.mainBranch} conflicts in ${outcome.files.join(', ')}; dispatch a worker to reconcile ${run.mainBranch} into ${run.devBranch}, then finish again`)
  }
  if (outcome.kind === 'error') return fail(`finish: ${outcome.message}`)
  lines.push(
    outcome.kind === 'up-to-date'
      ? `${run.mainBranch} already holds ${run.devBranch}.`
      : outcome.kind === 'fast-forward'
        ? `${run.mainBranch} fast-forwarded to ${run.devBranch}.`
        : `${run.mainBranch} merged ${run.devBranch} with one merge commit (histories had diverged).`,
  )
  lines.push(...notes)
  for (const w of rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.status !== 'merged')) {
    lines.push(...(await git.removeWorktree(io, run.root, w.worktree, w.branch)))
  }
  for (const q of rows.filter((r): r is QaRow => r.kind === 'qa')) lines.push(...(await git.removeWorktree(io, run.root, q.worktree)))
  await io.setRun(() => ({ ...run, status: 'done' }))
  lines.push(`Run ${run.id} finished. Reports and briefs are under ${run.runDir}.`)
  return ok({ runId: run.id }, lines.join('\n'))
}

// ---------- completion of the agents ----------

async function rubricFor(run: Run, row: QaRow): Promise<RubricItem[]> {
  const held = rubrics.get(row.id)
  if (held) return held
  const text = await io.read(`${run.runDir}/qa-${row.iteration}-${row.round}-rubric.json`)
  return JSON.parse(text) as RubricItem[]
}

async function collectQa(row: QaRow, now: number, agentFailure: string | null) {
  const run = await io.getRun()
  if (!run) return
  if (agentFailure) {
    await patchRow(row.id, r => ({ ...r, status: 'failed', endedAt: now, note: agentFailure }))
    wake(`QA round ${row.round} of iteration ${row.iteration} failed before writing a report (${agentFailure}). Call ${tool('status')}, then ${tool('qa')} again or ${tool('finish')} as you see fit.`)
    return
  }
  let text: string | null = null
  try {
    if (await io.exists(row.reportPath)) text = await io.read(row.reportPath)
  } catch {
    text = null
  }
  let rubric: RubricItem[]
  try {
    rubric = await rubricFor(run, row)
  } catch (error) {
    await patchRow(row.id, r => ({ ...r, status: 'failed', endedAt: now, note: `rubric unreadable: ${String(error)}` }))
    return
  }
  const checked = text === null ? { ok: false as const, problems: [`no report at ${row.reportPath}`] } : validateReport(text, rubric)
  if (!checked.ok) {
    if (row.attempt < 2) {
      const retry = await spawnQa(
        row.worktree,
        'opus',
        `${qaPrompt(row.worktree)}\n\nA previous attempt produced an unusable report:\n${checked.problems.map(p => `- ${p}`).join('\n')}\nWrite the report again, complete and in the exact JSON shape the brief gives.`,
      )
      if (retry) {
        rubrics.set(retry, rubric)
        rubrics.delete(row.id)
        await io.setRows(rows =>
          rows.map(r => (r.kind === 'qa' && r.id === row.id ? { ...r, id: retry, attempt: 2, lastActivityAt: now, status: 'running' } : r)),
        )
        return
      }
    }
    const note = `report invalid: ${checked.problems.join('; ')}`
    await patchQa(row.id, r => ({ ...r, status: 'invalid', endedAt: now, note }))
    wake(`QA round ${row.round} of iteration ${row.iteration} ended without a valid report (${note}). Call ${tool('qa')} again with a clearer harness, or decide without it.`)
    return
  }
  const stamped = JSON.stringify(
    { iteration: row.iteration, round: row.round, collectedAt: new Date(now).toISOString(), summary: checked.summary, items: checked.items, overview: checked.overview },
    null,
    2,
  )
  await io.write(`${run.runDir}/qa-${row.iteration}-${row.round}.json`, stamped)
  await patchRow(row.id, r => ({ ...r, status: 'finished', endedAt: now, summary: checked.summary, items: checked.items, overview: checked.overview }))
  rubrics.delete(row.id)
  await git.removeWorktree(io, run.root, row.worktree)
  const s = checked.summary
  const weak = checked.items.filter(i => i.score !== 'strong').map(i => `- ${i.score}: ${i.title}${i.note ? ` — ${i.note}` : ''}`)
  wake(
    [
      `QA round ${row.round} for iteration ${row.iteration}: ${s.strong} strong, ${s.acceptable} acceptable, ${s.unacceptable} unacceptable → verdict: ${s.verdict}.`,
      ...(weak.length > 0 ? ['Items below strong:', ...weak] : []),
      'Overview from QA:',
      checked.overview,
      s.verdict === 'fix'
        ? `Next: plan the fixes and call ${tool('dispatch')} (a new iteration starts), then ${tool('merge')} and ${tool('qa')} again.`
        : `Next: call ${tool('finish')} to merge ${run.devBranch} into ${run.mainBranch}, or dispatch improvements first if the recommendations are worth another iteration.`,
    ].join('\n'),
  )
}

async function maybeWakeForWorkers() {
  const run = await io.getRun()
  if (!run) return
  const rows = await io.getRows()
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === run.iteration)
  if (workers.length === 0 || workers.some(w => !isTerminal(w))) return
  const lines = workers.map(w => `- ${w.taskId} [${w.id}]: ${statusWord[w.status]} after ${elapsed(w.at, w.endedAt ?? w.at)}${w.note ? ` — ${w.note.slice(0, 300)}` : ''}`)
  const finished = workers.filter(w => w.status === 'finished').length
  wake(
    [
      `Iteration ${run.iteration}: all ${workers.length} worker(s) have ended (${finished} finished).`,
      ...lines,
      finished > 0
        ? `Next: call ${tool('merge')}, then ${tool('qa')}. Re-dispatch any task that failed, timed out or was cancelled.`
        : `No worker finished. Review with ${tool('status')} and re-dispatch.`,
    ].join('\n'),
  )
}

async function touch(agentId: string) {
  const rows = await io.getRows()
  const row = rows.find(isAgent(agentId))
  if (!row || isTerminal(row)) return
  const now = await io.now()
  if (row.status === 'stale' || row.lastActivityAt < now - 5_000) {
    await patchRow(row.id, r =>
      r.kind === 'worker'
        ? { ...r, lastActivityAt: now, status: r.status === 'stale' ? 'running' : r.status }
        : { ...r, lastActivityAt: now, status: r.status === 'stale' ? 'running' : r.status },
    )
  }
}

// ---------- the ticker: spinner, elapsed, stale and timeout ----------

async function tick() {
  const run = await io.getRun()
  if (!run || run.status === 'done' || run.status === 'aborted') return
  const rows = await io.getRows()
  const live = rows.filter((r): r is WorkerRow | QaRow => r.kind !== 'user' && !isTerminal(r))
  const now = await io.now()
  await io.setUi(ui => ({ ...ui, tick: now }))
  for (const row of live) {
    const idle = now - row.lastActivityAt
    const who = row.kind === 'worker' ? `Worker ${row.taskId}` : `QA round ${row.round}`
    if (idle >= TIMEOUT_MS) {
      await patchRow(row.id, r => ({ ...r, status: 'timeout', endedAt: now, note: `no activity for ${elapsed(row.lastActivityAt, now)}; stopped` }))
      void io.stop(row.id).catch(() => undefined)
      wake(`${who} [${row.id}] timed out: no activity for ${elapsed(row.lastActivityAt, now)}, so it was stopped. Call ${tool('status')} and re-dispatch or finish.`)
      if (row.kind === 'worker') await maybeWakeForWorkers()
    } else if (idle >= STALE_MS && row.status === 'running') {
      await patchRow(row.id, r => ({ ...r, status: 'stale' }))
      wake(
        `${who} [${row.id}] looks stale: no tool call or model step for ${elapsed(row.lastActivityAt, now)}. It is still running. Call ${tool('status')} to review, and ${tool('cancel')} with its agent id if it should stop; it is stopped automatically after ${TIMEOUT_MS / 3_600_000} hours idle.`,
      )
    }
  }
}

const actions: Actions = {
  toggleIteration: n => void io.setUi(ui => ({ ...ui, collapsed: ui.collapsed.includes(n) ? ui.collapsed.filter(x => x !== n) : [...ui.collapsed, n] })),
  toggleRow: id => void io.setUi(ui => ({ ...ui, expanded: ui.expanded.includes(id) ? ui.expanded.filter(x => x !== id) : [...ui.expanded, id] })),
  openPane: () => void io.openPane(true),
  hideBand: () => void io.setUi(ui => ({ ...ui, isBandHidden: true })),
}

// ---------- the module ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    io = {
      run: (argv, init) => $.process.run(argv, init),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      cwd: () => $.session.cwd(),
      spawn: args => $.agent.spawn(args),
      stop: agentId => $.tool.call({ tool: 'TaskStop', task_id: agentId }),
      submit: text => $.prompt.submit({ text }),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'Task loop', focus: true } : { id: PANE, title: 'Task loop' }),
      getRun: () => read($, runAtom),
      setRun: fn => update($, runAtom, fn),
      getRows: () => read($, rowsAtom),
      setRows: fn => update($, rowsAtom, fn),
      getUi: () => read($, uiAtom),
      setUi: fn => update($, uiAtom, fn),
    }

    await Promise.all([
      $.tool.register({
        name: 'start',
        description:
          'Begins (or confirms) the task-loop run for the task handed over: records the repository, creates the dev branch and its worktree if missing, and opens the timeline pane. Call once, after the task is clear.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The task in one or two sentences.' },
            devBranch: { type: 'string', description: 'Integration branch; default "dev".' },
            mainBranch: { type: 'string', description: 'Release branch; default "main".' },
          },
          required: ['task'],
        },
      }),
      $.tool.register({
        name: 'dispatch',
        description:
          'Starts one worker subagent per task, each in its own git worktree and branch off the dev branch. Returns at once; the run wakes you with a prompt when every worker has ended or one goes stale. A second dispatch after QA starts the next iteration.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short kebab-case id, unique in this dispatch.' },
                  title: { type: 'string', description: 'A few words naming the task.' },
                  prompt: { type: 'string', description: 'The full brief: what to build, where, constraints, acceptance.' },
                  model: { type: 'string', enum: ['opus', 'sonnet'], description: 'opus for complex or cross-cutting work, sonnet for contained work.' },
                  commit: { type: 'string', description: 'Conventional Commit title for the squash commit, e.g. "feat: add login endpoint". No scope in parentheses.' },
                  build: { type: 'string', description: 'Command that must pass before the worker finishes.' },
                  test: { type: 'string', description: 'Test command the worker runs, if any.' },
                  context: {
                    type: 'array',
                    description: 'Extra files placed under .context/ in the worktree.',
                    items: {
                      type: 'object',
                      properties: { name: { type: 'string' }, text: { type: 'string' } },
                      required: ['name', 'text'],
                    },
                  },
                },
                required: ['id', 'title', 'prompt', 'model', 'commit'],
              },
            },
          },
          required: ['tasks'],
        },
      }),
      $.tool.register({
        name: 'merge',
        description:
          'Squash-merges every finished worker branch of the current iteration into the dev branch, one commit per task titled as planned, and prunes the merged worktrees. Reports conflicts instead of resolving them.',
        isDeferred: false,
        inputSchema: { type: 'object', properties: {} },
      }),
      $.tool.register({
        name: 'qa',
        description:
          'Starts the QA subagent in a fresh worktree of the dev branch. It uses the deliverable as an end user, scores every rubric item strong/acceptable/unacceptable and writes a report the run collects. Returns at once; the run wakes you with the overview and verdict.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            rubric: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'kebab-case id' },
                  title: { type: 'string', description: 'What is checked, as a user-visible outcome.' },
                  category: { type: 'string', enum: ['core', 'ui-ux'] },
                },
                required: ['id', 'title', 'category'],
              },
            },
            harness: {
              type: 'string',
              description: 'How to start, reach and use the deliverable: install and run commands, URLs or binaries, accounts or fixtures, expected flows. Markdown.',
            },
            brief: { type: 'string', description: 'Optional: what was built this iteration and what changed since the last round.' },
            model: { type: 'string', enum: ['opus', 'sonnet'], description: 'Default opus.' },
          },
          required: ['rubric', 'harness'],
        },
      }),
      $.tool.register({
        name: 'status',
        description: 'The timeline as text: every worker and QA row with status and elapsed time, and the run state.',
        isDeferred: false,
        inputSchema: { type: 'object', properties: {} },
      }),
      $.tool.register({
        name: 'cancel',
        description: 'Stops a running worker or QA subagent by agent id and marks its row cancelled. Its worktree is kept for inspection until merge or finish.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string' }, reason: { type: 'string' } },
          required: ['agentId'],
        },
      }),
      $.tool.register({
        name: 'finish',
        description: 'Ends the run: merges the dev branch into the main branch (fast-forward, else one merge commit), removes leftover run worktrees, and closes the loop.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: { abort: { type: 'boolean', description: 'true ends the run without merging into main.' } },
        },
      }),
      $.agent.register({
        name: 'worker',
        description: 'task-loop worker: implements one planned task inside its own worktree. Spawned by the task-loop tools only.',
        prompt: WORKER_SYSTEM,
        disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
      }),
      $.agent.register({
        name: 'qa',
        description: 'task-loop QA: uses the deliverable as the end user and scores a rubric. Spawned by the task-loop tools only.',
        prompt: QA_SYSTEM,
        disallowedTools: ['Agent', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'],
        omitClaudeMd: true,
      }),
      $.command.register({ name: 'task-loop-pane', description: 'Opens the task-loop timeline pane.' }),
    ])

    $.clock.every(TICK_MS, () => void tick())

    return next(e)
  })

  on('agent.offer', { agent: 'task-loop:worker' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'task-loop:qa' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('command.run', { command: 'task-loop-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Task loop', focus: true })
    await update($, uiAtom, ui => ({ ...ui, isBandHidden: false }))
    return { text: 'Task-loop timeline opened.' }
  })

  // ----- prompts: the /task-loop prompt opens a run; every later prompt during a run is a row -----

  on('prompt.submit', async ($, e, next) => {
    const text = e.text
    if (ownPrompts.has(text) || text.startsWith(WAKE_PREFIX)) {
      ownPrompts.delete(text)
      return next(e)
    }
    const starts = /^\s*\/task-loop(?::task-loop)?(\s|$)/.exec(text)
    let run = await currentRun()
    if (starts) {
      const task = text.slice(starts[0].length).trim() || '(task to be clarified)'
      run = await openRun(task, 'dev', 'main')
      void $.ui.open({ id: PANE, title: 'Task loop' })
    }
    if (run) {
      const now = await $.clock.now()
      const row: UserRow = { kind: 'user', id: `user-${now}`, iteration: run.iteration, at: now, text }
      await update($, rowsAtom, rows => [...rows, row])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ----- the tools -----

  on('tool.call', { tool: 'mcp__task-loop__start' }, ($, e) => start(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__dispatch' }, ($, e) => dispatch(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__merge' }, () => merge()).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__qa' }, ($, e) => qa(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__cancel' }, ($, e) => cancel(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__finish' }, ($, e) => finish(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__task-loop__status' }, async () => {
    const snap = await snapshot()
    return ok({ run: snap.run, rows: snap.rows }, statusText(snap))
  }).catch(crashed)

  // ----- guards: the orchestrator does not edit; workers stay in their worktree; QA never reads source -----

  on('tool.call', async ($, e, next) => {
    const run = await currentRun()
    if (!run) return next(e)
    const a = e as unknown as Args
    if (e.agentId === undefined) {
      if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        return { deny: `task-loop: the orchestrator does not change files; only worker subagents do, through ${tool('dispatch')}.` }
      }
      if (e.tool === 'Bash') {
        const cmd = str(a.command)
        if (/\bgit\s+(-C\s+\S+\s+)?(commit|merge|rebase|push|checkout|switch|reset|worktree|cherry-pick|am|apply|stash|branch\s+(-[dDmM]|--delete|--move))\b/.test(cmd)) {
          return { deny: 'task-loop: git history is changed only by the task-loop tools (merge, finish) and by worker subagents.' }
        }
      }
      return next(e)
    }
    const rows = await io.getRows()
    const row = rows.find(isAgent(e.agentId))
    if (!row) return next(e)
    await touch(row.id)
    if (row.kind === 'worker') {
      const target = str(a.file_path) || str(a.notebook_path)
      if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && target && !isUnder(target, row.worktree, row.worktree)) {
        return { deny: `task-loop: write only inside your worktree ${row.worktree}` }
      }
      return next(e)
    }
    const contextDir = `${row.worktree}/.context`
    if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const target = str(a.file_path) || str(a.notebook_path)
      if (!isUnder(target, contextDir, row.worktree)) {
        return { deny: `task-loop QA: you judge the deliverable as its user and never open source. Only ${contextDir} is readable or writable.` }
      }
      if ((e.tool === 'Write' || e.tool === 'Edit') && normalize(target, row.worktree) !== row.reportPath) {
        return { deny: `task-loop QA: the only file you write is ${row.reportPath}` }
      }
    }
    const name: string = e.tool
    if (name === 'Glob' || name === 'Grep') {
      const target = str(a.path) || row.worktree
      if (!isUnder(target, contextDir, row.worktree)) {
        return { deny: `task-loop QA: searching the checkout is not allowed; use the product instead. Only ${contextDir} may be searched.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'task-loop: guard failed closed' }))

  // ----- activity and completion of the agents -----

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) await touch(e.agentId)
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const rows = await io.getRows()
      const row = rows.find(isAgent(e.agentId))
      if (row && !isTerminal(row)) {
        const now = await io.now()
        const failed = e.reason !== 'answer' || e.isAborted
        if (row.kind === 'worker') {
          const note = failed
            ? `${e.reason}${e.reason === 'refusal' ? `: ${e.refusal.explanation ?? ''}` : ''}`
            : e.answer.replace(/\s+/g, ' ').trim().slice(0, 400)
          await patchRow(row.id, r => ({ ...r, status: failed ? 'failed' : 'finished', endedAt: now, note }))
          await maybeWakeForWorkers()
        } else {
          await collectQa(row, now, failed ? `agent ended: ${e.reason}` : null)
        }
      }
    }
    return next(e)
  })

  // ----- drawing -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    return drawPane(els, { run, rows, ui }, actions, e.props.bodyColumns)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    const els = $.ui.resolve(e) as unknown as Els
    const tree = drawBand(els, { run, rows, ui }, actions, e.props.bodyColumns)
    return tree ?? next(e)
  })
}
