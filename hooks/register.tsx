import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, AgentStats, Collector, Gh, OrchestratorRow, Phase, Pr, QaRow, Row, Run, UserRow, Wake, WorkerRow } from '../types'
import type { Loop, LoopLevel, LoopNode, LoopRef, Stage, Transition, ViewerFocus, ViewerState } from '../types/loops'
import { applyOps, loopDelete, loopMove, loopNew, loopRename, parseOp, saveDraft, setDefaultLoop, type Op } from './architect'
import { BRANCH_NAME, describeConf, loadConf, SHIPPED_COMMITS, SHIPPED_PRS, type Layer, type Loaded } from './conf'
import { ZERO, addUsage, parsePrices, type Price } from './cost'
import * as gh from './gh'
import * as git from './git'
import type { Io } from './io'
import { ID, countsOf, discardDraft, draftKey, draftsRoot, graphFromJson, listLoops, nodeOrder, openDraft, readDraft, readLoop, roots, validateLoop, withDefaultTransitions, writeDraft, type LoopFs, type Roots } from './loops'
import { fromD2 } from './loopd2'
import { transitionId } from './looplayout'
import { PHASES, currentStages, drawBand, drawPane, elapsed, hhmm, isAgentRow, levelOf, prText, prsOf, roleOf, roundName, scoreLine, spend, spendText, statusWord, type Actions, type Els, type Snapshot } from './pane'
import { COLLECTS_SUFFIX, LANDS_SUFFIX, SCORES_SUFFIX, qaBrief, reviewBrief, workerBrief } from './prompts'
import { validateReport, validateRubric, type RubricItem } from './report'
import { LOOPS_PANE, drawViewer, focusText, viewerText, type ViewerActions } from './viewer'

const PANE = 'dacapo'
/** The agent types of rows saved before loops, which name no node. */
const LEGACY_AGENT = { worker: 'dacapo:worker', qa: 'dacapo:qa', review: 'dacapo:reviewer', collector: 'dacapo:qa-collector' } as const
const agentType = (node: string) => `dacapo:${node}`
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

const viewerAtom = atom({ plugin: 'dacapo', key: 'viewer' } as const, { screen: 'library', library: [], defaultLoop: 'core', view: { folded: false, tab: 'canvas' } })

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
/** Prompts this module queued itself, so `prompt.submit` does not log them as the person's. */
const ownPrompts = new Set<string>()
/** Rubrics by judge (`<node>-<iteration>-<round>`), for validation; the run folder holds the copy that survives a reload. */
const rubrics = new Map<string, RubricItem[]>()
/** The node a judge row runs as; a row saved before loops is named by its role. */
const judgeNode = (row: QaRow) => row.node ?? roleOf(row)
/** How a judge is spoken of to the agents it starts and in refusals: QA for the shipped `qa` node, else its node id. */
const judgeName = (row: QaRow) => (judgeNode(row) === 'qa' ? 'QA' : judgeNode(row))
/** The key of a judge row's rubric, report and wake-up: its node, iteration and round. */
const judgeKey = (row: QaRow) => `${judgeNode(row)}-${row.iteration}-${row.round}`

// ---------- the loop ----------

/** The file system the loop functions work over: `$.fs`, and a remove that only ever reaches a loops or drafts folder. */
let loopFs: LoopFs
/** The loops folder of each level, as the session found them at start. */
let loopRoots: Roots = { plugin: null, user: null, project: null }
/** The user's drafts folder, beside the user's loops. */
let loopDrafts = ''
/** The loop the session resolved at start from the `loop` conf key; null when it could not be loaded (see `activeProblem`). */
let active: { ref: LoopRef; loop: Loop } | null = null
let activeProblem = ''
/** The loop the /dacapo:core prompt asked for when it could not be loaded: `start` and `config` name it and its problems. */
let asked: string | null = null
/** Loops read this session, by name, so a run's nodes are at hand once its loop was read. */
const loaded = new Map<string, { ref: LoopRef; loop: Loop }>()
/** Agent types this session registered, by node id: the loop that registered each, and the spec as JSON. */
const agents = new Map<string, { loop: string; spec: string }>()
type AgentSpec = { name: string; description: string; prompt: string; disallowedTools: string[]; skills: string[]; omitClaudeMd?: true }
/** Registers an agent type; set at session start over `$.agent.register`. */
let registerAgent: (spec: AgentSpec) => Promise<unknown> = async () => undefined
/** Registers the dispatch tool again with the model enum of a loop's lands node; set at session start. */
let registerDispatch: (loop: Loop | null) => Promise<unknown> = async () => undefined
/** The loop the dispatch tool's schema was last registered for. */
let dispatchFor: string | null = null

type Resolved = { ok: true; ref: LoopRef; loop: Loop } | { ok: false; problem: string }

/**
 * Finds a loop by name (project over user over plugin), reads it, and checks it: the loop's own rules, and every
 * node's models drawn from the configured ones (`workers`, `qa`, `review`). The loop comes back with its default
 * transitions added.
 */
async function resolveLoop(name: string): Promise<Resolved> {
  if (!ID.test(name)) return { ok: false, problem: `"${name}" is not a loop name: lowercase letters, digits and inner hyphens` }
  let refs: LoopRef[]
  try {
    refs = await listLoops(loopFs, loopRoots)
  } catch (error) {
    return { ok: false, problem: `the loops could not be listed: ${String(error)}` }
  }
  const ref = refs.find(r => r.name === name && !r.shadowedBy)
  if (!ref) {
    const names = [...new Set(refs.map(r => r.name))]
    return { ok: false, problem: `there is no loop "${name}"; the loops available: ${names.length > 0 ? names.join(', ') : 'none'}` }
  }
  let read: Awaited<ReturnType<typeof readLoop>>
  try {
    read = await readLoop(loopFs, ref.dir)
  } catch (error) {
    return { ok: false, problem: `the loop "${name}" at ${ref.dir} could not be read: ${String(error)}` }
  }
  const problems = read.problems.length > 0 ? read.problems : validateLoop(read.loop)
  const universe = [...new Set([...conf.conf.workers, ...conf.conf.qa, ...conf.conf.review])]
  for (const n of Object.values(read.loop.nodes)) {
    const outside = n.models.filter(m => !universe.includes(m))
    if (outside.length > 0) problems.push({ path: `nodes.${n.id}.models`, message: `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among the configured models (${universe.join(', ')}; the workers, qa and review keys)` })
  }
  if (problems.length > 0) {
    return { ok: false, problem: `the loop "${name}" (${ref.level}, ${ref.dir}) cannot run:\n${problems.map(p => `- ${p.path}: ${p.message}`).join('\n')}` }
  }
  const loop: Loop = { ...withDefaultTransitions(read.loop), nodes: read.loop.nodes }
  loaded.set(name, { ref, loop })
  return { ok: true, ref, loop }
}

/** The whole loop a run walks, read again when this session has not read it yet; null for a run without a loop. */
async function loopOf(run: Run): Promise<Loop | null> {
  if (!run.loop) return null
  const held = loaded.get(run.loop.name)
  if (held) return held.loop
  const r = await resolveLoop(run.loop.name)
  return r.ok ? r.loop : null
}

/** The loop as the run keeps it: its name, level, and steps of stage ids and summaries. */
const runLoopOf = (r: { ref: LoopRef; loop: Loop }): NonNullable<Run['loop']> => ({
  name: r.ref.name,
  level: r.ref.level,
  steps: r.loop.steps.map(s => ({ stages: s.stages.map(st => ({ id: st.id, summary: st.summary })) })),
})

/** Where a node works: its stage and the index of the step holding it; undefined for a node on call or a helper. */
function placeOf(loop: Loop, id: string): { step: number; stage: Stage } | undefined {
  for (let step = 0; step < loop.steps.length; step += 1) {
    const stage = loop.steps[step]!.stages.find(st => st.nodes.includes(id))
    if (stage) return { step, stage }
  }
  return undefined
}
const stepOfStage = (loop: Loop, id: string): number => loop.steps.findIndex(s => s.stages.some(st => st.id === id))
const nodesIn = (loop: Loop, stageId: string): LoopNode[] =>
  loop.steps.flatMap(s => s.stages).find(st => st.id === stageId)?.nodes.map(id => loop.nodes[id]).filter((n): n is LoopNode => !!n) ?? []
/** A judge that uses the product as its end user (QA), rather than reading the change (a reviewer). */
const usesProduct = (n: LoopNode) => (n.categories ?? []).some(c => c === 'core' || c === 'ui-ux')
/** The collects node a judge hands slices to, if any. */
const collectsOf = (loop: Loop, judge: string): LoopNode | undefined =>
  loop.handovers.map(h => (h.from === judge ? loop.nodes[h.to] : undefined)).find((n): n is LoopNode => n?.contract === 'collects')
/** How many collectors a judge may run at once: its node's `collectors`, else the `qa-collectors` conf key. */
const collectorCap = (n: LoopNode) => n.collectors ?? conf.conf['qa-collectors']
/** The scores nodes of a loop, in step order. */
const judgesOf = (loop: Loop): LoopNode[] =>
  loop.steps.flatMap(s => s.stages.flatMap(st => st.nodes)).map(id => loop.nodes[id]).filter((n): n is LoopNode => n?.contract === 'scores')
const forwardFrom = (loop: Loop, from: string): Transition | undefined => loop.transitions.find(t => t.from === from && !t.back)
/** The stage whose forward transition leads to the exit: where the run integrates (`merge` in the shipped loops). */
const exitStage = (loop: Loop): string | undefined => loop.transitions.find(t => !t.back && t.to.includes('exit') && t.from !== 'entry')?.from
/** The last stage without nodes before the first step holding a lands node: where `start` puts the run (`plan` in the shipped loops). */
function planStage(loop: Loop): string | undefined {
  const first = loop.steps.findIndex(s => s.stages.some(st => st.nodes.some(id => loop.nodes[id]?.contract === 'lands')))
  if (first <= 0) return undefined
  const before = loop.steps[first - 1]!.stages
  return before.length === 1 && before[0]!.nodes.length === 0 ? before[0]!.id : undefined
}

const CONTRACT_WORDS: Record<LoopNode['contract'], string> = {
  lands: 'lands its own work through a pull request and reports how it went',
  scores: 'scores a rubric and writes a report the run collects',
  collects: 'gathers evidence on a slice of a rubric for its judge and never scores',
  none: 'answers when the orchestrator asks it',
}

/** The agent type of a node: its role and the contract's suffix as the system prompt, its skills, its denied tools. */
function agentSpec(loopName: string, node: LoopNode): AgentSpec {
  const suffix = node.contract === 'lands' ? LANDS_SUFFIX : node.contract === 'scores' ? SCORES_SUFFIX(node.categories ?? []) : node.contract === 'collects' ? COLLECTS_SUFFIX : ''
  return {
    name: node.id,
    description: `dacapo ${node.id} of the loop ${loopName}: ${node.summary}; ${CONTRACT_WORDS[node.contract]}. Spawned through the dacapo tools only.`,
    prompt: [node.role.trim(), suffix].filter(Boolean).join('\n\n'),
    disallowedTools: [...node.tools.deny],
    skills: [...node.skills],
    ...(node.contract === 'scores' || node.contract === 'collects' ? { omitClaudeMd: true as const } : {}),
  }
}

/**
 * Registers one agent type per node of the loop other than entry and exit, unless this session already holds it. A node
 * id another loop registered with a different role is refused: a session holds one role per agent type, so the run
 * of the other loop would lose its agent. Returns the agent types registered now.
 */
async function ensureAgents(name: string, loop: Loop): Promise<{ problem?: string; added: string[] }> {
  const specs = Object.values(loop.nodes)
    .filter(n => n.type !== 'entry' && n.type !== 'exit')
    .map(node => ({ node, spec: agentSpec(name, node) }))
  const clashes = specs.filter(({ node, spec }) => {
    const held = agents.get(node.id)
    return !!held && held.loop !== name && (JSON.parse(held.spec) as AgentSpec).prompt !== spec.prompt
  })
  if (clashes.length > 0) {
    const owner = agents.get(clashes[0]!.node.id)!.loop
    const names = clashes.map(c => agentType(c.node.id)).join(', ')
    return {
      problem: `the agent type${clashes.length === 1 ? '' : 's'} ${names} ${clashes.length === 1 ? 'is' : 'are'} registered in this session by the loop "${owner}" with a different role, and a session holds one role per agent type. Ask the user to begin a new session with \`/dacapo:core --loop ${name} <task>\` to run this loop.`,
      added: [],
    }
  }
  const added: string[] = []
  for (const { node, spec } of specs) {
    const text = JSON.stringify(spec)
    if (agents.get(node.id)?.spec === text) continue
    await registerAgent(spec)
    agents.set(node.id, { loop: name, spec: text })
    added.push(agentType(node.id))
  }
  return { added }
}

/** Marks the run's stage; `activeStages` names the stages of its step with a live agent when several run side by side. */
async function markStage(stage: string, activeStages: string[] = []) {
  await io.setRun(run => (run ? { ...run, stage, activeStages, ...((PHASES as readonly string[]).includes(stage) ? { phase: stage as Phase } : {}) } : run))
}

/** The words that send the orchestrator to `finish`, with what it passes. */
const finishWords = (run: Run) =>
  `call ${tool('finish')} with the final pull request's title and body (to the ${conf.conf['prs-skill']} skill) to open it from ${run.branch} into ${run.baseBranch}`

/** What the orchestrator does once the work of the stage `from` is in, by the loop's forward transition out of it. */
function nextMove(loop: Loop, from: string, run: Run): string {
  const t = forwardFrom(loop, from)
  if (!t || t.to.includes('exit')) return finishWords(run)
  const judges = t.to.flatMap(id => nodesIn(loop, id)).filter(n => n.contract === 'scores')
  if (judges.length > 0) {
    const names = judges.map(n => `"${n.id}"`).join(' and ')
    return judges.length === 1 ? `call ${tool('judge')} with node ${names}` : `call ${tool('judge')} with node ${names}, one call each, then make their Agent calls in one message`
  }
  if (t.to.length === 1 && nodesIn(loop, t.to[0]!).length === 0) {
    if (forwardFrom(loop, t.to[0]!)?.to.includes('exit')) return finishWords(run)
    return `call ${tool('stage')} with "${t.to[0]}" and work through it as the loop says`
  }
  return `go on to ${t.to.join(' and ')} as the loop's transitions say`
}

/** The judges to run again after a reconciliation or repair, in step order, as a phrase; empty for a loop without judges. */
function judgeAgain(loop: Loop | null): string {
  const judges = loop ? judgesOf(loop) : []
  if (judges.length === 0) return ''
  return `run ${tool('judge')} once more for ${judges.map(n => `"${n.id}"`).join(', then ')} since a conflict resolution can break things, and `
}

/** The loop as text, for `config`: where it is, its steps, nodes, transitions and handovers, and the entry's role. */
function loopText(r: { ref: LoopRef; loop: Loop }): string[] {
  const { ref, loop } = r
  const onCall = Object.entries(loop.onCall)
  const placeWords = (id: string): string => {
    const p = placeOf(loop, id)
    if (p) return `works in ${p.stage.id}`
    if (loop.onCall[id]) return 'on call'
    const owner = onCall.find(([, helpers]) => helpers.includes(id))
    return owner ? `a helper of ${owner[0]}` : 'no place'
  }
  const nodeLine = (n: LoopNode): string => {
    const parts = [`${n.type}, contract ${n.contract}`]
    if (n.models.length > 0) parts.push(`models ${n.models.join(', ')}`)
    if (n.skills.length > 0) parts.push(`skills ${n.skills.join(', ')}`)
    if (n.categories) parts.push(`categories ${n.categories.join(', ')}`)
    if (n.contract === 'scores') {
      const helper = collectsOf(loop, n.id)
      parts.push(helper ? `up to ${collectorCap(n)} ${agentType(helper.id)} at once` : 'no collectors')
    }
    if (n.tools.deny.length > 0) parts.push(`denied ${n.tools.deny.join(', ')}`)
    const kind = n.type === 'entry' ? 'you' : n.type === 'exit' ? 'the end' : `agent type ${agentType(n.id)}, ${placeWords(n.id)}`
    return `- ${n.id}: ${n.summary} (${kind}). ${parts.join('; ')}.`
  }
  const entry = loop.nodes[loop.entry]
  return [
    `Loop: ${ref.name} (${ref.level} level, ${ref.dir})`,
    loop.description,
    'Steps, in order; stages in one step run side by side:',
    ...loop.steps.map((s, i) => `${i + 1}. ${s.stages.map(st => `${st.id}: ${st.summary} (${st.nodes.length > 0 ? st.nodes.join(', ') : 'you alone'})`).join(' ∥ ')}`),
    `On call: ${onCall.length > 0 ? onCall.map(([k, v]) => `${k}${v.length > 0 ? ` (helpers ${v.join(', ')})` : ''}`).join(', ') : 'none'}`,
    'Nodes:',
    ...Object.values(loop.nodes).map(nodeLine),
    'Transitions:',
    ...loop.transitions.map(t => `- ${t.from} → ${t.to.join(' ∥ ')}${t.back ? ' (back)' : ''}${t.label ? `: ${t.label}` : ''}${t.when ? `. When ${t.when.replace(/\.$/, '')}` : ''}${t.then ? `. Then ${t.then.replace(/\.$/, '')}` : ''}`),
    'Handovers:',
    ...(loop.handovers.length > 0 ? loop.handovers.map(h => `- ${h.from} → ${h.to}: ${h.label}. ${h.spec}`) : ['- none']),
    '',
    '## Your role',
    '',
    entry?.role.trim() || 'The loop gives its entry node no role text.',
  ]
}

/** The configuration in force and the loop a run would walk now, for the config tool and the command. */
async function configText(): Promise<string> {
  const run = await currentRun()
  const name = run?.loop?.name ?? asked ?? conf.conf.loop
  const r = await resolveLoop(name)
  const head = [describeConf(conf), '']
  if (!r.ok) return [...head, `Loop: "${name}" cannot be used: ${r.problem}`, `No run can start on it until it is fixed or another loop is named (\`loop\` of ${tool('start')}, or the loop conf key).`].join('\n')
  return [...head, ...loopText(r)].join('\n')
}
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
/** The id of a row until its Agent call started it: a worker's by round and task, a judge's by node, round and judge round, an asked node's by node and count. */
const pendingWorker = (iteration: number, taskId: string) => `pending-worker-${iteration}-${taskId}`
const pendingJudge = (node: string, iteration: number, round: number) => `pending-judge-${node}-${iteration}-${round}`
const pendingAsk = (node: string, n: number) => `pending-ask-${node}-${n}`
/** The first line of every prompt the Agent hook hands an agent of the run; the spawn hook reads the worktree off it. */
const WORKTREE_LINE = /^\[dacapo worktree: (.+)\]$/m
/** The prompts the tools' replies list for the Agent calls: `dacapo worker <id>`, `dacapo judge <node> <round>-<n>`, `dacapo ask <node> <n>`. */
const CALL_LINE = /^\s*dacapo (?:worker (\S+)|judge (\S+) (\d+)-(\d+)|ask (\S+) (\d+))\s*$/
/** A worker row of a node asked with `ask`: no branch, no pull request, its answer is its Agent result. */
const isAsk = (r: Row): boolean => r.kind === 'worker' && r.contract === 'none'
/** A worker row that lands through a pull request: every worker but an asked node. */
const isLanding = (r: Row): r is WorkerRow => r.kind === 'worker' && r.contract !== 'none'
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

/** Opens a run; with a loop, the run walks its steps and stands on the first stage of the first step. */
async function openRun(task: string, baseBranch: string, loop?: { ref: LoopRef; loop: Loop }): Promise<Run> {
  const cwd = await io.cwd()
  const root = (await git.repoRoot(io, cwd)) ?? cwd
  const now = await io.now()
  const id = `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${slug(task || 'run').slice(0, 24)}`
  const steps = loop ? runLoopOf(loop) : undefined
  const first = steps?.steps[0]?.stages[0]?.id
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
    runDir: `${root}/.workspaces/.dacapo/${id}`,
    phase: first && (PHASES as readonly string[]).includes(first) ? (first as Phase) : 'clarify',
    ...(steps ? { loop: steps, stage: first, activeStages: [] } : {}),
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
  const heads = new Set<string>([run.branch, ...rows.filter(isLanding).map(r => r.branch)])
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
  if (!run) return `No dacapo run.${activeProblem ? ` The configured loop cannot run: ${activeProblem}` : ''}`
  const lines = [
    `Run ${run.id}${run.task ? ` (${run.task.replace(/\s+/g, ' ')})` : ' (task not yet named; call start when it is clear)'}: ${run.status}, round ${run.iteration}, branch=${run.branch || '(not started)'}, base=${run.baseBranch}`,
  ]
  const total = spendText(spend(rows.filter(isAgentRow), prices, run.orchestrator))
  const stages = currentStages(run)
  const where = run.loop
    ? `loop ${run.loop.name} (${run.loop.level}), stage${stages.length > 1 ? 's' : ''} ${stages.join(' ∥ ')}`
    : `no loop yet${asked ? ` (asked for "${asked}", which could not be loaded; see ${tool('config')})` : ''}, level ${levelOf(run)}, phase ${run.phase}`
  lines[0] += `, ${where}${total ? `, ${total}` : ''}`
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
      else if (isAsk(row)) {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        lines.push(`  ${t} ask ${row.node} [${row.id}] ${statusWord[row.status]} (${span}${row.model ? `, ${row.model}` : ''})${row.note ? `: ${row.note.slice(0, 200)}` : ''}`)
      } else if (row.kind === 'worker') {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        const pr = latestPr(run, row.branch)
        lines.push(
          `  ${t} ${row.node && row.node !== 'worker' ? `${row.node} ` : 'worker '}${row.taskId} [${row.id}] ${statusWord[row.status]}${row.outcome === 'limited' ? ' with limitations' : ''}${row.restarts ? ` (restarted ${row.restarts}x)` : ''} (${span}, ${row.model}, ${row.branch}${row.isResumed ? ', resumed' : ''}) PR: ${pr ? prText(pr) : 'none'}${row.note ? `: ${row.note.slice(0, 200)}` : ''}`,
        )
      } else {
        const span = elapsed(row.at, row.endedAt ?? ui.tick)
        const collectors = row.collectors?.length ? `, ${collectorsText(row)}` : ''
        lines.push(`  ${t} ${roundName(row)}${row.node ? ` (${row.node})` : ''} [${row.id}] ${statusWord[row.status]} (${span}${collectors}): ${scoreLine(row)}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------- tool handlers ----------

async function start(a: Args) {
  const task = str(a.task).trim()
  if (!task) return fail('start: "task" is required')
  const overview = str(a.overview).trim() || undefined
  const baseBranch = str(a.baseBranch).trim() || conf.conf['base-branch']
  const wanted = str(a.branch).trim() || slug(task)
  if (!BRANCH_NAME.test(wanted) || wanted.includes('--') || wanted === baseBranch) {
    return fail(`start: "branch" must be a lowercase git branch name without "--" and different from ${baseBranch}; got ${JSON.stringify(wanted)}`)
  }
  let run = await currentRun()
  const name = str(a.loop).trim() || run?.loop?.name || asked || conf.conf.loop
  // the loop is fixed once work can exist: a start after setup keeps it
  if (run?.worktree && run.loop && name !== run.loop.name) return fail(`start: the run walks the loop "${run.loop.name}" and a loop is never changed mid-run`)
  const resolved = await resolveLoop(name)
  if (!resolved.ok) return fail(`start: ${resolved.problem}`)
  const registered = await ensureAgents(name, resolved.loop)
  if (registered.problem) return fail(`start: ${registered.problem}`)
  if (dispatchFor !== name) await registerDispatch(resolved.loop).catch(() => undefined)
  asked = null
  if (!run) run = await openRun(task, baseBranch, resolved)
  const loopInfo = runLoopOf(resolved)
  const sameLoop = run.loop?.name === loopInfo.name && !!run.stage
  const named: Run = {
    ...run,
    task,
    overview: overview ?? run.overview,
    baseBranch: run.worktree ? run.baseBranch : baseBranch,
    loop: loopInfo,
    stage: sameLoop ? run.stage : loopInfo.steps[0]?.stages[0]?.id,
    activeStages: sameLoop ? run.activeStages : [],
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
  // start marks the stage the run plans in: the last stage without nodes before the first lands node's step
  const loop = resolved.loop
  const plan = planStage(loop)
  if (plan && stepOfStage(loop, (await io.getRun())?.stage ?? '') < stepOfStage(loop, plan)) await markStage(plan)
  void io.openPane()
  const repo = run.gh?.ok ? run.gh.repo : 'GitHub'
  const nodes = Object.values(loop.nodes).filter(n => n.type !== 'entry' && n.type !== 'exit')
  const landers = nodes.filter(n => n.contract === 'lands')
  const nodeWords = (n: LoopNode) => {
    const helper = n.contract === 'scores' ? collectsOf(loop, n.id) : undefined
    return `${n.id} (${n.contract}${n.models.length > 0 ? `; ${n.models.join(', ')}` : ''}${helper && collectorCap(n) > 0 ? `; up to ${collectorCap(n)} ${agentType(helper.id)} at once, so the harness must say what the product can share between testers` : ''})`
  }
  return ok(
    [
      `Run ${run.id} ready on ${repo} (${run.root}).`,
      ...notes.map(n => `- ${n}`),
      `- every worker branches from "${run.branch}" and lands through a pull request into it; the final pull request goes from "${run.branch}" into "${run.baseBranch}"`,
      `- run folder ${run.runDir}`,
      `- loop ${name} (${resolved.ref.level}): ${loopInfo.steps.map(s => s.stages.map(st => st.id).join(' ∥ ')).join(' → ')}`,
      `- nodes: ${nodes.length > 0 ? nodes.map(nodeWords).join('; ') : 'none'} (the first model of each is the strong tier and the default, the last the fast tier)`,
      ...(registered.added.length > 0 ? [`- agent types ${registered.added.join(', ')} registered now; the Agent tool takes them from your next turn, so end this turn before you start them`] : []),
      `- rules: commits follow the ${conf.conf['commits-skill']} skill, pull requests the ${conf.conf['prs-skill']} skill; workers load them from their brief, and you load ${conf.conf['prs-skill']} before writing the final pull request`,
      landers.length > 0 ? `Plan the work, then call ${tool('dispatch')}.` : 'Plan the work, then follow the loop: its stages say what comes next.',
    ].join('\n'),
  )
}

async function markStageTool(a: Args) {
  const id = str(a.stage).trim()
  const run = await currentRun()
  if (!run) return fail('stage: no active run')
  if (!run.loop) return fail(`stage: the run has no loop yet; call ${tool('start')} first`)
  const ids = run.loop.steps.flatMap(s => s.stages.map(st => st.id))
  if (!ids.includes(id)) return fail(`stage: "${id}" is not a stage of the loop "${run.loop.name}"; its stages: ${ids.join(', ')}`)
  await markStage(id)
  return ok(`Stage: ${id}.`)
}

/** Whether a round already holds work: a worker or judge of it, not counting a node asked with `ask`. */
const hadWork = (rows: Row[], iteration: number) => rows.some(r => isAgentRow(r) && !isAsk(r) && r.iteration === iteration)

const COMMIT_TITLE = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|revert)!?: \S/
/** Whether the shipped rules skills are the configured ones; only then does the mod check the rules they state itself. */
const shippedCommits = () => conf.conf['commits-skill'] === SHIPPED_COMMITS
const shippedPrs = () => conf.conf['prs-skill'] === SHIPPED_PRS

async function dispatch(a: Args) {
  let run = await currentRun()
  if (!run) return fail(`dispatch: no active run; call ${tool('start')} first`)
  if (!run.worktree) return fail(`dispatch: the run is not set up; call ${tool('start')} first`)
  const loop = await loopOf(run)
  if (!loop || !run.loop) return fail(`dispatch: the run's loop could not be read; call ${tool('config')} to see why`)
  const landers = Object.values(loop.nodes).filter(n => n.contract === 'lands')
  const nodeId = str(a.node).trim()
  let node: LoopNode
  if (nodeId) {
    const found = loop.nodes[nodeId]
    if (!found || found.contract !== 'lands') return fail(`dispatch: "${nodeId}" is not a lands node of the loop "${run.loop.name}"; its lands nodes: ${landers.map(n => n.id).join(', ') || 'none'}`)
    node = found
  } else if (landers.length === 1) {
    node = landers[0]!
  } else {
    return fail(landers.length === 0 ? `dispatch: the loop "${run.loop.name}" has no lands node, so it dispatches no workers` : `dispatch: the loop "${run.loop.name}" has several lands nodes (${landers.map(n => n.id).join(', ')}); name one with "node"`)
  }
  const place = placeOf(loop, node.id)
  const tasks = Array.isArray(a.tasks) ? (a.tasks as Args[]) : []
  if (tasks.length === 0) return fail('dispatch: "tasks" must hold at least one task')
  const rows0 = await io.getRows()
  const iterationTitle = str(a.title).trim() || `Round ${run.iteration + (hadWork(rows0, run.iteration) ? 1 : 0)}`
  const overview = str(a.overview).trim()
  const ids = new Set<string>()
  for (const t of tasks) {
    const id = str(t.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail(`dispatch: task id ${JSON.stringify(t.id)} must be a kebab-case slug`)
    if (ids.has(id)) return fail(`dispatch: task id "${id}" repeats`)
    ids.add(id)
    if (!str(t.title).trim() || !str(t.prompt).trim()) return fail(`dispatch: task "${id}" needs a title and a prompt`)
    if (typeof t.model !== 'string' || !node.models.includes(t.model)) return fail(`dispatch: task "${id}" model must be one of ${node.models.join(', ')} (the models of the node "${node.id}"; see ${tool('config')})`)
    const commit = str(t.commit).trim()
    if (!commit) return fail(`dispatch: task "${id}" needs a commit title`)
    if (shippedCommits() && (!COMMIT_TITLE.test(commit) || /^\w+\(/.test(commit) || commit.length > 72)) {
      return fail(`dispatch: task "${id}" commit title "${commit}" must be "<type>: <description>" with an allowed type, no scope, at most 72 characters (the ${SHIPPED_COMMITS} skill)`)
    }
    if (t.merge !== undefined && t.merge !== 'squash' && t.merge !== 'merge') return fail(`dispatch: task "${id}" merge must be "squash" or "merge"`)
    if (t.resume === true && !rows0.some(r => isLanding(r) && r.taskId === id)) return fail(`dispatch: task "${id}" has no earlier worker to resume`)
  }

  const iteration = run.iteration
  const unfinished = rows0.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && !isTerminal(r))
  if (unfinished.length > 0) return fail(`dispatch: ${unfinished.length} agent(s) still running; wait for the wake-up prompt or cancel them first`)
  run = { ...run, iteration: hadWork(rows0, iteration) ? iteration + 1 : iteration, status: 'active' }
  const startedAt = await io.now()
  const info = { n: run.iteration, title: iterationTitle, overview: overview || undefined, startedAt }
  run = { ...run, iterations: [...run.iterations.filter(i => i.n !== info.n), info] }
  if (place) run = { ...run, stage: place.stage.id, activeStages: [place.stage.id], ...((PHASES as readonly string[]).includes(place.stage.id) ? { phase: place.stage.id as Phase } : {}) }
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
        const prior = rows0.filter((r): r is WorkerRow => isLanding(r) && r.taskId === taskId).sort((x, y) => y.at - x.at)[0]!
        if (!(await io.exists(prior.worktree))) throw new Error(`the worktree of the earlier worker (${prior.worktree}) is gone; dispatch the task afresh`)
        branch = prior.branch
        path = prior.worktree
        if (t.merge === undefined) mergeMethod = prior.mergeMethod
        const pr = latestPr(withPrs, branch)
        resumed = { pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : undefined }
      } else {
        let wanted = `${active.branch}--${slug(taskId)}`
        if (rows0.some(r => isLanding(r) && r.branch.startsWith(wanted))) wanted = `${wanted}-${active.iteration}`
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
        id: pendingWorker(active.iteration, taskId),
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
        node: node.id,
        contract: 'lands',
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
          ...started.map(s => `- Agent({ subagent_type: "${agentType(node.id)}", description: "${s.title.replace(/"/g, "'")}", prompt: "dacapo worker ${s.taskId}" })`),
          `Then end your turn. Each worker opens a pull request against ${active.branch}, waits for its checks, merges it and only then finishes. A prompt wakes you when every worker has ended, or when one goes stale.`,
        ]
      : ['Nothing to start.']),
  ].join('\n')
  return ok(text)
}

/** What the orchestrator calls once a round's work has landed and is synced: the move out of the lands node's stage. */
async function afterLanding(run: Run, node?: string): Promise<string> {
  const loop = await loopOf(run)
  if (!loop) return finishWords(run)
  const lands = node ? loop.nodes[node] : Object.values(loop.nodes).find(n => n.contract === 'lands')
  const place = lands ? placeOf(loop, lands.id) : undefined
  return place ? nextMove(loop, place.stage.id, run) : finishWords(run)
}

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
  const workers = rows.filter((r): r is WorkerRow => isLanding(r) && isTerminal(r) && r.status !== 'merged').sort((a, b) => a.at - b.at)
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
  const next = landed.length > 0 && waiting.length === 0 ? `Next: ${await afterLanding(fresh, workers[0]?.node)}.` : ''
  const text = [
    `Synced ${fresh.branch}: ${landed.length} pull request(s) landed since the last sync.`,
    ...landed.map(m => `- ${m}`),
    pulled.kind === 'pulled' ? `${fresh.worktree} fast-forwarded by ${pulled.commits} commit(s).` : `${fresh.branch} at ${fresh.worktree} was not fast-forwarded: ${pulled.message}`,
    ...(waiting.length > 0 ? ['Finished without landing:', ...waiting.map(s => `- ${s}`)] : []),
    ...(kept.length > 0 ? ['Not landed:', ...kept.map(s => `- ${s}`)] : []),
    next,
  ]
    .filter(Boolean)
    .join('\n')
  return ok(text)
}

const judgePrompt = (row: QaRow) =>
  `Read ${row.worktree}/.context/${judgeNode(row)}-brief.md and ${row.worktree}/.context/rubric.json, then judge as your role says and write the report where the brief says. Your working directory is ${row.worktree}.`
const collectorPrompt = (row: QaRow) =>
  `Read ${row.worktree}/.context/${judgeNode(row)}-brief.md (what was built, and the harness: how to run and use the product) and ${row.worktree}/.context/rubric.json (the items; your slice is below). Save screenshots and notes only under ${row.worktree}/.context/evidence/.`

/**
 * Starts a scores node on the integrated state in a fresh checkout of the run branch. A judge waits for every agent of
 * an earlier step of the round, for the round's landed work to be synced, and for each judge of an earlier step to
 * have reported on the round; judges whose stages share a step start alongside each other.
 */
async function judge(a: Args) {
  const run = await currentRun()
  if (!run) return fail('judge: no active run')
  if (!run.worktree) return fail(`judge: nothing was dispatched yet; call ${tool('start')} first`)
  const loop = await loopOf(run)
  if (!loop || !run.loop) return fail(`judge: the run's loop could not be read; call ${tool('config')} to see why`)
  const judges = judgesOf(loop)
  const nodeId = str(a.node).trim()
  const node = loop.nodes[nodeId]
  if (!node || node.contract !== 'scores') {
    return fail(`judge: "${nodeId}" is not a scores node of the loop "${run.loop.name}"; its judges: ${judges.map(n => n.id).join(', ') || 'none, so nothing is judged'}`)
  }
  const place = placeOf(loop, node.id)
  if (!place) return fail(`judge: "${node.id}" works in no stage of the loop; a judge runs in its stage`)
  const categories = node.categories ?? []
  const rubric = validateRubric(a.rubric, categories as RubricItem['category'][])
  if (!rubric.ok) return fail(`judge: ${rubric.problem}`)
  const helper = collectsOf(loop, node.id)
  const cap = helper ? collectorCap(node) : 0
  const product = usesProduct(node)
  const harness = str(a.harness).trim()
  if (!harness && ((node.collectors ?? 0) > 0 || product)) return fail(`judge: "harness" must say how to run and use the deliverable: "${node.id}" uses the product`)
  const model = str(a.model).trim() || node.models[0]!
  if (!node.models.includes(model)) return fail(`judge: "model" must be one of ${node.models.join(', ')} (the models of the node "${node.id}"; see ${tool('config')})`)
  const iteration = run.iteration
  const rows = await io.getRows()
  const stepOfRow = (r: WorkerRow | QaRow): number | undefined => {
    const id = r.kind === 'qa' ? judgeNode(r) : r.node
    const p = id ? placeOf(loop, id) : undefined
    return p?.step
  }
  const running = rows.filter((r): r is WorkerRow | QaRow => isAgentRow(r) && !isTerminal(r))
  const busy = running.filter(r => r.kind === 'qa' && judgeNode(r) === node.id)
  if (busy.length > 0) return fail(`judge: ${roundName(busy[0] as QaRow)} of "${node.id}" is still running; wait for its wake-up or cancel it first`)
  const earlier = running.filter(r => (stepOfRow(r) ?? -1) < place.step)
  if (earlier.length > 0) return fail(`judge: ${earlier.length} agent(s) of an earlier step still running; wait or cancel them first`)
  const unsynced = rows.filter((r): r is WorkerRow => isLanding(r) && r.status === 'finished')
  if (unsynced.length > 0) return fail(`judge: ${unsynced.length} finished worker(s) not yet synced; call ${tool('sync')} first`)
  // the judges run in step order: each reads the state the judges before it reported on
  for (const before of judges.filter(n => (placeOf(loop, n.id)?.step ?? 0) < place.step)) {
    const reported = rows.some(r => r.kind === 'qa' && judgeNode(r) === before.id && r.iteration === iteration && r.status === 'finished')
    if (!reported) return fail(`judge: "${before.id}" has not reported on round ${iteration} yet; the judges run in step order, so call ${tool('judge')} with node "${before.id}" first`)
  }
  // rounds count across the whole run, per judge, since the timeline does not group by round
  const round = rows.filter((r): r is QaRow => r.kind === 'qa' && judgeNode(r) === node.id).length + 1
  const worktree = `${run.root}/.workspaces/${node.id}/${iteration}-${round}`
  const reportPath = `${worktree}/.context/${node.id}-report.json`
  const key = `${node.id}-${iteration}-${round}`
  try {
    await git.addDetachedWorktree(io, run.root, worktree, run.branch)
    await git.mkdirp(io, `${worktree}/.context`)
    await io.write(`${worktree}/.context/rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    const brief = product
      ? qaBrief({ node: node.id, task: run.task, harness, brief: str(a.brief), reportPath, worktree, collector: helper ? agentType(helper.id) : undefined, collectors: cap })
      : reviewBrief({ node: node.id, task: run.task, base: run.baseBranch, brief: [harness ? `How to run it, if you need to: ${harness}` : '', str(a.brief)].filter(Boolean).join('\n\n'), reportPath, worktree })
    await io.write(`${worktree}/.context/${node.id}-brief.md`, brief)
    await io.write(`${run.runDir}/${key}-rubric.json`, JSON.stringify(rubric.rubric, null, 2))
    await io.write(`${run.runDir}/${key}-brief.md`, brief)
  } catch (error) {
    return fail(`judge: ${String(error)}`)
  }
  const now = await io.now()
  const row: QaRow = {
    kind: 'qa',
    role: product ? 'qa' : 'review',
    node: node.id,
    id: pendingJudge(node.id, iteration, round),
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
  const sameStep = loop.steps[place.step]!.stages.map(st => st.id)
  const activeStages = [...new Set([...(run.activeStages ?? []).filter(s => sameStep.includes(s)), place.stage.id])]
  await markStage(place.stage.id, activeStages)
  await io.setRows(list => [...list, row])
  void io.openPane()
  // judges of the same step that have not started on this round may start alongside this one
  const alongside = judges.filter(n => n.id !== node.id && placeOf(loop, n.id)?.step === place.step && !rows.some(r => r.kind === 'qa' && judgeNode(r) === n.id && r.iteration === iteration && r.status !== 'cancelled'))
  return ok(
    [
      `${roundName(row)} of "${node.id}" prepared at ${worktree} (a checkout of ${run.branch}).`,
      'Now start it: call the Agent tool with exactly these arguments (the run fills in the brief, model, worktree and background mode):',
      `- Agent({ subagent_type: "${agentType(node.id)}", description: "${roundName(row)}", prompt: "dacapo judge ${node.id} ${iteration}-${round}" })`,
      alongside.length > 0
        ? `Its stage shares a step with ${alongside.map(n => `"${n.id}"`).join(', ')}: call ${tool('judge')} for ${alongside.length === 1 ? 'it' : 'them'} now as well, then make every Agent call in one message and end your turn; a prompt wakes you with each verdict.`
        : 'Then end your turn; a prompt wakes you with the verdict and overview.',
      ...(helper && cap > 0 ? [`"${node.id}" may start up to ${cap} ${agentType(helper.id)} agents on slices of the rubric; its brief says so.`] : []),
    ].join('\n'),
  )
}

/**
 * Prepares a node with contract none (on call, or in a stage) for one question. The Agent call the reply lists runs in
 * the foreground in the run's worktree (the repository before `start` set one up), and its result is the answer.
 */
async function ask(a: Args) {
  const run = await currentRun()
  if (!run) return fail('ask: no active run')
  const loop = await loopOf(run)
  if (!loop || !run.loop) return fail(`ask: the run has no loop yet; call ${tool('start')} first`)
  const askable = Object.values(loop.nodes).filter(n => n.contract === 'none' && n.type !== 'entry' && n.type !== 'exit')
  const nodeId = str(a.node).trim()
  const node = loop.nodes[nodeId]
  if (!node || node.contract !== 'none' || node.type === 'entry' || node.type === 'exit') {
    return fail(`ask: "${nodeId}" is not a node of the loop "${run.loop.name}" that answers questions (contract none, not the entry or the exit); those nodes: ${askable.map(n => n.id).join(', ') || 'none'}`)
  }
  const prompt = str(a.prompt).trim()
  if (!prompt) return fail('ask: "prompt" must hold the question or the task')
  const model = str(a.model).trim() || node.models[0] || ''
  if (str(a.model).trim() && node.models.length > 0 && !node.models.includes(model)) return fail(`ask: "model" must be one of ${node.models.join(', ')} (the models of the node "${node.id}")`)
  const rows = await io.getRows()
  const n = rows.filter(r => r.kind === 'worker' && isAsk(r) && r.node === node.id).length + 1
  const cwd = run.worktree || run.root
  await io.write(`${run.runDir}/ask-${node.id}-${n}.md`, prompt)
  const now = await io.now()
  const row: WorkerRow = {
    kind: 'worker',
    id: pendingAsk(node.id, n),
    iteration: run.iteration,
    at: now,
    lastActivityAt: now,
    taskId: `${node.id}-${n}`,
    title: prompt.split('\n')[0]!.slice(0, 80),
    branch: '',
    worktree: cwd,
    model,
    commit: '',
    mergeMethod: 'squash',
    status: 'pending',
    stats: freshStats(),
    node: node.id,
    contract: 'none',
  }
  await io.setRows(list => [...list, row])
  return ok(
    [
      `"${node.id}" is ready for question ${n}; it works in ${cwd}${run.worktree ? '' : ' (the repository: the run has no worktree before start)'}.`,
      'Ask it: call the Agent tool with exactly these arguments (the run fills in your prompt, the model and the working directory):',
      `- Agent({ subagent_type: "${agentType(node.id)}", description: "${node.id}: ${row.title.replace(/"/g, "'").slice(0, 40)}", prompt: "dacapo ask ${node.id} ${n}" })`,
      'It runs in the foreground: the Agent result is its answer.',
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
  if (isLanding(row) && run) {
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
  const unsynced = rows.filter((r): r is WorkerRow => isLanding(r) && r.status === 'finished')
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
  const loop = await loopOf(fresh)
  const merge = (loop && exitStage(loop)) || 'merge'
  await io.setRun(cur => (cur ? { ...cur, status: 'merging', phase: 'merge', stage: merge, activeStages: [], final: { number, url, title, openedAt: now, attempt } } : cur))
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
  for (const w of rows.filter((r): r is WorkerRow => isLanding(r) && r.status !== 'merged')) notes.push(...(await git.removeWorktree(io, run.root, w.worktree, w.branch)))
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
      `Run ${run.id} finished; reports and briefs are under ${run.runDir}. Report to the user in a few lines: what shipped, the loop and the last verdicts, anything left out, and the decisions and recommendations to review.`,
    ].join('\n'),
  )
}

async function watchFinal(run: Run) {
  if (run.status !== 'merging' || !run.final) return
  const final = run.final
  const pr = run.prs.find(p => p.number === final.number)
  if (!pr) return
  const again = judgeAgain(await loopOf(run))
  const key = (what: string) => `final-${what}-${pr.number}-${final.attempt}`
  if (pr.state === 'merged') return completeMerge(run, pr, 'merged by hand')
  if (pr.state === 'closed') {
    return wake(key('closed'), `The final pull request #${pr.number} was closed without merging. Call ${tool('finish')} again to open a new one, or finish with abort=true.`)
  }
  if (pr.mergeable === 'conflicting') {
    return wake(
      key('conflict'),
      `The final pull request #${pr.number} conflicts with ${run.baseBranch}. Dispatch one worker with merge: "merge" whose task is to merge origin/${run.baseBranch} into its branch and resolve the conflicts (commit title "chore: merge ${run.baseBranch} into ${run.branch}"), then ${tool('sync')}, ${again}call ${tool('finish')} again.`,
    )
  }
  if (pr.checks === 'failing') {
    return wake(
      key('checks'),
      `The final pull request #${pr.number} has failing checks (${pr.url}). Dispatch a worker to fix them (resume the task at fault, or a repair task), then ${tool('sync')}, ${again}call ${tool('finish')} again.`,
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
  const node = judgeNode(row)
  const key = judgeKey(row)
  const name = roundName(row)
  const again = `${tool('judge')} with node "${node}"`
  // the judge ended; a collector it left running would outlive the round
  await stopCollectors(row, now)
  await settleStages(row.id)
  if (agentFailure) {
    await patchQa(row.id, r => ({ ...r, status: 'failed', endedAt: now, note: agentFailure, collect: undefined }))
    await wake(key, `${name} failed before writing a report (${agentFailure}). Call ${tool('status')}, then ${again} again or ${tool('finish')} as you see fit.`)
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
    await wake(key, `${name} ended but its rubric could not be read (${String(error)}). Call ${again} again.`)
    return
  }
  const checked = text === null ? { ok: false as const, problems: [`no report at ${row.reportPath}`] } : validateReport(text, rubric)
  if (!checked.ok) {
    const note = `report invalid: ${checked.problems.join('; ')}`
    await patchQa(row.id, r => ({ ...r, status: 'invalid', endedAt: now, note, collect: undefined }))
    await wake(key, `${name} ended without a valid report (${note}). The worktree ${row.worktree} is kept. Call ${again} again (a new round) with a clearer ${role === 'qa' ? 'harness' : 'brief'}, or decide without it.`)
    return
  }
  const stamped = JSON.stringify(
    { iteration: row.iteration, round: row.round, node, collectedAt: new Date(now).toISOString(), summary: checked.summary, items: checked.items, overview: checked.overview },
    null,
    2,
  )
  await io.write(`${run.runDir}/${key}.json`, stamped)
  await patchQa(row.id, r => ({ ...r, status: 'finished', endedAt: now, summary: checked.summary, items: checked.items, overview: checked.overview, collect: undefined }))
  rubrics.delete(key)
  const s = checked.summary
  const weak = checked.items.filter(i => i.score !== 'strong').map(i => `- ${i.score}: ${i.title}${i.note ? ` — ${i.note}` : ''}`)
  const loop = await loopOf(run)
  const place = loop ? placeOf(loop, node) : undefined
  // the other judges of the same step and round: running alongside, or already in
  const sameStep = (r: QaRow) => (loop && place ? placeOf(loop, judgeNode(r))?.step === place.step : roleOf(r) !== role)
  const others = (await io.getRows()).filter((r): r is QaRow => r.kind === 'qa' && judgeNode(r) !== node && r.iteration === row.iteration && r.status !== 'cancelled' && sameStep(r))
  const other = others[others.length - 1]
  const preempted: string[] = []
  // a fix verdict from a judge that uses the product stops a judge of the change running beside it
  if (role === 'qa' && s.verdict === 'fix') {
    for (const r of others.filter(x => isLive(x) && roleOf(x) === 'review')) {
      void io.stop(r.id).catch(() => undefined)
      await patchQa(r.id, x => ({ ...x, status: 'cancelled', endedAt: now, note: `stopped: the fix verdict of "${node}" preempts it; it runs again after the fixes`, collect: undefined }))
      preempted.push(`${roundName(r)} of "${judgeNode(r)}" was stopped: the fix verdict of "${node}" preempts it. Run ${tool('judge')} with node "${judgeNode(r)}" again once the fixes have landed and "${node}" passes.`)
    }
    await settleStages(row.id)
  }
  const otherState = !other ? undefined : isLive(other) || other.status === 'pending' ? 'running' : other.summary ? other.summary.verdict : 'without a report'
  const back = loop && place ? loop.transitions.find(t => t.from === place.stage.id && t.back) : undefined
  const forward = loop && place ? nextMove(loop, place.stage.id, run) : finishWords(run)
  const judges = loop ? judgesOf(loop).map(n => `"${n.id}"`).join(', then ') : `"${node}"`
  const loopSays = back?.then ? ` The loop says: ${back.then.replace(/\.$/, '')}.` : ''
  const fixes =
    role === 'qa'
      ? `plan the fixes and call ${tool('dispatch')} (a new round starts), then ${tool('sync')} and ${tool('judge')} again for ${judges}.${loopSays}`
      : `the items below strong whose fix lies inside the run's own change become fix tasks: call ${tool('dispatch')} (a new round starts), then ${tool('sync')}, and ${tool('judge')} again for ${judges} (a fix can regress behaviour). An item whose fix would reach parts the run does not touch is not a task: it goes to the final report as a recommendation.`
  const recommendations = s.verdict === 'pass' && otherState !== 'pass-with-recommendations' ? '' : `, or dispatch improvements first if the recommendations are worth another round${back?.then ? ` (the loop says: ${back.then.replace(/\.$/, '')})` : ''}`
  // a fix verdict from the judge that uses the product decides the round; a judge of the change waits for one still running
  const next =
    s.verdict === 'fix' && role === 'qa'
      ? `Next: ${fixes}`
      : otherState === 'running'
        ? `${roundName(other!)} of "${judgeNode(other!)}" is still running; its wake-up follows. Decide once both are in${role === 'review' ? ', since a fix verdict from the judge that uses the product comes first' : ''}.`
        : s.verdict === 'fix'
          ? `Next: ${fixes}`
          : otherState === 'fix'
            ? `Next: ${roundName(other!)} of "${judgeNode(other!)}" asked for fixes this round: plan them with the items above and call ${tool('dispatch')} (a new round starts), then ${tool('sync')} and ${tool('judge')} again for ${judges}.${loopSays}`
            : `Next: ${forward}${recommendations}.`
  await wake(
    key,
    [
      `${name} of "${node}": ${s.strong} strong, ${s.acceptable} acceptable, ${s.unacceptable} unacceptable → verdict: ${s.verdict}.`,
      ...(weak.length > 0 ? ['Items below strong:', ...weak] : []),
      `Overview from "${node}":`,
      checked.overview,
      ...preempted,
      next,
    ].join('\n'),
  )
  await git.removeWorktree(io, run.root, row.worktree)
}

/** Drops from the run's active stages every stage that no longer has a live judge, once a judge ended. */
async function settleStages(endedId: string) {
  const run = await io.getRun()
  if (!run?.loop || !run.activeStages || run.activeStages.length < 2) return
  const loop = await loopOf(run)
  if (!loop) return
  const rows = await io.getRows()
  const live = rows.filter((r): r is QaRow => r.kind === 'qa' && r.id !== endedId && (isLive(r) || r.status === 'pending')).map(r => placeOf(loop, judgeNode(r))?.stage.id)
  const kept = run.activeStages.filter(s => live.includes(s))
  if (kept.length !== run.activeStages.length) await io.setRun(cur => (cur ? { ...cur, activeStages: kept } : cur))
}

const FAILURE_OPTIONS =
  'A worker that failed leaves its branch and pull request in place. Options, in order of preference: (1) resume it: dispatch the same task id with resume: true and a prompt that says what to fix; (2) when the failure is not the task\'s fault (a broken workflow, a flaky test), dispatch a repair task first, then resume; (3) cancel the task (its open pull request is closed); (4) ask the user when a human is needed (secrets, approvals, an outage).'

async function maybeWakeForWorkers() {
  const run = await io.getRun()
  if (!run) return
  const rows = await io.getRows()
  const workers = rows.filter((r): r is WorkerRow => isLanding(r) && r.iteration === run.iteration)
  if (workers.length === 0 || workers.some(w => !isTerminal(w))) return
  const lines = workers.map(w => {
    const pr = latestPr(run, w.branch)
    return `- ${w.taskId} [${w.id}]: ${statusWord[w.status]} after ${elapsed(w.at, w.endedAt ?? w.at)}; PR ${pr ? prText(pr) : 'none seen yet'}${w.note ? ` — ${w.note.slice(0, 300)}` : ''}`
  })
  const finished = workers.filter(w => w.status === 'finished').length
  const troubled = workers.some(w => w.status === 'failed' || w.status === 'timeout' || w.status === 'cancelled')
  const key = `workers-${run.iteration}`
  if (run.wakes.some(w => w.key === key)) return
  const then = finished > 0 ? await afterLanding(run, workers[0]?.node) : ''
  await wake(
    key,
    [
      `Round ${run.iteration}: all ${workers.length} worker(s) have ended (${finished} finished).`,
      ...lines,
      ...(troubled ? [FAILURE_OPTIONS] : []),
      finished > 0 ? `Next: call ${tool('sync')} (it confirms what landed and prunes), then ${then}.` : `No worker finished. Review with ${tool('status')} and decide.`,
    ].join('\n'),
  )
}

/**
 * An agent that ended and then acts again (the person or the orchestrator resumed it) is live again: its row
 * goes back to running, its end time is cleared, and the wake-up its round already sent is forgotten so the
 * next completion wakes the orchestrator afresh.
 */
async function revive(row: WorkerRow | QaRow, now: number) {
  const key = isAsk(row) ? '' : row.kind === 'worker' ? `workers-${row.iteration}` : judgeKey(row)
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
    const who = isAsk(row) ? `"${row.node}", asked` : row.kind === 'worker' ? `Worker ${row.taskId}` : roundName(row)
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
  const hasBranches = run.worktree && (rows.some(isLanding) || run.final)
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

/** Foreground Agent calls waiting for their agent's id, by prompt: the spawn hook hands it over as the agent starts. */
const spawning = new Map<string, (agentId: string) => Promise<unknown>>()

/** The text of a tool result: a string, or the text blocks of a content list. */
function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  const blocks = Array.isArray(result) ? result : result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content) ? (result as { content: unknown[] }).content : []
  return blocks.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
}

// ---------- the loop viewer and the architect ----------

/** The store key of the loop last open in the viewer, so the next session reopens it. */
const LAST_KEY = 'viewer.last'
type LastView = { name: string; level: LoopLevel; view: ViewerState['view'] }
const LEVEL_WORDS: readonly LoopLevel[] = ['plugin', 'user', 'project']
/** The skill's loop ops that change folders, not the draft: run here through the on-disk functions, never with draft edits. */
const FOLDER_OPS = ['loop.new', 'loop.move', 'loop.delete', 'loop.default']
const NOT_SAVED = 'The draft is not saved: press Save in the pane or say "save".'
const NO_LOOP = 'No loop is open. Open one with loops, action open, or start one with loop.new.'
const FRESH_VIEW: ViewerState['view'] = { folded: false, tab: 'canvas' }

/** The viewer's state, the pane and the store, as closures made in `session.start`. */
let views: {
  get: () => Promise<ViewerState>
  set: (fn: (state: ViewerState) => ViewerState) => Promise<unknown>
  open: (focus?: boolean) => Promise<unknown>
  recall: () => Promise<unknown>
  remember: (last: LastView | null) => Promise<unknown>
}
/** The repository the session started in, for project loops and draft keys; null outside one. */
let loopRepo: string | null = null
/** Whether `session.start` has made `views`: the loops pane draws only then. */
let viewerReady = false

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const countsWords = (c: LoopRef['counts']) => `${plural(c.stages, 'stage')} in ${plural(c.steps, 'step')} · ${plural(c.nodes, 'node')} · ${plural(c.edges, 'edge')}`
const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`
const isLevel = (v: unknown): v is LoopLevel => typeof v === 'string' && (LEVEL_WORDS as readonly string[]).includes(v)
const keyOf = (ref: { level: LoopLevel; name: string }) => draftKey({ level: ref.level, name: ref.name, repoRoot: loopRepo })
/** The loop as the viewer draws it: default transitions added for display, the stored graph left alone. */
const forDisplay = (loop: Loop): Loop => ({ ...withDefaultTransitions(loop), nodes: loop.nodes })
const sameLoop = (a: { name?: unknown; level?: unknown } | undefined, b: { name: string; level: LoopLevel }) => !!a && a.name === b.name && a.level === b.level

/** The store's last open loop, or undefined when it holds none or something else. */
async function lastView(): Promise<LastView | undefined> {
  const last = (await views.recall().catch(() => undefined)) as Partial<LastView> | undefined
  if (!last || typeof last !== 'object' || typeof last.name !== 'string' || !isLevel(last.level)) return undefined
  const v = last.view as Partial<ViewerState['view']> | undefined
  const view: ViewerState['view'] = v && typeof v === 'object' ? { folded: v.folded === true, tab: v.tab === 'files' ? 'files' : 'canvas', ...(v.focus ? { focus: v.focus } : {}) } : FRESH_VIEW
  return { name: last.name, level: last.level, view }
}

/** Every file under a folder, full paths, sorted; a name that lists nothing is taken as a file. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await loopFs.list(dir)) {
    const path = joinPath(dir, name)
    const inner = await filesUnder(path)
    if (inner.length > 0) out.push(...inner)
    else out.push(path)
  }
  return out.sort()
}

/** Loops that exist only as a draft so far (a `loop.new` not saved yet), at the user and project levels. */
async function draftOnlyRefs(listed: LoopRef[]): Promise<LoopRef[]> {
  const out: LoopRef[] = []
  const keys = await loopFs.list(loopDrafts)
  for (const level of ['project', 'user'] as const) {
    const root = loopRoots[level]
    if (!root) continue
    const prefix = keyOf({ level, name: '' })
    for (const key of keys.filter(k => k.startsWith(prefix)).sort()) {
      const name = key.slice(prefix.length)
      if (!ID.test(name) || listed.some(r => r.name === name && r.level === level)) continue
      const draft = await readDraft(loopFs, loopDrafts, key).catch(() => null)
      if (!draft) continue
      out.push({ name, level, dir: joinPath(root, name), description: draft.loop.description, draft: draft.info, counts: countsOf(draft.loop, Object.keys(draft.loop.nodes).length) })
    }
  }
  return out
}

/** Lists every loop again (new loops still in their draft included), each one's steps for the library's strip, and the default from the conf. */
async function refreshLibrary(): Promise<LoopRef[]> {
  await readConf(loopRepo ?? (await io.cwd()))
  const listed = await listLoops(loopFs, loopRoots, { root: loopDrafts, repoRoot: loopRepo })
  const unsaved = await draftOnlyRefs(listed)
  const library = [...listed, ...unsaved]
  const shapes: Record<string, string[][]> = {}
  for (const ref of library) {
    try {
      const graph = unsaved.includes(ref) ? (await readLoop(loopFs, ref.draft!.dir)).loop : graphFromJson(await loopFs.read(joinPath(ref.dir, 'loop.json')), ref.name).graph
      shapes[`${ref.level}/${ref.name}`] = graph.steps.map(s => s.stages.map(st => st.id))
    } catch {
      // the card draws grey blocks from its counts
    }
  }
  await views.set(s => ({ ...s, library, shapes, defaultLoop: conf.conf.loop }))
  return library
}

/** Finds a loop by name, at `level` when given, else at the level that wins. */
function findRef(library: LoopRef[], name: string, level?: LoopLevel): LoopRef | { problem: string } {
  const ref = level ? library.find(r => r.name === name && r.level === level) : library.find(r => r.name === name && !r.shadowedBy)
  if (ref) return ref
  const names = library.map(r => `${r.name} (${r.level})`)
  return { problem: `There is no loop ${name}${level ? ` at the ${level} level` : ''}. The loops: ${names.length > 0 ? names.join(', ') : 'none'}.` }
}

/** The diagram's blocks the loop model does not know, from the first folder holding a loop.d2; kept for the save. */
async function opaqueBlocks(dirs: string[], loop: Loop): Promise<string[]> {
  for (const dir of dirs) {
    const path = joinPath(dir, 'loop.d2')
    if (!(await loopFs.exists(path))) continue
    try {
      return fromD2(await loopFs.read(path), loop).opaque
    } catch {
      return []
    }
  }
  return []
}

/**
 * Puts a loop on the viewer's screen: its draft when one exists, else the saved folder; its files (the draft's last);
 * the view the store kept for it, else the one on screen when it is the same loop, else a fresh one. The store
 * remembers it for the next session.
 */
async function openLoop(ref: LoopRef, o: { notice?: string; view?: ViewerState['view']; focus?: ViewerFocus | null; pane?: 'open' | 'quiet' } = {}): Promise<NonNullable<ViewerState['open']>> {
  const saved = (await loopFs.exists(joinPath(ref.dir, 'loop.json'))) ? await readLoop(loopFs, ref.dir) : null
  const draft = await readDraft(loopFs, loopDrafts, keyOf(ref))
  const base = draft?.loop ?? saved?.loop
  if (!base) throw new Error(`there is no loop ${ref.name} at the ${ref.level} level any more`)
  const plain: LoopRef = { ...ref }
  delete plain.draft
  const open: NonNullable<ViewerState['open']> = {
    ref: draft ? { ...plain, draft: draft.info } : plain,
    loop: forDisplay(base),
    ...(draft ? { draft: draft.info } : {}),
    d2Newer: saved?.d2Newer ?? false,
    problems: saved?.problems ?? [],
    files: [...(saved ? await filesUnder(ref.dir) : []), ...(draft ? await filesUnder(draft.info.dir) : [])],
    opaque: await opaqueBlocks([...(draft ? [draft.info.dir] : []), ...(saved ? [ref.dir] : [])], base),
  }
  const last = await lastView()
  const current = await views.get()
  let view = o.view ?? (sameLoop(last, ref) ? last!.view : sameLoop(current.open?.ref, ref) ? current.view : FRESH_VIEW)
  if (o.focus !== undefined) view = o.focus ? { ...view, focus: o.focus } : { folded: view.folded, tab: view.tab }
  await views.set(s => ({ ...s, screen: 'loop', open, view, notice: o.notice }))
  await views.remember({ name: ref.name, level: ref.level, view })
  if (o.pane !== 'quiet') await views.open()
  return open
}

/** Changes the view of the open loop and keeps it in the store. */
async function setView(fn: (view: ViewerState['view']) => ViewerState['view']): Promise<ViewerState> {
  await views.set(s => ({ ...s, view: fn(s.view) }))
  const state = await views.get()
  if (state.open) await views.remember({ name: state.open.ref.name, level: state.open.ref.level, view: state.view })
  return state
}

/** The library as tool text: one line per loop, then the roots in use. */
function libraryLines(state: ViewerState): string {
  const lines = state.library.map(r => {
    const tags = [
      ...(r.name === state.defaultLoop && !r.shadowedBy ? ['[default]'] : []),
      ...(r.draft ? [`[draft: ${plural(r.draft.changes.length, 'change')}]`] : []),
      ...(r.shadowedBy ? [`[hidden by ${r.shadowedBy}]`] : []),
    ]
    return `${r.name} (${r.level}) · ${r.description} · ${countsWords(r.counts)} · ${r.dir}${tags.length > 0 ? ` ${tags.join(' ')}` : ''}`
  })
  return [
    `${plural(state.library.length, 'loop')}. Runs use ${state.defaultLoop} by default.`,
    ...lines,
    '',
    `Roots: plugin ${loopRoots.plugin ?? 'none'} (read-only) · user ${loopRoots.user ?? 'none'} · project ${loopRoots.project ?? 'none, there is no repository here'} · drafts ${loopDrafts}`,
  ].join('\n')
}

/** Where a node works, in words. */
function placeWords(loop: Loop, id: string): string {
  if (id === loop.entry) return 'the entry'
  if (id === loop.exit) return 'the exit'
  const helpers = loop.onCall[id]
  if (helpers) return `on call${helpers.length > 0 ? `, helpers ${helpers.join(', ')}` : ''}`
  const owner = Object.entries(loop.onCall).find(([, list]) => list.includes(id))
  if (owner) return `helper of ${owner[0]}`
  const p = placeOf(loop, id)
  return p ? `in stage ${p.stage.id}` : 'nowhere'
}

/** The `open` reply's header: where the loop is, its draft and changes, its problems, the entry's whole role, its nodes, transitions and handovers. */
function openHeader(open: NonNullable<ViewerState['open']>): string[] {
  const { ref, loop, draft } = open
  const nodeLine = (n: LoopNode) => {
    const parts = [n.type, `contract ${n.contract}`, placeWords(loop, n.id)]
    if (n.models.length > 0) parts.push(`models ${n.models.join(', ')}`)
    if (n.skills.length > 0) parts.push(`skills ${n.skills.join(', ')}`)
    if (n.categories) parts.push(`categories ${n.categories.join(', ')}`)
    if (n.collectors !== undefined) parts.push(`up to ${n.collectors} collectors`)
    if (n.tools.deny.length > 0) parts.push(`denied ${n.tools.deny.join(', ')}`)
    const role = n.role.split('\n').map(l => l.trim()).find(Boolean)
    return `- ${n.id}: ${n.summary}. ${parts.join('; ')}.${role && n.id !== loop.entry ? ` Role: ${role}` : ''}`
  }
  return [
    `Loop ${loop.name} (${ref.level}) at ${ref.dir}`,
    loop.description,
    ...(draft ? [`DRAFT: ${plural(draft.changes.length, 'change')}, kept in ${draft.dir}`, ...draft.changes.map(c => `- ${c}`)] : ['No draft: this is the saved loop.']),
    ...(ref.level === 'plugin' ? ['A plugin loop is read-only: save is refused. Copy it with loop.new to edit it.'] : []),
    ...(open.d2Newer ? ['loop.d2 edited by hand since the last save: import-d2 {} folds it into the draft.'] : []),
    ...(open.problems.length > 0 ? ['Problems in the saved folder:', ...open.problems.map(p => `- ${p.path}: ${p.message}`)] : []),
    '',
    `Entry ${loop.entry}, its whole role:`,
    loop.nodes[loop.entry]?.role.trim() || 'none',
    '',
    'Nodes:',
    ...nodeOrder(loop).map(id => nodeLine(loop.nodes[id]!)),
    'Transitions:',
    ...loop.transitions.map(t => `- ${t.from} → ${t.to.join(' + ')}${t.back ? ' (back)' : ''}: ${t.label || 'default'}${t.when ? `. When ${t.when.replace(/\.$/, '')}` : ''}${t.then ? `. Then ${t.then.replace(/\.$/, '')}` : ''}`),
    'Handovers:',
    ...(loop.handovers.length > 0 ? loop.handovers.map(h => `- ${h.from} → ${h.to}: ${h.label}. ${h.spec}`) : ['- none']),
  ]
}

/** A focus target as the tool takes it: a stage id, a node id (`stage:<id>` or `node:<id>` when both share it), or `from>to` for an edge. */
function parseTarget(loop: Loop, target: string): ViewerFocus | { problem: string } {
  const stages = loop.steps.flatMap(s => s.stages.map(st => st.id))
  const nodes = Object.keys(loop.nodes)
  const edges = withDefaultTransitions(loop).transitions.map(t => transitionId(t.from, t.to))
  const handovers = loop.handovers.map(h => `${h.from}>${h.to}`)
  const what = `It has stages ${stages.join(', ') || 'none'}; nodes ${nodes.join(', ')}; transitions ${edges.join(', ') || 'none'}; handovers ${handovers.join(', ') || 'none'}.`
  const prefixed = /^(stage|node):(.+)$/.exec(target)
  if (prefixed) {
    const kind = prefixed[1] as 'stage' | 'node'
    const id = prefixed[2]!
    return (kind === 'stage' ? stages : nodes).includes(id) ? { kind, id } : { problem: `There is no ${kind} ${id} in ${loop.name}. ${what}` }
  }
  if (target.includes('>')) {
    if (handovers.includes(target)) return { kind: 'handover', id: target }
    const [from, to = ''] = target.split('>', 2) as [string, string]
    const id = transitionId(from, to.split('+'))
    if (edges.includes(id)) return { kind: 'transition', id }
    return { problem: `There is no handover or transition ${target} in ${loop.name}. ${what}` }
  }
  if (stages.includes(target)) return { kind: 'stage', id: target }
  if (nodes.includes(target)) return { kind: 'node', id: target }
  return { problem: `There is no stage or node ${target} in ${loop.name}. ${what}` }
}

/** The focus reply: the focus panel's text, and for a node its whole role (the panel shows its first lines). */
function focusReply(state: ViewerState): string {
  const f = state.view.focus
  const node = f?.kind === 'node' ? state.open?.loop.nodes[f.id] : undefined
  return [...focusText(state), ...(node ? ['', `The whole role of ${node.id}:`, node.role.trim() || 'none'] : [])].join('\n')
}

async function loopsTool(a: Args) {
  const action = str(a.action)
  if (action === 'list') {
    await refreshLibrary()
    await views.set(s => ({ ...s, screen: 'library', notice: undefined }))
    await views.open()
    return ok(libraryLines(await views.get()))
  }
  if (action === 'open') {
    const name = str(a.name).trim()
    if (!name) return fail('open needs name: the loop to open.')
    if (a.level !== undefined && !isLevel(a.level)) return fail('level must be plugin, user or project.')
    const found = findRef(await refreshLibrary(), name, a.level as LoopLevel | undefined)
    if ('problem' in found) return fail(found.problem)
    const open = await openLoop(found)
    return ok([...openHeader(open), '', viewerText(await views.get(), 100)].join('\n'))
  }
  const state = await views.get()
  if (action === 'focus') {
    if (!state.open || state.screen !== 'loop') return fail(NO_LOOP)
    const target = str(a.target).trim()
    if (!target) return ok(focusReply(await setView(v => ({ folded: v.folded, tab: v.tab }))))
    const focus = parseTarget(state.open.loop, target)
    if ('problem' in focus) return fail(focus.problem)
    return ok(focusReply(await setView(v => ({ ...v, focus, tab: 'canvas' }))))
  }
  if (action === 'fold') {
    if (!state.open || state.screen !== 'loop') return fail(NO_LOOP)
    const next = await setView(v => ({ ...v, folded: !v.folded }))
    return ok(next.view.folded ? 'The on-call section is folded.' : 'The on-call section is unfolded.')
  }
  return fail('action must be list, open, focus or fold.')
}

/** The element a batch changed first, for the viewer to focus: a stage, a node or an edge it names and did not remove. */
function changedFocus(ops: Op[]): ViewerFocus | null {
  for (const op of ops) {
    switch (op.op) {
      case 'stage.add':
      case 'stage.move':
      case 'stage.split':
      case 'stage.summary':
        return { kind: 'stage', id: op.id }
      case 'stage.rename':
        return { kind: 'stage', id: op.to }
      case 'node.add':
      case 'node.move':
      case 'node.set':
      case 'node.role':
        return { kind: 'node', id: op.id }
      case 'node.rename':
        return { kind: 'node', id: op.to }
      case 'handover.set':
        return { kind: 'handover', id: `${op.from}>${op.to}` }
      case 'transition.set':
        return { kind: 'transition', id: transitionId(op.from, op.to) }
    }
  }
  return null
}

/** One folder op of a `loop_edit` batch, checked then run through the on-disk functions: the reply's line, or a problem. */
async function folderOp(raw: Record<string, unknown>): Promise<{ text: string } | { problem: string }> {
  const name = str(raw.op)
  const takes: Record<string, string[]> = { 'loop.new': ['name', 'level', 'from'], 'loop.move': ['level'], 'loop.delete': ['name', 'level'], 'loop.default': ['name'] }
  const extra = Object.keys(raw).filter(k => k !== 'op' && !takes[name]!.includes(k))
  if (extra.length > 0) return { problem: `${name} does not take ${extra.map(k => `"${k}"`).join(', ')} (it takes ${takes[name]!.join(', ')})` }
  const state = await views.get()

  if (name === 'loop.new') {
    const loopName = str(raw.name)
    if (!loopName) return { problem: 'loop.new needs "name", a string' }
    if (raw.level !== 'user' && raw.level !== 'project') return { problem: 'loop.new: "level" must be user or project' }
    let from: { name: string; level: LoopLevel } | undefined
    if (raw.from !== undefined) {
      const f = raw.from as Record<string, unknown> | null
      if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !isLevel(f.level)) return { problem: 'loop.new: "from" must be like { "name": "core", "level": "plugin" }' }
      from = { name: f.name, level: f.level }
    }
    const made = await loopNew(loopFs, loopRoots, loopDrafts, loopRepo, { name: loopName, level: raw.level, ...(from ? { from } : {}) })
    if (!made.ok) return { problem: made.problem }
    await refreshLibrary()
    await openLoop(made.ref, { focus: null })
    const what = from ? `a copy of ${from.name} (${from.level}); the original stays as it was` : 'a blank loop with an entry and an exit'
    return { text: `Started loop ${loopName} (${raw.level}) as a draft: ${what}. Nothing is in ${made.ref.dir} until you save. ${NOT_SAVED}` }
  }

  if (name === 'loop.move') {
    if (raw.level !== 'user' && raw.level !== 'project') return { problem: 'loop.move: "level" must be user or project' }
    if (!state.open) return { problem: `loop.move moves the open loop. ${NO_LOOP}` }
    const { ref } = state.open
    const problem = await loopMove(loopFs, loopRoots, loopDrafts, loopRepo, { name: ref.name, from: ref.level, to: raw.level })
    if (problem) return { problem }
    const found = findRef(await refreshLibrary(), ref.name, raw.level)
    if ('problem' in found) return found
    await openLoop(found, { view: state.view })
    return { text: `Moved ${ref.name} from the ${ref.level} level to the ${raw.level} level, with its draft: ${found.dir}.` }
  }

  if (name === 'loop.delete') {
    const loopName = str(raw.name)
    if (!loopName) return { problem: 'loop.delete needs "name", a string' }
    if (!isLevel(raw.level)) return { problem: 'loop.delete: "level" must be user or project' }
    const level = raw.level
    const problem = await loopDelete(loopFs, loopRoots, loopDrafts, loopRepo, { name: loopName, level })
    if (problem) return { problem }
    if (sameLoop(await lastView(), { name: loopName, level })) await views.remember(null)
    await refreshLibrary()
    await views.set(s => ({ ...s, screen: 'library', notice: undefined, ...(sameLoop(s.open?.ref, { name: loopName, level }) ? { open: undefined, view: FRESH_VIEW } : {}) }))
    await views.open()
    return { text: `Deleted ${loopName} (${level}): its folder and its draft are gone.\n\n${libraryLines(await views.get())}` }
  }

  // loop.default: the conf beside the loop's level, the repository's for a project loop
  const loopName = str(raw.name)
  if (!loopName) return { problem: 'loop.default needs "name", a string' }
  const found = findRef(await refreshLibrary(), loopName)
  if ('problem' in found) return found
  const home = (await io.home().catch(() => undefined)) ?? ''
  const confPath = found.level === 'project' && loopRepo ? `${loopRepo}/.dacapo.conf` : `${home}/.claude/dacapo.conf`
  const problem = await setDefaultLoop(loopFs, confPath, loopName)
  if (problem) return { problem }
  await refreshLibrary()
  const inForce = conf.conf.loop
  return {
    text: `Wrote loop = ${loopName} to ${confPath}. Runs use ${loopName} unless --loop names another.${inForce !== loopName ? ` A conf file read later names ${inForce}, so runs here still use ${inForce}.` : ''}`,
  }
}

async function loopEdit(a: Args) {
  const ops = a.ops
  if (!Array.isArray(ops) || ops.length === 0) return fail('ops must be a list of at least one op, like [{ "op": "stage.add", "id": "security", "summary": "checks for holes", "alongside": "qa" }]. Nothing was written.')
  const opName = (v: unknown) => (v && typeof v === 'object' ? str((v as Record<string, unknown>).op) : '')
  const folders = ops.filter(v => FOLDER_OPS.includes(opName(v))).length
  if (folders > 0 && folders < ops.length) {
    return fail('loop.new, loop.move, loop.delete and loop.default change loop folders and go in a batch of their own. Send them first, then the draft edits in a second loop_edit call. Nothing was written.')
  }
  if (folders > 0) {
    const lines: string[] = []
    for (let i = 0; i < ops.length; i++) {
      const out = await folderOp(ops[i] as Record<string, unknown>)
      if ('problem' in out) return fail([`Refused op ${i} (${opName(ops[i])}): ${out.problem}.`, i > 0 ? `The ops before it were done:\n${lines.join('\n')}` : 'Nothing was written.'].join('\n'))
      lines.push(out.text)
    }
    return ok(lines.join('\n'))
  }

  const parsed: Op[] = []
  for (let i = 0; i < ops.length; i++) {
    const p = parseOp(ops[i])
    if ('problem' in p) return fail(`Refused op ${i} (${opName(ops[i]) || 'unnamed'}): ${p.problem}. Nothing was written.`)
    parsed.push(p.op)
  }
  const state = await views.get()
  if (!state.open) return fail(`${NO_LOOP} Nothing was written.`)
  const { ref } = state.open
  // the ops apply to the draft on disk, or to the saved loop as stored; the draft is opened only once they pass
  const existing = await readDraft(loopFs, loopDrafts, keyOf(ref))
  const saved = existing ? null : (await readLoop(loopFs, ref.dir)).loop
  const d2Dir = (await loopFs.exists(joinPath(ref.dir, 'loop.d2'))) ? ref.dir : existing?.info.dir
  const d2 = d2Dir && parsed.some(op => op.op === 'import-d2') ? await loopFs.read(joinPath(d2Dir, 'loop.d2')).catch(() => undefined) : undefined
  const out = applyOps(existing?.loop ?? saved!, parsed, { ...(d2 !== undefined ? { d2 } : {}), opaque: state.open.opaque ?? [] })
  if (!out.ok) {
    const head = out.op === 'batch' ? 'Refused: after the last op the loop breaks these rules.' : `Refused op ${out.index} (${out.op}):`
    return fail([head, ...out.problems.map(p => `- ${p}`), 'Nothing was written.'].join('\n'))
  }
  const info = existing?.info ?? (await openDraft(loopFs, loopDrafts, { level: ref.level, name: ref.name, repoRoot: loopRepo }, saved)).info
  const after = await writeDraft(loopFs, info, out.loop, out.changes.join('; '))
  const focus = changedFocus(parsed)
  await refreshLibrary()
  await openLoop({ ...ref, draft: after }, { focus })
  await views.set(s => (s.open ? { ...s, open: { ...s.open, opaque: out.opaque } } : s))
  return ok(
    [
      `Changed in the draft of ${ref.name} (${ref.level}):`,
      ...out.changes.map(c => `- ${c}`),
      `The draft holds ${plural(after.changes.length, 'change')}. ${NOT_SAVED}`,
      ...(ref.level === 'plugin' ? ['This is a plugin loop, so save is refused: copy it with loop.new to keep edits in a loop of your own.'] : []),
      ...(focus ? [`The viewer shows ${focus.kind} ${focus.id}.`] : []),
    ].join('\n'),
  )
}

/** Saves the open loop's draft: the tool and the pane's Save button. */
async function saveLoop(force: boolean) {
  const state = await views.get()
  if (!state.open) return fail(NO_LOOP)
  const { ref } = state.open
  const draft = await readDraft(loopFs, loopDrafts, keyOf(ref))
  if (!draft) return fail(`There is no draft of ${ref.name} (${ref.level}) to save.`)
  const problem = await saveDraft(loopFs, { ref, loop: draft.loop, info: draft.info, opaque: state.open.opaque ?? [], force })
  if (problem) {
    const hint =
      ref.level === 'plugin'
        ? ` Copy it with loop.new { name, level: user or project, from: { name: ${ref.name}, level: plugin } }, then edit the copy.`
        : /save with force/.test(problem)
          ? ' Ask the user before saving with force: true, which overwrites it.'
          : ''
    await views.set(s => ({ ...s, notice: `Not saved: ${problem}` }))
    return fail(`Not saved: ${problem}.${hint} The draft is kept.`)
  }
  let name = ref.name
  let note = ''
  if (draft.loop.name !== ref.name) {
    const renamed = await loopRename(loopFs, loopRoots, loopDrafts, loopRepo, { name: ref.name, level: ref.level, to: draft.loop.name })
    if (renamed) note = ` It was saved as ${ref.name}: renaming its folder to ${draft.loop.name} failed: ${renamed}.`
    else name = draft.loop.name
  }
  const found = findRef(await refreshLibrary(), name, ref.level)
  if ('problem' in found) return fail(found.problem)
  const open = await openLoop(found, { notice: 'saved' })
  return ok([`Saved ${name} (${ref.level}) to ${found.dir}. The draft is cleared.${note}`, 'Files:', ...open.files.map(f => `- ${f}`), `Run it with /dacapo:core --loop ${name} <task>.`].join('\n'))
}

/** Discards the open loop's draft: the tool and the pane's Discard button. */
async function discardLoop() {
  const state = await views.get()
  if (!state.open) return fail(NO_LOOP)
  const { ref } = state.open
  const draft = await readDraft(loopFs, loopDrafts, keyOf(ref))
  if (!draft) return fail(`There is no draft of ${ref.name} (${ref.level}) to discard.`)
  await discardDraft(loopFs, draft.info)
  const found = findRef(await refreshLibrary(), ref.name, ref.level)
  if ('problem' in found) {
    // a new loop never saved: nothing is left of it
    await views.remember(null)
    await views.set(s => ({ ...s, screen: 'library', open: undefined, notice: undefined, view: FRESH_VIEW }))
    return ok(`Discarded the draft of ${ref.name} (${ref.level}). It was never saved, so nothing is left of it.`)
  }
  await openLoop(found, { notice: 'discarded' })
  return ok(`Discarded the draft of ${ref.name} (${ref.level}). The viewer shows the saved loop again.`)
}

/** Runs a button's action; a failure becomes a toast. */
const press = (run: () => Promise<unknown>) => void run().catch(error => io.toast(`dacapo: ${error instanceof Error ? error.message : String(error)}`))

/** The viewer's buttons: they navigate, focus, fold and switch the tab, and save or discard through the tools' own paths. None submits a prompt. */
const viewerActions: ViewerActions = {
  back: () =>
    press(async () => {
      await views.remember(null)
      await refreshLibrary()
      await views.set(s => ({ ...s, screen: 'library', notice: undefined }))
    }),
  open: (name, level) =>
    press(async () => {
      const found = findRef(await refreshLibrary(), name, level)
      if ('problem' in found) throw new Error(found.problem)
      await openLoop(found, { pane: 'quiet' })
    }),
  focus: target => press(() => setView(v => (target ? { ...v, focus: target } : { folded: v.folded, tab: v.tab }))),
  fold: () => press(() => setView(v => ({ ...v, folded: !v.folded }))),
  tab: tab => press(() => setView(v => ({ ...v, tab }))),
  save: () => press(() => saveLoop(false)),
  discard: () => press(() => discardLoop()),
}

/** At session start: reopens the loop the store names as last open, draft included, without taking focus; nothing when it is gone. */
async function reopenLast(): Promise<void> {
  const last = await lastView()
  if (!last) return
  const found = findRef(await refreshLibrary(), last.name, last.level)
  if ('problem' in found) return
  await openLoop(found, { view: last.view })
}

// ---------- the tools' schemas ----------

const RUBRIC_ITEMS = (title: string, category: string) => ({
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'kebab-case id' },
      title: { type: 'string', description: title },
      category: { type: 'string', description: category },
    },
    required: ['id', 'title', 'category'],
  },
})

/** The dispatch tool; a loop with one lands node gives the task's model an enum of that node's models. */
function dispatchSpec(loop: Loop | null) {
  const landers = loop ? Object.values(loop.nodes).filter(n => n.contract === 'lands') : []
  const only = landers.length === 1 ? landers[0]! : undefined
  return {
    name: 'dispatch',
    description:
      'Prepares one worker subagent per task of a lands node of the loop, each in its own git worktree and branch off the run branch, and returns the Agent calls that start them. Each worker lands its work through a pull request into the run branch before it finishes. A dispatch after a judge starts the next round; a task with resume: true continues an earlier worker on its branch and pull request.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The lands node that works the tasks; leave it out when the loop has one lands node (see config).' },
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
              model: only
                ? { type: 'string', enum: [...only.models], description: `One of the models of the node "${only.id}": the first for complex or cross-cutting work, the last for contained work.` }
                : { type: 'string', description: "One of the models of the lands node (config lists them): the first for complex or cross-cutting work, the last for contained work." },
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
  }
}

const TOOL_SPECS = [
  {
    name: 'config',
    description:
      'The configuration in force, each value with the file it came from, and the loop a run walks: its name, level and folder, its steps with stage ids and summaries, every node with type, contract, models, skills and categories, its transitions and handovers, and your role as its entry node under "Your role". Agents never read the conf or loop files themselves.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start',
    description:
      'Begins (or confirms) the dacapo run for the task handed over on a loop: checks the loop and registers its agents, checks that gh is installed and logged in, pulls the base branch, cuts the run branch from it in its own worktree, pushes it, and opens the timeline pane. Call once, after the task is clear.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task in one line: the heading of the run.' },
        overview: { type: 'string', description: 'One short paragraph on the whole task: deliverable, who it is for, what done looks like. Shown under the heading.' },
        branch: { type: 'string', description: 'The run branch, named after the change (kebab-case, e.g. "add-login"); default a slug of the task. Every worker pull request targets it.' },
        baseBranch: { type: 'string', description: 'The branch the run is cut from and merged into; default the configured base-branch.' },
        loop: { type: 'string', description: 'The loop the run walks, by name; default the one the /dacapo:core prompt named with --loop, else the configured loop. Fixed once the run is set up.' },
      },
      required: ['task', 'overview'],
    },
  },
  {
    name: 'stage',
    description: 'Marks the stage of the loop the run is in, for a stage you work through alone (clarify and research in the shipped loops). start, dispatch, judge and finish mark the stages they enter themselves.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: { stage: { type: 'string', description: 'A stage id of the run\'s loop (config lists them).' } },
      required: ['stage'],
    },
  },
  {
    name: 'judge',
    description:
      'Starts a scores node of the loop (QA, a reviewer) on a fresh worktree of the run branch. It scores every rubric item strong/acceptable/unacceptable and writes a report the run collects; a judge that hands slices to a collects node may split the rubric among those collectors, so the harness must say what the product can share between testers. Judges run in step order; two whose stages share a step run side by side. Returns at once; the run wakes you with the overview and verdict.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The scores node to run (config lists the judges of the loop).' },
        rubric: RUBRIC_ITEMS('What is checked: a user-visible outcome for a judge that uses the product, a property of the code for one that reads the change.', "One of the node's categories (config lists them)."),
        harness: {
          type: 'string',
          description: 'How to start, reach and use the deliverable: install and run commands, URLs or binaries, accounts or fixtures, expected flows. Markdown. Required for a judge that uses the product or runs collectors.',
        },
        brief: { type: 'string', description: 'Optional: what was built this round and what changed since the last one; for a judge of the change, the conventions and references the briefs pointed at and what to look at first.' },
        model: { type: 'string', description: "One of the node's models; default its first (config lists them)." },
      },
      required: ['node', 'rubric'],
    },
  },
  {
    name: 'ask',
    description:
      'Prepares a node of the loop with contract none (on call, or in a stage) for one question or task, and returns the Agent call that asks it. The agent runs in the foreground in the run worktree with your prompt as its first turn, and the Agent result is its answer.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The node to ask (config lists the nodes and where they work).' },
        prompt: { type: 'string', description: 'The question or task, whole: the node sees nothing else of the run.' },
        model: { type: 'string', description: "One of the node's models; default its first." },
      },
      required: ['node', 'prompt'],
    },
  },
  {
    name: 'sync',
    description:
      'After the workers ended: lists their pull requests through gh, marks the ones that merged, prunes their worktrees and branches, and fast-forwards the run branch worktree to origin. Reports a worker that finished without landing.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'The timeline as text: the loop and its current stages, every worker, judge and asked node with status, pull request and elapsed time, and the run state.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel',
    description: 'Stops a running worker, judge or asked node by agent id, marks its row cancelled and closes its open pull request. Its worktree is kept for inspection until the run ends.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' }, reason: { type: 'string' } },
      required: ['agentId'],
    },
  },
]

/** The architect's tools: the loop viewer and the edits of a draft, for /dacapo:design. */
const LOOP_TOOL_SPECS = [
  {
    name: 'loops',
    description:
      "The loop viewer. list: every loop at the plugin, user and project levels, one line each (level, description, counts, folder, default, draft, hidden by a higher level) and the roots; the pane opens on the library. open: one loop as text (its draft when one exists, DRAFT and its changes, the entry's role, every node, transition and handover, the canvas) and the pane shows it. focus: points the viewer at a stage, a node or an edge and returns what the focus panel shows. fold: folds or unfolds the on-call section.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'focus', 'fold'] },
        name: { type: 'string', description: 'open: the loop, by name.' },
        level: { type: 'string', enum: ['plugin', 'user', 'project'], description: 'open: the level, when the same name lives at more than one; default the level that wins (project over user over plugin).' },
        target: {
          type: 'string',
          description: 'focus: a stage id, a node id, or from>to for an edge (a handover between two nodes, else a transition with its stages joined by +, like implement>qa+review). stage:<id> or node:<id> picks one when a stage and a node share the id. Empty clears the focus.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'loop_edit',
    description:
      "Applies operations in order to the open loop's draft, and opens the draft when none exists. The first failing op stops the batch: nothing is written and the reply names the op and the rule it broke. loop.new, loop.move, loop.delete and loop.default change folders and go in a batch of their own. The reply lists what changed and the draft's change count; the viewer focuses the first changed element.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: { op: { type: 'string', description: 'stage.add, stage.remove, stage.move, stage.split, stage.rename, stage.summary, node.add, node.remove, node.move, node.set, node.role, node.rename, transition.set, transition.remove, handover.set, handover.remove, loop.new, loop.rename, loop.move, loop.delete, loop.default, loop.describe or import-d2' } }, required: ['op'] },
          description: 'The operations, each an object with "op" and its fields, as the design skill lists them.',
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'loop_save',
    description: "Saves the open loop's draft: validates it, writes loop.json, nodes/*.md, loop.d2 and LOOP.md, and clears the draft. Refused for a plugin loop, and when the saved loop changed on disk since the draft began unless force. Only on the user's word.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'true overwrites a loop that changed on disk since the draft began. Only when the user says to.' } },
    },
  },
  {
    name: 'loop_discard',
    description: "Deletes the open loop's draft; the viewer shows the saved loop again.",
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  },
]

const finishSpec = () => ({
  name: 'finish',
  description: `Opens the final pull request from the run branch into the base branch with the given title and body, written to the configured pull request rules skill (${conf.conf['prs-skill']}). The run then watches its checks, merges it with a merge commit when green, prunes the worktrees and wakes you; failing checks or conflicts wake you instead.`,
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: `The merge commit title, to the ${conf.conf['commits-skill']} skill, e.g. "feat: add login to the CLI".` },
      body: { type: 'string', description: `The pull request body, to the ${conf.conf['prs-skill']} skill.` },
      abort: { type: 'boolean', description: 'true ends the run without a final pull request.' },
    },
  },
})

/** Whether `path` is strictly inside one of `roots`: the only places the loop file system may remove. */
const isRemovable = (path: string, bases: readonly (string | null)[]) => bases.some(b => !!b && path.startsWith('/') && normalize(path, '/') !== normalize(b, '/') && isUnder(path, b, '/'))

/** The element table a drawer gets: the terminal's without `Svg`, so the bar and the icons draw as glyphs there. */
function elementsFor(surface: string, resolved: Els): Els {
  if (surface !== 'terminal') return resolved
  const { Box, Text, Button, Link } = resolved
  return { Box, Text, Button, Link }
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
    const repo = await git.repoRoot(io, cwd)
    await readConf(repo ?? cwd)
    // where loops live: the plugin's, the user's (DACAPO_HOME or ~/.claude/dacapo) and this repository's, kept out of git
    const env = { home: (await io.home().catch(() => undefined)) ?? '', dacapoHome: (await $.env.get('DACAPO_HOME').catch(() => undefined)) || null }
    loopRoots = roots({ ...env, pluginRoot: $.plugin.root, repoRoot: repo })
    loopDrafts = draftsRoot(env)
    loopFs = {
      read: path => io.read(path),
      write: (path, text) => io.write(path, text),
      exists: path => io.exists(path),
      list: async dir => (await $.fs.list(dir).catch(() => [])).map(entry => entry.name),
      stat: async path => {
        const s = await $.fs.stat(path).catch(() => null)
        return s ? { mtime: s.mtimeMs } : null
      },
      remove: async path => {
        if (!isRemovable(path, [loopRoots.user, loopRoots.project, loopDrafts])) throw new Error(`dacapo removes only inside a loops or drafts folder, not ${path}`)
        const out = await io.run(['rm', '-rf', path])
        if (out.exitCode !== 0) throw new Error(`rm -rf ${path} failed: ${out.stderr.trim()}`)
      },
    }
    if (repo) await git.ensureExclude(io, repo, ['.claude/dacapo/']).catch(() => undefined)
    loopRepo = repo
    views = {
      get: () => read($, viewerAtom),
      set: fn => update($, viewerAtom, fn),
      open: focus => $.ui.open(focus ? { id: LOOPS_PANE, title: 'Loops', focus: true } : { id: LOOPS_PANE, title: 'Loops' }),
      recall: () => $.store.get(LAST_KEY),
      // the store only remembers the view: a failure there never fails a tool
      remember: last => (last ? $.store.set(LAST_KEY, last) : $.store.delete(LAST_KEY)).catch(() => undefined),
    }
    viewerReady = true
    registerAgent = spec => $.agent.register(spec)
    registerDispatch = async loop => {
      dispatchFor = loop?.name ?? null
      return $.tool.register(dispatchSpec(loop))
    }

    // the active loop: the one the loop conf key names; a loop that fails to load leaves the tools working, and config and start say why
    const resolved = await resolveLoop(conf.conf.loop)
    active = resolved.ok ? { ref: resolved.ref, loop: resolved.loop } : null
    activeProblem = resolved.ok ? '' : resolved.problem
    if (active) {
      const registered = await ensureAgents(active.ref.name, active.loop).catch(error => ({ problem: String(error), added: [] }))
      if (registered.problem) activeProblem = registered.problem
    }
    dispatchFor = active?.ref.name ?? null

    await Promise.all([
      ...TOOL_SPECS.map(spec => $.tool.register(spec)),
      $.tool.register(dispatchSpec(active?.loop ?? null)),
      $.tool.register(finishSpec()),
      $.command.register({ name: 'dacapo-pane', description: 'Opens the dacapo timeline pane.' }),
      $.command.register({ name: 'dacapo-config', description: 'Shows the dacapo configuration in force, the files it was read from, and the loop a run walks.' }),
      ...LOOP_TOOL_SPECS.map(spec => $.tool.register(spec)),
      $.command.register({ name: 'dacapo-loops', description: 'Opens the dacapo loop viewer: the library of loops, or the loop last open.' }),
    ])

    // the loop open in the viewer last time, draft included, comes back without taking focus
    await reopenLast().catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick())

    return next(e)
  })

  // ----- the orchestrator starts each agent itself (so the permission mode judges its own call); the run fills the call in -----

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const a = e as unknown as Args
    if (e.agentId !== undefined) {
      // an agent of the run starting another: only a judge may, and only the collector its loop hands slices to
      const found = await rowFor(e.agentId)
      if (!found) return next(e)
      const { row, collector } = found
      if (collector) return { deny: 'dacapo collector: collectors never start agents; bring what you found back to your judge in your final message.' }
      if (row.kind !== 'qa') return { deny: `dacapo: ${isAsk(row) ? `"${row.node}", asked,` : 'a worker'} never starts agents.` }
      const run = await io.getRun()
      const loop = run ? await loopOf(run) : null
      const judgeOf = row.node && loop ? loop.nodes[row.node] : undefined
      const helper = judgeOf && loop ? collectsOf(loop, judgeOf.id) : row.node ? undefined : roleOf(row) === 'qa' ? ({ id: 'qa-collector', models: conf.conf.qa } as unknown as LoopNode) : undefined
      const who = `dacapo ${judgeName(row)}`
      if (!helper) return { deny: `${who}: you start no agents in this loop; collect the evidence yourself.` }
      const helperType = row.node ? agentType(helper.id) : LEGACY_AGENT.collector
      if (str(a.subagent_type) !== helperType) {
        return { deny: `${who}: the only agent you may start is ${helperType}: it collects evidence on a slice of the rubric, never opens source and never scores.` }
      }
      const cap = judgeOf ? collectorCap(judgeOf) : conf.conf['qa-collectors']
      if (cap <= 0) return { deny: `${who}: collectors are off for this judge (its cap is 0); collect the evidence yourself.` }
      const live = liveCollectors(row).length
      if (live >= cap) return { deny: `${who}: ${cap} collector${cap === 1 ? '' : 's'} may run at once and ${live} ${live === 1 ? 'is' : 'are'} running; wait for one to report before starting another.` }
      const slice = str(a.prompt).trim()
      if (!slice) return { deny: `${who}: the prompt must tell the collector its rubric ids, its instance and what is shared.` }
      const allowed = helper.models.length > 0 ? helper.models : conf.conf.qa
      const model = allowed.includes(str(a.model)) ? str(a.model) : allowed[allowed.length - 1]!
      const prompt = `[dacapo worktree: ${row.worktree}]\n\n${collectorPrompt(row)}\n\n## Your slice, from ${judgeName(row)}\n\n${slice}\n\nStart now. Your working directory is the worktree above; write only under its .context/evidence folder.`
      // in the foreground: the Agent call blocks, so the judge keeps its turn while a batch runs (several calls in one message still run at once);
      // a judge's turn that ended to wait on a background collector would end the round without a report
      const ran = await next({ ...e, prompt, subagent_type: helperType, model, run_in_background: false })
      const got = 'result' in ran && ran.result && typeof ran.result === 'object' ? (ran.result as { agentId?: unknown }).agentId : undefined
      if (typeof got === 'string') {
        const now = await io.now()
        await patchQa(row.id, r => ({ ...r, collectors: [...(r.collectors ?? []), { id: got, description: str(a.description).trim().slice(0, 80) || 'collector', at: now }] }))
      }
      return ran
    }
    const call = CALL_LINE.exec(str(a.prompt))
    if (!call) return next(e)
    const run = await currentRun()
    if (!run) return { deny: `dacapo: no active run; call ${tool('start')} first` }
    const rows = await io.getRows()
    const wanted = call[1] ? pendingWorker(run.iteration, call[1]) : call[2] ? pendingJudge(call[2], Number(call[3]), Number(call[4])) : pendingAsk(call[5]!, Number(call[6]))
    const row = rows.find((r): r is WorkerRow | QaRow => isAgentRow(r) && r.id === wanted)
    if (!row) {
      const expected = rows
        .filter((r): r is WorkerRow | QaRow => isAgentRow(r) && r.status === 'pending')
        .map(r => (r.kind === 'qa' ? `judge ${judgeNode(r)} ${r.iteration}-${r.round}` : isAsk(r) ? `ask ${r.node} ${r.taskId.split('-').pop()}` : `worker ${r.taskId}`))
      const by = call[1] ? 'dispatch' : call[2] ? 'judge' : 'ask'
      return { deny: `dacapo: nothing pending for "${call[0]!.trim()}"${expected.length ? `; pending: ${expected.join(', ')}` : ''}. Call ${tool(by)} first.` }
    }
    let prompt: string
    let subagent: string
    let background = true
    if (row.kind === 'qa') {
      prompt = `[dacapo worktree: ${row.worktree}]\n\n${judgePrompt(row)}\n\nStart now. Your working directory is the worktree above; every path you touch is under it.`
      subagent = row.node ? agentType(row.node) : roleOf(row) === 'review' ? LEGACY_AGENT.review : LEGACY_AGENT.qa
    } else if (isAsk(row)) {
      // an asked node answers in the foreground: the Agent result is its answer, in the run worktree (the repository before start)
      const n = row.taskId.split('-').pop()
      const asked = await io.read(`${run.runDir}/ask-${row.node}-${n}.md`).catch(() => '')
      prompt = `[dacapo worktree: ${row.worktree}]\n\n${asked}`
      subagent = agentType(row.node!)
      background = false
    } else {
      const brief = await io.read(`${row.worktree}/.context/brief.md`)
      prompt = `[dacapo worktree: ${row.worktree}]\n\n${brief}\n\nStart now. Your working directory is the worktree above; every path you touch is under it.`
      subagent = row.node ? agentType(row.node) : LEGACY_AGENT.worker
    }
    const now0 = await io.now()
    if (!background) {
      await patchRow(row.id, r => ({ ...r, status: 'running', at: now0, lastActivityAt: now0 }))
      // the spawn hook learns the agent's id as it starts, so the guards and the timeline follow it while the call blocks
      spawning.set(prompt, id => io.setRows(list => list.map(r => (isAgentRow(r) && r.id === row.id ? { ...r, id } : r))))
    }
    const ran = await next({
      ...e,
      prompt,
      description: row.kind === 'worker' ? (isAsk(row) ? str(a.description) || `${row.node}: ${row.title}` : row.title) : roundName(row),
      subagent_type: subagent,
      ...(row.model ? { model: row.model } : {}),
      run_in_background: background,
    })
    const got = 'result' in ran && ran.result && typeof ran.result === 'object' ? (ran.result as { agentId?: unknown }).agentId : undefined
    const agentId = typeof got === 'string' ? got : undefined
    const now = await io.now()
    const refused = 'deny' in ran && ran.deny ? String(ran.deny) : 'isError' in ran && ran.isError ? String(ran.result ?? 'the Agent tool reported an error') : ''
    if (!background) {
      // the foreground call has ended: the answer is its result, whatever id the agent ran under
      spawning.delete(prompt)
      const answer = refused || ('result' in ran ? textOf(ran.result) : '')
      const ids = [row.id, ...(agentId ? [agentId] : [])]
      await io.setRows(list =>
        list.map(r =>
          r.kind === 'worker' && ids.includes(r.id) && !isTerminal(r)
            ? { ...r, id: agentId ?? r.id, status: refused ? 'failed' : 'finished', endedAt: now, note: answer.replace(/\s+/g, ' ').trim().slice(0, 400) || undefined }
            : r,
        ),
      )
    } else if (agentId) {
      await io.setRows(list => list.map(r => (isAgentRow(r) && r.id === row.id ? { ...r, id: agentId, status: 'running', at: now, lastActivityAt: now } : r)))
    } else {
      const note = refused || 'the Agent tool answered without an agent id'
      await patchRow(row.id, r => ({ ...r, note: `not started: ${note.slice(0, 300)}` }))
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'dacapo: the Agent call could not be prepared' }))

  on('agent.spawn', async ($, e, next) => {
    const line = WORKTREE_LINE.exec(e.prompt)
    if (!line || e.isTeammate) return next(e)
    const out = await next({ ...e, cwd: line[1]! })
    const started = spawning.get(e.prompt)
    if (started && out.agentId) {
      spawning.delete(e.prompt)
      await started(out.agentId)
    }
    return out
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dacapo-config' }, async () => {
    const cwd = await io.cwd()
    await readConf((await git.repoRoot(io, cwd)) ?? cwd)
    return {
      text: `dacapo configuration\n${await configText()}\n\nEdit ~/.claude/dacapo.conf for every repository, or .dacapo.conf at this repository's root; see dacapo.conf in the plugin for the keys. loop names the loop a run walks; commits-skill and prs-skill name the skills commits and pull requests follow; base-branch names the branch runs are cut from and merged into.`,
    }
  })

  on('command.run', { command: 'dacapo-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Da capo', focus: true })
    await update($, uiAtom, ui => ({ ...ui, isBandHidden: false }))
    return { text: 'dacapo timeline opened.' }
  })

  on('command.run', { command: 'dacapo-loops' }, async () => {
    await refreshLibrary()
    await views.open(true)
    return { text: 'dacapo loops opened.' }
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
    if (/^\s*\/dacapo:design(\s|$)/.test(text)) {
      // the architect's entry: the library is fresh and the pane open before the turn; the skill lists the loops itself
      await refreshLibrary().catch(() => undefined)
      await views.set(s => ({ ...s, screen: 'library', notice: undefined }))
      void views.open()
    }
    const starts = /^\s*\/dacapo:core(?:\s+--loop(?:\s+|=)(\S+))?(\s|$)/.exec(text)
    let run = await currentRun()
    if (starts) {
      // the run has no heading yet: the prompt is the person's words, the title and overview come from `start` once the task is clear;
      // a --loop flag right after the command names the loop now, so the pane shows its stages while the task is clarified
      const cwd = await io.cwd()
      await readConf((await git.repoRoot(io, cwd)) ?? cwd)
      const name = starts[1] ?? conf.conf.loop
      const resolved = await resolveLoop(name)
      const registered = resolved.ok ? await ensureAgents(name, resolved.loop).catch(error => ({ problem: String(error), added: [] })) : { problem: resolved.problem, added: [] }
      asked = registered.problem ? name : null
      if (resolved.ok && !registered.problem && dispatchFor !== name) await registerDispatch(resolved.loop).catch(() => undefined)
      run = await openRun('', conf.conf['base-branch'], resolved.ok && !registered.problem ? resolved : undefined)
      if (registered.problem) io.toast(`dacapo: the loop "${name}" cannot run: ${registered.problem.split('\n')[0]}`)
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
  on('tool.call', { tool: 'mcp__dacapo__stage' }, ($, e) => markStageTool(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__dispatch' }, ($, e) => dispatch(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__sync' }, () => sync()).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__judge' }, ($, e) => judge(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__ask' }, ($, e) => ask(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__cancel' }, ($, e) => cancel(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__finish' }, ($, e) => finish(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__config' }, async () => ok(await configText())).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__status' }, async () => {
    const snap = await snapshot()
    return ok(statusText(snap))
  }).catch(crashed)
  // the architect's tools: the viewer and the draft of one loop
  on('tool.call', { tool: 'mcp__dacapo__loops' }, ($, e) => loopsTool(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__loop_edit' }, ($, e) => loopEdit(e as unknown as Args)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__loop_save' }, ($, e) => saveLoop((e as unknown as Args).force === true)).catch(crashed)
  on('tool.call', { tool: 'mcp__dacapo__loop_discard' }, () => discardLoop()).catch(crashed)
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
    if (isAsk(row)) {
      // an asked node works in the run's worktree, which only workers change: it writes under .context alone
      const target = str(a.file_path) || str(a.notebook_path)
      if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && target && !isUnder(target, `${row.worktree}/.context`, row.worktree)) {
        return { deny: `dacapo ${row.node}: you answer, you do not change the run; write only under ${row.worktree}/.context` }
      }
      return next(e)
    }
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
        if (normalize(target, row.worktree) !== row.reportPath) return { deny: `dacapo ${judgeNode(row)}: you never change the code; the only file you write is ${row.reportPath}` }
      }
      return next(e)
    }
    // a judge that uses the product and its collectors alike: the product, never the source; the judge writes its report, a collector its evidence
    const who = collector ? 'dacapo QA collector' : `dacapo ${judgeName(row)}`
    const evidenceDir = `${contextDir}/evidence`
    if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const target = str(a.file_path) || str(a.notebook_path)
      if (!isUnder(target, contextDir, row.worktree)) {
        return { deny: `${who}: you judge the deliverable as its user and never open source. Only ${contextDir} is readable or writable.` }
      }
      if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit') {
        if (collector && !isUnder(target, evidenceDir, row.worktree)) return { deny: `${who}: write only under ${evidenceDir}; your judge writes the report.` }
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
    const els = elementsFor(e.surface, $.ui.resolve(e) as unknown as Els)
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    return drawPane(els, { run, rows, ui }, actions, e.props.bodyColumns, { prices })
  })

  on('ui.render', { component: 'Pane', requestId: LOOPS_PANE }, async ($, e, next) => {
    // before the session starts the mod knows no loops: the pane is left to what draws beneath
    if (!viewerReady) return next(e)
    const els = elementsFor(e.surface, $.ui.resolve(e) as unknown as Els)
    return drawViewer(els, await read($, viewerAtom), viewerActions, e.props.bodyColumns)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [run, rows, ui] = await Promise.all([read($, runAtom), read($, rowsAtom), read($, uiAtom)])
    const els = elementsFor(e.surface, $.ui.resolve(e) as unknown as Els)
    const tree = drawBand(els, { run, rows, ui }, actions, e.props.bodyColumns, e.props.maxRows, { prices })
    return tree ?? next(e)
  })
}
