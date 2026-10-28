import type { Contract, DraftInfo, Handover, Loop, LoopLevel, LoopNode, LoopRef, Problem, Stage, Step, Transition } from '../types/loops'
import { fromD2, toD2 } from './loopd2'
import { blankLoop, countsOf, discardDraft, draftKey, endName, graphOf, hashLoop, ID, readLoop, stageIndex, transitionWords, validateLoop, withDefaultTransitions, writeLoop, type LoopFs, type Roots } from './loops'

// The architect edits a draft of one loop through a fixed set of operations. `applyOps` checks and applies them to a
// copy of the loop; the on-disk operations create, rename, move, delete and save loop folders and their drafts.

/** One edit of a loop draft, as the architect's `loop_edit` tool takes it. */
export type Op =
  | { op: 'stage.add'; id: string; summary: string; after?: number; alongside?: string }
  | { op: 'stage.remove'; id: string }
  | { op: 'stage.move'; id: string; after?: number; alongside?: string }
  | { op: 'stage.split'; id: string }
  | { op: 'stage.rename'; id: string; to: string }
  | { op: 'stage.summary'; id: string; summary: string }
  | {
      op: 'node.add'
      id: string
      type: 'agent' | 'swarm'
      contract: Contract
      summary: string
      stage?: string
      onCall?: true
      helperOf?: string
      models?: string[]
      skills?: string[]
      tools?: { deny: string[] }
      categories?: string[]
      collectors?: number
    }
  | { op: 'node.remove'; id: string }
  | { op: 'node.move'; id: string; stage?: string; onCall?: true; helperOf?: string }
  | { op: 'node.set'; id: string; models?: string[]; skills?: string[]; tools?: { deny: string[] }; contract?: Contract; summary?: string; categories?: string[]; collectors?: number }
  | { op: 'node.role'; id: string; text: string }
  | { op: 'node.rename'; id: string; to: string }
  | { op: 'transition.set'; from: string; to: string[]; back?: boolean; label: string; when?: string; then?: string }
  | { op: 'transition.remove'; from: string; to: string[] }
  | { op: 'handover.set'; from: string; to: string; label: string; spec: string }
  | { op: 'handover.remove'; from: string; to: string }
  | { op: 'loop.describe'; description: string }
  | { op: 'loop.rename'; to: string }
  | { op: 'import-d2' }

/** The words a transition uses for the entry and the exit node, as hooks/loops.ts has them. */
const ENTRY = 'entry'
const EXIT = 'exit'
/** The role a node added by the architect starts with, as hooks/loopd2.ts stubs one. */
const STUB_ROLE = 'Role to be written.'
const CONTRACTS: readonly Contract[] = ['lands', 'scores', 'collects', 'none', 'interviews']

/** Copied from hooks/loops.ts, where it is not exported. */
const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size
const list = (items: string[]) => (items.length ? items.join(', ') : 'none')
/** Names in prose: `a`, `a and b`, `a, b and c`; `or` for a choice. */
const series = (items: string[], conj: 'and' | 'or' = 'and') => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${conj} ${items.at(-1)}`)
/** An id to suggest for a name that is not one: `Docs Only` becomes `docs-only`. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const stageIdsOf = (loop: Loop) => loop.steps.flatMap(s => s.stages.map(st => st.id))

/** A refusal of one op: thrown inside `applyOps`, caught at the op that raised it. */
class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message)
}

// Describing

function placement(o: { stage?: string; onCall?: true; helperOf?: string }): string {
  if (o.stage !== undefined) return `in stage ${o.stage}`
  if (o.helperOf !== undefined) return `as a helper of ${o.helperOf}`
  return 'on call'
}

function position(o: { after?: number; alongside?: string }): string {
  if (o.alongside !== undefined) return `alongside ${o.alongside}`
  if (o.after === undefined) return 'as the last step'
  if (o.after < 0) return 'as the first step'
  return `after step ${o.after + 1}`
}

/**
 * One line in the user's words for the change list: `added stage security alongside qa`, `moved worker on call`, ...
 * With the loop, a transition's entry and exit are named by their node ids, as everywhere a person reads them.
 */
export function describeOp(op: Op, loop?: Pick<Loop, 'entry' | 'exit'>): string {
  const end = (word: string) => (loop ? endName(loop, word) : word)
  const ends = (words: string[]) => words.map(end).join(' and ')
  switch (op.op) {
    case 'stage.add':
      return `added stage ${op.id} ${position(op)}`
    case 'stage.remove':
      return `removed stage ${op.id}`
    case 'stage.move':
      return `moved stage ${op.id} ${op.alongside === undefined && op.after === undefined ? 'to the last step' : position(op)}`
    case 'stage.split':
      return `split stage ${op.id} into its own step`
    case 'stage.rename':
      return `renamed stage ${op.id} to ${op.to}`
    case 'stage.summary':
      return `set the summary of stage ${op.id} to "${op.summary}"`
    case 'node.add':
      return `added ${op.type} ${op.id} (${op.contract}) ${placement(op)}`
    case 'node.remove':
      return `removed node ${op.id}`
    case 'node.move':
      return `moved ${op.id} ${op.stage !== undefined ? `into stage ${op.stage}` : placement(op)}`
    case 'node.set': {
      const parts: string[] = []
      if (op.contract !== undefined) parts.push(`contract to ${op.contract}`)
      if (op.summary !== undefined) parts.push(`summary to "${op.summary}"`)
      if (op.models !== undefined) parts.push(`models to ${list(op.models)}`)
      if (op.skills !== undefined) parts.push(`skills to ${list(op.skills)}`)
      if (op.tools !== undefined) parts.push(`denied tools to ${list(op.tools.deny)}`)
      if (op.categories !== undefined) parts.push(`categories to ${list(op.categories)}`)
      if (op.collectors !== undefined) parts.push(`collectors to ${op.collectors}`)
      return `set ${op.id} ${parts.join('; ')}`
    }
    case 'node.role':
      return `rewrote the role of ${op.id}`
    case 'node.rename':
      return `renamed node ${op.id} to ${op.to}`
    case 'transition.set':
      return `set ${op.back ? 'back transition' : 'transition'} ${end(op.from)} to ${ends(op.to)}${op.label ? `: ${op.label}` : ''}`
    case 'transition.remove':
      return `removed transition ${end(op.from)} to ${ends(op.to)}`
    case 'handover.set':
      return `set handover ${op.from} to ${op.to}: ${op.label}`
    case 'handover.remove':
      return `removed handover ${op.from} to ${op.to}`
    case 'loop.describe':
      return `changed the description to "${op.description}"`
    case 'loop.rename':
      return `renamed the loop to ${op.to}`
    case 'import-d2':
      return 'imported the hand-edited loop.d2'
  }
}

// Parsing

type Field = 'string' | 'strings' | 'int' | 'true' | 'bool' | 'tools' | 'contract' | 'type'
type Shape = { required: Record<string, Field>; optional: Record<string, Field> }

const NODE_FIELDS: Record<string, Field> = { models: 'strings', skills: 'strings', tools: 'tools', categories: 'strings', collectors: 'int' }
const SHAPES: Record<Op['op'], Shape> = {
  'stage.add': { required: { id: 'string', summary: 'string' }, optional: { after: 'int', alongside: 'string' } },
  'stage.remove': { required: { id: 'string' }, optional: {} },
  'stage.move': { required: { id: 'string' }, optional: { after: 'int', alongside: 'string' } },
  'stage.split': { required: { id: 'string' }, optional: {} },
  'stage.rename': { required: { id: 'string', to: 'string' }, optional: {} },
  'stage.summary': { required: { id: 'string', summary: 'string' }, optional: {} },
  'node.add': {
    required: { id: 'string', type: 'type', contract: 'contract', summary: 'string' },
    optional: { stage: 'string', onCall: 'true', helperOf: 'string', ...NODE_FIELDS },
  },
  'node.remove': { required: { id: 'string' }, optional: {} },
  'node.move': { required: { id: 'string' }, optional: { stage: 'string', onCall: 'true', helperOf: 'string' } },
  'node.set': { required: { id: 'string' }, optional: { contract: 'contract', summary: 'string', ...NODE_FIELDS } },
  'node.role': { required: { id: 'string', text: 'string' }, optional: {} },
  'node.rename': { required: { id: 'string', to: 'string' }, optional: {} },
  'transition.set': { required: { from: 'string', to: 'strings', label: 'string' }, optional: { back: 'bool', when: 'string', then: 'string' } },
  'transition.remove': { required: { from: 'string', to: 'strings' }, optional: {} },
  'handover.set': { required: { from: 'string', to: 'string', label: 'string', spec: 'string' }, optional: {} },
  'handover.remove': { required: { from: 'string', to: 'string' }, optional: {} },
  'loop.describe': { required: { description: 'string' }, optional: {} },
  'loop.rename': { required: { to: 'string' }, optional: {} },
  'import-d2': { required: {}, optional: {} },
}
/** The skill's loop operations that change folders, not the draft: the wiring runs them through the on-disk functions. */
const FOLDER_OPS = ['loop.new', 'loop.move', 'loop.delete', 'loop.default']

const FIELD_WORDS: Record<Field, string> = {
  string: 'a string',
  strings: 'a list of strings',
  int: 'a whole number',
  true: 'true',
  bool: 'true or false',
  tools: 'the tools to deny: deny with a list of tool names, like Edit',
  contract: `one of ${CONTRACTS.join(', ')}`,
  type: 'agent or swarm',
}

function fits(value: unknown, field: Field): boolean {
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
  switch (field) {
    case 'string':
      return typeof value === 'string'
    case 'strings':
      return strings(value)
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'true':
      return value === true
    case 'bool':
      return typeof value === 'boolean'
    case 'tools':
      return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && strings((value as { deny?: unknown }).deny)
    case 'contract':
      return CONTRACTS.includes(value as Contract)
    case 'type':
      return value === 'agent' || value === 'swarm'
  }
}

/**
 * What each op takes, in words that never name an op: a refusal's bullet speaks of the change, and only its
 * `Refused op n (<op>)` header names the op.
 */
const TAKES: Record<Op['op'], string> = {
  'stage.add': 'a new stage takes id, summary, and after or alongside',
  'stage.remove': 'removing a stage takes only its id',
  'stage.move': 'moving a stage takes its id, and after or alongside',
  'stage.split': 'splitting a stage takes only its id',
  'stage.rename': 'renaming a stage takes its id and to, the new id',
  'stage.summary': "a stage's summary takes its id and summary",
  'node.add': 'a new node takes id, type, contract, summary, one of stage, onCall or helperOf, and optionally models, skills, tools, categories and collectors',
  'node.remove': 'removing a node takes only its id',
  'node.move': 'moving a node takes its id and one of stage, onCall or helperOf',
  'node.set': "it changes a node's models, skills, tools, contract, summary, categories or collectors",
  'node.role': "a node's role takes its id and text, the whole role",
  'node.rename': 'renaming a node takes its id and to, the new id',
  'transition.set': 'a transition takes from, to and label, and optionally back, when and then',
  'transition.remove': 'removing a transition takes from and to',
  'handover.set': 'a handover takes from, to, label and spec',
  'handover.remove': 'removing a handover takes from and to',
  'loop.describe': 'describing the loop takes only description',
  'loop.rename': 'renaming the loop takes only to, the new name',
  'import-d2': 'importing the hand-edited loop.d2 takes nothing else',
}

/** What an op is about, as a missing field's bullet names it: `the stage needs ...`. */
const SUBJECT = (name: Op['op']) => (name.startsWith('import') ? 'the import' : `the ${name.split('.')[0]}`)

/** A missing required field, in words: `the stage needs a summary of two to four words`. */
function needs(name: Op['op'], key: string): string {
  const by: Record<string, string> = {
    id: 'an id',
    summary: 'a summary of two to four words',
    type: 'a type: agent or swarm',
    contract: 'a contract: lands, scores, collects, none or interviews',
    text: 'its whole role text, in text',
    spec: 'a spec: what the handover carries',
    description: 'a description: a sentence on what it is for',
  }
  const handover = name.startsWith('handover')
  const transition = name.startsWith('transition')
  if (key === 'to') {
    if (transition) return 'the stages it leads to, as a list in to'
    if (handover) return 'the node it hands over to, in to'
    return name === 'loop.rename' ? 'a new name, in to' : 'a new id, in to'
  }
  if (key === 'from') return transition ? 'the stage it leaves, in from' : 'the node it hands over from, in from'
  if (key === 'label') return handover ? 'a label of one or two words' : 'a label of a few words'
  return by[key] ?? `${key}, as ${FIELD_WORDS[SHAPES[name].required[key] ?? 'string']}`
}

/** Edit distance, for a key that is a slip of a known one. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = here
    }
  }
  return row[b.length]!
}

/** The known key an unknown one most likely meant: the same in another case, `id` for the thing's own name, or a near spelling. */
function meant(key: string, known: string[]): string | undefined {
  const lower = key.toLowerCase()
  const same = known.find(k => k.toLowerCase() === lower)
  if (same) return same
  if (known.includes('id') && ['node', 'stage', 'name', 'nodeid', 'stageid'].includes(lower)) return 'id'
  const near = known.map(k => ({ k, d: distance(lower, k.toLowerCase()) })).filter(x => x.d <= 2 && x.d < x.k.length).sort((a, b) => a.d - b.d)
  return near[0]?.k
}

/** Parses an untyped tool argument into an Op, or says what is wrong in words that never name an op. */
export function parseOp(value: unknown): { op: Op } | { problem: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'each op is one object that names itself in op, beside its fields; send each op so' }
  const raw = value as Record<string, unknown>
  const name = raw.op
  if (typeof name !== 'string') return { problem: 'the op does not name itself; give op, the change it makes, as the design skill lists them' }
  if (FOLDER_OPS.includes(name)) return { problem: 'it changes loop folders, not the draft; send it in a batch of its own' }
  const shape = SHAPES[name as Op['op']]
  if (!shape) return { problem: `"${name}" is not a change the architect makes; name one the design skill lists` }
  const known = { ...shape.required, ...shape.optional }
  const out: Record<string, unknown> = { op: name }
  for (const key of Object.keys(raw)) {
    if (key === 'op' || key in known) continue
    const guess = meant(key, Object.keys(known))
    const hint = guess ? ` (did you mean ${guess}?)` : ''
    if (name === 'node.set') return { problem: `${TAKES[name]}; "${key}" is not something it changes${hint}` }
    return { problem: `${TAKES[name as Op['op']]}; "${key}" is not one of them${hint}` }
  }
  for (const [key, field] of Object.entries(known)) {
    const v = raw[key]
    if (v === undefined) {
      if (key in shape.required) return { problem: `${SUBJECT(name as Op['op'])} needs ${needs(name as Op['op'], key)}` }
      continue
    }
    if (!fits(v, field)) return { problem: `${key} is not ${FIELD_WORDS[field]}; give ${key} as ${FIELD_WORDS[field]}` }
    out[key] = field === 'strings' ? [...(v as string[])] : field === 'tools' ? { deny: [...(v as { deny: string[] }).deny] } : v
  }
  return { op: out as Op }
}

// Applying

/** A deep copy of a loop, so ops never touch the caller's. */
function copyLoop(loop: Loop): Loop {
  const nodes = Object.fromEntries(
    Object.entries(loop.nodes).map(([id, n]) => {
      const c: LoopNode = { ...n, models: [...n.models], skills: [...n.skills], tools: { deny: [...n.tools.deny] } }
      if (n.categories) c.categories = [...n.categories]
      return [id, c]
    }),
  )
  return { ...graphOf(loop), nodes }
}

/** A forward transition with no label, when or then, where the default would go: stored as nothing, as fromD2 has it. */
function stripDefaults(loop: Loop): Transition[] {
  const isDefault = (t: Transition) => {
    if (t.back || t.label || t.when || t.then) return false
    const others = loop.transitions.filter(u => u !== t)
    const added = withDefaultTransitions({ ...loop, transitions: others }).transitions.slice(others.length)
    return added.some(d => d.from === t.from && sameSet(d.to, t.to))
  }
  return loop.transitions.filter(t => !isDefault(t))
}

/** The edits, over a working copy the ops change in place. */
class Draft {
  /** What the op being applied rewired beyond itself, said after its change line. */
  rewired: string[] = []
  /** The op's change line when what it did depends on the loop, in place of `describeOp`. */
  head: string | undefined

  constructor(public loop: Loop) {}

  stage(id: string): { step: Step; stage: Stage } {
    for (const step of this.loop.steps) for (const stage of step.stages) if (stage.id === id) return { step, stage }
    if (this.loop.nodes[id]) refuse(`"${id}" is a node, not a stage; ${this.nameStage()}`)
    return refuse(`there is no stage "${id}"; ${this.nameStage()}`)
  }

  node(id: string): LoopNode {
    const n = this.loop.nodes[id]
    if (n) return n
    if (stageIndex(this.loop).has(id)) refuse(`"${id}" is a stage, not a node; ${this.nameNode()}`)
    return refuse(`there is no node "${id}"; ${this.nameNode()}`)
  }

  /** The end of a refusal that names no stage: the stages to name instead. */
  nameStage(): string {
    const ids = stageIdsOf(this.loop)
    return ids.length > 0 ? `name one of ${series(ids, 'or')}` : 'the loop has no stage yet, so add one first'
  }

  /** The end of a refusal that names no node: the nodes to name instead. */
  nameNode(): string {
    return `name one of ${series(Object.keys(this.loop.nodes), 'or')}`
  }

  /** A node that sits in a stage, on call or as a helper: not the entry or the exit. `to` is where a move puts it. */
  placeable(id: string, to?: { stage?: string; onCall?: true; helperOf?: string }): LoopNode {
    const n = this.node(id)
    const end = id === this.loop.exit || n.type === 'exit' ? 'exit' : id === this.loop.entry || n.type === 'entry' ? 'entry' : null
    if (end && to) {
      const instead = to.stage !== undefined ? `add a node in ${to.stage}` : to.helperOf !== undefined ? `add a helper of ${to.helperOf}` : 'add a node on call'
      refuse(`"${id}" is the ${end}; the entry and the exit stay where they are, so ${instead} instead or rename the ${end}`)
    }
    if (end) refuse(`"${id}" is the ${end}; a loop keeps its entry and exit, so rename it or rewrite its role instead`)
    return n
  }

  newStageId(id: string) {
    checkId(id, 'stage')
    if (id === ENTRY || id === EXIT) refuse(`"${id}" is the word transitions use for the ${id} node; pick another id for the stage`)
    if (stageIndex(this.loop).has(id)) refuse(`there is already a stage "${id}"; pick another id or rename the existing one`)
  }

  newNodeId(id: string) {
    checkId(id, 'node')
    if (this.loop.nodes[id]) refuse(`there is already a node "${id}"; pick another id or rename the existing one`)
  }

  /** Refuses an `after` outside the steps; -1 is before the first. */
  after(after: number) {
    const n = this.loop.steps.length
    if (after >= -1 && after < n) return
    if (n === 0) refuse(`after is ${after}, but the loop has no step yet; give -1 or leave after out`)
    refuse(`after is ${after}, but the steps run from 0 to ${n - 1}; give a step in that range, or -1 to put the stage first`)
  }

  /** The step of the stage named by `alongside`. */
  alongside(id: string, self?: string): Step {
    if (id === self) refuse(`stage "${self}" cannot go alongside itself; name another stage to share a step with`)
    if (!stageIndex(this.loop).has(id)) refuse(`alongside names "${id}", which is not a stage; ${this.nameStage()}`)
    return this.stage(id).step
  }

  /** A new empty step at index `at`. */
  insert(at: number): Step {
    const step: Step = { stages: [] }
    this.loop.steps.splice(at, 0, step)
    return step
  }

  /** Puts a stage into a step; a forward transition that listed every stage of that step now lists it too. */
  join(stage: Stage, step: Step) {
    const all = step.stages.map(s => s.id)
    if (all.length > 0) for (const t of this.loop.transitions) if (!t.back && sameSet(t.to, all)) t.to.push(stage.id)
    step.stages.push(stage)
  }

  /** Takes a stage out of its step (an empty step goes); a transition that listed it with other stages keeps the others. */
  leave(id: string): Stage {
    const { step, stage } = this.stage(id)
    step.stages.splice(step.stages.indexOf(stage), 1)
    if (step.stages.length === 0) this.loop.steps.splice(this.loop.steps.indexOf(step), 1)
    for (const t of this.loop.transitions) if (t.to.length > 1 && t.to.includes(id)) t.to = t.to.filter(s => s !== id)
    return stage
  }

  /**
   * Moves a stage into the step of another and rewires what the move breaks. Transitions between it and the stages
   * of its new step go: one step cannot lead to itself. Forward transitions into the stage alone lose it, or, when its
   * old step is left empty, lead to the step that came after. Forward transitions into exactly its new step's stages
   * take it in. Its own forward transitions that no longer point forward go.
   */
  moveAlongside(id: string, step: Step) {
    const loop = this.loop
    const { step: from, stage } = this.stage(id)
    const others = step.stages.map(s => s.id)
    const dropped: Transition[] = []
    const led = new Set<Transition>()
    loop.transitions = loop.transitions.filter(t => {
      const between = (t.from === id && t.to.some(s => others.includes(s))) || (others.includes(t.from) && t.to.includes(id))
      if (between) dropped.push(t)
      return !between
    })
    const at = loop.steps.indexOf(from)
    const next = loop.steps[at + 1]?.stages.map(s => s.id) ?? [EXIT]
    from.stages.splice(from.stages.indexOf(stage), 1)
    const emptied = from.stages.length === 0
    if (emptied) loop.steps.splice(at, 1)
    for (const t of loop.transitions) {
      if (t.back || !t.to.includes(id)) continue
      if (t.to.length > 1) t.to = t.to.filter(s => s !== id)
      else if (emptied) t.to = [...next]
      else continue
      led.add(t)
    }
    for (const t of loop.transitions) {
      if (t.back || !sameSet(t.to, others)) continue
      t.to.push(id)
      led.add(t)
    }
    step.stages.push(stage)
    const index = stageIndex(loop)
    const here = loop.steps.indexOf(step)
    loop.transitions = loop.transitions.filter(t => {
      const stays = t.back || t.from !== id || t.to.every(s => s === EXIT || (index.get(s)?.step ?? -1) > here)
      if (!stays) dropped.push(t)
      return stays
    })
    this.say(dropped, led)
  }

  /**
   * Takes a stage out of a shared step into a step of its own right after, the inverse of moving it alongside:
   * transitions into the shared step let it go, and the stages left behind lead to it where they led to the step after.
   */
  split(id: string) {
    const loop = this.loop
    const { step, stage } = this.stage(id)
    if (step.stages.length === 1) refuse(`stage ${id} is alone in its step; a split takes a stage out of a shared step, so move it instead`)
    const at = loop.steps.indexOf(step)
    const next = loop.steps[at + 1]?.stages.map(s => s.id) ?? [EXIT]
    step.stages.splice(step.stages.indexOf(stage), 1)
    const left = step.stages.map(s => s.id)
    const led = new Set<Transition>()
    for (const t of loop.transitions) {
      if (t.to.length > 1 && t.to.includes(id)) t.to = t.to.filter(s => s !== id)
      else if (!t.back && left.includes(t.from) && sameSet(t.to, next)) t.to = [id]
      else continue
      led.add(t)
    }
    this.insert(at + 1).stages.push(stage)
    this.say([], led)
  }

  /** Says what an op rewired: the transitions it dropped, then where each changed one now leads. */
  say(dropped: Transition[], led: Set<Transition>) {
    const loop = this.loop
    if (dropped.length > 0) this.rewired.push(`dropped the transition${dropped.length > 1 ? 's' : ''} ${series(dropped.map(t => transitionWords(loop, t)))}`)
    for (const t of loop.transitions) if (led.has(t)) this.rewired.push(`${endName(loop, t.from)} now leads ${t.back ? 'back ' : ''}to ${t.to.map(w => endName(loop, w)).join(' ∥ ')}`)
  }

  /**
   * After a stage joins a step: a stage of the step that leads on only by default, to where a sibling's stored forward
   * transition leads, takes that transition's label, so the step reads alike (`qa → merge: all pass` beside
   * `review → merge: all pass`). Each one taken is said.
   */
  matchSiblings(step: Step) {
    const loop = this.loop
    const ids = step.stages.map(s => s.id)
    const defaults = withDefaultTransitions(loop).transitions.slice(loop.transitions.length)
    for (const id of ids) {
      const own = defaults.find(t => t.from === id && !t.back)
      if (!own) continue
      const like = loop.transitions.find(t => !t.back && t.label && t.from !== id && ids.includes(t.from) && sameSet(t.to, own.to))
      if (!like) continue
      const t: Transition = { from: id, to: [...own.to], label: like.label }
      loop.transitions.push(t)
      this.rewired.push(`${transitionWords(loop, t)}: ${t.label}, the label of ${transitionWords(loop, like)}`)
    }
  }

  /** Takes a node out of its place. An on-call node's helpers stay on call, as on-call nodes of their own. */
  unplace(id: string) {
    for (const s of this.loop.steps) for (const st of s.stages) st.nodes = st.nodes.filter(n => n !== id)
    const onCall: Record<string, string[]> = {}
    for (const [key, helpers] of Object.entries(this.loop.onCall)) {
      if (key === id) for (const h of helpers) onCall[h] = []
      else onCall[key] = helpers.filter(h => h !== id)
    }
    this.loop.onCall = onCall
  }

  /** Puts a node in a stage, on call or as a helper of an on-call node; exactly one of the three. */
  place(id: string, o: { stage?: string; onCall?: true; helperOf?: string }) {
    const given = (['stage', 'onCall', 'helperOf'] as const).filter(k => o[k] !== undefined)
    if (given.length === 0) refuse(`node ${id} needs a place; give one of stage, onCall: true or helperOf`)
    if (given.length > 1) refuse(`node ${id} goes in one place, not ${given.join(' and ')}; keep one of them`)
    const n = this.loop.nodes[id]!
    if (o.stage !== undefined) {
      const { stage } = this.stage(o.stage)
      const lands = stage.nodes.filter(x => x !== id && this.loop.nodes[x]?.contract === 'lands')
      if (n.contract === 'lands' && lands.length > 0) {
        refuse(`stage ${o.stage} already holds a lands node (${lands.join(', ')}); a stage holds at most one, so put ${id} in another stage or on call`)
      }
      this.unplace(id)
      stage.nodes.push(id)
    } else if (o.helperOf !== undefined) {
      if (o.helperOf === id) refuse(`"${id}" cannot be a helper of itself; name an on-call node as helperOf`)
      this.node(o.helperOf)
      if (!this.loop.onCall[o.helperOf]) refuse(`"${o.helperOf}" is not on call; a helper hangs off an on-call node, so move ${o.helperOf} on call first`)
      this.unplace(id)
      this.loop.onCall[o.helperOf]!.push(id)
    } else if (!this.loop.onCall[id]) {
      this.unplace(id)
      this.loop.onCall[id] = []
    }
  }

  /**
   * A transition end as loop.json stores it: a stage id, or the word entry or exit. The entry and exit node ids stand
   * for the words (`merge` to `done` is `merge` to `exit`), unless a stage has that id.
   */
  end(id: string): string {
    if (id === ENTRY || id === EXIT) return id
    if (stageIndex(this.loop).has(id)) return id
    if (id === this.loop.entry) return ENTRY
    if (id === this.loop.exit) return EXIT
    const JOINS = 'a transition joins stages, the entry and the exit'
    if (this.loop.nodes[id]) {
      const home = this.loop.steps.flatMap(s => s.stages).find(st => st.nodes.includes(id))
      refuse(`"${id}" is a node, not a stage; ${JOINS}, so ${home ? `name its stage ${home.id}` : this.nameStage()}`)
    }
    return refuse(`there is no stage "${id}"; ${JOINS}, so ${this.nameStage()}`)
  }
}

function checkId(id: string, kind: string) {
  if (ID.test(id)) return
  const like = slug(id)
  refuse(`"${id}" is not a ${kind} id; use lowercase letters, digits and inner hyphens${like ? `, like ${like}` : ''}`)
}

function checkSummary(summary: string) {
  const w = words(summary)
  if (w < 1 || w > 5) refuse(`the summary "${summary}" has ${w} words; write a summary of 1 to 5 words`)
}

/** Applies one op to the working copy; a problem is thrown as a Refusal. Returns the opaque blocks when they change. */
function apply(d: Draft, op: Op, ctx: { d2?: string }): string[] | undefined {
  const loop = d.loop
  switch (op.op) {
    case 'stage.add': {
      d.newStageId(op.id)
      checkSummary(op.summary)
      if (op.after !== undefined && op.alongside !== undefined) refuse('give after or alongside, not both')
      if (op.after !== undefined) d.after(op.after)
      const step = op.alongside !== undefined ? d.alongside(op.alongside) : d.insert(op.after === undefined ? loop.steps.length : op.after + 1)
      d.join({ id: op.id, summary: op.summary, nodes: [] }, step)
      if (op.alongside !== undefined) d.matchSiblings(step)
      return
    }
    case 'stage.remove': {
      const stage = d.leave(op.id)
      loop.transitions = loop.transitions.filter(t => t.from !== op.id && !(t.to.length === 1 && t.to[0] === op.id))
      const judgeOf = (id: string) =>
        loop.nodes[id]?.contract === 'collects' ? stage.nodes.find(j => loop.nodes[j]?.contract === 'scores' && loop.handovers.some(h => h.from === j && h.to === id)) : undefined
      for (const id of stage.nodes) if (!judgeOf(id)) loop.onCall[id] = []
      for (const id of stage.nodes) {
        const judge = judgeOf(id)
        if (judge) loop.onCall[judge]!.push(id)
      }
      if (stage.nodes.length > 0) d.head = `${describeOp(op)} and put its nodes on call`
      return
    }
    case 'stage.move': {
      const { step: from } = d.stage(op.id)
      if (op.after !== undefined && op.alongside !== undefined) refuse('give after or alongside, not both')
      if (op.alongside !== undefined) {
        const step = d.alongside(op.alongside, op.id)
        if (step !== from) {
          d.moveAlongside(op.id, step)
          d.matchSiblings(step)
        }
        return
      }
      if (op.after !== undefined) d.after(op.after)
      // `after` counts the steps as they are before the move; the anchor step is found again after the stage leaves.
      const anchor = op.after === undefined ? loop.steps[loop.steps.length - 1] : op.after >= 0 ? loop.steps[op.after] : undefined
      if (anchor === from && from.stages.length === 1) return
      const stage = d.leave(op.id)
      const at = op.after === undefined ? loop.steps.length : anchor ? loop.steps.indexOf(anchor) + 1 : 0
      d.join(stage, d.insert(at))
      return
    }
    case 'stage.split': {
      d.split(op.id)
      return
    }
    case 'stage.rename': {
      const { stage } = d.stage(op.id)
      if (op.to === op.id) refuse(`stage ${op.id} is already called ${op.to}; give a new id in to`)
      d.newStageId(op.to)
      stage.id = op.to
      const rename = (s: string) => (s === op.id ? op.to : s)
      for (const t of loop.transitions) {
        t.from = rename(t.from)
        t.to = t.to.map(rename)
      }
      return
    }
    case 'stage.summary': {
      const { stage } = d.stage(op.id)
      checkSummary(op.summary)
      stage.summary = op.summary
      return
    }
    case 'node.add': {
      d.newNodeId(op.id)
      checkSummary(op.summary)
      const n: LoopNode = {
        id: op.id,
        type: op.type,
        summary: op.summary,
        contract: op.contract,
        models: [...(op.models ?? [])],
        skills: [...(op.skills ?? [])],
        tools: { deny: [...(op.tools?.deny ?? [])] },
        role: STUB_ROLE,
      }
      if (op.categories !== undefined) n.categories = [...op.categories]
      if (op.collectors !== undefined) n.collectors = op.collectors
      loop.nodes[op.id] = n
      d.place(op.id, op)
      return
    }
    case 'node.remove': {
      d.placeable(op.id)
      d.unplace(op.id)
      delete loop.nodes[op.id]
      loop.handovers = loop.handovers.filter(h => h.from !== op.id && h.to !== op.id)
      return
    }
    case 'node.move': {
      d.placeable(op.id, op)
      d.place(op.id, op)
      return
    }
    case 'node.set': {
      const n = d.node(op.id)
      const { op: _, id: __, ...fields } = op
      if (Object.keys(fields).length === 0) refuse(`nothing to change was given; give at least one of ${series(Object.keys(SHAPES['node.set'].optional), 'or')}`)
      if (op.summary !== undefined) checkSummary(op.summary)
      if (op.contract !== undefined) n.contract = op.contract
      if (op.summary !== undefined) n.summary = op.summary
      if (op.models !== undefined) n.models = [...op.models]
      if (op.skills !== undefined) n.skills = [...op.skills]
      if (op.tools !== undefined) n.tools = { deny: [...op.tools.deny] }
      if (op.categories !== undefined) n.categories = [...op.categories]
      if (op.collectors !== undefined) n.collectors = op.collectors
      // A node that stops scoring drops what only a scores node carries, unless the op sets it again.
      if (op.contract !== undefined && op.contract !== 'scores') {
        if (op.categories === undefined) delete n.categories
        if (op.collectors === undefined) delete n.collectors
      }
      return
    }
    case 'node.role': {
      const n = d.node(op.id)
      if (!op.text.trim()) refuse(`the role of ${op.id} would be empty; give the whole role text`)
      n.role = op.text
      return
    }
    case 'node.rename': {
      const n = d.node(op.id)
      if (op.to === op.id) refuse(`node ${op.id} is already called ${op.to}; give a new id in to`)
      d.newNodeId(op.to)
      const rename = (s: string) => (s === op.id ? op.to : s)
      loop.nodes = Object.fromEntries(Object.entries(loop.nodes).map(([id, x]) => (id === op.id ? [op.to, { ...n, id: op.to }] : [id, x])))
      for (const s of loop.steps) for (const st of s.stages) st.nodes = st.nodes.map(rename)
      loop.onCall = Object.fromEntries(Object.entries(loop.onCall).map(([k, v]) => [rename(k), v.map(rename)]))
      for (const h of loop.handovers) {
        h.from = rename(h.from)
        h.to = rename(h.to)
      }
      loop.entry = rename(loop.entry)
      loop.exit = rename(loop.exit)
      return
    }
    case 'transition.set': {
      const from = d.end(op.from)
      const to = op.to.map(id => d.end(id))
      if (to.length === 0) refuse('the transition goes nowhere; list in to the stages it leads to')
      const t: Transition = { from, to, back: op.back || undefined, label: op.label, when: op.when, then: op.then }
      const i = loop.transitions.findIndex(x => x.from === from && sameSet(x.to, to))
      if (i >= 0) loop.transitions[i] = t
      else loop.transitions.push(t)
      return
    }
    case 'transition.remove': {
      const from = d.end(op.from)
      const to = op.to.map(id => d.end(id))
      const i = loop.transitions.findIndex(x => x.from === from && sameSet(x.to, to))
      if (i < 0) {
        const out = loop.transitions.filter(x => x.from === from)
        const name = endName(loop, from)
        refuse(
          `there is no transition from ${name} to ${series(to.map(w => endName(loop, w)))}; ${
            out.length > 0 ? `name one of ${series(out.map(t => transitionWords(loop, t)), 'or')}` : `${name} leads on only by default, so there is none to remove; set a transition of its own instead`
          }`,
        )
      }
      loop.transitions.splice(i, 1)
      return
    }
    case 'handover.set': {
      d.node(op.from)
      d.node(op.to)
      const h: Handover = { from: op.from, to: op.to, label: op.label, spec: op.spec }
      const i = loop.handovers.findIndex(x => x.from === op.from && x.to === op.to)
      if (i >= 0) loop.handovers[i] = h
      else loop.handovers.push(h)
      return
    }
    case 'handover.remove': {
      d.node(op.from)
      d.node(op.to)
      const i = loop.handovers.findIndex(x => x.from === op.from && x.to === op.to)
      if (i < 0) {
        const out = loop.handovers.filter(x => x.from === op.from)
        refuse(`there is no handover from ${op.from} to ${op.to}; ${out.length > 0 ? `name one of ${series(out.map(x => `${x.from} → ${x.to}`), 'or')}` : `${op.from} hands nothing over, so there is nothing to remove`}`)
      }
      loop.handovers.splice(i, 1)
      return
    }
    case 'loop.describe': {
      if (!op.description.trim()) refuse('the description would be empty; say in a sentence what the loop is for')
      loop.description = op.description
      return
    }
    case 'loop.rename': {
      checkId(op.to, 'loop')
      loop.name = op.to
      return
    }
    case 'import-d2': {
      if (ctx.d2 === undefined) refuse('there is no loop.d2 to import; save the loop once to write one, then edit it')
      const out = fromD2(ctx.d2!, loop)
      if (out.problems.length > 0) throw new Refusal(out.problems.map(p => p.message).join('\n'))
      d.loop = copyLoop(out.loop)
      return out.opaque
    }
  }
  return refuse(`"${(op as { op: unknown }).op}" is not an op`)
}

/** What to do about a problem of the loop that names this key of a node, in words that name no op. */
const NODE_FIX: Record<string, string> = {
  models: 'set its models',
  skills: 'set its skills',
  summary: 'set its summary',
  contract: 'set its contract',
  tools: 'set its denied tools',
  collectors: 'set its collectors',
}

/** A problem `validateLoop` found, said the way a refusal is: what is wrong, then what to do, in one sentence. */
function explain(loop: Loop, p: Problem): string {
  const at = /^(transitions|handovers)\[(\d+)\]$/.exec(p.path)
  const t = at?.[1] === 'transitions' ? loop.transitions[Number(at[2])] : undefined
  if (t) {
    const end = (w: string) => endName(loop, w)
    const from = end(t.from)
    const the = `the ${t.back ? 'back ' : ''}transition from ${from} to ${series(t.to.map(end))}`
    const index = stageIndex(loop)
    const stepOf = (s: string) => (s === ENTRY ? -1 : s === EXIT ? loop.steps.length : (index.get(s)?.step ?? -1))
    if (p.message.startsWith('to of a forward transition')) {
      const target = stepOf(t.to.find(s => s !== EXIT) ?? EXIT)
      const all = (loop.steps[target]?.stages.map(s => s.id) ?? [EXIT]).map(end)
      const which = target === stepOf(t.from) + 1 ? 'the next step' : `step ${target + 1}`
      return `the transition from ${from} must lead to every stage of ${which}: ${series(all)}; remove the one from ${from} to ${series(t.to.map(end))}, and set one from ${from} to ${series(all)}`
    }
    if (p.message.startsWith('a transition to an earlier step')) return `${the} leads to an earlier step or its own; set it again with back: true, or point it at a later step`
    if (p.message.startsWith('a back transition')) return `${the} does not lead to one earlier step; point it at a stage of an earlier step, or set it again without back`
    return `${the}: ${p.message}`
  }
  const h = at?.[1] === 'handovers' ? loop.handovers[Number(at[2])] : undefined
  if (h) return `the handover from ${h.from} to ${h.to}: ${p.message}`

  const node = /^nodes\.([^.]+)(?:\.(.+))?$/.exec(p.path)
  if (node) {
    const [, id, key] = node as unknown as [string, string, string | undefined]
    const n = loop.nodes[id]
    if (key === 'categories' && n?.contract === 'scores') return `node ${id} scores but has no categories; give it the rubric categories it accepts`
    if (n && (key === 'categories' || key === 'collectors') && /for scores nodes only/.test(p.message)) {
      return `node ${id} does not score, so it takes no ${key}; set its contract to ${n.contract} again to drop them, or set it to scores`
    }
    if (n && key === 'models' && /needs at least one model/.test(p.message)) {
      const does = n.contract === 'lands' ? 'lands work' : n.contract === 'interviews' ? 'talks to the user' : 'scores'
      return `node ${id} ${does} but has no model; give it at least one`
    }
    if (key === 'contract' && n?.contract === 'collects') {
      // the judge to name is one the loop still has: never the node a batch just removed
      const judges = Object.values(loop.nodes).filter(x => x.contract === 'scores').map(x => x.id)
      const fix =
        judges.length > 0
          ? `add a handover to ${id} from ${series(judges, 'or')}, or remove ${id}`
          : `no scores node is left to hand it slices, so remove ${id}, or give it another contract`
      return `node ${id} collects evidence but no scores node hands over to it; ${fix}`
    }
    if (key === undefined && /in no stage and not on call/.test(p.message)) return `node ${id} is in no stage and not on call; move it into a stage or on call`
    const times = /is placed (\d+) times/.exec(p.message)
    if (key === undefined && times) return `node ${id} is placed ${times[1]} times; move it to one place`
    return `node ${id}: ${p.message}${key && NODE_FIX[key] ? `; ${NODE_FIX[key]}` : ''}`
  }

  const stage = /^steps\[(\d+)\]\.stages\[(\d+)\](\.summary)?/.exec(p.path)
  if (stage) {
    const id = loop.steps[Number(stage[1])]?.stages[Number(stage[2])]?.id ?? '?'
    if (/is not reachable from entry/.test(p.message)) return `stage ${id} is not reachable from entry; lead a transition into it from the stage before`
    if (stage[3]) return `stage ${id}: ${p.message}; give it a summary of two to four words`
    return `stage ${id}: ${p.message}`
  }
  const step = /^steps\[(\d+)\]$/.exec(p.path)
  if (step) return `step ${Number(step[1]) + 1}: ${p.message}`
  const onCall = /^onCall\.(.+)$/.exec(p.path)
  if (onCall) return `on call: ${p.message}; remove it or move it elsewhere`
  if (p.path === 'exit' && /not reachable/.test(p.message)) return `the exit ${loop.exit} is not reachable from the entry ${loop.entry}; lead a transition from the last step to ${loop.exit}`
  if (p.path === 'description') return p.message
  if (p.path === 'name') return `${p.message}; rename the loop`
  // entry and exit say what is wrong in a whole sentence; no raw path reaches the user
  return p.message
}

/** The problems of a loop as refusals say them, over the loop with its default transitions. */
function problemsOf(loop: Loop): string[] {
  const full = { ...withDefaultTransitions(loop), nodes: loop.nodes }
  return validateLoop(full).map(p => explain(full, p))
}

/**
 * A note for each old id a batch renamed or removed that the role bodies or the description still say, as a whole
 * word in any case: the prose an id change leaves behind. Nothing when the id names a stage or a node again.
 */
function staleNotes(loop: Loop, old: string[]): string[] {
  const notes: string[] = []
  for (const id of [...new Set(old)]) {
    if (loop.nodes[id] || stageIndex(loop).has(id)) continue
    const escaped = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    const word = new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, 'i')
    const roles = Object.keys(loop.nodes).filter(n => word.test(loop.nodes[n]!.role))
    const description = word.test(loop.description)
    if (roles.length === 0 && !description) continue
    const parts = [...(roles.length > 0 ? [`the role${roles.length > 1 ? 's' : ''} of ${series(roles)}`] : []), ...(description ? ['the description'] : [])]
    const many = parts.length > 1 || roles.length > 1
    notes.push(`${series(parts)} still ${many ? 'say' : 'says'} "${id}"; rewrite ${many ? 'them' : 'it'}`)
  }
  return notes
}

/** A whole-word test for an id in prose, in any case. */
const wordOf = (id: string) => new RegExp(`(?<![a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![a-z0-9-])`, 'i')

/** Whether a collects node works with a judge: it hands evidence to the judge or takes a slice from it, and sits with it (its stage, or as its helper on call). */
function collectorOf(loop: Loop, judge: string): boolean {
  const stageOf = (id: string) => loop.steps.flatMap(s => s.stages).find(st => st.nodes.includes(id))?.id
  return Object.values(loop.nodes).some(c => {
    if (c.contract !== 'collects') return false
    if (!loop.handovers.some(h => (h.from === c.id && h.to === judge) || (h.from === judge && h.to === c.id))) return false
    const here = stageOf(judge)
    return here !== undefined ? stageOf(c.id) === here : (loop.onCall[judge] ?? []).includes(c.id)
  })
}

/**
 * Notes on what a batch left stale beyond ids: a judge that still allows collectors none works with now, a transition
 * left without a label where the ones around it had labels, and a description that may no longer match the order.
 */
function shapeNotes(before: Loop, after: Loop, ops: Op[], described: boolean): string[] {
  const notes: string[] = []
  for (const n of Object.values(after.nodes)) {
    if (n.contract !== 'scores' || !n.collectors) continue
    const was = before.nodes[n.id]
    if (was && was.contract === 'scores' && (was.collectors ?? 0) > 0 && !collectorOf(before, n.id)) continue
    if (collectorOf(after, n.id)) continue
    const related = Object.values(after.nodes).find(c => c.contract === 'collects' && after.handovers.some(h => (h.from === c.id && h.to === n.id) || (h.from === n.id && h.to === c.id)))
    const fix = related ? `move ${related.id} back` : 'give it a collector node that hands it evidence'
    notes.push(`${n.id} allows up to ${n.collectors} collector${n.collectors === 1 ? '' : 's'} but no collector node hands evidence to it now; set its collectors to 0 or ${fix}`)
  }
  const key = (t: Transition) => `${t.back ? 'back ' : ''}${t.from}>${[...t.to].sort().join('+')}`
  const was = withDefaultTransitions(before).transitions
  const unlabelled = new Set(was.filter(t => !t.label).map(key))
  for (const t of withDefaultTransitions(after).transitions) {
    if (t.label || unlabelled.has(key(t))) continue
    const around = was.some(u => u.label && !u.back === !t.back && (u.from === t.from || u.to.some(s => t.to.includes(s))))
    if (around) notes.push(`${transitionWords(after, t)} has no label now; give it one`)
  }
  const reorders = ops.some(op => op.op === 'stage.move' || op.op === 'stage.split' || op.op === 'stage.remove' || (op.op === 'stage.add' && op.alongside !== undefined))
  if (reorders && !described && !ops.some(op => op.op === 'loop.describe')) {
    const moved = ops.flatMap(op => (op.op.startsWith('stage.') && 'id' in op ? [op.id] : []))
    const named = stageIdsOf(before).filter(id => wordOf(id).test(after.description))
    if (moved.some(id => wordOf(id).test(after.description)) || named.length >= 2) notes.push('the description may be out of date; say how the loop should be described')
  }
  return notes
}

/** The problems of a loop as they would be after a batch: over its transitions without the stored defaults. */
const problemsAfter = (loop: Loop) => problemsOf({ ...loop, transitions: stripDefaults(loop) })

/** A refused batch: the op that failed and why. `op: 'batch'` is a loop that breaks rules after the last op, with `culprits` the ops that brought the problems in (none when no op can be told). */
export type Refused = { ok: false; index: number; op: string; problems: string[]; culprits?: { index: number; op: string }[] }
/** A batch that leaves the loop as it was: nothing to refuse, and nothing to write. */
export type Unchanged = { ok: false; unchanged: true }

/**
 * Applies the ops in order to a copy of the loop. The first op that cannot apply stops everything: nothing is returned
 * but the problem. After the last op the whole loop must validate, else the batch is refused with the problems, named
 * by the op that brought them in when one op did, else as the batch with every op that brought one in as `culprits`
 * (none when a problem was there before the first op). A batch that leaves the loop as it was is `unchanged`. A change
 * line, one per op, says what its op rewired; `notes` on what the batch left stale (prose an id change left behind,
 * a judge's collectors, a transition's lost label, the description) come apart from them.
 */
export function applyOps(
  loop: Loop,
  ops: Op[],
  ctx: { d2?: string; opaque?: string[] },
): { ok: true; loop: Loop; changes: string[]; notes: string[]; opaque: string[] } | Refused | Unchanged {
  if (ops.length === 0) return { ok: false, index: 0, op: 'batch', problems: ['the batch holds no ops; send at least one'] }
  const d = new Draft(copyLoop(loop))
  let opaque = [...(ctx.opaque ?? [])]
  const changes: string[] = []
  const old: string[] = []
  // the problems before the first op and after each, to tell which op brought in a problem the batch ends with
  const seen: string[][] = [problemsAfter(d.loop)]
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    d.rewired = []
    d.head = undefined
    try {
      const next = apply(d, op, ctx)
      if (next) opaque = next
    } catch (e) {
      const problems = e instanceof Refusal ? e.message.split('\n') : [`the op failed: ${errorText(e)}`]
      return { ok: false, index: i, op: String((op as { op?: unknown })?.op), problems }
    }
    changes.push([d.head ?? describeOp(op, d.loop), ...d.rewired].join('; '))
    if (op.op === 'node.rename' || op.op === 'stage.rename' || op.op === 'stage.remove') old.push(op.id)
    seen.push(problemsAfter(d.loop))
  }
  const problems = seen[ops.length]!
  if (problems.length > 0) {
    const by = [...new Set(problems.map(p => broughtIn(seen, p)))].sort((a, b) => a - b)
    const [i] = by
    if (by.length === 1 && i !== undefined && i >= 0) return { ok: false, index: i, op: ops[i]!.op, problems: problems.map(p => hintFor(p, ops[i])) }
    const culprits = by.includes(-1) ? [] : by.map(index => ({ index, op: ops[index]!.op }))
    // the problems in the order of the ops that brought them in, as the refusal names those ops
    const ordered = problems.map((p, k) => ({ p, k, at: broughtIn(seen, p) })).sort((a, b) => a.at - b.at || a.k - b.k)
    return { ok: false, index: ops.length, op: 'batch', problems: ordered.map(o => hintFor(o.p, ops[o.at])), culprits }
  }
  d.loop.transitions = stripDefaults(d.loop)
  const before = copyLoop(loop)
  before.transitions = stripDefaults(before)
  // an import that changes nothing still goes through: it is how the person settles a hand-edited loop.d2
  const imported = ops.some(op => op.op === 'import-d2')
  if (!imported && plainHash(d.loop) === plainHash(before) && sameList(opaque, ctx.opaque ?? [])) return { ok: false, unchanged: true }
  const stale = staleNotes(d.loop, old)
  const described = stale.some(n => /\bthe description\b/.test(n))
  return { ok: true, loop: d.loop, changes, notes: [...stale, ...shapeNotes(before, d.loop, ops, described)], opaque }
}

/** A node.add has no contract to set again: its hint says to leave the field out. */
function hintFor(problem: string, op: Op | undefined): string {
  if (op?.op !== 'node.add') return problem
  return problem.replace(
    /^(node \S+ does not score, so it takes no (\w+)); set its contract to (\w+) again to drop them, or set it to scores$/,
    (_, head: string, key: string, c: string) => `${head}; leave ${key} out: ${c === 'interviews' ? 'an' : 'a'} ${c} node does not score, or give it the scores contract`,
  )
}

/** The op that brought in a problem: the last after which it appeared and stayed; -1 when the loop had it before the first. */
function broughtIn(seen: string[][], problem: string): number {
  let i = seen.length - 1
  while (i > 0 && seen[i - 1]!.includes(problem)) i--
  return i - 1
}

/** The hash of a loop as it is written: a key set to undefined is the same as no key. */
const plainHash = (loop: Loop) => hashLoop(JSON.parse(JSON.stringify(loop)) as Loop)
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// On disk

const draftJson = (info: DraftInfo) => `${JSON.stringify({ base: info.base, since: info.since, changes: info.changes }, null, 2)}\n`
/** How a person changes a plugin loop, in their words: `copy it first: say "new loop <name> at user level from core"`. */
export const copyFirst = (name: string) => `copy it first: say "new loop <name> at user level from ${name}"`
/** The refusal of a change to a plugin loop: copy it first. */
const readOnly = (name: string) => `the plugin's loops are read-only; ${copyFirst(name)}, then change the copy`
/** The end of a refusal that names no loop. */
const CHECK_LIBRARY = 'check the name and level in the library'

/** Copies a folder, file by file; a name that cannot be read as a file is taken as a folder. */
async function copyTree(fs: LoopFs, from: string, to: string): Promise<void> {
  for (const name of await fs.list(from)) {
    const path = join(from, name)
    let text: string | null = null
    try {
      text = await fs.read(path)
    } catch {
      text = null
    }
    if (text === null) await copyTree(fs, path, join(to, name))
    else await fs.write(join(to, name), text)
  }
}

/** The folder of a loop at a level, or a problem when the level has no root. */
function loopDir(roots: Roots, level: LoopLevel, name: string): string {
  const root = roots[level]
  if (!root) return refuse(level === 'project' ? 'there is no repository here, so there is no project level; use the user level' : `there is no ${level} level here; use the user level`)
  return join(root, name)
}

const hasLoop = (fs: LoopFs, dir: string) => fs.exists(join(dir, 'loop.json'))
const hasDraft = (fs: LoopFs, dir: string) => fs.exists(join(dir, 'draft.json'))

/** Runs an on-disk operation: a Refusal or a failure becomes the problem. */
async function guarded(run: () => Promise<void>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (e) {
    return errorText(e)
  }
}

/** The opaque blocks of a folder's loop.d2 over `loop`, or none when there is no diagram. */
async function opaqueOf(fs: LoopFs, dir: string, loop: Loop): Promise<string[]> {
  if (!(await fs.exists(join(dir, 'loop.d2')))) return []
  try {
    return fromD2(await fs.read(join(dir, 'loop.d2')), loop).opaque
  } catch {
    return []
  }
}

/**
 * Starts a new loop as a draft: a copy of `from` (any level) or a blank loop. Refused when a loop of that name exists
 * at that level or a draft for it does. The loops root is not written until `saveDraft`.
 */
export async function loopNew(
  fs: LoopFs,
  roots: Roots,
  draftsRoot: string,
  repoRoot: string | null,
  a: { name: string; level: 'user' | 'project'; from?: { name: string; level: LoopLevel } },
): Promise<{ ok: true; ref: LoopRef; loop: Loop; info: DraftInfo } | { ok: false; problem: string }> {
  try {
    checkId(a.name, 'loop')
    const dir = loopDir(roots, a.level, a.name)
    if (await hasLoop(fs, dir)) refuse(`a loop named ${a.name} already exists at the ${a.level} level; pick another name or open that loop`)
    const draftDir = join(draftsRoot, draftKey({ level: a.level, name: a.name, repoRoot }))
    if (await hasDraft(fs, draftDir)) refuse(`a draft of ${a.name} at the ${a.level} level is already open; continue it or discard it`)
    let loop = blankLoop(a.name)
    let change = `new loop ${a.name}`
    let opaque: string[] = []
    if (a.from) {
      const source = loopDir(roots, a.from.level, a.from.name)
      if (!(await hasLoop(fs, source))) refuse(`there is no loop ${a.from.name} at the ${a.from.level} level; ${CHECK_LIBRARY}`)
      const read = (await readLoop(fs, source)).loop
      const description = `A copy of ${a.from.name} (${a.from.level}): ${read.description}`
      loop = { ...read, name: a.name, description }
      change = `new from ${a.from.name} (${a.from.level}), described as "${description}"`
      opaque = await opaqueOf(fs, source, read)
    }
    const info: DraftInfo = { dir: draftDir, base: null, since: Date.now(), changes: [change] }
    // a draft is a whole loop folder: its diagram too, with the blocks of the source's diagram the subset does not know
    await writeLoop(fs, draftDir, loop, { 'loop.d2': toD2(loop, opaque) })
    await fs.write(join(draftDir, 'draft.json'), draftJson(info))
    const ref: LoopRef = { name: a.name, level: a.level, dir, description: loop.description, draft: info, counts: countsOf(loop, Object.keys(loop.nodes).length) }
    return { ok: true, ref, loop, info }
  } catch (e) {
    return { ok: false, problem: errorText(e) }
  }
}

/**
 * Renames a loop: its folder, `name` in loop.json, and LOOP.md and loop.d2 written again; an open draft follows under
 * its new key. Refused for a plugin loop or when the new name is taken.
 */
export async function loopRename(fs: LoopFs, roots: Roots, draftsRoot: string, repoRoot: string | null, a: { name: string; level: LoopLevel; to: string }): Promise<string | null> {
  return guarded(async () => {
    if (a.level === 'plugin') refuse(readOnly(a.name))
    checkId(a.to, 'loop')
    if (a.to === a.name) refuse(`the loop is already called ${a.to}; give a new name in to`)
    const from = loopDir(roots, a.level, a.name)
    const to = loopDir(roots, a.level, a.to)
    if (!(await hasLoop(fs, from))) refuse(`there is no loop ${a.name} at the ${a.level} level; ${CHECK_LIBRARY}`)
    if (await fs.exists(to)) refuse(`a loop named ${a.to} already exists at the ${a.level} level; pick another name, or rename or delete that one first`)
    const fromDraft = join(draftsRoot, draftKey({ level: a.level, name: a.name, repoRoot }))
    const toDraft = join(draftsRoot, draftKey({ level: a.level, name: a.to, repoRoot }))
    if (await fs.exists(toDraft)) refuse(`a draft named ${a.to} at the ${a.level} level is already open; save or discard it first`)

    const old = (await readLoop(fs, from)).loop
    const loop = { ...old, name: a.to }
    const opaque = await opaqueOf(fs, from, old)
    await copyTree(fs, from, to)
    await writeLoop(fs, to, loop, { 'loop.d2': toD2(loop, opaque) })
    await fs.remove(from)

    if (await hasDraft(fs, fromDraft)) {
      const info = JSON.parse(await fs.read(join(fromDraft, 'draft.json'))) as { base: string | null; since: number; changes: string[] }
      const draft = (await readLoop(fs, fromDraft)).loop
      await copyTree(fs, fromDraft, toDraft)
      await writeLoop(fs, toDraft, { ...draft, name: a.to })
      // The saved loop's hash changed with its name; a draft based on it stays based on it.
      const base = info.base === hashLoop(old) ? hashLoop(loop) : info.base
      await fs.write(join(toDraft, 'draft.json'), draftJson({ dir: toDraft, base, since: info.since, changes: info.changes }))
      await fs.remove(fromDraft)
    }
  })
}

/**
 * Moves a loop between the user and project levels, with its draft when it has one. Refused for a plugin loop or when
 * the target is taken. Returns the problem, or whether a draft moved with it. With `check`, only the refusals run:
 * nothing moves, so a caller can ask before it moves.
 */
export async function loopMove(
  fs: LoopFs,
  roots: Roots,
  draftsRoot: string,
  repoRoot: string | null,
  a: { name: string; from: LoopLevel; to: 'user' | 'project'; check?: true },
): Promise<string | { draftMoved: boolean }> {
  let draftMoved = false
  const problem = await guarded(async () => {
    if (a.from === 'plugin') refuse(readOnly(a.name))
    if (a.from === a.to) refuse(`the loop is already at the ${a.to} level; name the other level to move it`)
    const from = loopDir(roots, a.from, a.name)
    const to = loopDir(roots, a.to, a.name)
    if (!(await hasLoop(fs, from))) refuse(`there is no loop ${a.name} at the ${a.from} level; ${CHECK_LIBRARY}`)
    if (await fs.exists(to)) refuse(`a loop named ${a.name} already exists at the ${a.to} level; rename or delete one of them first`)
    const fromDraft = join(draftsRoot, draftKey({ level: a.from, name: a.name, repoRoot }))
    const toDraft = join(draftsRoot, draftKey({ level: a.to, name: a.name, repoRoot }))
    if (await fs.exists(toDraft)) refuse(`a draft of ${a.name} at the ${a.to} level is already open; save or discard it first`)
    if (a.check) return
    await copyTree(fs, from, to)
    await fs.remove(from)
    if (await fs.exists(fromDraft)) {
      await copyTree(fs, fromDraft, toDraft)
      await fs.remove(fromDraft)
      draftMoved = true
    }
  })
  return problem ?? { draftMoved }
}

/** Deletes a loop's folder and its draft. Refused for a plugin loop. */
export async function loopDelete(fs: LoopFs, roots: Roots, draftsRoot: string, repoRoot: string | null, a: { name: string; level: LoopLevel }): Promise<string | null> {
  return guarded(async () => {
    if (a.level === 'plugin') refuse(`the plugin's loops are read-only and cannot be deleted; to stop using ${a.name}, make another loop the default: say "make <name> the default"`)
    const dir = loopDir(roots, a.level, a.name)
    const draft = join(draftsRoot, draftKey({ level: a.level, name: a.name, repoRoot }))
    const [folder, drafted] = await Promise.all([fs.exists(dir), fs.exists(draft)])
    if (!folder && !drafted) refuse(`there is no loop ${a.name} at the ${a.level} level; ${CHECK_LIBRARY}`)
    if (folder) await fs.remove(dir)
    if (drafted) await fs.remove(draft)
  })
}

/** Writes `loop = <name>` into a conf file (the user conf for a user or plugin loop, `<repo>/.dacapo.conf` for a project loop), replacing an existing `loop =` line, keeping every other line. */
export async function setDefaultLoop(fs: LoopFs, confPath: string, name: string): Promise<string | null> {
  return guarded(async () => {
    checkId(name, 'loop')
    const text = (await fs.exists(confPath)) ? await fs.read(confPath) : ''
    const LINE = /^(\s*loop\s*=\s*)([^#]*?)(\s+#.*)?$/
    let found = false
    const lines = text.split('\n').map(line => {
      const m = LINE.exec(line)
      if (!m) return line
      found = true
      return `${m[1]}${name}${m[3] ?? ''}`
    })
    let out = lines.join('\n')
    if (!found) out = `${out}${out && !out.endsWith('\n') ? '\n' : ''}loop = ${name}\n`
    await fs.write(confPath, out)
  })
}

/** Validates, writes loop.json, nodes/*.md, loop.d2 (toD2 with the opaque blocks) and LOOP.md, then clears the draft. Refuses a plugin loop; refuses when the folder's hash differs from `info.base` unless `force`. */
export async function saveDraft(fs: LoopFs, a: { ref: LoopRef; loop: Loop; info: DraftInfo; opaque: string[]; force?: boolean }): Promise<string | null> {
  return guarded(async () => {
    if (a.ref.level === 'plugin') refuse(readOnly(a.ref.name))
    const problems = problemsOf(a.loop)
    if (problems.length > 0) refuse(`the draft does not validate: ${problems.join(' · ')}`)
    const saved = (await hasLoop(fs, a.ref.dir)) ? hashLoop((await readLoop(fs, a.ref.dir)).loop) : null
    if (saved !== a.info.base && !a.force) {
      refuse(
        saved === null
          ? `${a.ref.name} was deleted since the draft began; save with force to write it again`
          : a.info.base === null
            ? `a loop named ${a.ref.name} was saved at ${a.ref.dir} since the draft began; save with force to overwrite it`
            : `${a.ref.name} changed on disk since the draft began; save with force to overwrite it`,
      )
    }
    await writeLoop(fs, a.ref.dir, a.loop, { 'loop.d2': toD2(a.loop, a.opaque) })
    await discardDraft(fs, a.info)
  })
}
