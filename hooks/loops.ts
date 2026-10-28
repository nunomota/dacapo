import type { Contract, DraftInfo, Loop, LoopGraph, LoopLevel, LoopNode, LoopRef, NodeType, Problem, Stage, Transition } from '../types/loops'

/**
 * The file system the loop functions work over: the mod passes `$.fs` and a shell remove, tests an in-memory fake.
 * `stat` is optional; `readLoop` uses it only when it is given no content check, and without either it never takes
 * `loop.d2` as edited.
 */
export type LoopFs = {
  /** Rejects when the file is missing. */
  read: (path: string) => Promise<string>
  /** Creates the parent folders. */
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** Names, not paths; [] when the folder is missing. */
  list: (dir: string) => Promise<string[]>
  /** A file or a folder, recursively. */
  remove: (path: string) => Promise<void>
  /** The modification time in milliseconds, or null when the path is missing. */
  stat?: (path: string) => Promise<{ mtime: number } | null>
}

/** The loops folder of each level; null when a level has no root (no repository). */
export type Roots = Record<LoopLevel, string | null>

/** The levels from the one that wins to the one that loses: project over user over plugin. */
export const LEVELS: readonly LoopLevel[] = ['project', 'user', 'plugin']

/** A node, stage or loop id: lowercase letters, digits and inner hyphens. */
export const ID = /^[a-z0-9][a-z0-9-]*$/
/** A model name, as hooks/conf.ts takes it. */
const MODEL = /^[a-z][a-z0-9.-]*$/
/** A skill name as the Skill tool takes it, as hooks/conf.ts takes it. */
const SKILL = /^\/?([a-z0-9][a-z0-9_-]*:)?[a-z0-9][a-z0-9_-]*$/
const NODE_TYPES: readonly NodeType[] = ['entry', 'agent', 'swarm', 'exit']
const CONTRACTS: readonly Contract[] = ['lands', 'scores', 'collects', 'none', 'interviews']
/** The frontmatter keys of a node file, in the order they are written. */
export const NODE_KEYS = ['type', 'summary', 'contract', 'models', 'skills', 'tools', 'categories', 'collectors'] as const
/** The words a transition uses for the entry and the exit node. */
const ENTRY = 'entry'
const EXIT = 'exit'

/**
 * The node a transition's `entry` or `exit` word stands for, as a person reads it: `merge → done`, never
 * `merge → exit`. The words stay in loop.json and as the addresses the tools accept.
 */
export const endName = (loop: Pick<LoopGraph, 'entry' | 'exit'>, word: string): string => (word === ENTRY ? loop.entry : word === EXIT ? loop.exit : word)

/** A transition as a person reads it, the entry and the exit by their node ids: `merge → done`, `qa ⇢ implement`, `implement → qa ∥ review`. */
export const transitionWords = (loop: Pick<LoopGraph, 'entry' | 'exit'>, t: { from: string; to: string[]; back?: boolean }): string =>
  `${endName(loop, t.from)} ${t.back ? '⇢' : '→'} ${t.to.map(w => endName(loop, w)).join(' ∥ ')}`

/** What each contract holds a node to, in a few words: the one gloss focus, config, LOOP.md and the library use. */
export const CONTRACT_GLOSS: Record<Contract, string> = {
  lands: 'builds and lands work',
  scores: 'judges a rubric',
  collects: 'gathers evidence',
  none: 'answers a prompt',
  interviews: 'talks to the user and writes a report',
}

/** A contract with its gloss: `none (answers a prompt)`. */
export const contractText = (c: Contract): string => `${c} (${CONTRACT_GLOSS[c]})`

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The user-level root, `DACAPO_HOME` or `~/.claude/dacapo`, which holds `loops/` and `drafts/`. */
function userHome(env: { home: string; dacapoHome: string | null }): string {
  return env.dacapoHome ? env.dacapoHome.replace(/\/+$/, '') : join(env.home, '.claude/dacapo')
}

/** The loops folder of each level: the plugin's `loops/`, the user's `$DACAPO_HOME/loops`, the repository's `.claude/dacapo/loops`. */
export function roots(env: { home: string; dacapoHome: string | null; pluginRoot: string; repoRoot: string | null }): Roots {
  return {
    plugin: join(env.pluginRoot, 'loops'),
    user: join(userHome(env), 'loops'),
    project: env.repoRoot ? join(env.repoRoot, '.claude/dacapo/loops') : null,
  }
}

/** Where drafts live: `drafts/` beside the user's `loops/`, under `DACAPO_HOME` when it is set. */
export function draftsRoot(env: { home: string; dacapoHome: string | null }): string {
  return join(userHome(env), 'drafts')
}

/** The FNV-1a hash of a text as eight hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** JSON with every object's keys sorted and undefined values left out, so the same value always reads the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A hash of the loop that does not change with key order or the whitespace around a role. */
export function hashLoop(loop: Loop): string {
  const nodes = Object.fromEntries(Object.entries(loop.nodes).map(([id, n]) => [id, { ...n, role: n.role.trim() }]))
  return fnv1a(canonicalJson({ ...loop, nodes }))
}

/** The folder name of a draft: `user--<name>`, `plugin--<name>`, or `project--<hash of the repository>--<name>`. */
export function draftKey(ref: { level: LoopLevel; name: string; repoRoot: string | null }): string {
  if (ref.level === 'project') return `project--${fnv1a(ref.repoRoot ?? '')}--${ref.name}`
  return `${ref.level}--${ref.name}`
}

// Frontmatter

type Scalar = string | number

function parseScalar(raw: string): Scalar {
  const v = raw.trim()
  return /^[0-9]+$/.test(v) ? Number(v) : v
}

function parseList(raw: string): string[] | null {
  const m = /^\[(.*)\]$/.exec(raw.trim())
  if (!m) return null
  if (/[[\]{}]/.test(m[1]!)) return null
  return m[1]!
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
}

/**
 * Reads the frontmatter of a node file: `key: scalar`, `key: [a, b]` and `key: { name: [a, b] }` lines between two
 * `---` lines, then the body. Anything else is a problem naming its line; the body loses the blank line after the
 * frontmatter and trailing whitespace.
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; problems: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const data: Record<string, unknown> = {}
  const problems: string[] = []
  if (lines[0]?.trim() !== '---') return { data, body: text.trim(), problems: ['line 1: the file must start with a "---" line'] }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (close < 0) return { data, body: '', problems: ['the frontmatter has no closing "---" line'] }
  for (let i = 1; i < close; i++) {
    const raw = lines[i]!
    if (!raw.trim()) continue
    const m = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(raw.trim())
    if (!m) {
      problems.push(`line ${i + 1}: not "key: value": ${raw.trim()}`)
      continue
    }
    const key = m[1]!
    const rest = m[2]!
    if (key in data) {
      problems.push(`line ${i + 1}: "${key}" is set twice`)
      continue
    }
    if (rest.startsWith('[')) {
      const list = parseList(rest)
      if (list) data[key] = list
      else problems.push(`line ${i + 1}: "${key}" is not a list like [a, b]: ${rest}`)
    } else if (rest.startsWith('{')) {
      const o = /^\{\s*([a-z][a-z0-9-]*):\s*(\[.*\])\s*\}$/.exec(rest)
      const list = o ? parseList(o[2]!) : null
      if (o && list) data[key] = { [o[1]!]: list }
      else problems.push(`line ${i + 1}: "${key}" is not like { deny: [a, b] }: ${rest}`)
    } else if (!rest) {
      problems.push(`line ${i + 1}: "${key}" has no value`)
    } else {
      data[key] = parseScalar(rest)
    }
  }
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd()
  return { data, body, problems }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${formatValue(v)}`)
      .join(', ')} }`
  }
  return String(value)
}

/** Writes frontmatter in the subset `parseFrontmatter` reads, keys in the order given, then a blank line and the body. */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
  const text = body.trim()
  return `---\n${lines.join('\n')}\n---\n${text ? `\n${text}\n` : ''}`
}

const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** Reads `nodes/<id>.md` into a node; what is missing or malformed is a problem at `nodes.<id>` or `nodes.<id>.<key>`. */
export function nodeFromFile(id: string, text: string): { node: LoopNode; problems: Problem[] } {
  const { data, body, problems: raw } = parseFrontmatter(text)
  const at = (key?: string) => (key ? `nodes.${id}.${key}` : `nodes.${id}`)
  const problems: Problem[] = raw.map(message => ({ path: at(), message: `nodes/${id}.md ${message}` }))
  const node: LoopNode = { id, type: 'agent', summary: '', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: body }
  for (const key of Object.keys(data)) {
    if (!(NODE_KEYS as readonly string[]).includes(key)) problems.push({ path: at(key), message: `unknown key "${key}" (one of ${NODE_KEYS.join(', ')})` })
  }
  const type = data.type
  if (type === undefined) problems.push({ path: at('type'), message: `"type" is missing (one of ${NODE_TYPES.join(', ')})` })
  else if (NODE_TYPES.includes(type as NodeType)) node.type = type as NodeType
  else problems.push({ path: at('type'), message: `"type" must be one of ${NODE_TYPES.join(', ')}, not ${String(type)}` })
  if (data.summary === undefined) problems.push({ path: at('summary'), message: '"summary" is missing' })
  else node.summary = String(data.summary)
  const contract = data.contract
  if (contract === undefined) problems.push({ path: at('contract'), message: `"contract" is missing (one of ${CONTRACTS.join(', ')})` })
  else if (CONTRACTS.includes(contract as Contract)) node.contract = contract as Contract
  else problems.push({ path: at('contract'), message: `"contract" must be one of ${CONTRACTS.join(', ')}, not ${String(contract)}` })
  for (const key of ['models', 'skills', 'categories'] as const) {
    const v = data[key]
    if (v === undefined) continue
    if (stringList(v)) node[key] = v
    else problems.push({ path: at(key), message: `"${key}" must be a list like [a, b]` })
  }
  const tools = data.tools
  if (tools !== undefined) {
    const deny = (tools as Record<string, unknown>)?.deny
    if (tools && typeof tools === 'object' && Object.keys(tools).length === 1 && stringList(deny)) node.tools = { deny }
    else problems.push({ path: at('tools'), message: '"tools" must be like { deny: [Edit, Agent] }' })
  }
  const collectors = data.collectors
  if (collectors !== undefined) {
    if (typeof collectors === 'number') node.collectors = collectors
    else problems.push({ path: at('collectors'), message: `"collectors" must be a whole number, not ${String(collectors)}` })
  }
  return { node, problems }
}

/** Writes a node as `nodes/<id>.md`: the frontmatter keys in order, absent optional ones left out, then the role. */
export function nodeToFile(node: LoopNode): string {
  return serializeFrontmatter(
    {
      type: node.type,
      summary: node.summary,
      contract: node.contract,
      models: node.models,
      skills: node.skills,
      tools: { deny: node.tools.deny },
      categories: node.categories,
      collectors: node.collectors,
    },
    node.role,
  )
}

// The graph

/** The graph of a loop, its keys and those of each part in the order of the type, as loop.json stores it. */
export function graphOf(loop: LoopGraph): LoopGraph {
  return {
    name: loop.name,
    description: loop.description,
    entry: loop.entry,
    exit: loop.exit,
    steps: loop.steps.map(s => ({ stages: s.stages.map(st => ({ id: st.id, summary: st.summary, nodes: [...st.nodes] })) })),
    onCall: Object.fromEntries(Object.entries(loop.onCall).map(([k, v]) => [k, [...v]])),
    transitions: loop.transitions.map(t => ({ from: t.from, to: [...t.to], back: t.back || undefined, label: t.label, when: t.when, then: t.then })),
    handovers: loop.handovers.map(h => ({ from: h.from, to: h.to, label: h.label, spec: h.spec })),
  }
}

/** loop.json's text: the graph with two-space indent and a trailing newline. */
export function graphToJson(loop: LoopGraph): string {
  return `${JSON.stringify(graphOf(loop), null, 2)}\n`
}

/** Where each stage id sits: its step index and its index inside the step. */
export function stageIndex(graph: LoopGraph): Map<string, { step: number; index: number; stage: Stage }> {
  const out = new Map<string, { step: number; index: number; stage: Stage }>()
  graph.steps.forEach((s, step) => s.stages.forEach((stage, index) => out.has(stage.id) || out.set(stage.id, { step, index, stage })))
  return out
}

/**
 * The graph with a forward transition added for every source that lists none: the entry to the first step, each stage
 * to the next step, the last step to the exit (the entry straight to the exit when there are no steps). Added ones
 * have an empty label and come after the listed ones.
 */
export function withDefaultTransitions(graph: LoopGraph): LoopGraph {
  const steps = graph.steps.filter(s => s.stages.length > 0)
  const targets = (i: number) => (i < steps.length ? steps[i]!.stages.map(s => s.id) : [EXIT])
  const hasForward = (from: string) => graph.transitions.some(t => t.from === from && !t.back)
  const added: Transition[] = []
  if (!hasForward(ENTRY)) added.push({ from: ENTRY, to: targets(0), label: '' })
  steps.forEach((step, i) => {
    for (const stage of step.stages) if (!hasForward(stage.id)) added.push({ from: stage.id, to: targets(i + 1), label: '' })
  })
  return { ...graph, transitions: [...graph.transitions, ...added] }
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/** Checks a loop against every rule of the model; each problem names the rule it breaks and where. */
export function validateLoop(loop: Loop): Problem[] {
  const problems: Problem[] = []
  const add = (path: string, message: string) => problems.push({ path, message })
  const nodes = loop.nodes
  const ids = Object.keys(nodes)
  const stages = stageIndex(loop)

  // The loop itself.
  if (!loop.name.trim()) add('name', 'the loop has no name; a name is required')
  else if (!ID.test(loop.name)) add('name', `the name "${loop.name}" is not an id: lowercase letters, digits and inner hyphens`)
  if (!loop.description.trim()) add('description', 'the description is empty; say in a sentence what the loop is for')

  // Entry and exit.
  for (const kind of ['entry', 'exit'] as const) {
    const ofType = ids.filter(id => nodes[id]!.type === kind)
    const named = loop[kind]
    if (ofType.length !== 1) add(kind, `the loop needs exactly one ${kind} node; it has ${ofType.length}${ofType.length ? ` (${ofType.join(', ')})` : ''}`)
    if (!nodes[named]) add(kind, `${kind} names "${named}", which is not a node; the ${kind} must name the ${kind} node`)
    else if (nodes[named]!.type !== kind) add(kind, `${kind} names "${named}", which is of type ${nodes[named]!.type}; the ${kind} must name the ${kind} node`)
  }

  // Nodes.
  for (const id of ids) {
    const n = nodes[id]!
    const at = (key?: string) => (key ? `nodes.${id}.${key}` : `nodes.${id}`)
    if (!ID.test(id)) add(at(), `the node id "${id}" is not an id: lowercase letters, digits and inner hyphens`)
    if (n.id !== id) add(at(), `the node is filed as "${id}" but its id is "${n.id}"; ids must match their file`)
    const w = words(n.summary)
    if (w < 1 || w > 5) add(at('summary'), `the summary has ${w} words; a summary has 1 to 5 words`)
    if (n.type === 'entry' || n.type === 'exit') {
      if (n.contract !== 'none') add(at('contract'), `the ${n.type} node has contract ${n.contract}; entry and exit have contract none`)
      if (n.models.length > 0) add(at('models'), `the ${n.type} node lists models; entry and exit have no models`)
    }
    if ((n.contract === 'lands' || n.contract === 'scores' || n.contract === 'interviews') && n.models.length === 0) add(at('models'), `a ${n.contract} node needs at least one model`)
    if (n.contract === 'scores' && !(n.categories && n.categories.length > 0)) add(at('categories'), 'a scores node needs categories: the rubric categories it accepts')
    if (n.contract !== 'scores' && n.categories !== undefined) add(at('categories'), 'categories are for scores nodes only')
    if (n.contract !== 'scores' && n.collectors !== undefined) add(at('collectors'), 'collectors are for scores nodes only')
    if (n.collectors !== undefined && !(Number.isInteger(n.collectors) && n.collectors >= 0)) add(at('collectors'), 'collectors must be a whole number from 0 up')
    if (n.contract === 'collects' && !loop.handovers.some(h => h.to === id && nodes[h.from]?.contract === 'scores')) {
      add(at('contract'), 'a collects node needs a handover from a scores node: the judge it gathers evidence for')
    }
    const badModel = n.models.find(m => !MODEL.test(m))
    if (badModel !== undefined) add(at('models'), `"${badModel}" is not a model name like opus or claude-sonnet-5`)
    const badSkill = n.skills.find(s => !SKILL.test(s))
    if (badSkill !== undefined) add(at('skills'), `"${badSkill}" is not a skill name like my-rules or plugin:skill`)
  }

  // Stages and steps.
  const seen = new Set<string>()
  loop.steps.forEach((step, i) => {
    if (step.stages.length === 0) add(`steps[${i}]`, 'the step has no stage; every step has at least one stage')
    step.stages.forEach((st, j) => {
      const at = `steps[${i}].stages[${j}]`
      if (!ID.test(st.id)) add(at, `the stage id "${st.id}" is not an id: lowercase letters, digits and inner hyphens`)
      else if (st.id === ENTRY || st.id === EXIT) add(at, `"${st.id}" is the word transitions use for the ${st.id} node; a stage needs another id`)
      if (seen.has(st.id)) add(at, `the stage "${st.id}" appears more than once; every stage is in exactly one step and ids are unique`)
      seen.add(st.id)
      const w = words(st.summary)
      if (w < 1 || w > 5) add(`${at}.summary`, `the summary has ${w} words; a summary has 1 to 5 words`)
      const unknown = st.nodes.filter(n => !nodes[n])
      if (unknown.length > 0) add(`${at}.nodes`, `the stage lists ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a node' : 'are not nodes'}`)
      const lands = st.nodes.filter(n => nodes[n]?.contract === 'lands')
      if (lands.length > 1) add(at, `the stage holds ${lands.length} lands nodes (${lands.join(', ')}); a stage holds at most one lands node`)
    })
  })

  // Placement: every node in exactly one place, entry and exit in none.
  const places = new Map<string, number>()
  const place = (id: string) => places.set(id, (places.get(id) ?? 0) + 1)
  loop.steps.forEach(s => s.stages.forEach(st => st.nodes.forEach(place)))
  for (const [key, helpers] of Object.entries(loop.onCall)) {
    if (!nodes[key]) add(`onCall.${key}`, `"${key}" is on call but is not a node`)
    place(key)
    for (const h of helpers) {
      if (!nodes[h]) add(`onCall.${key}`, `the helper "${h}" is not a node`)
      place(h)
    }
  }
  for (const id of ids) {
    const n = nodes[id]!
    const count = places.get(id) ?? 0
    if (n.type === 'entry' || n.type === 'exit') {
      if (count > 0) add(`nodes.${id}`, `the ${n.type} node is placed in a stage or on call; entry and exit are in no stage`)
    } else if (count === 0) {
      add(`nodes.${id}`, `"${id}" is in no stage and not on call; every node is in exactly one place`)
    } else if (count > 1) {
      add(`nodes.${id}`, `"${id}" is placed ${count} times; every node is in exactly one place`)
    }
  }

  // Transitions.
  const known = (id: string) => id === ENTRY || id === EXIT || stages.has(id)
  const stepOf = (id: string) => (id === ENTRY ? -1 : id === EXIT ? loop.steps.length : (stages.get(id)?.step ?? NaN))
  loop.transitions.forEach((t, k) => {
    const at = `transitions[${k}]`
    const unknown = [t.from, ...t.to].filter(id => !known(id))
    if (unknown.length > 0) {
      add(at, `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a stage' : 'are not stages'}; from and to name known stages or entry and exit`)
      return
    }
    if (t.to.length === 0) return add(at, 'the transition goes nowhere; to lists the stages it leads to')
    if (t.from === EXIT) return add(at, 'a transition cannot leave exit; from and to name known stages or entry and exit')
    if (t.to.includes(ENTRY)) return add(at, 'a transition cannot lead to entry; from and to name known stages or entry and exit')
    const targetSteps = new Set(t.to.map(stepOf))
    if (t.back) {
      if (targetSteps.size !== 1 || ![...targetSteps].every(s => s < stepOf(t.from))) add(at, 'a back transition points to an earlier step')
      return
    }
    const target = [...targetSteps][0]!
    const full = t.to.includes(EXIT) ? t.to.length === 1 : targetSteps.size === 1 && loop.steps[target]!.stages.length === new Set(t.to).size
    if (!full) add(at, 'to of a forward transition lists every stage of one step')
    else if (target <= stepOf(t.from)) add(at, 'a transition to an earlier step or its own is marked back')
  })

  // Reachability, with the default transitions.
  const graph = withDefaultTransitions(loop)
  const reached = new Set<string>([ENTRY])
  const queue = [ENTRY]
  while (queue.length > 0) {
    const from = queue.shift()!
    for (const t of graph.transitions) {
      if (t.from !== from) continue
      for (const to of t.to) if (!reached.has(to)) reached.add(to), queue.push(to)
    }
  }
  loop.steps.forEach((s, i) =>
    s.stages.forEach((st, j) => {
      if (!reached.has(st.id)) add(`steps[${i}].stages[${j}]`, `the stage "${st.id}" is not reachable from entry; every stage is reachable`)
    }),
  )
  if (!reached.has(EXIT)) add('exit', 'exit is not reachable from entry; a run must be able to end')

  // Handovers.
  const pairs = new Set<string>()
  loop.handovers.forEach((h, k) => {
    const at = `handovers[${k}]`
    const unknown = [h.from, h.to].filter(id => !nodes[id])
    if (unknown.length > 0) add(at, `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a node' : 'are not nodes'}; a handover names known nodes`)
    if (h.from === h.to) add(at, `the handover goes from "${h.from}" to itself; from differs from to`)
    const pair = `${h.from}\u0000${h.to}`
    if (pairs.has(pair)) add(at, `a second handover from "${h.from}" to "${h.to}"; there is no duplicate pair`)
    pairs.add(pair)
  })
  return problems
}

// Files

const emptyGraph = (name: string): LoopGraph => ({ name, description: '', entry: '', exit: '', steps: [], onCall: {}, transitions: [], handovers: [] })

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reads loop.json's text into a graph, keeping what is well formed; the rest is a problem at its path. */
export function graphFromJson(text: string, fallbackName: string): { graph: LoopGraph; problems: Problem[] } {
  const problems: Problem[] = []
  const add = (path: string, message: string) => problems.push({ path, message })
  const graph = emptyGraph(fallbackName)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    add('loop.json', `loop.json is not JSON: ${errorText(e)}`)
    return { graph, problems }
  }
  if (!isObject(raw)) {
    add('loop.json', 'loop.json is not an object')
    return { graph, problems }
  }
  for (const key of ['name', 'description', 'entry', 'exit'] as const) {
    if (typeof raw[key] === 'string') graph[key] = raw[key] as string
    else add(key, `"${key}" is missing or not a string`)
  }
  const strings = (v: unknown) => stringList(v)
  if (Array.isArray(raw.steps)) {
    raw.steps.forEach((s, i) => {
      if (!isObject(s) || !Array.isArray(s.stages)) return add(`steps[${i}]`, 'a step is { "stages": [...] }')
      const stages: Stage[] = []
      s.stages.forEach((st, j) => {
        if (isObject(st) && typeof st.id === 'string' && typeof st.summary === 'string' && strings(st.nodes)) stages.push({ id: st.id, summary: st.summary, nodes: st.nodes as string[] })
        else add(`steps[${i}].stages[${j}]`, 'a stage is { "id", "summary", "nodes": [...] }')
      })
      graph.steps.push({ stages })
    })
  } else add('steps', '"steps" is missing or not a list')
  if (isObject(raw.onCall)) {
    for (const [k, v] of Object.entries(raw.onCall)) {
      if (strings(v)) graph.onCall[k] = v as string[]
      else add(`onCall.${k}`, 'an on-call node maps to a list of helper ids')
    }
  } else add('onCall', '"onCall" is missing or not an object')
  if (Array.isArray(raw.transitions)) {
    raw.transitions.forEach((t, k) => {
      const ok =
        isObject(t) &&
        typeof t.from === 'string' &&
        strings(t.to) &&
        typeof t.label === 'string' &&
        (t.back === undefined || typeof t.back === 'boolean') &&
        (t.when === undefined || typeof t.when === 'string') &&
        (t.then === undefined || typeof t.then === 'string')
      if (!ok) return add(`transitions[${k}]`, 'a transition is { "from", "to": [...], "label" } with optional "back", "when", "then"')
      graph.transitions.push({ from: t.from as string, to: t.to as string[], back: (t.back as boolean | undefined) || undefined, label: t.label as string, when: t.when as string | undefined, then: t.then as string | undefined })
    })
  } else add('transitions', '"transitions" is missing or not a list')
  if (Array.isArray(raw.handovers)) {
    raw.handovers.forEach((h, k) => {
      if (isObject(h) && typeof h.from === 'string' && typeof h.to === 'string' && typeof h.label === 'string' && typeof h.spec === 'string') {
        graph.handovers.push({ from: h.from, to: h.to, label: h.label, spec: h.spec })
      } else add(`handovers[${k}]`, 'a handover is { "from", "to", "label", "spec" }')
    })
  } else add('handovers', '"handovers" is missing or not a list')
  return { graph: graphOf(graph), problems }
}

/** Every node id the graph refers to: entry, exit, stage nodes, on-call nodes and helpers, handover ends. */
export function referencedNodes(graph: LoopGraph): Set<string> {
  const out = new Set<string>()
  if (graph.entry) out.add(graph.entry)
  if (graph.exit) out.add(graph.exit)
  graph.steps.forEach(s => s.stages.forEach(st => st.nodes.forEach(n => out.add(n))))
  for (const [k, v] of Object.entries(graph.onCall)) [k, ...v].forEach(n => out.add(n))
  graph.handovers.forEach(h => (out.add(h.from), out.add(h.to)))
  return out
}

const baseName = (dir: string) => dir.replace(/\/+$/, '').split('/').pop() ?? ''

/** Whether loop.d2's text says something the stored loop does not; hooks/loopd2.ts has `d2Differs`. */
export type D2Check = (d2: string, loop: Loop) => boolean

/**
 * Reads a loop folder: loop.json and every nodes/*.md, as stored (no default transitions). A file that cannot be read
 * or parsed, a node file nothing refers to and a node referred to without a file are problems.
 *
 * `d2Edited` is true when loop.d2 exists and was edited by hand since the last save. With `isEdited` (pass
 * `d2Differs` from hooks/loopd2.ts) that is a content rule: the diagram fails to parse or draws something the stored
 * loop does not. Without it, the older rule stands: loop.d2 changed after loop.json, when `fs.stat` is there.
 */
export async function readLoop(
  fs: LoopFs,
  dir: string,
  isEdited?: D2Check,
): Promise<{
  loop: Loop
  problems: Problem[]
  d2Edited: boolean
  /** @deprecated The same value as `d2Edited`, kept for the callers that read this name. */
  d2Newer: boolean
}> {
  const problems: Problem[] = []
  let text: string | null = null
  try {
    text = await fs.read(join(dir, 'loop.json'))
  } catch (e) {
    problems.push({ path: 'loop.json', message: `loop.json cannot be read: ${errorText(e)}` })
  }
  const parsed = text === null ? { graph: emptyGraph(baseName(dir)), problems: [] } : graphFromJson(text, baseName(dir))
  problems.push(...parsed.problems)
  const nodes: Record<string, LoopNode> = {}
  const files = (await fs.list(join(dir, 'nodes'))).filter(n => n.endsWith('.md')).sort()
  for (const file of files) {
    const id = file.slice(0, -3)
    try {
      const out = nodeFromFile(id, await fs.read(join(dir, 'nodes', file)))
      nodes[id] = out.node
      problems.push(...out.problems)
    } catch (e) {
      problems.push({ path: `nodes.${id}`, message: `nodes/${file} cannot be read: ${errorText(e)}` })
    }
  }
  const referenced = referencedNodes(parsed.graph)
  for (const id of referenced) if (!nodes[id] && !files.includes(`${id}.md`)) problems.push({ path: `nodes.${id}`, message: `loop.json refers to "${id}" but there is no nodes/${id}.md` })
  for (const id of Object.keys(nodes)) if (!referenced.has(id)) problems.push({ path: `nodes.${id}`, message: `nodes/${id}.md is not referred to by loop.json` })
  const loop = { ...parsed.graph, nodes }
  let d2Edited = false
  if (text !== null && (isEdited || fs.stat) && (await fs.exists(join(dir, 'loop.d2')))) {
    if (isEdited) {
      const d2 = await fs.read(join(dir, 'loop.d2')).catch(() => null)
      d2Edited = d2 !== null && isEdited(d2, loop)
    } else {
      const [d2, json] = await Promise.all([fs.stat!(join(dir, 'loop.d2')), fs.stat!(join(dir, 'loop.json'))])
      d2Edited = !!d2 && !!json && d2.mtime > json.mtime
    }
  }
  return { loop, problems, d2Edited, d2Newer: d2Edited }
}

/**
 * Writes a loop folder: nodes/<id>.md for every node, LOOP.md, each `extra` file, then loop.json last, so no file of
 * the save is newer than it; node files of ids no longer in the loop go.
 */
export async function writeLoop(fs: LoopFs, dir: string, loop: Loop, extra?: Record<string, string>): Promise<void> {
  const ids = Object.keys(loop.nodes)
  for (const id of ids) await fs.write(join(dir, 'nodes', `${id}.md`), nodeToFile(loop.nodes[id]!))
  for (const name of await fs.list(join(dir, 'nodes'))) {
    if (name.endsWith('.md') && !ids.includes(name.slice(0, -3))) await fs.remove(join(dir, 'nodes', name))
  }
  await fs.write(join(dir, 'LOOP.md'), toSpec(loop))
  for (const [name, text] of Object.entries(extra ?? {})) await fs.write(join(dir, name), text)
  await fs.write(join(dir, 'loop.json'), graphToJson(loop))
}

// The prose spec

const sentence = (text: string) => {
  const t = text.trim()
  if (!t) return ''
  const s = t[0]!.toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

const TYPE_WORDS: Record<NodeType, string> = {
  entry: 'The entry: it runs the loop.',
  exit: 'The exit.',
  agent: 'One agent.',
  swarm: 'A swarm: as many agents as the round has tasks or slices.',
}

function contractWords(n: LoopNode): string {
  const head = `Contract: ${contractText(n.contract)}.`
  if (n.contract === 'lands') return `${head} It lands its own work and reports how it went.`
  if (n.contract === 'collects') return `${head} It gathers evidence for the judge that hands it a slice, and never scores.`
  if (n.contract === 'none') return head
  if (n.contract === 'interviews') return `${head} It talks to the user itself, writes a report in the format its role defines and hands the floor back.`
  const categories = n.categories?.length ? ` in the categories ${n.categories.join(', ')}` : ''
  const collectors = n.collectors ? ` It may run up to ${n.collectors} collector${n.collectors === 1 ? '' : 's'} at once.` : ''
  return `${head} It scores every rubric item${categories}, and the host derives the verdict.${collectors}`
}

/** The node ids in the order the spec lists them: entry, on call with helpers, stages in step order, any left over, exit. */
export function nodeOrder(loop: Loop): string[] {
  const out: string[] = []
  const push = (id: string) => loop.nodes[id] && !out.includes(id) && out.push(id)
  push(loop.entry)
  for (const [k, v] of Object.entries(loop.onCall)) [k, ...v].forEach(push)
  loop.steps.forEach(s => s.stages.forEach(st => st.nodes.forEach(push)))
  Object.keys(loop.nodes).filter(id => id !== loop.exit).forEach(push)
  push(loop.exit)
  return out
}

function placeWords(loop: Loop, id: string): string {
  if (id === loop.entry || id === loop.exit) return ''
  if (loop.onCall[id]) return ' On call: usable at any point of the run.'
  const owner = Object.entries(loop.onCall).find(([, v]) => v.includes(id))
  if (owner) return ` A helper of ${owner[0]}, which is on call.`
  for (const s of loop.steps) for (const st of s.stages) if (st.nodes.includes(id)) return ` It works in the ${st.id} stage.`
  return ' It has no place in the loop yet.'
}

/** The settings of a node the role section lists under its summary line: models, skills, a judge's categories and collectors, denied tools. */
function settingLines(n: LoopNode): string[] {
  const list = (items: string[] | undefined) => (items?.length ? items.join(', ') : 'none')
  const out = [`- Models: ${list(n.models)}`, `- Skills: ${list(n.skills)}`]
  if (n.contract === 'scores') out.push(`- Categories: ${list(n.categories)}`)
  if (n.contract === 'scores' && n.collectors !== undefined) out.push(`- Collectors: ${n.collectors}`)
  if (n.tools.deny.length) out.push(`- Denied tools: ${n.tools.deny.join(', ')}`)
  return out
}

/**
 * The paragraph LOOP.md opens with, for a reader without the plugin: what the file is, and the words the rest of it
 * uses (a loop, the orchestrator, a swarm, a back transition, the host).
 */
function readerNote(loop: Loop): string {
  const who = loop.entry === 'orchestrator' ? 'the orchestrator (the agent the user talks to)' : `the orchestrator (the agent the user talks to; ${loop.entry} below)`
  return [
    `This file describes the ${loop.name} loop in plain words, so any agent can follow it without the dacapo plugin; it is generated from loop.json and the node files beside it.`,
    `A loop is a sequence of steps that ${who} walks in order; a step holds one or more stages that run side by side, and each stage names the agents that work in it.`,
    'A swarm is many copies of one agent running at once, one per task or slice.',
    'A transition marked (back) returns the loop to an earlier step, and one marked (default) is the plain move to the next step.',
    'The host is whatever program runs the agents and lands their work.',
  ].join(' ')
}

/** LOOP.md: the loop as prose, generated from loop.json and the node files. */
export function toSpec(loop: Loop): string {
  const out = ['<!-- generated by dacapo from loop.json and nodes/*.md; edit those, not this -->', '', `# ${loop.name}`, '', sentence(loop.description), '', readerNote(loop), '', '## Roles', '']
  for (const id of nodeOrder(loop)) {
    const n = loop.nodes[id]!
    out.push(`### ${id}`, '', `${sentence(n.summary)} ${TYPE_WORDS[n.type]}${placeWords(loop, id)} ${contractWords(n)}`, '', ...settingLines(n), '')
    if (n.role.trim()) out.push(n.role.trim(), '')
  }
  out.push('## Order', '')
  const alone = `(the ${loop.entry} alone)`
  loop.steps.forEach((s, i) => out.push(`${i + 1}. ${s.stages.map(st => `${st.id} (${st.summary})${st.nodes.length ? '' : ` ${alone}`}`).join(' ∥ ')}`))
  if (loop.steps.length === 0) out.push('No steps: the entry hands straight to the exit.')
  out.push('', '## Transitions', '')
  for (const t of withDefaultTransitions(loop).transitions) {
    out.push(`- ${endName(loop, t.from)} → ${t.to.map(w => endName(loop, w)).join(' ∥ ')}${t.back ? ' (back)' : ''}${t.label ? `: ${t.label}` : ' (default)'}`)
    if (t.when) out.push(`  When ${t.when.trim().replace(/[.]$/, '')}.`)
    if (t.then) out.push(`  Then ${t.then.trim().replace(/[.]$/, '')}.`)
  }
  out.push('', '## Handovers', '')
  for (const h of loop.handovers) out.push(`- ${h.from} → ${h.to}: ${h.label}. ${sentence(h.spec)}`)
  if (loop.handovers.length === 0) out.push('None.')
  return `${out.join('\n')}\n`
}

// Listing

/** The counts the library shows for a loop: stages, steps, node files, and edges as drawn (default transitions included). */
export function countsOf(graph: LoopGraph, nodeCount: number): LoopRef['counts'] {
  return {
    stages: graph.steps.reduce((sum, s) => sum + s.stages.length, 0),
    steps: graph.steps.length,
    nodes: nodeCount,
    edges: withDefaultTransitions(graph).transitions.length + graph.handovers.length,
  }
}

/**
 * Lists the loops of every level, project first, then user, then plugin, names alphabetical within a level. A loop is
 * a folder holding loop.json. With `drafts`, a loop carries its draft state, and a loop that is a draft alone so far
 * (a new loop not saved yet, at the user or project level) is listed too, `unsaved`, with the folder its save writes.
 * A name resolves project over user over plugin: the loop that wins says which levels it `hides`, each one hidden says
 * `shadowedBy`. Without `drafts`, only saved loops count, as for a run; with them, a draft alone counts at its level,
 * as for opening a loop by name.
 */
export async function listLoops(fs: LoopFs, roots: Roots, drafts?: { root: string; repoRoot: string | null }): Promise<LoopRef[]> {
  const out: LoopRef[] = []
  const keys = drafts ? await fs.list(drafts.root) : []
  for (const level of LEVELS) {
    const root = roots[level]
    if (!root) continue
    const refs: LoopRef[] = []
    for (const name of (await fs.list(root)).filter(n => ID.test(n)).sort()) {
      const dir = join(root, name)
      if (!(await fs.exists(join(dir, 'loop.json')))) continue
      let graph = emptyGraph(name)
      try {
        graph = graphFromJson(await fs.read(join(dir, 'loop.json')), name).graph
      } catch {
        // An unreadable loop.json still lists the folder; reading the loop names the problem.
      }
      const nodeCount = (await fs.list(join(dir, 'nodes'))).filter(n => n.endsWith('.md')).length
      const ref: LoopRef = { name, level, dir, description: graph.description, counts: countsOf(graph, nodeCount) }
      if (drafts) {
        const draft = await readDraftInfo(fs, join(drafts.root, draftKey({ level, name, repoRoot: drafts.repoRoot })))
        if (draft) ref.draft = draft
      }
      refs.push(ref)
    }
    // a new loop not saved yet lives only as its draft; a plugin loop always has its folder
    if (drafts && level !== 'plugin') {
      const prefix = draftKey({ level, name: '', repoRoot: drafts.repoRoot })
      for (const key of keys.filter(k => k.startsWith(prefix)).sort()) {
        const name = key.slice(prefix.length)
        if (!ID.test(name) || refs.some(r => r.name === name)) continue
        const draft = await readDraft(fs, drafts.root, key).catch(() => null)
        if (!draft) continue
        const loop = draft.loop
        refs.push({ name, level, dir: join(root, name), description: loop.description, draft: draft.info, unsaved: true, counts: countsOf(loop, Object.keys(loop.nodes).length) })
      }
      refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    }
    out.push(...refs)
  }
  // resolution: the first level that has a name wins it
  for (const ref of out) {
    const winner = out.find(r => r.name === ref.name)!
    if (winner === ref) continue
    ref.shadowedBy = winner.level
    winner.hides = [...(winner.hides ?? []), ref.level]
  }
  return out
}

// Drafts

/** A new loop with only an entry `orchestrator` and an exit `done`. */
export function blankLoop(name: string): Loop {
  const end = (id: string, type: NodeType, summary: string, role: string): LoopNode => ({ id, type, summary, contract: 'none', models: [], skills: [], tools: { deny: [] }, role })
  return {
    name,
    description: 'A new loop.',
    entry: 'orchestrator',
    exit: 'done',
    steps: [],
    onCall: {},
    transitions: [],
    handovers: [],
    nodes: {
      orchestrator: end('orchestrator', 'entry', 'talks to you', 'You are the orchestrator of this loop: you talk to the user and run the loop.'),
      done: end('done', 'exit', 'the run ends', 'The run ends here.'),
    },
  }
}

const draftJson = (info: DraftInfo) => `${JSON.stringify({ base: info.base, since: info.since, changes: info.changes }, null, 2)}\n`

async function readDraftInfo(fs: LoopFs, dir: string): Promise<DraftInfo | null> {
  if (!(await fs.exists(join(dir, 'draft.json')))) return null
  try {
    const raw = JSON.parse(await fs.read(join(dir, 'draft.json'))) as Record<string, unknown>
    return {
      dir,
      base: typeof raw.base === 'string' ? raw.base : null,
      since: typeof raw.since === 'number' ? raw.since : 0,
      changes: stringList(raw.changes) ? raw.changes : [],
    }
  } catch {
    return { dir, base: null, since: 0, changes: [] }
  }
}

/** Reads the draft under `key`, or null when there is none. */
export async function readDraft(fs: LoopFs, draftsRoot: string, key: string): Promise<{ loop: Loop; info: DraftInfo } | null> {
  const info = await readDraftInfo(fs, join(draftsRoot, key))
  if (!info) return null
  return { loop: (await readLoop(fs, info.dir)).loop, info }
}

/**
 * Opens the draft of a loop: the existing one when there is one, else a copy of `loop` (a new blank loop when null)
 * written into the draft folder with draft.json naming the hash it was copied from.
 */
export async function openDraft(
  fs: LoopFs,
  draftsRoot: string,
  ref: { level: LoopLevel; name: string; repoRoot: string | null },
  loop: Loop | null,
): Promise<{ loop: Loop; info: DraftInfo }> {
  const key = draftKey(ref)
  const existing = await readDraft(fs, draftsRoot, key)
  if (existing) return existing
  const copy = loop ?? blankLoop(ref.name)
  const info: DraftInfo = { dir: join(draftsRoot, key), base: loop ? hashLoop(loop) : null, since: Date.now(), changes: [] }
  await writeLoop(fs, info.dir, copy)
  await fs.write(join(info.dir, 'draft.json'), draftJson(info))
  return { loop: copy, info }
}

/**
 * Writes the loop into its draft folder, `loop.d2` (the diagram as `toD2` in hooks/loopd2.ts writes it, opaque blocks
 * included) beside the other files, so a draft is a whole loop folder; appends each change, one line per op, to
 * draft.json. Returns the draft state after it.
 */
export async function writeDraft(fs: LoopFs, info: DraftInfo, loop: Loop, changes: string | string[], d2: string): Promise<DraftInfo> {
  await writeLoop(fs, info.dir, loop, { 'loop.d2': d2 })
  const next: DraftInfo = { ...info, changes: [...info.changes, ...(typeof changes === 'string' ? [changes] : changes)] }
  await fs.write(join(info.dir, 'draft.json'), draftJson(next))
  return next
}

/** Removes a draft folder. */
export async function discardDraft(fs: LoopFs, info: DraftInfo): Promise<void> {
  await fs.remove(info.dir)
}
