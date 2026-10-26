import type { Handover, Loop, LoopNode, NodeType, Problem, Stage, Step, Transition } from '../types/loops'
import { canonicalJson, graphOf, ID, stageIndex, withDefaultTransitions } from './loops'

// loop.d2 is the loop drawn in a D2 subset: the entry with its on-call nodes, one container per step holding its
// stages and their nodes, the exit, then the transitions and the handovers. It carries structure, labels and summaries
// only; everything else stays in loop.json and the node files.

/** The words a transition uses for the entry and the exit node, as hooks/loops.ts has them. */
const ENTRY = 'entry'
const EXIT = 'exit'
const STEP = /^step([1-9][0-9]*)$/
/** The role a node drawn in the diagram but missing from the loop starts with. */
const STUB_ROLE = 'Role to be written.'

const CLASSES = [
  'entry: {}',
  'agent: {}',
  'swarm: { style.multiple: true }',
  'exit: {}',
  'stage: {}',
  'transition: { style.stroke-dash: 4 }',
  'back: { style.stroke-dash: 4 }',
  'handover: {}',
]

// Writing

/**
 * A value as the subset writes it: bare when it holds only `[A-Za-z0-9 ,.'-]`, starts and ends with neither a space
 * nor a quote, and opens no word with a quote; double quoted otherwise.
 */
function quoted(text: string): string {
  if (/^[A-Za-z0-9 ,.'-]+$/.test(text) && !/^[ ']| $|\s'/.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** A shape with no children on one line. It carries no label: D2 draws the key, so the diagram reads the ids as written. */
const leaf = (indent: string, id: string, cls: string, summary: string) => `${indent}${id}: { class: ${cls}; summary: ${quoted(summary)} }`
const edge = (from: string, to: string, label: string, cls: string) => `${from} -> ${to}${label ? `: ${quoted(label)}` : ''} { class: ${cls} }`
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size

/**
 * Writes loop.d2: the classes, the entry with its on-call nodes and their helpers, one `step<n>` container per step,
 * the exit, the transitions with the default ones applied, then the handovers. Each `opaque` block (as `fromD2`
 * returned it) follows the generated part unchanged.
 */
export function toD2(loop: Loop, opaque: string[] = []): string {
  const out: string[] = ['direction: down', '', 'classes: {', ...CLASSES.map(c => `  ${c}`), '}', '']
  const summary = (id: string) => loop.nodes[id]?.summary ?? ''
  const nodeClass = (id: string) => (loop.nodes[id]?.type === 'swarm' ? 'swarm' : 'agent')

  // The entry and its on-call nodes.
  const onCall = Object.entries(loop.onCall)
  if (onCall.length === 0) out.push(leaf('', loop.entry, 'entry', summary(loop.entry)))
  else {
    out.push(`${loop.entry}: {`, '  class: entry', `  summary: ${quoted(summary(loop.entry))}`, '  on-call: {')
    for (const [id, helpers] of onCall) {
      if (helpers.length === 0) out.push(leaf('    ', id, nodeClass(id), summary(id)))
      else {
        out.push(`    ${id}: {`, `      class: ${nodeClass(id)}`, `      summary: ${quoted(summary(id))}`)
        for (const h of helpers) out.push(leaf('      ', h, nodeClass(h), summary(h)))
        out.push('    }')
      }
    }
    out.push('  }', '}')
  }
  out.push('')

  // The steps.
  loop.steps.forEach((step, i) => {
    if (step.stages.length === 0) return out.push(`step${i + 1}: {}`, '')
    out.push(`step${i + 1}: {`)
    if (step.stages.length > 1) out.push(`  grid-columns: ${step.stages.length}`)
    for (const st of step.stages) {
      if (st.nodes.length === 0) out.push(leaf('  ', st.id, 'stage', st.summary))
      else {
        out.push(`  ${st.id}: {`, '    class: stage', `    summary: ${quoted(st.summary)}`)
        for (const n of st.nodes) out.push(leaf('    ', n, nodeClass(n), summary(n)))
        out.push('  }')
      }
    }
    out.push('}', '')
  })

  out.push(leaf('', loop.exit, 'exit', summary(loop.exit)), '')

  // The transitions: a stage is its step when the step holds only it; a forward move to every stage of a step is that step.
  const stages = stageIndex(loop)
  const stagePath = (id: string) => {
    if (id === ENTRY) return loop.entry
    if (id === EXIT) return loop.exit
    const at = stages.get(id)
    if (!at) return id
    return loop.steps[at.step]!.stages.length > 1 ? `step${at.step + 1}.${id}` : `step${at.step + 1}`
  }
  const transitions = withDefaultTransitions(loop).transitions
  for (const t of transitions) {
    const cls = t.back ? 'back' : 'transition'
    const steps = new Set(t.to.map(id => stages.get(id)?.step ?? -1))
    const step = steps.size === 1 ? [...steps][0]! : -1
    const whole = step >= 0 && sameSet(t.to, loop.steps[step]!.stages.map(s => s.id))
    if (whole) out.push(edge(stagePath(t.from), `step${step + 1}`, t.label, cls))
    else for (const to of t.to) out.push(edge(stagePath(t.from), stagePath(to), t.label, cls))
  }

  // The handovers, by the dotted path of each node.
  const nodePath = new Map<string, string>()
  const setPath = (id: string, path: string) => nodePath.has(id) || nodePath.set(id, path)
  setPath(loop.entry, loop.entry)
  setPath(loop.exit, loop.exit)
  for (const [id, helpers] of onCall) {
    setPath(id, `${loop.entry}.on-call.${id}`)
    for (const h of helpers) setPath(h, `${loop.entry}.on-call.${id}.${h}`)
  }
  loop.steps.forEach((s, i) => s.stages.forEach(st => st.nodes.forEach(n => setPath(n, `step${i + 1}.${st.id}.${n}`))))
  if (loop.handovers.length > 0 && transitions.length > 0) out.push('')
  for (const h of loop.handovers) out.push(edge(nodePath.get(h.from) ?? h.from, nodePath.get(h.to) ?? h.to, h.label, 'handover'))

  for (const block of opaque) out.push('', block.replace(/\n+$/, ''))
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

// Reading: tokens

type TokenKind = '{' | '}' | ';' | ':' | '->' | 'nl' | 'text' | 'str'
type Token = { kind: TokenKind; text: string; start: number; end: number; line: number }
/** A problem found while reading, at an offset so one inside an opaque block can be dropped; `keep` ones never are. */
type Found = { line: number; offset: number; message: string; keep?: boolean }

/**
 * Splits the text into braces, `;`, `:`, `->`, newlines, quoted strings (single or double, with backslash escapes) and
 * text runs (anything else up to whitespace). `#` starts a comment to the end of the line.
 */
function tokenize(src: string): { tokens: Token[]; found: Found[] } {
  const tokens: Token[] = []
  const found: Found[] = []
  let i = 0
  let line = 1
  const push = (kind: TokenKind, text: string, start: number, end: number) => tokens.push({ kind, text, start, end, line })
  while (i < src.length) {
    const c = src[i]!
    if (c === '\n') {
      push('nl', c, i, i + 1)
      line++
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '{' || c === '}' || c === ';' || c === ':') {
      push(c, c, i, i + 1)
      i++
    } else if (c === '-' && src[i + 1] === '>') {
      push('->', '->', i, i + 2)
      i += 2
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length && src[j + 1] !== '\n') {
          value += src[j + 1] === 'n' ? '\n' : src[j + 1]
          j += 2
        } else value += src[j++]
      }
      if (src[j] === c) j++
      else found.push({ line, offset: i, message: `the string opened with ${c} is never closed on its line` })
      push('str', value, i, j)
      i = j
    } else {
      let j = i
      while (j < src.length && !/[\s{};:#]/.test(src[j]!) && !(src[j] === '-' && src[j + 1] === '>')) j++
      push('text', src.slice(i, j), i, j)
      i = j
    }
  }
  return { tokens, found }
}

// Reading: statements

/**
 * One statement: a key (one path) or an edge (two or more), an optional value after `:` and an optional block.
 * `start` and `end` are offsets of its first character and of the end of its last token, closing brace included.
 */
type Stmt = { ends: string[]; value?: string; body?: Stmt[]; line: number; start: number; end: number }

const tokenName = (t: Token | undefined) => (!t ? 'the end of the text' : t.kind === 'nl' ? 'the end of the line' : `"${t.text}"`)

/** Reads the tokens into nested statements; braces close their block or are problems naming the line. */
function parse(src: string): { stmts: Stmt[]; found: Found[] } {
  const { tokens, found } = tokenize(src)
  let k = 0
  let lastEnd = 0
  const peek = () => tokens[k]
  const next = () => {
    const t = tokens[k++]!
    lastEnd = t.end
    return t
  }
  const ends = (t: Token | undefined) => !t || t.kind === 'nl' || t.kind === ';' || t.kind === '}'
  const isKey = (t: Token | undefined) => !!t && (t.kind === 'text' || t.kind === 'str')

  const value = (): string | undefined => {
    const first = peek()
    if (isKey(first) && first!.kind === 'str' && (ends(tokens[k + 1]) || tokens[k + 1]!.kind === '{')) return next().text
    let from = -1
    while (!ends(peek()) && peek()!.kind !== '{') {
      const t = next()
      if (from < 0) from = t.start
    }
    return from < 0 ? undefined : src.slice(from, lastEnd)
  }

  const block = (depth: number, openLine: number): Stmt[] => {
    const out: Stmt[] = []
    for (;;) {
      const t = peek()
      if (!t) {
        if (depth > 0) found.push({ line: openLine, offset: 0, message: 'the block opened on this line is never closed: braces must balance', keep: true })
        return out
      }
      if (t.kind === 'nl' || t.kind === ';') {
        next()
        continue
      }
      if (t.kind === '}') {
        next()
        if (depth > 0) return out
        found.push({ line: t.line, offset: t.start, message: 'this "}" closes no block: braces must balance', keep: true })
        continue
      }
      if (t.kind === '{') {
        next()
        found.push({ line: t.line, offset: t.start, message: 'a block with no key before it' })
        block(depth + 1, t.line)
        continue
      }
      if (!isKey(t)) {
        next()
        found.push({ line: t.line, offset: t.start, message: `expected a key, found ${tokenName(t)}` })
        continue
      }
      const stmt: Stmt = { ends: [next().text], line: t.line, start: t.start, end: t.end }
      while (peek()?.kind === '->') {
        next()
        if (isKey(peek())) stmt.ends.push(next().text)
        else found.push({ line: t.line, offset: t.start, message: `an edge needs a key after "->", not ${tokenName(peek())}` })
      }
      if (peek()?.kind === ':') {
        next()
        stmt.value = value()
      }
      if (peek()?.kind === '{') {
        const open = next()
        stmt.body = block(depth + 1, open.line)
      }
      stmt.end = lastEnd
      if (!ends(peek())) {
        found.push({ line: peek()!.line, offset: peek()!.start, message: `unexpected ${tokenName(peek())} after "${stmt.ends.join(' -> ')}"` })
        while (!ends(peek())) {
          if (peek()!.kind === '{') {
            const open = next()
            block(depth + 1, open.line)
          } else next()
        }
        stmt.end = lastEnd
      }
      out.push(stmt)
    }
  }

  return { stmts: block(0, 1), found }
}

// Reading: the loop

/** What the diagram says of a node: where it is drawn, its type and its summary when one is given. */
type Drawn = { type: NodeType; summary?: string; line: number }
/** What an edge end names: the entry, the exit, a step (its stages), a stage, or a node. */
type NodeEnd = { kind: 'entry' | 'exit' | 'node'; id: string }
type End = NodeEnd | { kind: 'step'; step: number; stages: string[] } | { kind: 'stage'; step: number; id: string }

const attr = (s: Stmt, key: string) => (s.ends.length === 1 && s.ends[0] === key && !s.body ? s : undefined)
const classOf = (s: Stmt) => s.body?.find(b => attr(b, 'class'))?.value?.trim()

/**
 * Reads loop.d2 over `base`, which supplies all the diagram does not carry: roles, models, skills, tools, specs and
 * the `when` and `then` of a transition whose pair is unchanged. Nodes, stages, steps, on-call entries, transitions
 * and handovers follow the diagram; a node new to it gets a stub; a forward transition drawn without a label where the
 * default would go is not stored. A top-level block the subset does not know comes back verbatim in `opaque`. Every
 * problem names its line.
 */
export function fromD2(text: string, base: Loop): { loop: Loop; problems: Problem[]; opaque: string[] } {
  const src = text.replace(/\r\n/g, '\n')
  const { stmts, found } = parse(src)
  const problems: Problem[] = []
  const add = (line: number, message: string) => problems.push({ path: 'loop.d2', message: `loop.d2 line ${line}: ${message}` })

  // Sort the top-level statements; what the subset does not know is opaque.
  const opaque: string[] = []
  const ranges: [number, number][] = []
  const edges: Stmt[] = []
  const steps: { n: number; stmt: Stmt }[] = []
  const entries: Stmt[] = []
  const exits: Stmt[] = []
  for (const s of stmts) {
    const key = s.ends[0]!
    const cls = classOf(s)
    if (s.ends.length > 1) edges.push(s)
    else if (key === 'direction' || key === 'classes') continue
    else if (STEP.test(key)) steps.push({ n: Number(STEP.exec(key)![1]), stmt: s })
    else if (s.body && (cls === 'entry' || (cls === undefined && key === base.entry))) entries.push(s)
    else if (s.body && (cls === 'exit' || (cls === undefined && key === base.exit))) exits.push(s)
    else {
      const lineStart = src.lastIndexOf('\n', s.start - 1) + 1
      const from = src.slice(lineStart, s.start).trim() ? s.start : lineStart
      opaque.push(src.slice(from, s.end))
      ranges.push([from, s.end])
    }
  }
  for (const f of found) if (f.keep || !ranges.some(([a, b]) => f.offset >= a && f.offset < b)) add(f.line, f.message)

  const drawn = new Map<string, Drawn>()
  const ends = new Map<string, End>()
  /** Records a node drawn at `path`; a node drawn twice is a problem. */
  const place = (id: string, path: string, d: Drawn) => {
    if (!ID.test(id)) add(d.line, `"${id}" is not a node id: lowercase letters, digits and inner hyphens`)
    const seen = drawn.get(id)
    if (seen) return add(d.line, `"${id}" is already drawn on line ${seen.line}; a node has one parent`)
    drawn.set(id, d)
    ends.set(path, d.type === 'entry' ? { kind: 'entry', id } : d.type === 'exit' ? { kind: 'exit', id } : { kind: 'node', id })
  }
  /** The attributes and child shapes of a known block; an unknown attribute or a shape where none goes is a problem. */
  const split = (s: Stmt, keys: string[], children: string | null) => {
    const attrs: Record<string, Stmt> = {}
    const shapes: Stmt[] = []
    for (const b of s.body ?? []) {
      const key = b.ends.join(' -> ')
      if (b.ends.length > 1) add(b.line, `the edge "${key}" is inside a block; edges go at the top level`)
      else if (!b.body && keys.includes(key)) {
        if (attrs[key]) add(b.line, `"${key}" is set twice`)
        else attrs[key] = b
      } else if (b.body && children && !keys.includes(key)) shapes.push(b)
      else if (b.body && keys.includes(key)) add(b.line, `"${key}" is an attribute and holds no block`)
      else if (b.body) add(b.line, `${s.ends[0]} holds no shapes; "${key}" cannot be drawn in it`)
      else add(b.line, `unknown attribute "${key}" in ${s.ends[0]} (one of ${keys.join(', ')}${children ? `, or a ${children} with a block` : ''})`)
    }
    return { attrs, shapes }
  }
  const summaryOf = (a: Record<string, Stmt>) => (a.summary ? (a.summary.value ?? '').trim() : undefined)
  const expectClass = (a: Record<string, Stmt>, allowed: string[], fallback: string): string => {
    const v = a.class?.value?.trim()
    if (v === undefined) return fallback
    if (allowed.includes(v)) return v
    add(a.class!.line, `class ${v} is not allowed here (one of ${allowed.join(', ')})`)
    return fallback
  }
  /** A node shape in a stage or on call; on-call nodes may hold helpers. */
  const readNode = (s: Stmt, path: string, helpers: boolean): string[] => {
    const id = s.ends[0]!
    const { attrs, shapes } = split(s, ['class', 'summary'], helpers ? 'helper' : null)
    const known = base.nodes[id]?.type
    const fallback = known === 'agent' || known === 'swarm' ? known : 'agent'
    place(id, path, { type: expectClass(attrs, ['agent', 'swarm'], fallback) as NodeType, summary: summaryOf(attrs), line: s.line })
    return shapes.map(h => (readNode(h, `${path}.${h.ends[0]}`, false), h.ends[0]!))
  }

  // The entry and its on-call nodes.
  const onCall: Record<string, string[]> = {}
  let entry = base.entry
  if (entries.length === 0) add(1, 'the diagram has no entry: a top-level shape with class: entry')
  entries.forEach((s, i) => {
    if (i > 0) return add(s.line, `a second entry; the entry is drawn on line ${entries[0]!.line}`)
    entry = s.ends[0]!
    const { attrs, shapes } = split(s, ['class', 'summary'], 'on-call block')
    place(entry, entry, { type: 'entry', summary: summaryOf(attrs), line: s.line })
    for (const block of shapes) {
      if (block.ends[0] !== 'on-call') {
        add(block.line, `"${block.ends[0]}" cannot be drawn in the entry; on-call nodes go in its on-call block`)
        continue
      }
      for (const n of split(block, [], 'node').shapes) {
        const id = n.ends[0]!
        if (onCall[id]) continue
        onCall[id] = readNode(n, `${entry}.on-call.${id}`, true)
      }
    }
  })

  // The exit.
  let exit = base.exit
  if (exits.length === 0) add(1, 'the diagram has no exit: a top-level shape with class: exit')
  exits.forEach((s, i) => {
    if (i > 0) return add(s.line, `a second exit; the exit is drawn on line ${exits[0]!.line}`)
    exit = s.ends[0]!
    const { attrs } = split(s, ['class', 'summary'], null)
    place(exit, exit, { type: 'exit', summary: summaryOf(attrs), line: s.line })
  })

  // The steps, by number, and their stages.
  const baseStages = stageIndex(base)
  const stageLines = new Map<string, number>()
  const stepList: Step[] = []
  const numbers = new Map<number, number>()
  steps.sort((a, b) => a.n - b.n)
  for (const { n, stmt } of steps) {
    if (numbers.has(n)) {
      add(stmt.line, `step${n} is drawn twice; the first is on line ${numbers.get(n)}`)
      continue
    }
    numbers.set(n, stmt.line)
    const index = stepList.length
    const stages: Stage[] = []
    const { attrs, shapes } = split(stmt, ['grid-columns'], 'stage')
    const columns = attrs['grid-columns']?.value?.trim()
    if (columns !== undefined && !/^[1-9][0-9]*$/.test(columns)) add(attrs['grid-columns']!.line, `grid-columns must be a whole number, not ${columns}`)
    for (const st of shapes) {
      const id = st.ends[0]!
      if (!ID.test(id)) add(st.line, `"${id}" is not a stage id: lowercase letters, digits and inner hyphens`)
      const seen = stageLines.get(id)
      if (seen !== undefined) {
        add(st.line, `the stage "${id}" is already drawn on line ${seen}; a stage is in one step`)
        continue
      }
      stageLines.set(id, st.line)
      const part = split(st, ['class', 'summary'], 'node')
      expectClass(part.attrs, ['stage'], 'stage')
      const nodes = part.shapes.map(s => (readNode(s, `step${n}.${id}.${s.ends[0]}`, false), s.ends[0]!))
      stages.push({ id, summary: summaryOf(part.attrs) ?? baseStages.get(id)?.stage.summary ?? '', nodes })
      ends.set(`step${n}.${id}`, { kind: 'stage', step: index, id })
    }
    stepList.push({ stages })
    ends.set(`step${n}`, { kind: 'step', step: index, stages: stages.map(s => s.id) })
  }

  // The edges: transitions between steps, stages, the entry and the exit; handovers between nodes.
  const transitions: Transition[] = []
  const handovers: Handover[] = []
  const usedT = new Set<Transition>()
  const usedH = new Set<Handover>()
  const stepNumber = (e: End) => (e.kind === 'entry' ? -1 : e.kind === 'exit' ? stepList.length : e.kind === 'step' || e.kind === 'stage' ? e.step : NaN)
  const movable = (e: End) => e.kind !== 'node'
  const handable = (e: End): e is NodeEnd => e.kind === 'node' || e.kind === 'entry' || e.kind === 'exit'
  const stagesOf = (e: End): string[] => (e.kind === 'entry' ? [ENTRY] : e.kind === 'exit' ? [EXIT] : e.kind === 'step' ? e.stages : e.kind === 'stage' ? [e.id] : [])
  for (const s of edges) {
    if (s.ends.length > 2) {
      add(s.line, 'a chain of edges is not in the subset; draw one edge per line')
      continue
    }
    const [a, b] = s.ends.map(p => ({ path: p, end: ends.get(p) }))
    const unknown = [a!, b!].filter(e => !e.end).map(e => e.path)
    if (unknown.length > 0) {
      add(s.line, `the edge names ${unknown.map(p => `"${p}"`).join(' and ')}, which ${unknown.length === 1 ? 'is' : 'are'} not drawn; an edge joins a step, stage or node by its dotted path`)
      continue
    }
    const from = a!.end!
    const to = b!.end!
    const { attrs } = split(s, ['class'], null)
    const label = (s.value ?? '').trim()
    let cls = attrs.class?.value?.trim()
    if (cls !== undefined && !['transition', 'back', 'handover'].includes(cls)) {
      add(attrs.class!.line, `class ${cls} is not an edge class (one of transition, back, handover)`)
      continue
    }
    if (cls === undefined) cls = movable(from) && movable(to) ? (stepNumber(to) <= stepNumber(from) ? 'back' : 'transition') : 'handover'
    if (cls === 'handover') {
      if (!handable(from) || !handable(to)) {
        add(s.line, 'a handover joins two nodes; a step or stage is joined by a transition')
        continue
      }
      const h = base.handovers.find(x => !usedH.has(x) && x.from === from.id && x.to === to.id)
      if (h) usedH.add(h)
      handovers.push({ from: from.id, to: to.id, label, spec: h?.spec ?? '' })
      continue
    }
    if (!movable(from) || !movable(to)) {
      add(s.line, 'a transition joins steps, stages, the entry or the exit; a node inside a stage is joined by a handover')
      continue
    }
    const sources = stagesOf(from)
    const targets = stagesOf(to)
    if (sources.length === 0 || targets.length === 0) {
      add(s.line, `${sources.length === 0 ? a!.path : b!.path} holds no stage for the transition to ${sources.length === 0 ? 'leave' : 'reach'}`)
      continue
    }
    const back = cls === 'back'
    for (const source of sources) {
      const t = base.transitions.find(x => !usedT.has(x) && x.from === source && !!x.back === back && sameSet(x.to, targets))
      if (t) usedT.add(t)
      transitions.push({ from: source, to: [...targets], back: back || undefined, label, when: t?.when, then: t?.then })
    }
  }

  // A forward transition drawn without a label, where the default would go, is the default: it is not stored.
  const graph = { name: base.name, description: base.description, entry, exit, steps: stepList, onCall, transitions, handovers }
  const isDefault = (t: Transition) => {
    if (t.back || t.label || t.when || t.then) return false
    const others = transitions.filter(u => u !== t)
    const added = withDefaultTransitions({ ...graph, transitions: others }).transitions.slice(others.length)
    return added.some(d => d.from === t.from && sameSet(d.to, t.to))
  }
  graph.transitions = transitions.filter(t => !isDefault(t))

  // The nodes: those of the base keep all the diagram does not carry; new ones get a stub.
  const nodes: Record<string, LoopNode> = {}
  const keep = (id: string) => (entries.length === 0 && id === base.entry) || (exits.length === 0 && id === base.exit)
  const ids = [...Object.keys(base.nodes).filter(id => drawn.has(id) || keep(id)), ...[...drawn.keys()].filter(id => !base.nodes[id])]
  for (const id of ids) {
    const d = drawn.get(id)
    const b = base.nodes[id]
    if (!d) nodes[id] = b!
    else if (b) nodes[id] = { ...b, type: d.type, summary: d.summary ?? b.summary }
    else nodes[id] = { id, type: d.type, summary: d.summary ?? '', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: STUB_ROLE }
  }

  return { loop: { ...graphOf(graph), nodes }, problems, opaque }
}

// Hand edits

/**
 * What the diagram carries of a loop, in a form that compares by value: the graph with the default transitions applied,
 * transitions and handovers in a fixed order, and each node's type and summary.
 */
function drawnPart(loop: Loop): string {
  const graph = graphOf(withDefaultTransitions(loop))
  const sorted = <T>(list: T[]) => list.map(canonicalJson).sort()
  const nodes = Object.fromEntries(Object.values(loop.nodes).map(n => [n.id, { type: n.type, summary: n.summary }]))
  return canonicalJson({ ...graph, transitions: sorted(graph.transitions), handovers: sorted(graph.handovers), nodes })
}

/**
 * True when loop.d2 says something the stored loop does not: the text has a problem `fromD2` reports, or what it
 * draws (steps, stages, nodes and their types and summaries, on-call nodes, transitions, handovers) differs from the
 * loop. Roles, models, skills, tools, categories, collectors and specs are not drawn, so they never count; neither do
 * the opaque blocks, layout or whitespace. Pass it to `readLoop` to tell a hand edit from a save.
 */
export function d2Differs(text: string, loop: Loop): boolean {
  const out = fromD2(text, loop)
  return out.problems.length > 0 || drawnPart(out.loop) !== drawnPart(loop)
}
