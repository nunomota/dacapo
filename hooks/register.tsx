import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, AgentStats, Collector, Gh, Level, OrchestratorRow, Phase, Pr, QaRow, Row, Run, UserRow, Wake, WorkerRow } from '../types'
import { BRANCH_NAME, describeConf, loadConf, SHIPPED_COMMITS, SHIPPED_PRS, type Layer, type Loaded } from './conf'
import { ZERO, addUsage, parsePrices, type Price } from './cost'
import * as gh from './gh'
import * as git from './git'
import type { Io } from './io'
import { LEVELS, PHASES, drawBand, drawPane, elapsed, hhmm, isAgentRow, levelOf, prText, prsOf, roleOf, roundName, scoreLine, spend, spendText, statusWord, type Actions, type Els, type Snapshot } from './pane'
import { COLLECTOR_SYSTEM, QA_SYSTEM, REVIEW_SYSTEM, WORKER_SYSTEM, qaBrief, reviewBrief, workerBrief } from './prompts'
import { QA_CATEGORIES, REVIEW_CATEGORIES, validateReport, validateRubric, type RubricItem } from './report'

const PANE = 'dacapo'
const WORKER_AGENT = 'dacapo:worker'
const QA_AGENT = 'dacapo:qa'
/** The evidence collectors QA may start: bound like QA, they use the product on a slice of the rubric and never score. */
const COLLECTOR_AGENT = 'dacapo:qa-collector'
const REVIEW_AGENT = 'dacapo:reviewer'
const tool = (name: string) => `mcp__dacapo__${name}`

const STALE_MS = 30 * 60_000
const TIMEOUT_MS = 2 * 60 * 60_000
const TICK_MS = 1_000
/** How often the pull requests of the run's branches are listed through gh. */
const POLL_MS = 20_000
const WAKE_PREFIX = '[dacapo]'
/** A wake-up whose turn has not started after this long is sent again, up to WAKE_TRIES times. */
const WAKE_RETRY_MS = 30_000
const WAKE_TRIES = 3

const runAtom = atom({ plugin: 'dacapo', key: 'run' } as const, null)
const rowsAtom = atom({ plugin: 'dacapo', key: 'rows' } as const, [])
const uiAtom = atom({ plugin: 'dacapo', key: 'ui' } as const, {
  expanded: [],
  openSections: ['timeline'],
  isTimelineFull: false,
  tick: 0,
  isBandHidden: false,
})

type Args = Record<string, unknown>

/** The engine as closures, made once in `session.start`; every helper below reaches the engine through it. */
let io: Io
/** Dollars per million tokens by model prefix, from the built-in table and the `prices` option. */
let prices: Record<string, Price> = parsePrices(undefined)
/** The configuration in force: the shipped `dacapo.conf`, then the user's, then the repository's. */
let conf: Loaded = loadConf([])
const SHIPPED_CONF = `${import.meta.dir}/../dacapo.conf`

/** Reads the conf files that exist, in the order they apply; agents never read them, the config tool and command tell. */
async function readConf(root: string): Promise<Loaded> {
  const home = await io.home().catch(() => undefined)
  const paths = [SHIPPED_CONF, ...(home ? [`${home}/.claude/dacapo.conf`] : []), `${root}/.dacapo.conf`]
  const layers: Layer[] = []
  for (const path of paths) {
    try {
      layers.push({ path, text: (await io.exists(path)) ? await io.read(path) : null })
    } catch {
      layers.push({ path, text: null })
    }
  }
  conf = loadConf(layers)
  return conf
}
const freshStats = (): AgentStats => ({ usage: ZERO, steps: 0, toolCalls: 0, activity: [] })
const setPhase = (phase: Phase) => io.setRun(run => (run ? { ...run, phase } : run))
/** Prompts this module queued itself, so `prompt.submit` does not log them as the person's. */
const ownPrompts = new Set<string>()
/** Rubrics by judge (`qa-<iteration>-<round>`, `review-...`), for validation; the run folder holds the copy that survives a reload. */
const rubrics = new Map<string, RubricItem[]>()
type Role = 'qa' | 'review'
/** The key of a judge row's rubric, report and wake-up: its role, iteration and round. */
const judgeKey = (row: QaRow) => `${roleOf(row)}-${row.iteration}-${row.round}`

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

const isLive = (row: WorkerRow | QaRow) => row.status === 'running' || row.status === 'stale'
const isTerminal = (row: WorkerRow | QaRow) => !isLive(row) && row.status !== 'pending'
const pendingId = (kind: 'worker' | Role, iteration: number, key: string) => `pending-${kind}-${iteration}-${key}`
/** The first line of every prompt the Agent hook hands a worker, QA or reviewer agent; the spawn hook reads the worktree off it. */
const WORKTREE_LINE = /^\[dacapo worktree: (.+)\]$/m
const ASK_LINE = /^\s*dacapo (worker|qa|review) (\S+)\s*$/
/** The last line of a worker's answer: `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`. */
const STATUS_LINE = /^\s*dacapo:\s*(done with limitations|done|failed)\s*\.?\s*$/im
/** The last line of a collector's answer to QA: `dacapo: collected`, `dacapo: collected with gaps` or `dacapo: failed`. */
const COLLECTED_LINE = /^\s*dacapo:\s*(collected with gaps|collected|failed)\s*\.?\s*$/im

const isAgent = (id: string) => (r: Row): r is WorkerRow | QaRow => isAgentRow(r) && r.id === id

const patchRow = (id: string, fn: (row: WorkerRow | QaRow) => WorkerRow | QaRow) =>
  io.setRows(rows => rows.map(r => (isAgentRow(r) && r.id === id ? fn(r) : r)))
const patchWorker = (id: string, fn: (row: WorkerRow) => WorkerRow) =>
  io.setRows(rows => rows.map(r => (r.kind === 'worker' && r.id === id ? fn(r) : r)))
const patchQa = (id: string, fn: (row: QaRow) => QaRow) =>
  io.setRows(rows => rows.map(r => (r.kind === 'qa' && r.id === id ? fn(r) : r)))

const liveCollectors = (row: QaRow) => (row.collectors ?? []).filter(c => !c.endedAt)
/** The collectors of a QA round in a phrase: how many ended of how many, and how many of those failed or left gaps. */
function collectorsText(row: QaRow): string {
  const all = row.collectors ?? []
  if (all.length === 0) return ''
  const live = liveCollectors(row).length
  const failed = all.filter(c => c.outcome === 'failed').length
  const gaps = all.filter(c => c.outcome === 'gaps').length
  const tail = [...(failed ? [`${failed} failed`] : []), ...(gaps ? [`${gaps} with gaps`] : [])]
  return `${live > 0 ? `${live} of ${all.length} collectors live` : `${all.length} collector${all.length === 1 ? '' : 's'} ended`}${tail.length ? `, ${tail.join(', ')}` : ''}`
}

/** The row an agent id belongs to: its own, or the QA round whose evidence collector it is. */
async function rowFor(agentId: string): Promise<{ row: WorkerRow | QaRow; collector: boolean } | undefined> {
  const rows = await io.getRows()
  const own = rows.find(isAgent(agentId))
  if (own) return { row: own, collector: false }
  const parent = rows.find((r): r is QaRow => r.kind === 'qa' && (r.collectors ?? []).some(c => c.id === agentId))
  return parent ? { row: parent, collector: true } : undefined
}

/** Stops the collectors of a QA round that are still running and marks them ended; a stop that fails is not fatal. */
async function stopCollectors(row: QaRow, now: number) {
  const live = liveCollectors(row)
  if (live.length === 0) return
  for (const c of live) void io.stop(c.id).catch(() => undefined)
  await patchQa(row.id, r => ({ ...r, collectors: (r.collectors ?? []).map(c => (c.endedAt ? c : { ...c, endedAt: now })) }))
}

async function snapshot(): Promise<Snapshot> {
  const [run, rows, ui] = await Promise.all([io.getRun(), io.getRows(), io.getUi()])
  return { run, rows, ui }
}

/** Queues a prompt for the orchestrator once per `key`; the ticker resends it until its turn starts. */
async function wake(key: string, text: string) {
  const run = await io.getRun()
  if (!run || run.wakes.some(w => w.key === key)) return
  const full = `${WAKE_PREFIX} ${text}`
  const now = await io.now()
  const entry: Wake = { key, text: full, sentAt: now, tries: 1 }
  await io.setRun(cur => (cur ? { ...cur, wakes: [...cur.wakes, entry] } : cur))
  ownPrompts.add(full)
  void io.submit(full).catch(() => undefined)
}

/** A wake-up counts as delivered when a turn starts whose text holds it; the engine may wrap the prompt ("The dacapo plugin sent a message: ..."). */
async function markDelivered(text: string) {
  const squash = (t: string) => t.replace(/\s+/g, ' ').trim()
  const seen = squash(text)
  const holds = (w: Wake) => !w.deliveredAt && seen.includes(squash(w.text))
  const run = await io.getRun()
  if (!run || !run.wakes.some(holds)) return
  const now = await io.now()
  await io.setRun(cur => (cur ? { ...cur, wakes: cur.wakes.map(w => (holds(w) ? { ...w, deliveredAt: now } : w)) } : cur))
}

/** A registered tool answers with text: the engine holds `result` to a string or content blocks. */
const fail = (text: string) => ({ isError: true as const, result: text })
const ok = (text: string) => ({ result: text })
/** A tool handler that threw answers the call with the error instead of failing silently. */
const crashed = (_: unknown, e: { tool: string }, next: { error: { kind: string; message?: string } }) =>
  fail(`${e.tool} failed (${next.error.kind}): ${next.error.message ?? 'no message'}`)

// ---------- the run ----------

async function openRun(task: string, baseBranch: string, at?: string, level: Level = 'balanced'): Promise<Run> {
  const cwd = at ?? (await io.cwd())
  const root = (await git.repoRoot(io, cwd)) ?? cwd
  const now = await io.now()
  const id = `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${slug(task || 'run').slice(0, 24)}`
  const run: Run = {
    id,
    task,
    startedAt: now,
    status: 'planning',
    iteration: 1,
    root,
    branch: '',
    worktree: '',
    baseBranch,
    level,
    judges: conf.conf.judges,
    runDir: `${root}/.workspaces/.dacapo/${id}`,
    phase: 'clarify',
    iterations: [],
    orchestrator: { ...ZERO, steps: 0 },
    wakes: [],
    prs: [],
  }
  await io.setRun(() => run)
  await io.setRows(() => [])
  await io.setUi(() => ({ expanded: [], openSections: ['timeline'], isTimelineFull: false, tick: now, isBandHidden: false }))
  return run
}

/** What to tell the orchestrator when gh cannot be used; it helps the person before trying again. */
function ghHelp(g: Gh & { ok: false }): string {
  switch (g.problem) {
    case 'missing':
      return [
        'gh, the GitHub CLI, is not installed (or not on the PATH), and dacapo lands every change through GitHub pull requests.',
        'Help the user install it: macOS `brew install gh`; Debian or Ubuntu `sudo apt install gh`; other systems https://cli.github.com.',
        'Then they run `gh auth login` in a terminal of their own (it is interactive; you cannot do it for them).',
        `Call ${tool('start')} again once \`gh auth status\` succeeds.`,
      ].join(' ')
    case 'unauthenticated':
      return `gh is installed but not logged in (${g.detail}). Ask the user to run \`gh auth login\` in a terminal of their own, then call ${tool('start')} again.`
    case 'not-github':
      return `gh cannot reach this repository on GitHub (${g.detail}). dacapo needs an origin on GitHub to open pull requests; ask the user how to proceed, then call ${tool('start')} again.`
  }
}

/** Git prerequisites, done once per run: excludes, the base branch refreshed, the run branch and its worktree, the run folder. */
async function ensureSetup(run: Run, wantedBranch: string): Promise<{ run: Run; notes: string[]; isNew: boolean }> {
  if (run.worktree) return { run, notes: [], isNew: false }
  if (!(await git.repoRoot(io, run.root))) throw new Error(`${run.root} is not a git repository`)
  await git.ensureExclude(io, run.root)
  const refreshed = await git.refreshBase(io, run.root, run.baseBranch)
  const from = refreshed.fetched ? `origin/${run.baseBranch}` : (await git.branchExists(io, run.root, run.baseBranch)) ? run.baseBranch : 'HEAD'
  const { branch, path } = await git.addBranchWorktree(io, run.root, wantedBranch, from, refreshed.fetched)
  await git.mkdirp(io, run.runDir)
  const next: Run = { ...run, branch, worktree: path }
  await io.setRun(() => next)
  return { run: next, notes: [refreshed.note, `run branch "${branch}" cut from ${from} at ${path}`], isNew: true }
}

async function currentRun(): Promise<Run | null> {
  const run = await io.getRun()
  return run && (run.status === 'planning' || run.status === 'active' || run.status === 'merging') ? run : null
}

/** A short argument for a tool call's activity line: the file, command, pattern or prompt it names. */
function shortArg(json: string): string {
  if (!json.trim()) return ''
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    for (const key of ['file_path', 'notebook_path', 'command', 'pattern', 'path', 'url', 'query', 'prompt', 'description', 'task_id', 'text']) {
      const got = v[key]
      if (typeof got === 'string' && got.trim()) return got.split('\n')[0]!.trim().slice(0, 90)
    }
    return ''
  } catch {
    return ''
  }
}

function grow(stats: AgentStats, usage: Partial<AgentStats['usage']> | null, toolCalls: number, entries: Activity[], modelId: string): AgentStats {
  return {
    usage: addUsage(stats.usage, usage ?? {}),
    steps: stats.steps + 1,
    toolCalls: stats.toolCalls + toolCalls,
    modelId: modelId || stats.modelId,
    activity: [...stats.activity, ...entries].slice(-40),
  }
}

// ---------- pull requests, polled through gh ----------

let polling = false

/** Lists the pull requests of every branch of the run and stores them; null when gh did not answer. */
async function refreshPrs(run: Run): Promise<Pr[] | null> {
  if (!run.gh?.ok || !run.worktree) return null
  const rows = await io.getRows()
  const heads = new Set<string>([run.branch, ...rows.filter((r): r is WorkerRow => r.kind === 'worker').map(r => r.branch)])
  const prs = await gh.listPrs(io, run.worktree, heads)
  const now = await io.now()
  if (prs) await io.setRun(cur => (cur ? { ...cur, prs, prsAt: now } : cur))
  else await io.setRun(cur => (cur ? { ...cur, prsAt: now } : cur))
  return prs
}

const latestPr = (run: Run, branch: string): Pr | undefined => prsOf(run, branch)[0]

// ---------- status text for the orchestrator ----------

function statusText(snap: Snapshot): string {
  const { run, rows, ui } = snap
  if (!run) return 'No dacapo run.'
  const lines = [
    `Run ${run.id}${run.task ? ` (${run.task.replace(/\s+/g, ' ')})` : ' (task not yet named; call start when it is clear)'}: ${run.status}, round ${run.iteration}, branch=${run.branch || '(not started)'}, base=${run.baseBranch}`,
  ]
  const total = spendText(spend(rows.filter(isAgentRow), prices, run.orchestrator))
  lines[0] += `, level ${levelOf(run)}${run.judges === 'parallel' ? ' (judges in parallel)' : ''}, phase ${run.phase}${total ? `, ${total}` : ''}`
  if (run.overview) lines.push(`  ${run.overview.replace(/\s+/g, ' ').slice(0, 300)}`)
  if (run.gh && !run.gh.ok) lines.push(`gh: ${run.gh.problem} (${run.gh.detail})`)
  if (run.pushProblem) lines.push(`Push problem: ${run.pushProblem}`)
  if (run.final) lines.push(`Final PR #${run.final.number} (${run.final.url}): ${run.prs.find(p => p.number === run.final!.number)?.state ?? 'not yet seen'}`)
  for (const w of run.wakes.filter(w => !w.deliveredAt)) {
    lines.push(`Wake-up not yet delivered (sent ${elapsed(w.sentAt, ui.tick)} ago, try ${w.tries}/${WAKE_TRIES}): ${w.text.split('\n')[0]}`)
  }
  for (let n = 1; n <= run.iteration; n += 1) {
    const info = run.iterations.find(i => i.n === n)
    const mine = rows.filter(r => r.iteration === n).sort((a, b) => a.at - b.at)
    const money = spendText(spend(mine.filter(isAgentRow), prices))
    lines.push(`Round ${n}${info ? `: ${info.title}` : ''}${money ? ` (${money})` : ''}`)
    if (info?.overview) lines.push(`  ${info.overview.replace(/\s+/g, ' ').slice(0, 300)}`)
    for (const row of mine) {
      const t = hhmm(row.at)
      if (row.kind === 'user') lines.push(`  ${t} user: ${row.text.replace(/\s+/g, ' ').slice(0, 120)}`)
      else if (row.kind === 'orchestrator') lines.push(`  ${t} orchestrator: ${row.text.replace(/\s+/g, ' ').slice(0, 120)}`)
      else if (row.kind === 'worker') {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        const pr = latestPr(run, row.branch)
        lines.push(
          `  ${t} worker ${row.taskId} [${row.id}] ${statusWord[row.status]}${row.outcome === 'limited' ? ' with limitations' : ''}${row.restarts ? ` (restarted ${row.restarts}x)` : ''} (${span}, ${row.model}, ${row.branch}${row.isResumed ? ', resumed' : ''}) PR: ${pr ? prText(pr) : 'none'}${row.note ? `: ${row.note.slice(0, 200)}` : ''}`,
        )
      } else {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        const collectors = row.collectors?.length ? `, ${collectorsText(row)}` : ''
        lines.push(`  ${t} ${roundName(row)} [${row.id}] ${statusWord[row.status]} (${span}${collectors}): ${scoreLine(row)}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------- tool handlers ----------

async function start(a: Args) {
  const task = str(a.task).trim()
  if (!task) return fail('start: "task" is required')
  const root = str(a.root).trim()
  if (root && !(await git.repoRoot(io, root))) return fail(`start: ${root} is not inside a git repository`)
  const overview = str(a.overview).trim() || undefined
  const baseBranch = str(a.baseBranch).trim() || conf.conf['base-branch']
  const askedLevel = str(a.level).trim()
  if (askedLevel && !LEVELS.includes(askedLevel as Level)) return fail(`start: "level" must be one of ${LEVELS.join(', ')}; got ${JSON.stringify(askedLevel)}`)
  const askedJudges = str(a.judges).trim()
  if (askedJudges && askedJudges !== 'sequential' && askedJudges !== 'parallel') return fail(`start: "judges" must be "sequential" or "parallel"; got ${JSON.stringify(askedJudges)}`)
  const wanted = str(a.branch).trim() || slug(task)
  if (!BRANCH_NAME.test(wanted) || wanted.includes('--') || wanted === baseBranch) {
    return fail(`start: "branch" must be a lowercase git branch name without "--" and different from ${baseBranch}; got ${JSON.stringify(wanted)}`)
  }
  let run = await currentRun()
  if (!run) run = await openRun(task, baseBranch, root || undefined, (askedLevel as Level) || 'balanced')
  // the level is fixed once work can exist: a start after setup keeps it
  if (askedLevel && run.worktree && askedLevel !== levelOf(run)) return fail(`start: the run is at level ${levelOf(run)} and a level is never changed mid-run`)
  const level: Level = (askedLevel as Level) || levelOf(run)
  if (askedJudges && run.worktree && askedJudges !== (run.judges ?? 'sequential')) return fail(`start: the run's judges are ${run.judges ?? 'sequential'} and that is never changed mid-run`)
  const judges = (askedJudges as Run['judges']) || run.judges || conf.conf.judges
  const named: Run = { ...run, task, level, judges, overview: overview ?? run.overview, baseBranch: run.worktree ? run.baseBranch : baseBranch }
  if (root && !run.worktree) {
    const top = (await git.repoRoot(io, root)) ?? root
    named.root = top
    named.runDir = `${top}/.workspaces/.dacapo/${run.id}`
  }
  await io.setRun(() => named)
  run = named
  if (!run.gh?.ok) {
    const checked = await gh.checkGh(io, run.root)
    run = { ...run, gh: checked }
    await io.setRun(() => run)
    if (!checked.ok) return fail(`start: ${ghHelp(checked)}`)
  }
  let notes: string[]
  let isNew: boolean
  try {
    ;({ run, notes, isNew } = await ensureSetup(run, wanted))
  } catch (error) {
    return fail(`start: ${String(error)}`)
  }
  if (isNew || run.pushProblem) {
    const pushed = await pushAfter(run.worktree, run.branch)
    notes.push(pushed)
    if ((await io.getRun())?.pushProblem) return fail(`start: ${pushed} Pull requests need the run branch on origin; fix the push and call start again.`)
  }
  if (PHASES.indexOf(run.phase) < PHASES.indexOf('plan')) await setPhase('plan')
  void io.openPane()
  const repo = run.gh?.ok ? run.gh.repo : 'GitHub'
  return ok(
    [
      `Run ${run.id} ready on ${repo} (${run.root}).`,
      ...notes.map(n => `- ${n}`),
      `- every worker branches from "${run.branch}" and lands through a pull request into it; the final pull request goes from "${run.branch}" into "${run.baseBranch}"`,
      `- run folder ${run.runDir}`,
      `- level ${levelOf(run)}: ${levelOf(run) === 'fast' ? 'no QA; the run merges once the work has landed' : levelOf(run) === 'balanced' ? 'QA as the end user, then merge' : run.judges === 'parallel' ? 'QA as the end user and an engineering review side by side, then merge' : 'QA as the end user, then an engineering review, then merge'}`,
      `- models: workers ${conf.conf.workers.join(', ')}; QA ${conf.conf.qa.join(', ')}; review ${conf.conf.review.join(', ')} (the first of each is the strong tier and the default, the last the fast tier)`,
      ...(levelOf(run) === 'fast' ? [] : [`- QA collectors: ${conf.conf['qa-collectors'] > 0 ? `up to ${conf.conf['qa-collectors']} at once, so the harness must say what the product can share between testers` : 'off; QA collects every piece of evidence itself'}`]),
      `- rules: commits follow the ${conf.conf['commits-skill']} skill, pull requests the ${conf.conf['prs-skill']} skill; workers load them from their brief, and you load ${conf.conf['prs-skill']} before writing the final pull request`,
      `Plan the work, then call ${tool('dispatch')}.`,
    ].join('\n'),
  )
}

const rows_hadWork = (rows: Row[], iteration: number) => rows.some(r => isAgentRow(r) && r.iteration === iteration)

const COMMIT_TITLE = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|revert)!?: \S/
/** Whether the shipped rules skills are the configured ones; only then does the mod check the rules they state itself. */
const shippedCommits = () => conf.conf['commits-skill'] === SHIPPED_COMMITS
const shippedPrs = () => conf.conf['prs-skill'] === SHIPPED_PRS

async function dispatch(a: Args) {
  let run = await currentRun()
  if (!run) return fail(`dispatch: no active run; call ${tool('start')} first`)
  if (!run.worktree) return fail(`dispatch: the run is not set up; call ${tool('start')} first`)
  const tasks = Array.isArray(a.tasks) ? (a.tasks as Args[]) : []
  if (tasks.length === 0) return fail('dispatch: "tasks" must hold at least one task')
  const rows0 = await io.getRows()
  const iterationTitle = str(a.title).trim() || `Round ${run.iteration + (rows_hadWork(rows0, run.iteration) ? 1 : 0)}`
  const overview = str(a.overview).trim()
  const ids = new Set<string>()
  for (const t of tasks) {
    const id = str(t.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail(`dispatch: task id ${JSON.stringify(t.id)} must be a kebab-case slug`)
    if (ids.has(id)) return fail(`dispatch: task id "${id}" repeats`)
    ids.add(id)
    if (!str(t.title).trim() || !str(t.prompt).trim()) return fail(`dispatch: task "${id}" needs a title and a prompt`)
    if (typeof t.model !== 'string' || !conf.conf.workers.includes(t.model)) return fail(`dispatch: task "${id}" model must be one of ${conf.conf.workers.join(', ')} (the configured worker models; see ${tool('config')})`)
    const commit = str(t.commit).trim()
    if (!commit) return fail(`dispatch: task "${id}" needs a commit title`)
    if (shippedCommits() && (!COMMIT_TITLE.test(commit) || /^\w+\(/.test(commit) || commit.length > 72)) {
      return fail(`dispatch: task "${id}" commit title "${commit}" must be "<type>: <description>" with an allowed type, no scope, at most 72 characters (the ${SHIPPED_COMMITS} skill)`)
    }
    if (t.merge !== undefined && t.merge !== 'squash' && t.merge !== 'merge') return fail(`dispatch: task "${id}" merge must be "squash" or "merge"`)
    if (t.resume === true && !rows0.some(r => r.kind === 'worker' && r.taskId === id)) return fail(`dispatch: task "${id}" has no earlier worker to resume`)
  }

  const iteration = run.iteration
  const hadWork = rows0.some(r => isAgentRow(r) && r.iteration === iteration)
  const unfinished = rows0.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && !isTerminal(r))
  if (unfinished.length > 0) return fail(`dispatch: ${unfinished.length} agent(s) still running; wait for the wake-up prompt or cancel them first`)
  run = { ...run, iteration: hadWork ? iteration + 1 : iteration, status: 'active' }
  const startedAt = await io.now()
  const info = { n: run.iteration, title: iterationTitle, overview: overview || undefined, startedAt }
  run = { ...run, phase: 'implement', iterations: [...run.iterations.filter(i => i.n !== info.n), info] }
  const active = run
  await io.setRun(() => active)
  // workers branch from the run branch as origin has it, since their pull requests land there
  const fetched = (await git.git(io, active.root, ['fetch', 'origin', active.branch])).ok
  const base = fetched ? `origin/${active.branch}` : active.branch
  await refreshPrs(active)
  const withPrs = (await io.getRun()) ?? active

  const started: Array<{ taskId: string; title: string; branch: string; worktree: string; model: string; resumed: boolean }> = []
  const problems: string[] = []
  for (const t of tasks) {
    const taskId = str(t.id)
    const title = str(t.title).trim()
    const model = str(t.model)
    try {
      let branch: string
      let path: string
      let mergeMethod: 'squash' | 'merge' = t.merge === 'merge' ? 'merge' : 'squash'
      let resumed: { pr?: { number: number; url: string; state: string } } | undefined
      if (t.resume === true) {
        const prior = rows0.filter((r): r is WorkerRow => r.kind === 'worker' && r.taskId === taskId).sort((x, y) => y.at - x.at)[0]!
        if (!(await io.exists(prior.worktree))) throw new Error(`the worktree of the earlier worker (${prior.worktree}) is gone; dispatch the task afresh`)
        branch = prior.branch
        path = prior.worktree
        if (t.merge === undefined) mergeMethod = prior.mergeMethod
        const pr = latestPr(withPrs, branch)
        resumed = { pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : undefined }
      } else {
        let wanted = `${active.branch}--${slug(taskId)}`
        if (rows0.some(r => r.kind === 'worker' && r.branch.startsWith(wanted))) wanted = `${wanted}-${active.iteration}`
        ;({ branch, path } = await git.addBranchWorktree(io, active.root, wanted, base, true))
      }
      await git.mkdirp(io, `${path}/.context`)
      const extras = Array.isArray(t.context) ? (t.context as Args[]) : []
      const names: string[] = []
      for (const c of extras) {
        const name = str(c.name).replace(/[^A-Za-z0-9._-]/g, '_')
        if (!name || name === 'brief.md') continue
        await io.write(`${path}/.context/${name}`, str(c.text))
        names.push(name)
      }
      const brief = workerBrief({
        title,
        prompt: str(t.prompt),
        worktree: path,
        branch,
        base: active.branch,
        commit: str(t.commit).trim(),
        mergeMethod,
        build: str(t.build) || undefined,
        test: str(t.test) || undefined,
        extras: names,
        rules: { commits: conf.conf['commits-skill'], prs: conf.conf['prs-skill'] },
        resumed,
      })
      await io.write(`${path}/.context/brief.md`, brief)
      await io.write(`${active.runDir}/round-${active.iteration}-${taskId}.md`, brief)
      const now = await io.now()
      const row: WorkerRow = {
        kind: 'worker',
        id: pendingId('worker', active.iteration, taskId),
        iteration: active.iteration,
        at: now,
        lastActivityAt: now,
        taskId,
        title,
        branch,
        worktree: path,
        model,
        commit: str(t.commit).trim(),
        mergeMethod,
        status: 'pending',
        stats: freshStats(),
        ...(resumed ? { isResumed: true } : {}),
      }
      await io.setRows(list => [...list.filter(r => r.kind !== 'worker' || r.id !== row.id), row])
      started.push({ taskId, title, branch, worktree: path, model, resumed: !!resumed })
    } catch (error) {
      problems.push(`${taskId}: ${String(error)}`)
    }
  }
  void io.openPane()
  const text = [
    `Round ${active.iteration}: ${started.length} worktree(s) prepared${fetched ? '' : ` (origin/${active.branch} could not be fetched; branched from the local ${active.branch})`}.`,
    ...started.map(s => `- ${s.taskId}: ${s.branch} at ${s.worktree} (${s.model}${s.resumed ? ', resumed' : ''})`),
    ...(problems.length > 0 ? ['Problems:', ...problems.map(p => `- ${p}`)] : []),
    ...(started.length > 0
      ? [
          'Now start the workers: call the Agent tool once per task, all in one message, with exactly these arguments (the run fills in the brief, model, worktree and background mode):',
          ...started.map(s => `- Agent({ subagent_type: "${WORKER_AGENT}", description: "${s.title.replace(/"/g, "'")}", prompt: "dacapo worker ${s.taskId}" })`),
          `Then end your turn. Each worker opens a pull request against ${active.branch}, waits for its checks, merges it and only then finishes. A prompt wakes you when every worker has ended, or when one goes stale.`,
        ]
      : ['Nothing to start.']),
  ].join('\n')
  return ok(text)
}

/** What the orchestrator calls once a round's work has landed and is synced, by level. */
const afterLanding = (run: Run): string => (levelOf(run) === 'fast' ? tool('finish') : tool('qa'))
/** The judges to run again after a reconciliation or repair, by level, as a phrase. */
const judgeAgain = (run: Run): string =>
  levelOf(run) === 'fast' ? '' : levelOf(run) === 'balanced' ? `run ${tool('qa')} once more since a conflict resolution can break things, and ` : `run ${tool('qa')} and then ${tool('review')} once more since a conflict resolution can break things, and `

async function sync() {
  const run = await currentRun()
  if (!run) return fail('sync: no active run')
  if (!run.worktree) return fail(`sync: nothing was dispatched yet; call ${tool('start')} first`)
  const prs = await refreshPrs(run)
  if (prs === null) return fail('sync: gh did not answer when listing the pull requests; try again in a moment')
  const fresh = (await io.getRun()) ?? run
  const rows = await io.getRows()
  const landed: string[] = []
  const waiting: string[] = []
  const kept: string[] = []
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker' && isTerminal(r) && r.status !== 'merged').sort((a, b) => a.at - b.at)
  for (const w of workers) {
    const mine = prsOf(fresh, w.branch)
    const merged = mine.find(p => p.state === 'merged')
    if (merged && w.status === 'finished') {
      const notes = await git.removeWorktree(io, fresh.root, w.worktree, w.branch)
      const remote = await git.deleteRemoteBranch(io, fresh.root, w.branch)
      if (remote) notes.push(remote)
      await patchWorker(w.id, r => ({ ...r, status: 'merged' }))
      landed.push(`${w.taskId}: ${prText(merged)}${notes.length ? ` [${notes.join('; ')}]` : ''}`)
    } else if (w.status === 'finished') {
      await patchWorker(w.id, r => ({ ...r, status: 'failed', note: `finished without landing: ${mine[0] ? prText(mine[0]) : 'no pull request'}${r.note ? ` — ${r.note}` : ''}` }))
      waiting.push(`${w.taskId}: ${mine[0] ? prText(mine[0]) : 'no pull request'}. The worker reported finished but nothing landed, so it is marked failed: resume it (dispatch the task with resume: true and say what to do), or cancel it.`)
    } else if (await io.exists(w.worktree)) {
      kept.push(`${w.taskId} (${statusWord[w.status]}): ${mine[0] ? prText(mine[0]) : 'no pull request'}; branch and worktree kept at ${w.worktree}`)
    }
  }
  const pulled = await git.pullFf(io, fresh.worktree, fresh.branch)
  const text = [
    `Synced ${fresh.branch}: ${landed.length} pull request(s) landed since the last sync.`,
    ...landed.map(m => `- ${m}`),
    pulled.kind === 'pulled' ? `${fresh.worktree} fast-forwarded by ${pulled.commits} commit(s).` : `${fresh.branch} at ${fresh.worktree} was not fast-forwarded: ${pulled.message}`,
    ...(waiting.length > 0 ? ['Finished without landing:', ...waiting.map(s => `- ${s}`)] : []),
    ...(kept.length > 0 ? ['Not landed:', ...kept.map(s => `- ${s}`)] : []),
    landed.length > 0 && waiting.length === 0 ? `Next: call ${afterLanding(fresh)}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return ok(text)
}

const qaPrompt = (worktree: string) =>
  `Read ${worktree}/.context/qa-brief.md and ${worktree}/.context/rubric.json, then test the deliverable as its user and write the report where the brief says. Your working directory is ${worktree}.`
const collectorPrompt = (worktree: string) =>
  `Read ${worktree}/.context/qa-brief.md (what was built, and the harness: how to run and use the product) and ${worktree}/.context/rubric.json (the items; your slice is below). Save screenshots and notes only under ${worktree}/.context/evidence/.`
const reviewPrompt = (worktree: string) =>
  `Read ${worktree}/.context/review-brief.md and ${worktree}/.context/rubric.json, then review the run's change as an engineer and write the report where the brief says. Your working directory is ${worktree}.`

/**
 * Starts a judge of the integrated state in a fresh checkout of the run branch: QA, which uses the product as its
 * user and needs a harness, or the reviewer, which reads the run's diff and runs only at level deep.
 */
async function startJudge(role: Role, a: Args) {
  const name = role
  const run = await currentRun()
  if (!run) return fail(`${name}: no active run`)
  if (!run.worktree) return fail(`${name}: nothing was dispatched yet; call ${tool('start')} first`)
  const level = levelOf(run)
  if (role === 'qa' && level === 'fast') return fail(`qa: the run is at level fast, which has no QA; call ${tool('finish')} once the work has landed`)
  if (role === 'review' && level !== 'deep') return fail(`review: the run is at level ${level}; an engineering review runs at level deep only`)
  const rubric = validateRubric(a.rubric, role === 'qa' ? QA_CATEGORIES : REVIEW_CATEGORIES)
  if (!rubric.ok) return fail(`${name}: ${rubric.problem}`)
  const harness = str(a.harness).trim()
  if (role === 'qa' && !harness) return fail('qa: "harness" must say how to run and use the deliverable')
  const allowed = role === 'qa' ? conf.conf.qa : conf.conf.review
  const model = str(a.model).trim() || allowed[0]!
  if (!allowed.includes(model)) return fail(`${name}: "model" must be one of ${allowed.join(', ')} (the configured ${name} models; see ${tool('config')})`)
  const iteration = run.iteration
  const rows = await io.getRows()
  const parallel = level === 'deep' && run.judges === 'parallel'
  // with judges in parallel, QA and the reviewer do not wait for each other; workers still end first
  const unfinished = rows.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && !isTerminal(r) && !(parallel && r.kind === 'qa'))
  if (unfinished.length > 0) return fail(`${name}: ${unfinished.length} agent(s) still running; wait or cancel them first`)
  const unsynced = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.status === 'finished')
  if (unsynced.length > 0) return fail(`${name}: ${unsynced.length} finished worker(s) not yet synced; call ${tool('sync')} first`)
  // the reviewer reads the state QA tests: QA goes first in every round, or alongside when the judges run in parallel
  const qaRows = rows.filter((r): r is QaRow => r.kind === 'qa' && roleOf(r) === 'qa' && r.iteration === iteration && r.status !== 'cancelled')
  const qaDone = qaRows.some(r => r.status === 'finished')
  if (role === 'review' && !qaDone && !(parallel && qaRows.length > 0)) {
    return fail(`review: QA has not ${parallel ? 'started' : 'reported'} on round ${iteration} yet; call ${tool('qa')} first, the reviewer reads the state QA tests`)
  }
  // rounds count across the whole run, per judge, since the timeline does not group by round
  const round = rows.filter((r): r is QaRow => r.kind === 'qa' && roleOf(r) === role).length + 1
  const worktree = `${run.root}/.workspaces/${role}/${iteration}-${round}`
  const reportPath = `${worktree}/.context/${role}-report.json`
  const key = `${role}-${iteration}-${round}`
  try {
    await git.addDetachedWorktree(io, run.root, worktree, run.branch)
    await git.mkdirp(io, `${worktree}/.context`)
    await io.write(`${worktree}/.context/rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    const brief =
      role === 'qa'
        ? qaBrief({ task: run.task, harness, brief: str(a.brief), reportPath, worktree, collectors: conf.conf['qa-collectors'] })
        : reviewBrief({ task: run.task, base: run.baseBranch, brief: str(a.brief), reportPath, worktree })
    await io.write(`${worktree}/.context/${role}-brief.md`, brief)
    await io.write(`${run.runDir}/${key}-rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    await io.write(`${run.runDir}/${key}-brief.md`, brief)
  } catch (error) {
    return fail(`${name}: ${String(error)}`)
  }
  const now = await io.now()
  const row: QaRow = {
    kind: 'qa',
    role,
    id: pendingId(role, iteration, `${round}`),
    iteration,
    round,
    attempt: 1,
    at: now,
    lastActivityAt: now,
    worktree,
    reportPath,
    model,
    status: 'pending',
    stats: freshStats(),
  }
  rubrics.set(key, rubric.rubric)
  await setPhase(role)
  await io.setRows(list => [...list, row])
  void io.openPane()
  return ok(
    [
      `${roundName(row)} prepared at ${worktree} (a checkout of ${run.branch}).`,
      'Now start it: call the Agent tool with exactly these arguments (the run fills in the brief, model, worktree and background mode):',
      `- Agent({ subagent_type: "${role === 'qa' ? QA_AGENT : REVIEW_AGENT}", description: "${roundName(row)}", prompt: "dacapo ${role} ${iteration}-${round}" })`,
      parallel && role === 'qa'
        ? `The judges run in parallel: call ${tool('review')} now as well, then start both agents in one message and end your turn; a prompt wakes you with each verdict.`
        : 'Then end your turn; a prompt wakes you with the verdict and overview.',
      ...(role === 'qa' && conf.conf['qa-collectors'] > 0 ? [`QA may start up to ${conf.conf['qa-collectors']} ${COLLECTOR_AGENT} agents on slices of the rubric; its brief says so.`] : []),
    ].join('\n'),
  )
}

async function cancel(a: Args) {
  const agentId = str(a.agentId)
  const run = await currentRun()
  const rows = await io.getRows()
  const row = rows.find(isAgent(agentId))
  if (!row) return fail(`cancel: no agent ${agentId} in this run`)
  if (isTerminal(row)) return fail(`cancel: agent ${agentId} already ${statusWord[row.status]}`)
  let stopNote = ''
  if (row.status !== 'pending') {
    try {
      await io.stop(agentId)
    } catch (error) {
      stopNote = ` (stop reported: ${String(error)})`
    }
    if (row.kind === 'qa') await stopCollectors(row, await io.now())
  }
  const now = await io.now()
  await patchRow(agentId, r => ({ ...r, status: 'cancelled', endedAt: now, note: str(a.reason) || 'cancelled by the orchestrator' }))
  const closed: string[] = []
  if (row.kind === 'worker' && run) {
    for (const pr of prsOf(run, row.branch).filter(p => p.state === 'open' || p.state === 'draft')) {
      const done = await gh.closePr(io, run.worktree, pr.number)
      closed.push(done.ok ? `pull request #${pr.number} closed` : `pull request #${pr.number} not closed: ${(done.err || done.out).split('\n')[0] ?? ''}`)
    }
  }
  return ok(`Agent ${agentId} cancelled${stopNote}.${closed.length ? ` ${closed.join('; ')}.` : ''}`)
}

const ATTRIBUTION = /co-authored-by|signed-off-by|generated with/i

async function finish(a: Args) {
  const run = await currentRun()
  if (!run) return fail('finish: no active run')
  const rows = await io.getRows()
  const unfinished = rows.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && !isTerminal(r))
  if (unfinished.length > 0) return fail(`finish: ${unfinished.length} agent(s) still running; wait or cancel them first`)
  if (a.abort === true) {
    await io.setRun(() => ({ ...run, status: 'aborted' }))
    return ok(`Run ${run.id} aborted; ${run.branch || 'no branch'} keeps what landed. Worktrees under .workspaces/ and open pull requests are kept for inspection.`)
  }
  if (!run.worktree) return fail('finish: nothing was ever dispatched; call finish with abort=true to close the run')
  const unsynced = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.status === 'finished')
  if (unsynced.length > 0) return fail(`finish: ${unsynced.length} finished worker(s) not yet synced; call ${tool('sync')} first`)
  const title = str(a.title).trim()
  if (!title) return fail('finish: "title" is required: the merge commit title')
  if (shippedCommits() && (!COMMIT_TITLE.test(title) || /^\w+\(/.test(title) || title.length > 72)) {
    return fail(`finish: "title" must be the merge commit title, "<type>: <description>" with an allowed type, no scope, at most 72 characters (the ${SHIPPED_COMMITS} skill)`)
  }
  const body = str(a.body).trim()
  if (!body) return fail(`finish: "body" is required: the final pull request body, written to the ${conf.conf['prs-skill']} skill`)
  if (shippedPrs() && (ATTRIBUTION.test(body) || ATTRIBUTION.test(title))) return fail(`finish: the title and body carry no Co-Authored-By, Signed-off-by or "Generated with" line (the ${SHIPPED_PRS} skill)`)
  if (!run.gh?.ok) return fail(`finish: gh is not usable (${run.gh?.detail ?? 'not checked'}); call ${tool('start')} to check it again`)
  await refreshPrs(run)
  const fresh = (await io.getRun()) ?? run
  const existing = prsOf(fresh, fresh.branch).find(p => p.state === 'open' || p.state === 'draft')
  const pushed = await pushAfter(fresh.worktree, fresh.branch)
  let number: number
  let url: string
  if (existing) {
    const edited = await gh.editPr(io, fresh.worktree, existing.number, title, body)
    if (!edited.ok) return fail(`finish: pull request #${existing.number} could not be updated: ${(edited.err || edited.out).split('\n')[0] ?? ''}`)
    ;({ number, url } = existing)
  } else {
    const created = await gh.createPr(io, fresh.worktree, { base: fresh.baseBranch, head: fresh.branch, title, body })
    if (created.kind === 'error') return fail(`finish: the final pull request could not be opened: ${created.message}`)
    ;({ number, url } = created)
  }
  const now = await io.now()
  const attempt = (fresh.final?.attempt ?? 0) + 1
  await io.setRun(cur => (cur ? { ...cur, status: 'merging', phase: 'merge', final: { number, url, title, openedAt: now, attempt } } : cur))
  return ok(
    [
      `Final pull request #${number} ${existing ? 'updated' : 'opened'}: ${url} (${fresh.branch} into ${fresh.baseBranch}). ${pushed}`,
      `The run watches its checks and merges it with a merge commit titled "${title}" once they pass and it is mergeable. A prompt wakes you when it is merged, when its checks fail, or when it conflicts with ${fresh.baseBranch}. End your turn now.`,
    ].join('\n'),
  )
}

// ---------- the final pull request, watched by the ticker ----------

/** Final pull requests the ticker already tried to merge, by number and attempt, so a refusal is reported once. */
const mergeTried = new Set<string>()

async function completeMerge(run: Run, pr: Pr, how: string) {
  // polling stops once the run is done, so the merge the run just made (or saw) is written into the list itself
  await io.setRun(cur => (cur ? { ...cur, prs: cur.prs.map(p => (p.number === pr.number ? { ...p, state: 'merged', title: pr.title } : p)) } : cur))
  const notes: string[] = []
  notes.push(...(await git.removeWorktree(io, run.root, run.worktree, run.branch)))
  const remote = await git.deleteRemoteBranch(io, run.root, run.branch)
  if (remote) notes.push(remote)
  notes.push((await git.refreshBase(io, run.root, run.baseBranch)).note)
  const rows = await io.getRows()
  for (const w of rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.status !== 'merged')) notes.push(...(await git.removeWorktree(io, run.root, w.worktree, w.branch)))
  for (const q of rows.filter((r): r is QaRow => r.kind === 'qa')) notes.push(...(await git.removeWorktree(io, run.root, q.worktree)))
  // one last listing, so every pull request shows its final state
  const latest = await io.getRun()
  if (latest) await refreshPrs(latest)
  await io.setRun(cur => (cur ? { ...cur, status: 'done', phase: 'merge', prs: cur.prs.map(p => (p.number === pr.number ? { ...p, state: 'merged' } : p)) } : cur))
  await wake(
    `merged-${pr.number}`,
    [
      `Merged into ${run.baseBranch}: pull request #${pr.number} "${pr.title}" (${pr.url}, ${how}).`,
      ...notes.filter(Boolean).map(n => `- ${n}`),
      `Run ${run.id} finished; reports and briefs are under ${run.runDir}. Report to the user in a few lines: what shipped, the level and the last verdicts, anything left out, and the decisions and recommendations to review.`,
    ].join('\n'),
  )
}

async function watchFinal(run: Run) {
  if (run.status !== 'merging' || !run.final) return
  const final = run.final
  const pr = run.prs.find(p => p.number === final.number)
  if (!pr) return
  const key = (what: string) => `final-${what}-${pr.number}-${final.attempt}`
  if (pr.state === 'merged') return completeMerge(run, pr, 'merged by hand')
  if (pr.state === 'closed') {
    return wake(key('closed'), `The final pull request #${pr.number} was closed without merging. Call ${tool('finish')} again to open a new one, or finish with abort=true.`)
  }
  if (pr.mergeable === 'conflicting') {
    return wake(
      key('conflict'),
      `The final pull request #${pr.number} conflicts with ${run.baseBranch}. Dispatch one worker with merge: "merge" whose task is to merge origin/${run.baseBranch} into its branch and resolve the conflicts (commit title "chore: merge ${run.baseBranch} into ${run.branch}"), then ${tool('sync')}, ${judgeAgain(run)}call ${tool('finish')} again.`,
    )
  }
  if (pr.checks === 'failing') {
    return wake(
      key('checks'),
      `The final pull request #${pr.number} has failing checks (${pr.url}). Dispatch a worker to fix them (resume the task at fault, or a repair task), then ${tool('sync')}, ${judgeAgain(run)}call ${tool('finish')} again.`,
    )
  }
  if (pr.checks === 'pending' || pr.mergeable === 'unknown') return
  const tried = `${pr.number}-${final.attempt}`
  if (mergeTried.has(tried)) return
  mergeTried.add(tried)
  const merged = await gh.mergePr(io, run.worktree, pr.number, 'merge', final.title)
  if (merged.ok) {
    await completeMerge(run, { ...pr, state: 'merged', title: final.title }, 'merged by the run')
    return
  }
  await wake(
    key('merge-failed'),
    `The final pull request #${pr.number} is green but GitHub refused the merge: ${(merged.err || merged.out).split('\n').filter(Boolean).slice(-1)[0] ?? 'no reason given'}. Either the user merges it on GitHub (the run finishes when it sees it merged), or fix the cause and call ${tool('finish')} again.`,
  )
}

// ---------- completion of the agents ----------

async function rubricFor(run: Run, row: QaRow): Promise<RubricItem[]> {
  const held = rubrics.get(judgeKey(row))
  if (held) return held
  const text = await io.read(`${run.runDir}/${judgeKey(row)}-rubric.json`)
  return JSON.parse(text) as RubricItem[]
}

async function collectQa(row: QaRow, now: number, agentFailure: string | null) {
  const run = await io.getRun()
  if (!run) return
  const role = roleOf(row)
  const key = judgeKey(row)
  const name = roundName(row)
  // QA ended; a collector it left running would outlive the round
  await stopCollectors(row, now)
  if (agentFailure) {
    await patchQa(row.id, r => ({ ...r, status: 'failed', endedAt: now, note: agentFailure, collect: undefined }))
    await wake(key, `${name} failed before writing a report (${agentFailure}). Call ${tool('status')}, then ${tool(role)} again or ${tool('finish')} as you see fit.`)
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
    await patchQa(row.id, r => ({ ...r, status: 'failed', endedAt: now, note: `rubric unreadable: ${String(error)}`, collect: undefined }))
    await wake(key, `${name} ended but its rubric could not be read (${String(error)}). Call ${tool(role)} again.`)
    return
  }
  const checked = text === null ? { ok: false as const, problems: [`no report at ${row.reportPath}`] } : validateReport(text, rubric)
  if (!checked.ok) {
    const note = `report invalid: ${checked.problems.join('; ')}`
    await patchQa(row.id, r => ({ ...r, status: 'invalid', endedAt: now, note, collect: undefined }))
    await wake(key, `${name} ended without a valid report (${note}). The worktree ${row.worktree} is kept. Call ${tool(role)} again (a new round) with a clearer ${role === 'qa' ? 'harness' : 'brief'}, or decide without it.`)
    return
  }
  const stamped = JSON.stringify(
    { iteration: row.iteration, round: row.round, collectedAt: new Date(now).toISOString(), summary: checked.summary, items: checked.items, overview: checked.overview },
    null,
    2,
  )
  await io.write(`${run.runDir}/${key}.json`, stamped)
  await patchQa(row.id, r => ({ ...r, status: 'finished', endedAt: now, summary: checked.summary, items: checked.items, overview: checked.overview, collect: undefined }))
  rubrics.delete(key)
  const s = checked.summary
  const weak = checked.items.filter(i => i.score !== 'strong').map(i => `- ${i.score}: ${i.title}${i.note ? ` — ${i.note}` : ''}`)
  const toFinish = `call ${tool('finish')} with the final pull request's title and body (to the ${conf.conf['prs-skill']} skill) to open it from ${run.branch} into ${run.baseBranch}`
  // with judges in parallel, the other judge of the round may be running or already in; a QA verdict of fix stops a running review
  const others = (await io.getRows()).filter((r): r is QaRow => r.kind === 'qa' && roleOf(r) !== role && r.iteration === row.iteration && r.status !== 'cancelled')
  const other = others[others.length - 1]
  const preempted: string[] = []
  if (role === 'qa' && s.verdict === 'fix') {
    for (const r of others.filter(isLive)) {
      void io.stop(r.id).catch(() => undefined)
      await patchQa(r.id, x => ({ ...x, status: 'cancelled', endedAt: now, note: 'stopped: a QA verdict of fix preempts the review; it runs again after the fixes', collect: undefined }))
      preempted.push(`${roundName(r)} was stopped: QA's fix verdict preempts it. Run ${tool('review')} again once the fixes have landed and QA passes.`)
    }
  }
  const otherState = !other ? undefined : isLive(other) || other.status === 'pending' ? 'running' : other.summary ? other.summary.verdict : 'without a report'
  const next =
    role === 'qa'
      ? s.verdict === 'fix'
        ? `Next: plan the fixes and call ${tool('dispatch')} (a new round starts), then ${tool('sync')} and ${tool('qa')} again.`
        : levelOf(run) === 'deep'
          ? otherState === 'running'
            ? `${roundName(other!)} is still running; its wake-up follows. Decide once both are in.`
            : otherState && otherState !== 'without a report'
              ? `${roundName(other!)} already reported ${otherState}; decide on both reports as the loop says.`
              : `Next: call ${tool('review')} with the engineering rubric${s.verdict === 'pass' ? '' : ', or dispatch improvements first if the recommendations are worth another round'}.`
          : `Next: ${toFinish}${s.verdict === 'pass' ? '' : ', or dispatch improvements first if the recommendations are worth another round'}.`
      : otherState === 'running'
        ? `${roundName(other!)} is still running; wait for its verdict before deciding, since a QA verdict of fix comes first.`
        : s.verdict === 'pass'
          ? `Next: ${toFinish}.`
          : `Next: the items below strong whose fix lies inside the run's own change become fix tasks: call ${tool('dispatch')} (a new round starts), then ${tool('sync')}, ${tool('qa')} again (a fix can regress behaviour) and ${tool('review')} again. An item whose fix would reach parts the run does not touch is not a task: it goes to the final report as a recommendation.`
  await wake(
    key,
    [
      `${name}: ${s.strong} strong, ${s.acceptable} acceptable, ${s.unacceptable} unacceptable → verdict: ${s.verdict}.`,
      ...(weak.length > 0 ? ['Items below strong:', ...weak] : []),
      `Overview from ${role === 'qa' ? 'QA' : 'the reviewer'}:`,
      checked.overview,
      ...preempted,
      next,
    ].join('\n'),
  )
  await git.removeWorktree(io, run.root, row.worktree)
}

const FAILURE_OPTIONS =
  'A worker that failed leaves its branch and pull request in place. Options, in order of preference: (1) resume it: dispatch the same task id with resume: true and a prompt that says what to fix; (2) when the failure is not the task\'s fault (a broken workflow, a flaky test), dispatch a repair task first, then resume; (3) cancel the task (its open pull request is closed); (4) ask the user when a human is needed (secrets, approvals, an outage).'

async function maybeWakeForWorkers() {
  const run = await io.getRun()
  if (!run) return
  const rows = await io.getRows()
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === run.iteration)
  if (workers.length === 0 || workers.some(w => !isTerminal(w))) return
  const lines = workers.map(w => {
    const pr = latestPr(run, w.branch)
    return `- ${w.taskId} [${w.id}]: ${statusWord[w.status]} after ${elapsed(w.at, w.endedAt ?? w.at)}; PR ${pr ? prText(pr) : 'none seen yet'}${w.note ? ` — ${w.note.slice(0, 300)}` : ''}`
  })
  const finished = workers.filter(w => w.status === 'finished').length
  const troubled = workers.some(w => w.status === 'failed' || w.status === 'timeout' || w.status === 'cancelled')
  await wake(
    `workers-${run.iteration}`,
    [
      `Round ${run.iteration}: all ${workers.length} worker(s) have ended (${finished} finished).`,
      ...lines,
      ...(troubled ? [FAILURE_OPTIONS] : []),
      finished > 0 ? `Next: call ${tool('sync')} (it confirms what landed and prunes), then ${afterLanding(run)}.` : `No worker finished. Review with ${tool('status')} and decide.`,
    ].join('\n'),
  )
}

/**
 * An agent that ended and then acts again (the person or the orchestrator resumed it) is live again: its row
 * goes back to running, its end time is cleared, and the wake-up its round already sent is forgotten so the
 * next completion wakes the orchestrator afresh.
 */
async function revive(row: WorkerRow | QaRow, now: number) {
  const key = row.kind === 'worker' ? `workers-${row.iteration}` : judgeKey(row)
  await io.setRun(cur => (cur ? { ...cur, wakes: cur.wakes.filter(w => w.key !== key) } : cur))
  await patchRow(row.id, r =>
    r.kind === 'worker'
      ? { ...r, status: 'running', endedAt: undefined, lastActivityAt: now, restarts: (r.restarts ?? 0) + 1, note: undefined }
      : { ...r, status: 'running', endedAt: undefined, lastActivityAt: now, restarts: (r.restarts ?? 0) + 1, note: undefined, collect: undefined },
  )
}

/** Pushes a branch after the run changed it; a failure is told and remembered, never fatal. */
async function pushAfter(cwd: string, branch: string): Promise<string> {
  const out = await git.pushBranch(io, cwd, branch)
  if (out.kind === 'pushed') {
    await io.setRun(cur => (cur && cur.pushProblem ? { ...cur, pushProblem: undefined } : cur))
    return `Pushed ${branch} to origin.`
  }
  const problem = out.kind === 'no-remote' ? `${branch} was not pushed: the repository has no origin remote.` : `${branch} was not pushed to origin: ${out.message}`
  await io.setRun(cur => (cur ? { ...cur, pushProblem: problem } : cur))
  io.toast(`dacapo: ${problem}`)
  return problem
}

async function touch(agentId: string) {
  const rows = await io.getRows()
  const row = rows.find(isAgent(agentId))
  if (!row) return
  const now = await io.now()
  if (isTerminal(row)) return revive(row, now)
  if (row.status === 'stale' || row.lastActivityAt < now - 5_000) {
    await patchRow(row.id, r =>
      r.kind === 'worker'
        ? { ...r, lastActivityAt: now, status: r.status === 'stale' ? 'running' : r.status }
        : { ...r, lastActivityAt: now, status: r.status === 'stale' ? 'running' : r.status },
    )
  }
}

// ---------- the ticker: spinner, elapsed, stale and timeout, pull requests, the final merge ----------

async function tick() {
  const run = await io.getRun()
  if (!run || run.status === 'done' || run.status === 'aborted') return
  const rows = await io.getRows()
  const live = rows.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && isLive(r))
  const now = await io.now()
  await io.setUi(ui => ({ ...ui, tick: now }))
  for (const row of live) {
    const idle = now - row.lastActivityAt
    const who = row.kind === 'worker' ? `Worker ${row.taskId}` : roundName(row)
    if (idle >= TIMEOUT_MS) {
      await patchRow(row.id, r => ({ ...r, status: 'timeout', endedAt: now, note: `no activity for ${elapsed(row.lastActivityAt, now)}; stopped` }))
      void io.stop(row.id).catch(() => undefined)
      if (row.kind === 'qa') await stopCollectors(row, now)
      await wake(`timeout-${row.id}`, `${who} [${row.id}] timed out: no activity for ${elapsed(row.lastActivityAt, now)}, so it was stopped. Call ${tool('status')} and decide: resume, re-dispatch or finish.`)
    } else if (idle >= STALE_MS && row.status === 'running') {
      await patchRow(row.id, r => ({ ...r, status: 'stale' }))
      await wake(
        `stale-${row.id}`,
        `${who} [${row.id}] looks stale: no tool call or model step for ${elapsed(row.lastActivityAt, now)}. It is still running (it may be waiting on checks). Call ${tool('status')} to review, and ${tool('cancel')} with its agent id if it should stop; it is stopped automatically after ${TIMEOUT_MS / 3_600_000} hours idle.`,
      )
    }
  }
  // work that must outlive an agent's own dispatch runs here, on the session's timer
  for (const row of rows) {
    if (row.kind === 'qa' && row.collect && !collecting.has(row.id)) {
      collecting.add(row.id)
      try {
        await collectQa(row, now, row.collect.failure)
      } finally {
        collecting.delete(row.id)
      }
    }
  }
  // the pull requests of the run, and the final pull request once it is open
  const hasBranches = run.worktree && (rows.some(r => r.kind === 'worker') || run.final)
  if (run.gh?.ok && hasBranches && !polling && now - (run.prsAt ?? 0) >= POLL_MS) {
    polling = true
    try {
      await refreshPrs(run)
      const fresh = await io.getRun()
      if (fresh) await watchFinal(fresh)
    } finally {
      polling = false
    }
  }
  await maybeWakeForWorkers()
  const stuck = (await io.getRun())?.wakes.filter(w => !w.deliveredAt && w.tries < WAKE_TRIES && now - w.sentAt >= WAKE_RETRY_MS) ?? []
  for (const w of stuck) {
    await io.setRun(cur => (cur ? { ...cur, wakes: cur.wakes.map(x => (x.key === w.key ? { ...x, sentAt: now, tries: x.tries + 1 } : x)) } : cur))
    ownPrompts.add(w.text)
    void io.submit(w.text).catch(() => undefined)
  }
}

/** QA rows whose report is being collected right now, so a slow collection is not started twice. */
const collecting = new Set<string>()

const actions: Actions = {
  toggleRow: id => void io.setUi(ui => ({ ...ui, expanded: ui.expanded.includes(id) ? ui.expanded.filter(x => x !== id) : [...ui.expanded, id] })),
  toggleSection: name => void io.setUi(ui => ({ ...ui, openSections: ui.openSections.includes(name) ? ui.openSections.filter(x => x !== name) : [...ui.openSections, name] })),
  toggleTimelineFull: () => void io.setUi(ui => ({ ...ui, isTimelineFull: !ui.isTimelineFull })),
  openPane: () => void io.openPane(true),
  hideBand: () => void io.setUi(ui => ({ ...ui, isBandHidden: true })),
}

// ---------- the module ----------

export const register: Register = (on, options) => {
  prices = parsePrices(options.prices)

  on('session.start', async ($, e, next) => {
    io = {
      run: (argv, init) => $.process.run(argv, init),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      cwd: () => $.session.cwd(),
      home: () => $.env.get('HOME'),
      stop: agentId => $.tool.call({ tool: 'TaskStop', task_id: agentId }),
      submit: text => $.prompt.submit({ text }),
      openPane: focus => $.ui.open(focus ? { id: PANE, title: 'Da capo', focus: true } : { id: PANE, title: 'Da capo' }),
      toast: text => $.ui.toast(text, { timeoutMs: 8_000 }),
      getRun: () => read($, runAtom),
      setRun: fn => update($, runAtom, fn),
      getRows: () => read($, rowsAtom),
      setRows: fn => update($, rowsAtom, fn),
      getUi: () => read($, uiAtom),
      setUi: fn => update($, uiAtom, fn),
    }

    const cwd = await io.cwd()
    await readConf((await git.repoRoot(io, cwd)) ?? cwd)

    await Promise.all([
      $.tool.register({
        name: 'start',
        description:
          'Begins (or confirms) the dacapo run for the task handed over: checks that gh is installed and logged in, pulls the base branch, cuts the run branch from it in its own worktree, pushes it, and opens the timeline pane. Call once, after the task is clear.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The task in one line: the heading of the run.' },
            overview: { type: 'string', description: 'One short paragraph on the whole task: deliverable, who it is for, what done looks like. Shown under the heading.' },
            branch: { type: 'string', description: 'The run branch, named after the change (kebab-case, e.g. "add-login"); default a slug of the task. Every worker pull request targets it.' },
            baseBranch: { type: 'string', description: 'The branch the run is cut from and merged into; default the configured base-branch.' },
            level: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'How far the run is judged before it merges: fast (no QA), balanced (QA as the end user), deep (QA, then an engineering review of the run\'s change). Default from the configuration. Fixed for the run.' },
            judges: { type: 'string', enum: ['sequential', 'parallel'], description: 'At deep: whether QA and the review run one after the other or side by side. Default from the configuration. Fixed for the run.' },
            root: { type: 'string', description: 'Absolute path inside the repository to run in; default the session working directory.' },
          },
          required: ['task'],
        },
      }),
      $.tool.register({
        name: 'dispatch',
        description:
          'Prepares one worker subagent per task, each in its own git worktree and branch off the run branch, and returns the Agent calls that start them. Each worker lands its work through a pull request into the run branch before it finishes. A dispatch after QA starts the next round; a task with resume: true continues an earlier worker on its branch and pull request.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional: a few words naming this round of work, kept in the run log.' },
            overview: { type: 'string', description: 'Optional: one short paragraph on what this round builds and why, kept in the run log.' },
            tasks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short kebab-case id, unique in this dispatch.' },
                  title: { type: 'string', description: 'A few words naming the task.' },
                  prompt: { type: 'string', description: 'The full brief: what to build, where, constraints, acceptance. For a resumed task: what to fix or finish.' },
                  model: { type: 'string', enum: conf.conf.workers, description: 'One of the configured worker models: the first for complex or cross-cutting work, the last for contained work.' },
                  commit: { type: 'string', description: 'Conventional Commit title of the squash commit and the pull request, e.g. "feat: add login endpoint". No scope in parentheses.' },
                  build: { type: 'string', description: 'Command that must pass before the worker marks its pull request ready.' },
                  test: { type: 'string', description: 'Test command the worker runs, if any.' },
                  merge: { type: 'string', enum: ['squash', 'merge'], description: 'How the worker merges its pull request; default squash. Use merge only for a branch that merges the base branch into the run branch.' },
                  resume: { type: 'boolean', description: 'true continues the latest earlier worker of this task id on its branch and pull request instead of starting afresh.' },
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
        name: 'sync',
        description:
          'After the workers ended: lists their pull requests through gh, marks the ones that merged, prunes their worktrees and branches, and fast-forwards the run branch worktree to origin. Reports a worker that finished without landing.',
        isDeferred: false,
        inputSchema: { type: 'object', properties: {} },
      }),
      $.tool.register({
        name: 'qa',
        description:
          'Starts the QA subagent in a fresh worktree of the run branch. It uses the deliverable as an end user, scores every rubric item strong/acceptable/unacceptable and writes a report the run collects. It may split the rubric among dacapo:qa-collector subagents (as many at once as qa-collectors allows), bound like itself, so the harness must say what the product can share between testers. Returns at once; the run wakes you with the overview and verdict.',
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
            brief: { type: 'string', description: 'Optional: what was built this round and what changed since the last one.' },
            model: { type: 'string', enum: conf.conf.qa, description: 'One of the configured QA models; default the first.' },
          },
          required: ['rubric', 'harness'],
        },
      }),
      $.tool.register({
        name: 'review',
        description:
          'At level deep, after QA passes: starts the reviewer subagent in a fresh worktree of the run branch. It reads the run\'s change against the base branch as an engineer, scores every engineering rubric item strong/acceptable/unacceptable and writes a report the run collects. Returns at once; the run wakes you with the overview and verdict.',
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
                  title: { type: 'string', description: 'What is checked, as a property of the code a reader can balanced in the diff.' },
                  category: { type: 'string', enum: ['quality', 'consistency', 'cleanup'] },
                },
                required: ['id', 'title', 'category'],
              },
            },
            brief: { type: 'string', description: 'Optional: what the run built, the conventions and references the briefs pointed at, and what to look at first.' },
            model: { type: 'string', enum: conf.conf.review, description: 'One of the configured review models; default the first.' },
          },
          required: ['rubric'],
        },
      }),
      $.tool.register({
        name: 'config',
        description: 'The configuration in force: the default level, whether judges run in parallel, the models workers, QA and the reviewer may be given, the skills commits and pull requests follow, the base branch, and how many evidence collectors QA may run at once, each with the file it came from. Agents never read the conf files themselves.',
        isDeferred: false,
        inputSchema: { type: 'object', properties: {} },
      }),
      $.tool.register({
        name: 'phase',
        description: 'Marks where the orchestrator is: clarify, research, plan, implement, qa, review or merge. start, dispatch, qa, review and finish set the later phases themselves; call this for clarify and research.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: { phase: { type: 'string', enum: ['clarify', 'research', 'plan', 'implement', 'qa', 'review', 'merge'] } },
          required: ['phase'],
        },
      }),
      $.tool.register({
        name: 'status',
        description: 'The timeline as text: every worker, QA and review row with status, pull request and elapsed time, and the run state.',
        isDeferred: false,
        inputSchema: { type: 'object', properties: {} },
      }),
      $.tool.register({
        name: 'cancel',
        description: 'Stops a running worker, QA or reviewer subagent by agent id, marks its row cancelled and closes its open pull request. Its worktree is kept for inspection until the run ends.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string' }, reason: { type: 'string' } },
          required: ['agentId'],
        },
      }),
      $.tool.register({
        name: 'finish',
        description:
          `Opens the final pull request from the run branch into the base branch with the given title and body, written to the configured pull request rules skill (${conf.conf['prs-skill']}). The run then watches its checks, merges it with a merge commit when green, prunes the worktrees and wakes you; failing checks or conflicts wake you instead.`,
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: `The merge commit title, to the ${conf.conf['commits-skill']} skill, e.g. "feat: add login to the CLI".` },
            body: { type: 'string', description: `The pull request body, to the ${conf.conf['prs-skill']} skill.` },
            abort: { type: 'boolean', description: 'true ends the run without a final pull request.' },
          },
        },
      }),
      $.agent.register({
        name: 'worker',
        description: 'dacapo worker: implements one planned task inside its own worktree and lands it through a pull request. Spawned by the dacapo tools only.',
        prompt: WORKER_SYSTEM,
        disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
      }),
      $.agent.register({
        name: 'qa',
        description: 'dacapo QA: uses the deliverable as the end user and scores a rubric. Spawned by the dacapo tools only.',
        prompt: QA_SYSTEM,
        disallowedTools: ['Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'],
        omitClaudeMd: true,
      }),
      $.agent.register({
        name: 'qa-collector',
        description: 'dacapo QA collector: uses the deliverable as the end user on a slice of the rubric and brings the evidence back to QA. Spawned by the dacapo QA subagent only.',
        prompt: COLLECTOR_SYSTEM,
        disallowedTools: ['Agent', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'],
        omitClaudeMd: true,
      }),
      $.agent.register({
        name: 'reviewer',
        description: 'dacapo reviewer: reads the run\'s change as an engineer and scores an engineering rubric. Spawned by the dacapo tools only.',
        prompt: REVIEW_SYSTEM,
        disallowedTools: ['Agent', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'],
      }),
      $.command.register({ name: 'dacapo-pane', description: 'Opens the dacapo timeline pane.' }),
      $.command.register({ name: 'dacapo-config', description: 'Shows the dacapo configuration in force and the files it was read from.' }),
    ])

    $.clock.every(TICK_MS, () => void tick())

    return next(e)
  })

  // ----- the orchestrator starts each agent itself (so the permission mode judges its own call); the run fills the call in -----

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const a = e as unknown as Args
    if (e.agentId !== undefined) {
      // an agent of the run starting another: only QA may, and only an evidence collector bound like itself
      const found = await rowFor(e.agentId)
      if (!found) return next(e)
      const { row, collector } = found
      if (collector) return { deny: 'dacapo QA collector: collectors never start agents; bring what you found back to QA in your final message.' }
      if (row.kind !== 'qa' || roleOf(row) !== 'qa') return { deny: `dacapo: ${row.kind === 'worker' ? 'a worker' : 'the reviewer'} never starts agents.` }
      if (str(a.subagent_type) !== COLLECTOR_AGENT) {
        return { deny: `dacapo QA: the only agent you may start is ${COLLECTOR_AGENT}: it collects evidence on a slice of the rubric, never opens source and never scores.` }
      }
      const cap = conf.conf['qa-collectors']
      if (cap <= 0) return { deny: 'dacapo QA: collectors are off (qa-collectors = 0); collect the evidence yourself.' }
      const live = liveCollectors(row).length
      if (live >= cap) return { deny: `dacapo QA: ${cap} collector${cap === 1 ? '' : 's'} may run at once (qa-collectors) and ${live} ${live === 1 ? 'is' : 'are'} running; wait for one to report before starting another.` }
      const slice = str(a.prompt).trim()
      if (!slice) return { deny: 'dacapo QA: the prompt must tell the collector its rubric ids, its instance and what is shared.' }
      const allowed = conf.conf.qa
      const model = allowed.includes(str(a.model)) ? str(a.model) : allowed[allowed.length - 1]!
      const prompt = `[dacapo worktree: ${row.worktree}]\n\n${collectorPrompt(row.worktree)}\n\n## Your slice, from QA\n\n${slice}\n\nStart now. Your working directory is the worktree above; write only under its .context/evidence folder.`
      // in the foreground: the Agent call blocks, so QA keeps its turn while a batch runs (several calls in one message still run at once);
      // a QA turn that ended to wait on a background collector would end the round without a report
      const ran = await next({ ...e, prompt, subagent_type: COLLECTOR_AGENT, model, run_in_background: false })
      const got = 'result' in ran && ran.result && typeof ran.result === 'object' ? (ran.result as { agentId?: unknown }).agentId : undefined
      if (typeof got === 'string') {
        const now = await io.now()
        await patchQa(row.id, r => ({ ...r, collectors: [...(r.collectors ?? []), { id: got, description: str(a.description).trim().slice(0, 80) || 'collector', at: now }] }))
      }
      return ran
    }
    const ask = ASK_LINE.exec(str(a.prompt))
    if (!ask) return next(e)
    const run = await currentRun()
    if (!run) return { deny: 'dacapo: no active run; call mcp__dacapo__start first' }
    const rows = await io.getRows()
    const kind = ask[1] as 'worker' | Role
    const key = ask[2]!
    // a worker is asked for by task id, a judge by `<round>-<judge round>`; the pending row's key is the task id or the round
    const wanted = kind === 'worker' ? pendingId('worker', run.iteration, key) : pendingId(kind, Number(key.split('-')[0]), key.split('-')[1] ?? '')
    const row = rows.find((r): r is WorkerRow | QaRow => r.kind === (kind === 'worker' ? 'worker' : 'qa') && r.id === wanted)
    if (!row) {
      const expected = rows.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && r.status === 'pending').map(r => (r.kind === 'worker' ? `worker ${r.taskId}` : `${roleOf(r)} ${r.iteration}-${r.round}`))
      return { deny: `dacapo: nothing pending for "${ask[0]!.trim()}"${expected.length ? `; pending: ${expected.join(', ')}` : ''}. Call ${tool(kind === 'worker' ? 'dispatch' : kind)} first.` }
    }
    const brief = row.kind === 'worker' ? await io.read(`${row.worktree}/.context/brief.md`) : roleOf(row) === 'review' ? reviewPrompt(row.worktree) : qaPrompt(row.worktree)
    const prompt = `[dacapo worktree: ${row.worktree}]\n\n${brief}\n\nStart now. Your working directory is the worktree above; every path you touch is under it.`
    const ran = await next({
      ...e,
      prompt,
      description: row.kind === 'worker' ? row.title : roundName(row),
      subagent_type: row.kind === 'worker' ? WORKER_AGENT : roleOf(row) === 'review' ? REVIEW_AGENT : QA_AGENT,
      model: row.model,
      run_in_background: true,
    })
    const got = 'result' in ran && ran.result && typeof ran.result === 'object' ? (ran.result as { agentId?: unknown }).agentId : undefined
    const agentId = typeof got === 'string' ? got : undefined
    const now = await io.now()
    if (agentId) {
      await io.setRows(list => list.map(r => (isAgentRow(r) && r.id === row.id ? { ...r, id: agentId, status: 'running', at: now, lastActivityAt: now } : r)))
    } else {
      const note = 'deny' in ran && ran.deny ? String(ran.deny) : 'isError' in ran && ran.isError ? String(ran.result ?? 'the Agent tool reported an error') : 'the Agent tool answered without an agent id'
      await patchRow(row.id, r => ({ ...r, note: `not started: ${note.slice(0, 300)}` }))
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'dacapo: the Agent call could not be prepared' }))

  on('agent.spawn', async ($, e, next) => {
    const line = WORKTREE_LINE.exec(e.prompt)
    if (!line || e.isTeammate) return next(e)
    return next({ ...e, cwd: line[1]! })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dacapo-config' }, async () => {
    const cwd = await io.cwd()
    const loaded = await readConf((await git.repoRoot(io, cwd)) ?? cwd)
    return { text: `dacapo configuration\n${describeConf(loaded)}\nEdit ~/.claude/dacapo.conf for every repository, or .dacapo.conf at this repository's root; see dacapo.conf in the plugin for the keys. commits-skill and prs-skill name the skills commits and pull requests follow; point them at your own to use your conventions. base-branch names the branch runs are cut from and merged into.` }
  })

  on('command.run', { command: 'dacapo-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Da capo', focus: true })
    await update($, uiAtom, ui => ({ ...ui, isBandHidden: false }))
    return { text: 'dacapo timeline opened.' }
  })

  // ----- prompts: the /dacapo:core prompt opens a run; every later prompt during a run is a row -----

  on('prompt.submit', async ($, e, next) => {
    const text = e.text
    if (ownPrompts.has(text) || text.includes(WAKE_PREFIX)) {
      ownPrompts.delete(text)
      await markDelivered(text)
      return next(e)
    }
    // only what the person typed is a row: not a subagent's hand-back, a notification or another session's message
    const isTyped = ['composer', 'bridge', 'sdk', 'channel'].includes(e.origin.kind) && !/^\s*<agent-message\b/.test(text)
    if (!isTyped) return next(e)
    const starts = /^\s*\/dacapo:core(?:\s+--(fast|balanced|deep)\b)?(\s|$)/.exec(text)
    let run = await currentRun()
    if (starts) {
      // the run has no heading yet: the prompt is the person's words, the title and overview come from `start` once the task is clear;
      // a level flag right after the command (`--deep`) sets the level now, so the pane shows it while the task is clarified
      const cwd = await io.cwd()
      await readConf((await git.repoRoot(io, cwd)) ?? cwd)
      run = await openRun('', conf.conf['base-branch'], undefined, (starts[1] as Level | undefined) ?? conf.conf.level)
      void $.ui.open({ id: PANE, title: 'Da capo' })
    }
    if (run) {
      const now = await $.clock.now()
      const row: UserRow = { kind: 'user', id: `user-${now}`, iteration: run.iteration, at: now, text }
      await update($, rowsAtom, rows => [...rows, row])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ----- the tools -----

  on('tool.call', { tool: 'mcp__dacapo__start' }, ($, e) => start(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__dispatch' }, ($, e) => dispatch(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__sync' }, () => sync()).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__qa' }, ($, e) => startJudge('qa', e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__review' }, ($, e) => startJudge('review', e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__cancel' }, ($, e) => cancel(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__finish' }, ($, e) => finish(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__phase' }, async ($, e) => {
    const phase = str((e as unknown as Args).phase) as Phase
    if (!PHASES.includes(phase)) return fail(`phase: one of ${PHASES.join(', ')}`)
    if (!(await currentRun())) return fail('phase: no active run')
    await setPhase(phase)
    return ok(`Phase: ${phase}.`)
  }).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__config' }, async () => ok(describeConf(conf))).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__status' }, async () => {
    const snap = await snapshot()
    return ok(statusText(snap))
  }).catch(crashed)

  // ----- guards: the orchestrator does not edit, merge or open pull requests; workers stay in their worktree; QA never reads source; the reviewer writes only its report -----

  on('tool.call', async ($, e, next) => {
    const run = await currentRun()
    if (!run) return next(e)
    const a = e as unknown as Args
    if (e.agentId === undefined) {
      if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        return { deny: `dacapo: the orchestrator does not change files; only worker subagents do, through ${tool('dispatch')}.` }
      }
      if (e.tool === 'Bash') {
        const cmd = str(a.command)
        if (/\bgit\s+(-C\s+\S+\s+)?(commit|merge|rebase|push|checkout|switch|reset|worktree|cherry-pick|am|apply|stash|branch\s+(-[dDmM]|--delete|--move))\b/.test(cmd)) {
          return { deny: 'dacapo: git history is changed only by the dacapo tools (sync, finish) and by worker subagents.' }
        }
        if (/\bgh\s+pr\s+(create|merge|close|ready|edit|reopen)\b/.test(cmd)) {
          return { deny: `dacapo: pull requests are opened and merged by the workers and by ${tool('finish')}, never by the orchestrator by hand.` }
        }
      }
      return next(e)
    }
    const found = await rowFor(e.agentId)
    if (!found) return next(e)
    const { row, collector } = found
    // a collector acting after its round ended must not revive the round
    if (!collector || !isTerminal(row)) await touch(row.id)
    if (row.kind === 'worker') {
      const target = str(a.file_path) || str(a.notebook_path)
      if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && target && !isUnder(target, row.worktree, row.worktree)) {
        return { deny: `dacapo: write only inside your worktree ${row.worktree}` }
      }
      return next(e)
    }
    const contextDir = `${row.worktree}/.context`
    if (roleOf(row) === 'review') {
      // the reviewer reads anything and writes one file
      if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        const target = str(a.file_path) || str(a.notebook_path)
        if (normalize(target, row.worktree) !== row.reportPath) return { deny: `dacapo reviewer: you never change the code; the only file you write is ${row.reportPath}` }
      }
      return next(e)
    }
    // QA and its collectors alike: the product, never the source; QA writes its report, a collector its evidence
    const who = collector ? 'dacapo QA collector' : 'dacapo QA'
    const evidenceDir = `${contextDir}/evidence`
    if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const target = str(a.file_path) || str(a.notebook_path)
      if (!isUnder(target, contextDir, row.worktree)) {
        return { deny: `${who}: you judge the deliverable as its user and never open source. Only ${contextDir} is readable or writable.` }
      }
      if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit') {
        if (collector && !isUnder(target, evidenceDir, row.worktree)) return { deny: `${who}: write only under ${evidenceDir}; QA writes the report.` }
        if (!collector && normalize(target, row.worktree) !== row.reportPath) return { deny: `${who}: the only file you write is ${row.reportPath}` }
      }
    }
    const name: string = e.tool
    if (name === 'Glob' || name === 'Grep') {
      const target = str(a.path) || row.worktree
      if (!isUnder(target, contextDir, row.worktree)) {
        return { deny: `${who}: searching the checkout is not allowed; use the product instead. Only ${contextDir} may be searched.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'dacapo: guard failed closed' }))

  // ----- activity and completion of the agents -----

  on('turn.step', async function* ($, e, next) {
    const run = await io.getRun()
    const active = !!run && (run.status === 'planning' || run.status === 'active' || run.status === 'merging')
    const found = active && e.agentId ? await rowFor(e.agentId) : undefined
    const row = found?.row
    if (!active || (e.agentId && !row)) return yield* next(e)
    // a collector's steps count toward its QA round; only the round's own agent acting again revives it
    if (row && isTerminal(row) && !found?.collector) await revive(row, await io.now())
    // one model step of a tracked agent (or of the orchestrator): collect its tool calls, text and usage, then store once
    const texts = new Map<number, string>()
    const tools = new Map<number, { name: string; json: string }>()
    let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null
    const stream = next(e)[Symbol.asyncIterator]()
    let r = await stream.next()
    while (!r.done) {
      const c = r.value
      if (c.kind === 'text') texts.set(c.index, (texts.get(c.index) ?? '') + c.text)
      else if (c.kind === 'tool') tools.set(c.index, { name: c.name, json: '' })
      else if (c.kind === 'input') {
        const t = tools.get(c.index)
        if (t) t.json += c.json
      } else if (c.kind === 'stop' && c.usage) {
        usage = { input: c.usage.input_tokens, output: c.usage.output_tokens, cacheRead: c.usage.cache_read_input_tokens, cacheWrite: c.usage.cache_creation_input_tokens }
      }
      yield c
      r = await stream.next()
    }
    const now = await io.now()
    if (row) {
      const entries: Activity[] = []
      for (const index of [...new Set([...texts.keys(), ...tools.keys()])].sort((a, b) => a - b)) {
        const text = texts.get(index)?.replace(/\s+/g, ' ').trim()
        if (text) entries.push({ at: now, kind: 'text', text: text.slice(0, 200) })
        const t = tools.get(index)
        if (t) entries.push({ at: now, kind: 'tool', text: `${t.name} ${shortArg(t.json)}`.trim() })
      }
      await patchRow(row.id, old =>
        old.kind === 'worker'
          ? { ...old, lastActivityAt: now, status: old.status === 'stale' ? 'running' : old.status, stats: grow(old.stats, usage, tools.size, entries, e.model) }
          : { ...old, lastActivityAt: now, status: old.status === 'stale' ? 'running' : old.status, stats: grow(old.stats, usage, tools.size, entries, e.model) },
      )
    } else {
      await io.setRun(cur => (cur ? { ...cur, orchestrator: { ...addUsage(cur.orchestrator, usage ?? {}), steps: cur.orchestrator.steps + 1, modelId: e.model } } : cur))
    }
    return r.value
  })

  on('turn.start', async ($, e, next) => {
    if (e.text.includes(WAKE_PREFIX)) await markDelivered(e.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const run = await currentRun()
      const text = e.answer.trim()
      if (run && text) {
        const now = await io.now()
        const row: OrchestratorRow = { kind: 'orchestrator', id: `orch-${now}`, iteration: run.iteration, at: now, text: text.slice(0, 4000) }
        await io.setRows(rows => [...rows, row])
      }
    }
    if (e.agentId) {
      const found = await rowFor(e.agentId)
      const row = found?.row
      if (found?.collector && row?.kind === 'qa') {
        // a collector ended: QA reads its answer itself and the round goes on; the run records how it ended, as it does for a worker
        const ended = e.agentId
        const now = await io.now()
        const failed = e.reason !== 'answer' || e.isAborted
        const said = COLLECTED_LINE.exec(e.answer)?.[1]?.toLowerCase()
        const outcome: Collector['outcome'] = failed || said === 'failed' ? 'failed' : said === 'collected with gaps' ? 'gaps' : 'collected'
        const note = failed ? `${e.reason}${e.reason === 'refusal' ? `: ${e.refusal.explanation ?? ''}` : ''}` : e.answer.replace(/\s+/g, ' ').trim().slice(0, 200)
        await patchQa(row.id, r => ({ ...r, collectors: (r.collectors ?? []).map(c => (c.id === ended ? { ...c, endedAt: now, outcome, note } : c)) }))
      } else if (row && !isTerminal(row)) {
        const now = await io.now()
        const failed = e.reason !== 'answer' || e.isAborted
        if (row.kind === 'worker') {
          const note = failed
            ? `${e.reason}${e.reason === 'refusal' ? `: ${e.refusal.explanation ?? ''}` : ''}`
            : e.answer.replace(/\s+/g, ' ').trim().slice(0, 400)
          // the worker's last line says how it ended; without one, its pull request decides later
          const said = STATUS_LINE.exec(e.answer)?.[1]?.toLowerCase()
          const outcome = said === 'failed' ? 'failed' : said === 'done with limitations' ? 'limited' : said === 'done' ? 'done' : undefined
          await patchRow(row.id, r =>
            r.kind === 'worker'
              ? { ...r, status: failed || outcome === 'failed' ? 'failed' : 'finished', endedAt: now, note, outcome }
              : { ...r, status: failed ? 'failed' : 'finished', endedAt: now, note },
          )
          // the wake-up carries the pull request state, so refresh it before the ticker wakes the orchestrator
          const run = await currentRun()
          if (run) await io.setRun(cur => (cur ? { ...cur, prsAt: 0 } : cur))
        } else {
          await patchQa(row.id, r => ({ ...r, endedAt: now, collect: { failure: failed ? `agent ended: ${e.reason}` : null } }))
        }
      }
    }
    return next(e)
  })

  // ----- drawing -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    return drawPane(els, { run, rows, ui }, actions, e.props.bodyColumns, { prices })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    const els = $.ui.resolve(e) as unknown as Els
    const tree = drawBand(els, { run, rows, ui }, actions, e.props.bodyColumns, e.props.maxRows, { prices })
    return tree ?? next(e)
  })
}
