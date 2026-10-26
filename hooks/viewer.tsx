import type { Handover, Loop, LoopLevel, LoopNode, LoopRef, Transition, ViewerFocus, ViewerState } from '../types/loops'
import { nodeOrder, stageIndex, withDefaultTransitions } from './loops'
import { layout, renderSvg, renderTerminal, transitionId, type Span, type View } from './looplayout'
import { GREEN, ORANGE, TEAL, YELLOW, stageColor, type Els } from './pane'

/** The pane's request id: the loop viewer, beside the run's own pane. */
export const LOOPS_PANE = 'dacapo-loops'

/** What the viewer's buttons do. Each only navigates, focuses, folds, switches the tab, or saves or discards a draft. */
export type ViewerActions = {
  back: () => void
  open: (name: string, level: LoopLevel) => void
  focus: (target: ViewerFocus | null) => void
  fold: () => void
  tab: (tab: 'canvas' | 'files') => void
  save: () => void
  discard: () => void
}

// The look: a dark pane, panels a shade lighter, the draft bar in a dark amber.

const BG = '#0d1117'
const PANEL = '#161b22'
const BORDER = '#30363d'
const TEXT = '#e6edf3'
const DIM = '#8b949e'
const FAINT = '#6e7681'
const DRAFT_BG = '#1c1a10'

/** The width of a field's label in the focus panel: `Contract` and a space. */
const LABEL_COLS = 10

const SECTIONS: ReadonlyArray<{ level: LoopLevel; title: string; where: string }> = [
  { level: 'project', title: 'Project', where: '.claude/dacapo/loops/ · this repository · kept out of git' },
  { level: 'user', title: 'User', where: '~/.claude/dacapo/loops/ · every repository' },
  { level: 'plugin', title: 'Plugin', where: 'shipped with dacapo · read-only · copy to edit' },
]

const LIBRARY_FOOTER =
  '/dacapo:design opens here; Open and View only navigate. Everything else is said to the architect: “new loop docs-only at project level from core”, “move core-fast to the project”, “make docs-only the default”, “delete quick”.'
const LOOP_FOOTER =
  "This pane only shows. Every change goes through the architect: with /dacapo:design this session is the architect, and what you say becomes operations on the draft. Deleting a stage keeps its nodes: they move to on call. Nothing reaches the loop's files until you press Save."
const D2_NOTICE = 'loop.d2 was edited by hand since the last save; say “import the diagram” to fold it in'
const NO_FOCUS = 'Press a stage or a node to see it here.'

// Example phrases under each kind of focus, so the person learns the architect's vocabulary. Each is built from the
// loop as it is: it names only stages and nodes the loop has, and offers only a change the loop can take.

/** Names in prose: `a`, `a and b`, `a, b and c`. */
const series = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** An id no stage or node of the loop has yet: `base`, else `base-2`, `base-3`, ... */
function freshId(loop: Loop, base: string): string {
  const taken = (id: string) => !!loop.nodes[id] || stageIndex(loop).has(id)
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  return id
}

/** The phrases under a stage: a move to the next step or alongside a neighbour's stage, a split when its step is shared, a rename, a delete, a node. */
function stageTry(loop: Loop, id: string): string[] {
  const at = loop.steps.findIndex(s => s.stages.some(st => st.id === id))
  const next = loop.steps[at + 1]?.stages[0]?.id
  const near = (loop.steps[at - 1] ?? loop.steps[at + 1])?.stages[0]?.id
  return [
    ...(next ? [`move ${id} after ${next}`] : []),
    ...(near ? [`move ${id} alongside ${near}`] : []),
    ...((loop.steps[at]?.stages.length ?? 0) > 1 ? [`split ${id} into its own step`] : []),
    `rename ${id} to …`,
    `delete the ${id} stage`,
    `add a node ${freshId(loop, `${id}-helper`)} in ${id}`,
  ]
}

/** Whether a transition is one the loop stores, not one it takes by default: a default has no label, when or then, and goes where the default would. */
function isStored(loop: Loop, t: Transition): boolean {
  const i = loop.transitions.findIndex(u => u.from === t.from && !!u.back === !!t.back && u.to.length === t.to.length && u.to.every(s => t.to.includes(s)))
  if (i < 0) return false
  const u = loop.transitions[i]!
  if (u.back || u.label || u.when || u.then) return true
  const others = loop.transitions.filter((_, j) => j !== i)
  const added = withDefaultTransitions({ ...loop, transitions: others }).transitions.slice(others.length)
  return !added.some(d => d.from === u.from && d.to.length === u.to.length && d.to.every(s => u.to.includes(s)))
}

/**
 * The phrases under a transition: when it fires; removing it when the loop stores it; marking it back when it is
 * marked forward but leads to its own step or an earlier one; a back transition the other way when there is none.
 */
function transitionTry(loop: Loop, t: Transition): string[] {
  const index = stageIndex(loop)
  const stepOf = (s: string) => (s === 'entry' ? -1 : s === 'exit' ? loop.steps.length : (index.get(s)?.step ?? -1))
  const out = [`change when ${endName(loop, t.from)} goes to ${series(t.to.map(s => endName(loop, s)))}`]
  if (isStored(loop, t)) out.push('remove this transition')
  if (!t.back && t.from !== 'entry' && t.to.every(s => s !== 'exit' && stepOf(s) <= stepOf(t.from))) out.push('make this a back transition')
  const backFrom = t.back || t.from === 'entry' ? undefined : t.to.find(s => s !== 'exit' && stepOf(s) > stepOf(t.from) && !loop.transitions.some(u => u.back && u.from === s && u.to.includes(t.from)))
  if (backFrom) out.push(`add a back transition from ${backFrom} to ${t.from}`)
  return out
}

/** The phrases under a handover: what it carries, removing it, and one the other way when there is none. */
function handoverTry(loop: Loop, h: Handover): string[] {
  const back = loop.handovers.some(x => x.from === h.to && x.to === h.from)
  return [`change what ${h.from} hands to ${h.to}`, 'remove this handover', ...(back ? [] : [`add a handover from ${h.to} to ${h.from}`])]
}

/** The phrases under a node, by what it is: the entry, a judge, a collector, a worker, a node on call. */
function nodeTry(loop: Loop, n: LoopNode): readonly string[] {
  const id = n.id
  if (id === loop.entry || n.type === 'entry') return [`add a scout the ${id} can ask anything, any time`, `rewrite the ${id}'s role to clarify in one message`]
  if (id === loop.exit || n.type === 'exit') return [`rename ${id} to finished`]
  switch (n.contract) {
    case 'scores':
      return [`add the category risk to ${id}`, `let ${id} use fable`, `give ${id} two collectors`]
    case 'collects':
      return [`let ${id} use haiku`, `never let ${id} use Edit`]
    case 'lands':
      return ['let workers use fable', 'add my lint skill to workers', 'make workers run the linter before every commit', 'rename worker to builder', 'move worker on call']
    case 'none': {
      const place = placeOf(loop, id)
      const stage = loop.steps.flatMap(s => s.stages).find(st => st.id !== place.stage)?.id
      const into = stage ? [`move ${id} into ${stage}`] : []
      if (place.stage || place.helperOf) return [`move ${id} on call`, ...into]
      return [...into, `give ${id} a helper ${freshId(loop, 'reader')} that summarises folders`]
    }
  }
}

// Words.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const two = (n: number) => `${n}`.padStart(2, '0')
/** A day as `2026-10-26`, in local time. */
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
const countsText = (c: LoopRef['counts']) => `${plural(c.stages, 'stage')} in ${plural(c.steps, 'step')} · ${plural(c.nodes, 'node')} · ${plural(c.edges, 'edge')}`
const refKey = (ref: Pick<LoopRef, 'level' | 'name'>) => `${ref.level}/${ref.name}`
/** The library entry runs use by default: the loop the conf names, at the level that wins. */
const isDefault = (state: ViewerState, ref: LoopRef) => ref.name === state.defaultLoop && !ref.shadowedBy
const draftLine = (d: { changes: string[]; since: number }) => `${plural(d.changes.length, 'change')} · since ${dayOf(d.since)} · kept across sessions`

type Chip = { text: string; color: string }

/** A library card's chips: default, draft, read-only, hidden by the loop that wins. */
function refChips(state: ViewerState, ref: LoopRef): Chip[] {
  const out: Chip[] = []
  if (isDefault(state, ref)) out.push({ text: 'default', color: GREEN })
  if (ref.draft) out.push({ text: 'draft', color: YELLOW })
  if (ref.level === 'plugin') out.push({ text: 'read-only', color: DIM })
  if (ref.shadowedBy) out.push({ text: `hidden by ${ref.shadowedBy}/${ref.name}`, color: ORANGE })
  return out
}

// The loop, read for the panel.

/** Each stage's colour as the canvas draws it: its index among every stage in step order. */
function stageColors(loop: Loop): Map<string, string> {
  const out = new Map<string, string>()
  loop.steps.flatMap(s => s.stages).forEach((st, i) => out.has(st.id) || out.set(st.id, stageColor(st.id, i)))
  return out
}

/** Where a node works: its stage, on call, a helper of an on-call node, or nowhere (the entry and the exit). */
function placeOf(loop: Loop, id: string): { stage?: string; onCall?: boolean; helperOf?: string } {
  if (loop.onCall[id]) return { onCall: true }
  const owner = Object.entries(loop.onCall).find(([, helpers]) => helpers.includes(id))
  if (owner) return { helperOf: owner[0] }
  for (const step of loop.steps) for (const st of step.stages) if (st.nodes.includes(id)) return { stage: st.id }
  return {}
}

function nodeColor(loop: Loop, id: string, colors: Map<string, string>): string {
  if (id === loop.entry) return TEAL
  if (id === loop.exit) return GREEN
  const place = placeOf(loop, id)
  if (place.stage) return colors.get(place.stage) ?? DIM
  return place.onCall || place.helperOf ? TEAL : DIM
}

/** The node a transition's `entry` or `exit` word stands for. */
const endName = (loop: Loop, word: string) => (word === 'entry' ? loop.entry : word === 'exit' ? loop.exit : word)
const transitionTitle = (loop: Loop, t: Transition) => `${endName(loop, t.from)} ${t.back ? '⇢' : '→'} ${t.to.map(w => endName(loop, w)).join(' ∥ ')}`
/** A handover with the entry node at one end reads as a stub: `○→ worker` or `worker →○`. */
const handoverTitle = (loop: Loop, h: Handover) => (h.from === loop.entry ? `○→ ${h.to}` : h.to === loop.entry ? `${h.from} →○` : `${h.from} → ${h.to}`)
const handoverId = (h: Handover) => `${h.from}>${h.to}`

function contractWords(n: LoopNode): string {
  switch (n.contract) {
    case 'lands':
      return 'lands work · reports done / done with limitations / failed'
    case 'scores': {
      const extra = [...(n.categories?.length ? [n.categories.join(', ')] : []), ...(n.collectors ? [`up to ${plural(n.collectors, 'collector')}`] : [])]
      return ['scores a rubric · strong / acceptable / unacceptable', ...extra].join(' · ')
    }
    case 'collects':
      return 'collects evidence'
    case 'none':
      return 'answers a prompt'
  }
}

// The focus panel, as rows both the drawing and the text read.

type Row =
  | { kind: 'title'; text: string; color: string; chips: Chip[] }
  | { kind: 'note'; text: string }
  | { kind: 'field'; label: string; text: string }
  | { kind: 'chips'; label: string; items: Array<Chip & { target: ViewerFocus }> }
  | { kind: 'heading'; text: string }
  | { kind: 'link'; text: string; detail: string; color: string; target: ViewerFocus }
  | { kind: 'body'; lines: string[]; more: number }
  | { kind: 'try'; phrases: readonly string[] }

/** How many lines of a node's role the panel shows. */
const ROLE_LINES = 8

function stageRows(loop: Loop, id: string): Row[] | null {
  const colors = stageColors(loop)
  const at = loop.steps.findIndex(s => s.stages.some(st => st.id === id))
  if (at < 0) return null
  const step = loop.steps[at]!
  const stage = step.stages.find(st => st.id === id)!
  const alongside = step.stages.filter(st => st.id !== id).map(st => st.id)
  const transitions = withDefaultTransitions(loop).transitions
  const link = (t: Transition): Row => ({
    kind: 'link',
    text: transitionTitle(loop, t),
    detail: [t.label || 'default', ...(t.when ? [`when ${t.when}`] : [])].join(' · '),
    color: t.back ? YELLOW : TEXT,
    target: { kind: 'transition', id: transitionId(t.from, t.to) },
  })
  const groups: Array<[string, Transition[]]> = [
    ['In', transitions.filter(t => !t.back && t.to.includes(id))],
    ['Out', transitions.filter(t => !t.back && t.from === id)],
    ['Back', transitions.filter(t => t.back && (t.from === id || t.to.includes(id)))],
  ]
  return [
    { kind: 'title', text: id, color: colors.get(id) ?? TEXT, chips: [{ text: 'stage', color: DIM }] },
    { kind: 'note', text: `step ${at + 1} of ${loop.steps.length}${alongside.length > 0 ? ` · alongside ${alongside.join(', ')}` : ''}` },
    { kind: 'field', label: 'Summary', text: stage.summary || 'none' },
    { kind: 'chips', label: 'Nodes', items: stage.nodes.map(n => ({ text: n, color: colors.get(id) ?? TEXT, target: { kind: 'node', id: n } })) },
    ...groups.flatMap(([heading, list]): Row[] => (list.length === 0 ? [] : [{ kind: 'heading', text: heading }, ...list.map(link)])),
    { kind: 'try', phrases: stageTry(loop, id) },
  ]
}

function nodeRows(loop: Loop, id: string): Row[] | null {
  const n = loop.nodes[id]
  if (!n) return null
  const colors = stageColors(loop)
  const place = placeOf(loop, id)
  const isEnd = n.type === 'entry' || n.type === 'exit'
  const chips: Chip[] = [{ text: n.type, color: DIM }]
  if (place.stage) chips.push({ text: place.stage, color: colors.get(place.stage) ?? DIM })
  else if (place.onCall || place.helperOf) chips.push({ text: 'on call', color: TEAL })
  const role = n.role
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
  const handovers = loop.handovers.filter(h => h.from === id || h.to === id)
  return [
    { kind: 'title', text: id, color: nodeColor(loop, id, colors), chips },
    { kind: 'note', text: `nodes/${id}.md${place.helperOf ? ` · helper of ${place.helperOf}` : ''}` },
    { kind: 'field', label: 'Summary', text: n.summary || 'none' },
    ...(isEnd ? [] : [{ kind: 'field' as const, label: 'Models', text: n.models.join(', ') || 'none' }]),
    { kind: 'field', label: 'Skills', text: n.skills.join(', ') || 'none' },
    { kind: 'field', label: 'Contract', text: contractWords(n) },
    { kind: 'field', label: 'Tools', text: n.tools.deny.length > 0 ? `never: ${n.tools.deny.join(', ')}` : 'every tool' },
    { kind: 'heading', text: 'Role' },
    role.length > 0 ? { kind: 'body', lines: role.slice(0, ROLE_LINES), more: Math.max(0, role.length - ROLE_LINES) } : { kind: 'note', text: 'none' },
    { kind: 'heading', text: 'Handovers' },
    ...(handovers.length > 0
      ? handovers.map((h): Row => ({ kind: 'link', text: handoverTitle(loop, h), detail: `${h.label}: ${h.spec}`, color: nodeColor(loop, h.from, colors), target: { kind: 'handover', id: handoverId(h) } }))
      : [{ kind: 'note' as const, text: 'none' }]),
    { kind: 'try', phrases: nodeTry(loop, n) },
  ]
}

function transitionRows(loop: Loop, id: string): Row[] | null {
  const t = withDefaultTransitions(loop).transitions.find(t => transitionId(t.from, t.to) === id)
  if (!t) return null
  return [
    { kind: 'title', text: transitionTitle(loop, t), color: t.back ? YELLOW : TEXT, chips: [{ text: `transition · ${t.back ? 'back' : 'forward'}`, color: t.back ? YELLOW : DIM }] },
    { kind: 'field', label: 'Label', text: t.label || 'none, a default transition' },
    ...(t.when ? [{ kind: 'field' as const, label: 'When', text: t.when }] : t.label ? [] : [{ kind: 'field' as const, label: 'When', text: 'a default transition' }]),
    ...(t.then ? [{ kind: 'field' as const, label: 'Then', text: t.then }] : []),
    { kind: 'try', phrases: transitionTry(loop, t) },
  ]
}

function handoverRows(loop: Loop, id: string): Row[] | null {
  const h = loop.handovers.find(h => handoverId(h) === id)
  if (!h) return null
  return [
    { kind: 'title', text: `${h.from} → ${h.to}`, color: TEXT, chips: [{ text: 'handover', color: DIM }] },
    { kind: 'field', label: 'Label', text: h.label || 'none' },
    { kind: 'field', label: 'Spec', text: h.spec || 'none' },
    { kind: 'try', phrases: handoverTry(loop, h) },
  ]
}

/** The focus panel's rows: a hint without focus, the focused element's rows, or a line saying it is gone. */
function focusRows(state: ViewerState): Row[] {
  const open = state.open
  if (!open) return []
  const f = state.view.focus
  if (!f) return [{ kind: 'note', text: NO_FOCUS }]
  const rows =
    f.kind === 'stage' ? stageRows(open.loop, f.id) : f.kind === 'node' ? nodeRows(open.loop, f.id) : f.kind === 'transition' ? transitionRows(open.loop, f.id) : handoverRows(open.loop, f.id)
  return rows ?? [{ kind: 'note', text: `No ${f.kind} ${f.id} in this loop.` }]
}

const tryText = (phrases: readonly string[]) => `Try saying: ${phrases.map(p => `“${p}”`).join(' · ')}`

/** The focus panel's content as plain text lines (shared by drawViewer and viewerText). */
export function focusText(state: ViewerState): string[] {
  return focusRows(state).flatMap(row => {
    switch (row.kind) {
      case 'title':
        return [[row.text, ...row.chips.map(c => c.text)].join(' · ')]
      case 'note':
      case 'heading':
        return [row.text]
      case 'field':
        return [`${row.label}: ${row.text}`]
      case 'chips':
        return [`${row.label}: ${row.items.map(i => i.text).join(', ') || 'none'}`]
      case 'link':
        return [`  ${row.text}${row.detail ? `  ${row.detail}` : ''}`]
      case 'body':
        return [...row.lines.map(l => `  ${l}`), ...(row.more > 0 ? [`  … ${plural(row.more, 'line')}`] : [])]
      case 'try':
        return [tryText(row.phrases)]
    }
  })
}

// Text for a tool reply.

const spansText = (line: Span[]) => line.map(s => s.text).join('')

function libraryText(state: ViewerState): string {
  const out = [headerText(state)]
  for (const s of SECTIONS) {
    out.push('', `${s.title}  ${s.where}`)
    const refs = state.library.filter(r => r.level === s.level)
    if (refs.length === 0) out.push('  No loops here.')
    for (const ref of refs) {
      const chips = refChips(state, ref).map(c => ` [${c.text}]`).join('')
      out.push(`  ${ref.name}${chips} · ${countsText(ref.counts)}`, `    ${ref.description}`, `    ${ref.dir}`)
    }
  }
  return out.join('\n')
}

function headerText(state: ViewerState): string {
  const d = state.library.find(r => isDefault(state, r))
  return `Loops · ${plural(state.library.length, 'loop')} · default for runs: ${state.defaultLoop}${d ? ` (${d.level})` : ''}`
}

const viewOf = (state: ViewerState): View => ({ folded: state.view.folded, ...(state.view.focus ? { focus: state.view.focus } : {}) })

/** The loop screen as plain text for a tool reply: the terminal rendering's lines joined, the focus panel's text beneath. */
export function viewerText(state: ViewerState, columns: number): string {
  const open = state.open
  if (state.screen === 'library' || !open) return libraryText(state)
  const view = viewOf(state)
  const out = [
    `${open.loop.name} · ${open.ref.level}`,
    open.draft ? `DRAFT · ${draftLine(open.draft)}` : `saved · ${open.ref.dir}`,
    ...(state.notice ? [state.notice] : []),
    ...(open.d2Newer && state.notice !== D2_NOTICE ? [D2_NOTICE] : []),
    ...open.problems.map(p => `${p.path}: ${p.message}`),
    '',
    ...renderTerminal(layout(open.loop, view), view, columns).map(spansText),
    '',
    ...focusText(state),
  ]
  return out.join('\n')
}

// Drawing.

/** A small pill: the label in its colour on the border grey, or filled with its colour when lit. */
function chip(els: Els, key: string, c: Chip, isLit = false): JSX.Element {
  const { Text } = els
  return isLit ? (
    <Text key={key} color={BG} backgroundColor={c.color} bold>
      {` ${c.text} `}
    </Text>
  ) : (
    <Text key={key} color={c.color} backgroundColor={BORDER}>
      {` ${c.text} `}
    </Text>
  )
}

/** A line of text and chips, a space between each. */
function chipLine(els: Els, key: string, lead: JSX.Element, chips: Chip[]): JSX.Element {
  const { Text } = els
  return (
    <Text key={key} wrap="truncate-end">
      {lead}
      {chips.map((c, i) => (
        <Text key={`${key}-${i}`}>
          {' '}
          {chip(els, `${key}-chip-${i}`, c)}
        </Text>
      ))}
    </Text>
  )
}

/** One block per stage in step order, a parallel step as a stacked pair: an SVG on the remote surfaces, glyphs on the terminal. */
function strip(els: Els, key: string, steps: string[][] | undefined, stepCount: number): JSX.Element {
  const { Box, Text, Svg } = els
  const ids = steps?.flat() ?? []
  const colorOf = (id: string) => stageColor(id, ids.indexOf(id))
  const columns: string[][] = steps ?? Array.from({ length: stepCount }, () => [''])
  const fill = (id: string) => (id ? colorOf(id) : FAINT)
  if (Svg) {
    const w = 14
    const gap = 3
    const tall = 8
    const rects = columns.flatMap((stages, i) => {
      const n = Math.max(1, stages.length)
      const each = (tall - (n - 1)) / n
      return stages.map((id, j) => `<rect x="${i * (w + gap)}" y="${j * (each + 1)}" width="${w}" height="${each}" rx="1.5" fill="${fill(id)}"/>`)
    })
    const total = Math.max(1, columns.length * (w + gap) - gap)
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${tall}">${rects.join('')}</svg>`
    return (
      <Box key={key} flexShrink={0} marginRight={1}>
        <Svg source={source} alt={`stages: ${ids.join(', ') || 'unknown'}`} width={total} height={tall} />
      </Box>
    )
  }
  return (
    <Text key={key}>
      {columns.map((stages, i) => (
        <Text key={`${key}-${i}`}>
          {i > 0 ? ' ' : ''}
          {stages.length > 1 ? (
            <Text color={fill(stages[0]!)} backgroundColor={fill(stages[1]!)}>
              ▀▀
            </Text>
          ) : (
            <Text color={fill(stages[0] ?? '')}>██</Text>
          )}
        </Text>
      ))}
      {' '}
    </Text>
  )
}

function libraryCard(els: Els, state: ViewerState, ref: LoopRef, act: ViewerActions): JSX.Element {
  const { Box, Text, Button } = els
  const key = refKey(ref)
  return (
    <Box key={`card-${key}`} flexDirection="column" borderStyle="round" borderColor={BORDER} backgroundColor={PANEL} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1} overflow="hidden">
          {chipLine(
            els,
            `name-${key}`,
            <Text bold color={TEXT}>
              {ref.name}
            </Text>,
            refChips(state, ref),
          )}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button key={`open-${key}`} plain onPress={() => act.open(ref.name, ref.level)}>
            <Text color={TEAL} bold>
              {ref.level === 'plugin' ? 'View' : 'Open'}
            </Text>
          </Button>
        </Box>
      </Box>
      <Text color={DIM} wrap="wrap">
        {ref.description}
      </Text>
      <Box flexDirection="row" alignItems="center">
        {strip(els, `strip-${key}`, state.shapes?.[key], ref.counts.steps)}
        <Text color={DIM} wrap="truncate-end">
          {countsText(ref.counts)}
        </Text>
      </Box>
      <Text color={FAINT} wrap="truncate-end">
        {ref.dir}
      </Text>
    </Box>
  )
}

function drawLibrary(els: Els, state: ViewerState, act: ViewerActions): JSX.Element {
  const { Box, Text } = els
  const d = state.library.find(r => isDefault(state, r))
  return (
    <Box flexDirection="column" backgroundColor={BG} paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={TEXT}>
          Loops
        </Text>
        <Text color={DIM}>{` · ${plural(state.library.length, 'loop')} · default for runs: ${state.defaultLoop}${d ? ` (${d.level})` : ''}`}</Text>
      </Text>
      {SECTIONS.map(s => {
        const refs = state.library.filter(r => r.level === s.level)
        return (
          <Box key={`section-${s.level}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text bold color={TEXT}>
                {s.title}
              </Text>
              <Text color={FAINT}>{`  ${s.where}`}</Text>
            </Text>
            {refs.length === 0 ? <Text color={FAINT}>No loops here.</Text> : refs.map(ref => libraryCard(els, state, ref, act))}
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text color={FAINT} wrap="wrap">
          {LIBRARY_FOOTER}
        </Text>
      </Box>
    </Box>
  )
}

/** A button that focuses a stage or a node: its chip, filled when it is the focus; pressed again it clears the focus. */
function focusButton(els: Els, key: string, c: Chip, target: ViewerFocus, focus: ViewerFocus | undefined, act: ViewerActions): JSX.Element {
  const { Button } = els
  const isLit = focus?.kind === target.kind && focus.id === target.id
  return (
    <Button key={key} plain onPress={() => act.focus(isLit ? null : target)}>
      {chip(els, `${key}-chip`, c, isLit)}
    </Button>
  )
}

function panelRow(els: Els, row: Row, i: number, focus: ViewerFocus | undefined, act: ViewerActions): JSX.Element {
  const { Box, Text, Button } = els
  const key = `panel-${i}`
  switch (row.kind) {
    case 'title':
      return chipLine(
        els,
        key,
        <Text bold color={row.color}>
          {row.text}
        </Text>,
        row.chips,
      )
    case 'note':
      return (
        <Text key={key} color={DIM} wrap="wrap">
          {row.text}
        </Text>
      )
    case 'heading':
      return (
        <Box key={key} marginTop={1}>
          <Text bold color={DIM}>
            {row.text}
          </Text>
        </Box>
      )
    case 'field':
      return (
        <Box key={key} flexDirection="row">
          <Box width={LABEL_COLS} flexShrink={0}>
            <Text color={DIM}>{row.label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={TEXT} wrap="wrap">
              {row.text}
            </Text>
          </Box>
        </Box>
      )
    case 'chips':
      return (
        <Box key={key} flexDirection="row">
          <Box width={LABEL_COLS} flexShrink={0}>
            <Text color={DIM}>{row.label}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
            {row.items.length === 0 ? <Text color={TEXT}>none</Text> : row.items.map(item => focusButton(els, `panel-${item.target.kind}-${item.target.id}`, item, item.target, focus, act))}
          </Box>
        </Box>
      )
    case 'link':
      return (
        <Box key={key} paddingLeft={2}>
          <Button key={`panel-${row.target.kind}-${row.target.id}`} plain onPress={() => act.focus(row.target)}>
            <Text color={row.color}>{row.text}</Text>
            <Text color={DIM}>{row.detail ? `  ${row.detail}` : ''}</Text>
          </Button>
        </Box>
      )
    case 'body':
      return (
        <Box key={key} flexDirection="column" paddingLeft={2}>
          {row.lines.map((line, j) => (
            <Text key={`${key}-${j}`} color={TEXT} wrap="wrap">
              {line}
            </Text>
          ))}
          {row.more > 0 ? <Text color={FAINT}>{`… ${plural(row.more, 'line')}`}</Text> : ''}
        </Box>
      )
    case 'try':
      return (
        <Box key={key} marginTop={1}>
          <Text wrap="wrap">
            <Text color={DIM}>Try saying: </Text>
            {row.phrases.map((p, j) => (
              <Text key={`${key}-${j}`}>
                {j > 0 ? <Text color={FAINT}> · </Text> : ''}
                <Text color={TEXT} italic>{`“${p}”`}</Text>
              </Text>
            ))}
          </Text>
        </Box>
      )
  }
}

/** The canvas: one SVG where the surface draws them, else the terminal lines as coloured spans. */
function canvas(els: Els, loop: Loop, view: View, columns: number): JSX.Element {
  const { Box, Text, Svg } = els
  const lay = layout(loop, view)
  if (Svg) {
    return (
      <Box flexDirection="column">
        <Svg source={renderSvg(lay, view)} alt={`${loop.name} canvas`} width={lay.width} height={lay.height} />
        <Text wrap="truncate-end">
          <Text color={FAINT}>○</Text>
          <Text color={DIM}> orchestrator  </Text>
          <Text color={TEXT}>●</Text>
          <Text color={DIM}> agent  </Text>
          <Text color={TEXT}>◍</Text>
          <Text color={DIM}> swarm  ┆ next  </Text>
          <Text color={YELLOW}>◀┐</Text>
          <Text color={DIM}> back</Text>
        </Text>
      </Box>
    )
  }
  // the terminal rendering ends with its own legend line
  return (
    <Box flexDirection="column">
      {renderTerminal(lay, view, columns).map((line, i) => (
        <Text key={`line-${i}`} wrap="truncate-end">
          {line.length === 0
            ? ' '
            : line.map((s, j) => (
                <Text key={`line-${i}-${j}`} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})}>
                  {s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  )
}

function drawLoop(els: Els, state: ViewerState, act: ViewerActions, columns: number): JSX.Element {
  const { Box, Text, Button } = els
  const open = state.open
  if (!open) {
    return (
      <Box flexDirection="column" backgroundColor={BG} paddingX={1}>
        <Button key="back" plain onPress={() => act.back()}>
          <Text color={TEAL}>‹ Loops</Text>
        </Button>
        <Text color={DIM}>No loop is open.</Text>
      </Box>
    )
  }
  const { loop, ref, draft } = open
  const view = viewOf(state)
  const focus = state.view.focus
  const colors = stageColors(loop)
  const tab = (name: 'canvas' | 'files', label: string) => (
    <Button key={`tab-${name}`} plain onPress={() => act.tab(name)}>
      {state.view.tab === name ? (
        <Text bold color={TEXT} underline>
          {label}
        </Text>
      ) : (
        <Text color={DIM}>{label}</Text>
      )}
    </Button>
  )
  const onCall = Object.entries(loop.onCall).reduce((n, [, helpers]) => n + 1 + helpers.length, 0)
  const stages = loop.steps.flatMap(s => s.stages)
  const nodes = nodeOrder(loop)

  return (
    <Box flexDirection="column" backgroundColor={BG} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" backgroundColor={PANEL} paddingX={1}>
        <Box flexDirection="row" flexShrink={1} overflow="hidden" columnGap={2}>
          <Button key="back" plain onPress={() => act.back()}>
            <Text color={TEAL}>‹ Loops</Text>
          </Button>
          {chipLine(
            els,
            'loop-name',
            <Text bold color={TEXT}>
              {loop.name}
            </Text>,
            [{ text: ref.level, color: DIM }],
          )}
        </Box>
        <Box flexDirection="row" flexShrink={0} columnGap={2}>
          {tab('canvas', 'Canvas')}
          {tab('files', 'Files')}
        </Box>
      </Box>
      {draft ? (
        <Box flexDirection="row" justifyContent="space-between" backgroundColor={DRAFT_BG} paddingX={1}>
          <Box flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color={DRAFT_BG} backgroundColor={YELLOW} bold>
                {' DRAFT '}
              </Text>
              <Text color={YELLOW}>{` ${draftLine(draft)}`}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" flexShrink={0} columnGap={2}>
            <Button key="save" plain onPress={() => act.save()}>
              <Text bold color={GREEN}>
                Save
              </Text>
            </Button>
            <Button key="discard" plain onPress={() => act.discard()}>
              <Text color={ORANGE}>Discard</Text>
            </Button>
          </Box>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color={FAINT} wrap="truncate-end">{`saved · ${ref.dir}`}</Text>
        </Box>
      )}
      {state.notice ? (
        <Box paddingX={1}>
          <Text color={TEXT} wrap="wrap">
            {state.notice}
          </Text>
        </Box>
      ) : (
        ''
      )}
      {open.d2Newer && state.notice !== D2_NOTICE ? (
        <Box paddingX={1}>
          <Text color={YELLOW} wrap="wrap">
            {D2_NOTICE}
          </Text>
        </Box>
      ) : (
        ''
      )}
      {open.problems.length > 0 ? (
        <Box flexDirection="column" paddingX={1}>
          {open.problems.map((p, i) => (
            <Text key={`problem-${i}`} color={ORANGE} wrap="wrap">
              {`${p.path}: ${p.message}`}
            </Text>
          ))}
        </Box>
      ) : (
        ''
      )}
      {state.view.tab === 'files' ? (
        <Box flexDirection="column" marginTop={1}>
          {open.files.length === 0 ? <Text color={FAINT}>No files.</Text> : ''}
          {open.files.map((f, i) => (
            <Text key={`file-${i}`} color={TEXT} wrap="truncate-start">
              {f}
            </Text>
          ))}
          {draft ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={DIM}>
                Draft
              </Text>
              <Text color={YELLOW} wrap="truncate-start">
                {draft.dir}
              </Text>
            </Box>
          ) : (
            ''
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {canvas(els, loop, view, Math.max(40, columns - 2))}
          {onCall > 0 ? (
            <Box>
              <Button key="fold" plain onPress={() => act.fold()}>
                <Text color={TEAL}>{`${state.view.folded ? '▸' : '▾'} on call · ${onCall}`}</Text>
              </Button>
            </Box>
          ) : (
            ''
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            <Text color={DIM}>Focus</Text>
            {stages.map(st => focusButton(els, `focus-stage-${st.id}`, { text: st.id, color: colors.get(st.id) ?? TEXT }, { kind: 'stage', id: st.id }, focus, act))}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={6}>
            {nodes.map(id => focusButton(els, `focus-node-${id}`, { text: id, color: nodeColor(loop, id, colors) }, { kind: 'node', id }, focus, act))}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor={BORDER} backgroundColor={PANEL} paddingX={1} marginTop={1}>
            {focusRows(state).map((row, i) => panelRow(els, row, i, focus, act))}
          </Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={FAINT} wrap="wrap">
          {LOOP_FOOTER}
        </Text>
      </Box>
    </Box>
  )
}

/** The pane, as a pure function of the state: the library or the loop screen. */
export function drawViewer(els: Els, state: ViewerState, act: ViewerActions, columns: number): JSX.Element {
  return state.screen === 'loop' ? drawLoop(els, state, act, columns) : drawLibrary(els, state, act)
}
