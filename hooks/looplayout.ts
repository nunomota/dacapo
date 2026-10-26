import type { Loop, NodeType } from '../types/loops'
import { withDefaultTransitions } from './loops'
import { GREEN, TEAL, YELLOW, cut, stageColor } from './pane'

/** What the viewer has focused. A transition's id is `${from}>${to.join('+')}`, a handover's `${from}>${to}`. */
export type Focus = { kind: 'stage' | 'node' | 'transition' | 'handover'; id: string }
/** How the canvas is viewed: the on-call section folded or open, and the focused element. */
export type View = { folded: boolean; focus?: Focus }
export type Box = { x: number; y: number; w: number; h: number }
/**
 * One element of the canvas. Labels are the loop's own; the renderers draw one word of a back transition, a stub or a
 * line and keep the whole label for the tooltip. `path` is an SVG path of absolute M, L, H and V commands.
 */
export type Placed =
  | { kind: 'entry' | 'exit'; id: string; box: Box; color: string; summary: string }
  | { kind: 'oncall'; box: Box; folded: boolean; count: number }
  | { kind: 'step'; index: number; box: Box }
  | { kind: 'stage'; id: string; step: number; box: Box; color: string; summary: string }
  | { kind: 'node'; id: string; box: Box; color: string; type: NodeType; summary: string; stage?: string; onCall?: boolean; helperOf?: string }
  | { kind: 'transition'; id: string; back: boolean; path: string; labelAt: { x: number; y: number }; label: string }
  | { kind: 'stub'; id: string; node: string; direction: 'in' | 'out'; at: { x: number; y: number }; label: string }
  | { kind: 'line'; id: string; from: string; to: string; path: string; labelAt: { x: number; y: number }; label: string }
export type Layout = { width: number; height: number; placed: Placed[] }
/** A run of terminal text in one style. */
export type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }

// The canvas, in SVG units.

/** The canvas width. */
const WIDTH = 528
/** Tiles and stages run from LEFT to RIGHT; the back channels sit to the right of them. */
const LEFT = 16
const RIGHT = 480
/** The margin above the entry tile and below the exit tile. */
const MARGIN = 16
/** The gap between two rows, where forward transitions run. */
const ROW_GAP = 28
/** The gap between two stages of one step. */
const STAGE_GAP = 16
/** A forward transition runs down this far right of its source's left edge: x=70 under a full-width row. */
const FORWARD_INSET = 54
/** Where a forward transition that skips a step runs down, left of every row. */
const SKIP_X = 8
/** The height of the entry and exit tiles' header, and of a stage with no nodes. */
const TILE_H = 40
/** A node icon's side. */
const ICON = 36
/** From one node icon's top to the next one's. */
const NODE_PITCH = 60
/** The space below the last node of a stage or of the on-call section. */
const PAD = 16
/** From a stage's top to its first node icon's: the name line, then padding. */
const STAGE_HEAD = 36
/** From a stage's left edge to its node icons': room for the stubs. */
const NODE_INSET = 72
/** From a node to the hollow circle at the far end of its stubs. */
const STUB_REACH = 54
/** How far above (in) or below (out) the node's centre a stub runs. */
const STUB_RISE = 6
/** The height of the on-call header line inside the entry tile. */
const ONCALL_HEAD = 24
/** The first back channel; each next one is CHANNEL_STEP further right, squeezed to end by CHANNEL_LAST. */
const CHANNEL_X = 496
const CHANNEL_STEP = 12
const CHANNEL_LAST = WIDTH - 4
/** A back transition drops from its source this far left of the source's right edge. */
const BACK_DROP_INSET = 48
/** A back transition's bottom horizontal runs this far below its source row, under the forward labels; the next one from that row 3 lower. */
const BACK_OUT = 20
const BACK_OUT_STEP = 3
/** The first back transition enters its target row this far below the row's top, the next ones 8 lower. */
const BACK_IN = 12
const BACK_IN_STEP = 8
/** Two handovers between the same two agents run this far either side of the icons' centre line. */
const LINE_SPLIT = 5
/** A character's estimated width as a share of the font size: text longer than its room is cut with an ellipsis. */
const TEXT_EM = 0.6
/** A forward transition's label is cut to this width; a back transition's to BACK_LABEL. */
const FORWARD_LABEL = 160
const BACK_LABEL = 80
/** Without focus, stubs show their word only when no stage (or on-call group) holds more nodes than this. */
const STUB_LABELS_UP_TO = 2

// Colours.

const TEXT = '#e6edf3'
const DIM = '#8b949e'
const FAINT = '#6e7681'
const BACKGROUND = '#0d1117'
const FILL = '#161b22'
const FOCUS = TEXT
const FONT = '-apple-system, Segoe UI, Helvetica, Arial, sans-serif'

/** The words transitions use for the entry and the exit tile. */
const ENTRY = 'entry'
const EXIT = 'exit'

const num = (v: number) => String(Math.round(v * 10) / 10)

/** One word of a label for the canvas: its last, the noun of a phrase like "scored report". */
export const oneWord = (label: string): string => label.trim().split(/\s+/).pop() ?? ''

/** A transition's id: `from>to+to`. */
export const transitionId = (from: string, to: readonly string[]): string => `${from}>${to.join('+')}`

/** A transition's ends from its id. */
const transitionEnds = (id: string): { from: string; to: string[] } => {
  const [from = '', to = ''] = id.split('>')
  return { from, to: to.split('+') }
}

const bottom = (b: Box) => b.y + b.h
const right = (b: Box) => b.x + b.w

/**
 * Lays a loop out on a canvas WIDTH units wide: the entry tile (with the on-call section inside it when the loop has
 * on-call nodes), one row per step with its stages side by side, then the exit tile. Forward transitions run down the
 * left between rows, back transitions up a channel of their own on the right, handovers with the entry node are stubs
 * on the agent and handovers between agents are lines. Pure and deterministic.
 */
export function layout(loop: Loop, view: View): Layout {
  const graph = withDefaultTransitions(loop)
  const placed: Placed[] = []
  const nodeBoxes = new Map<string, Box>()
  const placeNodes = (ids: readonly string[], x: number, top: number, color: string, extra: (id: string) => { stage?: string; onCall?: boolean; helperOf?: string }) =>
    ids.forEach((id, i) => {
      const box = { x, y: top + i * NODE_PITCH, w: ICON, h: ICON }
      const n = loop.nodes[id]
      placed.push({ kind: 'node', id, box, color, type: n?.type ?? 'agent', summary: n?.summary ?? '', ...extra(id) })
      nodeBoxes.set(id, box)
    })
  const stackHeight = (n: number) => (n - 1) * NODE_PITCH + ICON
  const fullWidth = RIGHT - LEFT

  // The entry tile and its on-call section.
  let y = MARGIN
  const groups = Object.entries(loop.onCall)
  const onCallCount = groups.reduce((sum, [, helpers]) => sum + 1 + helpers.length, 0)
  const sectionH = onCallCount === 0 ? 0 : view.folded ? ONCALL_HEAD : ONCALL_HEAD + stackHeight(onCallCount) + PAD
  const entryBox = { x: LEFT, y, w: fullWidth, h: TILE_H + sectionH }
  placed.push({ kind: 'entry', id: loop.entry, box: entryBox, color: TEAL, summary: loop.nodes[loop.entry]?.summary ?? '' })
  if (onCallCount > 0) {
    placed.push({ kind: 'oncall', box: { x: LEFT, y: y + TILE_H, w: fullWidth, h: sectionH }, folded: view.folded, count: onCallCount })
    if (!view.folded) {
      let i = 0
      for (const [key, helpers] of groups) {
        placeNodes([key], LEFT + NODE_INSET, y + TILE_H + ONCALL_HEAD + i * NODE_PITCH, TEAL, () => ({ onCall: true }))
        placeNodes(helpers, LEFT + NODE_INSET, y + TILE_H + ONCALL_HEAD + (i + 1) * NODE_PITCH, TEAL, () => ({ helperOf: key }))
        i += 1 + helpers.length
      }
    }
  }
  y = bottom(entryBox) + ROW_GAP

  // One row per step. `row` numbers the drawn rows: the entry is -1, the exit one past the last.
  type Where = { row: number; box: Box; rowBox: Box }
  const where = new Map<string, Where>([[ENTRY, { row: -1, box: entryBox, rowBox: entryBox }]])
  let row = 0
  let flat = 0
  loop.steps.forEach((step, index) => {
    if (step.stages.length === 0) return
    const k = step.stages.length
    const w = Math.floor((fullWidth - STAGE_GAP * (k - 1)) / k)
    const h = Math.max(...step.stages.map(st => (st.nodes.length > 0 ? STAGE_HEAD + stackHeight(st.nodes.length) + PAD : TILE_H)))
    const rowBox = { x: LEFT, y, w: k * w + (k - 1) * STAGE_GAP, h }
    placed.push({ kind: 'step', index, box: rowBox })
    step.stages.forEach((st, j) => {
      const box = { x: LEFT + j * (w + STAGE_GAP), y, w, h }
      const color = stageColor(st.id, flat++)
      placed.push({ kind: 'stage', id: st.id, step: index, box, color, summary: st.summary })
      if (!where.has(st.id)) where.set(st.id, { row, box, rowBox })
      placeNodes(st.nodes, box.x + NODE_INSET, y + STAGE_HEAD, color, () => ({ stage: st.id }))
    })
    y += h + ROW_GAP
    row++
  })
  const exitBox = { x: LEFT, y, w: fullWidth, h: TILE_H }
  placed.push({ kind: 'exit', id: loop.exit, box: exitBox, color: GREEN, summary: loop.nodes[loop.exit]?.summary ?? '' })
  where.set(EXIT, { row, box: exitBox, rowBox: exitBox })
  const height = bottom(exitBox) + MARGIN

  // Forward transitions: down the left of their source, forking into each stage of the step they lead to.
  const edges: Placed[] = []
  const backs: Array<{ id: string; label: string; from: Where; to: Where }> = []
  for (const t of graph.transitions) {
    const from = where.get(t.from)
    const to = t.to.map(id => where.get(id))
    if (!from || to.length === 0 || to.some(w => !w)) continue
    const targets = to as Where[]
    const id = transitionId(t.from, t.to)
    if (t.back) {
      backs.push({ id, label: t.label, from, to: targets[0]! })
      continue
    }
    const sx = from.box.x + FORWARD_INSET
    const y1 = bottom(from.box)
    const parts = targets.map(target => {
      const tx = target.box.x + FORWARD_INSET
      const ty = target.box.y
      if (target.row !== from.row + 1) return `M${num(sx)} ${num(y1)} V${num(y1 + 8)} H${num(SKIP_X)} V${num(ty - 8)} H${num(tx)} V${num(ty)}`
      // straight down when the target spans the source's x, else a branch along the bottom of the gap
      if (sx >= target.box.x && sx <= right(target.box)) return `M${num(sx)} ${num(y1)} V${num(ty)}`
      return `M${num(sx)} ${num(y1)} V${num(ty - 5)} H${num(tx)} V${num(ty)}`
    })
    edges.push({ kind: 'transition', id, back: false, path: parts.join(' '), labelAt: { x: sx + 6, y: y1 + 15 }, label: t.label })
  }

  // Back transitions: one channel each, shortest first so they nest; edges whose rows do not overlap share a channel.
  const order = backs.map((b, i) => i).sort((a, b) => backs[a]!.from.row - backs[a]!.to.row - (backs[b]!.from.row - backs[b]!.to.row) || a - b)
  const channel = new Array<number>(backs.length)
  for (const i of order) {
    const b = backs[i]!
    let c = 0
    while (order.some(j => channel[j] === c && backs[j]!.to.row <= b.from.row && b.to.row <= backs[j]!.from.row)) c++
    channel[i] = c
  }
  const channels = backs.length === 0 ? 0 : Math.max(...channel) + 1
  const step = channels > 1 ? Math.min(CHANNEL_STEP, (CHANNEL_LAST - CHANNEL_X) / (channels - 1)) : 0
  const channelX = (c: number) => CHANNEL_X + c * step
  // the outer channel enters its target highest and leaves its source lowest, so no horizontal crosses a channel
  const rank = (i: number, same: (j: number) => boolean, outerFirst: boolean) =>
    backs
      .map((_, j) => j)
      .filter(same)
      .sort((a, b) => (outerFirst ? channel[b]! - channel[a]! : channel[a]! - channel[b]!) || a - b)
      .indexOf(i)
  backs.forEach((b, i) => {
    const intoRow = backs.filter(o => o.to.row === b.to.row).length
    const room = intoRow > 1 ? Math.min(BACK_IN_STEP, (b.to.rowBox.h - 2 * BACK_IN) / (intoRow - 1)) : 0
    const ey = b.to.rowBox.y + BACK_IN + rank(i, j => backs[j]!.to.row === b.to.row, true) * Math.max(0, room)
    const hy = bottom(b.from.box) + BACK_OUT + rank(i, j => backs[j]!.from.row === b.from.row, false) * BACK_OUT_STEP
    const cx = channelX(channel[i]!)
    const dx = right(b.from.box) - BACK_DROP_INSET
    const path = `M${num(dx)} ${num(bottom(b.from.box))} V${num(hy)} H${num(cx)} V${num(ey)} H${num(right(b.to.rowBox))}`
    edges.push({ kind: 'transition', id: b.id, back: true, path, labelAt: { x: cx - 4, y: hy - 3 }, label: b.label })
  })

  // Handovers: a stub on the agent when the entry node is one end, a line when both ends are placed agents.
  const pairs = new Set(loop.handovers.map(h => `${h.from}>${h.to}`))
  for (const h of loop.handovers) {
    const id = `${h.from}>${h.to}`
    const toEntry = h.to === loop.entry
    if (h.from === loop.entry || toEntry) {
      const agent = toEntry ? h.from : h.to
      const box = nodeBoxes.get(agent)
      if (!box) continue
      const cy = box.y + box.h / 2
      edges.push({ kind: 'stub', id, node: agent, direction: toEntry ? 'out' : 'in', at: { x: box.x - STUB_REACH, y: toEntry ? cy + STUB_RISE : cy - STUB_RISE }, label: h.label })
      continue
    }
    const a = nodeBoxes.get(h.from)
    const b = nodeBoxes.get(h.to)
    if (!a || !b) continue
    const down = a.y < b.y
    const [upper, lower] = down ? [a, b] : [b, a]
    const cx = upper.x + ICON / 2
    if (upper.x === lower.x) {
      const split = pairs.has(`${h.to}>${h.from}`) ? LINE_SPLIT : 0
      const x = down ? cx - split : cx + split
      const [y1, y2] = down ? [bottom(upper), lower.y] : [lower.y, bottom(upper)]
      const mid = (bottom(upper) + lower.y) / 2 + 3
      edges.push({ kind: 'line', id, from: h.from, to: h.to, path: `M${num(x)} ${num(y1)} V${num(y2)}`, labelAt: { x: down ? x - 4 : x + 4, y: mid }, label: h.label })
    } else {
      const ax = a.x + ICON / 2
      const bx = b.x + ICON / 2
      const ay = down ? bottom(a) : a.y
      const by = down ? b.y : bottom(b)
      edges.push({ kind: 'line', id, from: h.from, to: h.to, path: `M${num(ax)} ${num(ay)} L${num(bx)} ${num(by)}`, labelAt: { x: (ax + bx) / 2 + 4, y: (ay + by) / 2 + 3 }, label: h.label })
    }
  }
  return { width: WIDTH, height, placed: [...placed, ...edges] }
}

// Reading a layout back.

type Pt = { x: number; y: number }

/** The subpaths of a path of absolute M, L, H and V commands, as lists of points. */
function subpaths(path: string): Pt[][] {
  const out: Pt[][] = []
  const tokens = path.match(/[MLHV]|-?[0-9.]+/g) ?? []
  let cmd = 'M'
  let cur: Pt = { x: 0, y: 0 }
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!
    if (/^[MLHV]$/.test(t)) {
      cmd = t
      i++
      continue
    }
    if (cmd === 'M' || cmd === 'L') {
      cur = { x: Number(t), y: Number(tokens[i + 1]) }
      i += 2
    } else {
      cur = cmd === 'H' ? { x: Number(t), y: cur.y } : { x: cur.x, y: Number(t) }
      i++
    }
    if (cmd === 'M') {
      out.push([cur])
      cmd = 'L'
    } else if (out.length > 0) out[out.length - 1]!.push(cur)
  }
  return out
}

type Tile = Extract<Placed, { kind: 'entry' | 'exit' }>
type Of<K extends Placed['kind']> = K extends 'entry' | 'exit' ? Tile : Extract<Placed, { kind: K }>
const ofKind = <K extends Placed['kind']>(lay: Layout, kind: K): Of<K>[] => lay.placed.filter((p): p is Of<K> => p.kind === kind)

/** Whether stubs show their word without focus: when no stage and no on-call group holds more than STUB_LABELS_UP_TO nodes. */
function sparse(lay: Layout): boolean {
  const counts = new Map<string, number>()
  for (const n of ofKind(lay, 'node')) {
    const group = n.stage !== undefined ? `stage:${n.stage}` : `oncall:${n.helperOf ?? n.id}`
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return [...counts.values()].every(c => c <= STUB_LABELS_UP_TO)
}

/** What the focus lights up: an element and its edges. */
function focusOf(lay: Layout, view: View) {
  const f = view.focus
  const entry = ofKind(lay, 'entry')[0]?.id
  const exit = ofKind(lay, 'exit')[0]?.id
  const is = (kind: Focus['kind'], id: string) => f?.kind === kind && f.id === id
  const end = (id: string) => (id === ENTRY ? entry : id === EXIT ? exit : undefined)
  return {
    node: (id: string) => is('node', id),
    stage: (id: string) => is('stage', id),
    tile: (p: Tile) => is('node', p.id),
    transition: (p: Of<'transition'>) => {
      if (is('transition', p.id)) return true
      const { from, to } = transitionEnds(p.id)
      return [from, ...to].some(id => is('stage', id) || (end(id) !== undefined && is('node', end(id)!)))
    },
    stub: (p: Of<'stub'>) => is('handover', p.id) || is('node', p.node) || (entry !== undefined && is('node', entry)),
    line: (p: Of<'line'>) => is('handover', p.id) || is('node', p.from) || is('node', p.to),
  }
}

// SVG.

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Text cut with an ellipsis to fit `room` units at `size` px. */
const fit = (text: string, room: number, size: number): string => (room < size ? '' : cut(text, Math.floor(room / (size * TEXT_EM))))

/** An arrowhead at the end of each subpath of `path`. */
function arrowheads(path: string, color: string): string {
  return subpaths(path)
    .map(pts => {
      if (pts.length < 2) return ''
      const tip = pts[pts.length - 1]!
      const from = pts[pts.length - 2]!
      const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1
      const ux = (tip.x - from.x) / len
      const uy = (tip.y - from.y) / len
      const bx = tip.x - ux * 6
      const by = tip.y - uy * 6
      return `<path d="M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * 3)} ${num(by + ux * 3)} L${num(bx + uy * 3)} ${num(by - ux * 3)} Z" fill="${color}"/>`
    })
    .join('')
}

/** The robot head of `icon('worker')` in hooks/pane.tsx, copied so it can sit inside the canvas at an offset. */
const robot = (color: string) =>
  `<line x1="12" y1="2.5" x2="12" y2="6"/><circle cx="12" cy="2.5" r="0.9" fill="${color}"/><rect x="4" y="6" width="16" height="13" rx="3"/><circle cx="9" cy="12" r="1.4" fill="${color}" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="${color}" stroke="none"/><line x1="9" y1="16" x2="15" y2="16"/><line x1="2" y1="11" x2="4" y2="11"/><line x1="20" y1="11" x2="22" y2="11"/>`

/** A node's icon: the robot head in a rounded square; a swarm stacks two more squares behind it. */
function nodeIcon(b: Box, type: NodeType, color: string): string {
  const square = (dx: number, opacity: number) =>
    `<rect x="${num(b.x + dx)}" y="${num(b.y - dx)}" width="${ICON}" height="${ICON}" rx="8" fill="${BACKGROUND}" stroke="${color}" stroke-width="1.5"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ''}/>`
  const behind = type === 'swarm' ? square(6, 0.35) + square(3, 0.6) : ''
  const head = `<g transform="translate(${num(b.x + 6)} ${num(b.y + 6)})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${robot(color)}</g>`
  return `${behind}${square(0, 1)}${head}`
}

/**
 * The layout as one SVG string: dark background, tiles and stages, dashed transitions, handover stubs and lines, then
 * the nodes on top. Each node, stage, tile and edge is a group with a `<title>` the surface shows as a tooltip. No
 * scripts and no references outside the document.
 */
export function renderSvg(lay: Layout, view: View): string {
  const lit = focusOf(lay, view)
  const showAll = sparse(lay)
  const nodes = new Map(ofKind(lay, 'node').map(n => [n.id, n]))
  const stages = new Map(ofKind(lay, 'stage').map(s => [s.id, s]))
  const entry = ofKind(lay, 'entry')[0]
  const out: string[] = []
  const group = (kind: string, id: string, title: string, body: string) => `<g data-kind="${kind}" data-id="${xml(id)}"><title>${xml(title)}</title>${body}</g>`
  const text = (x: number, y: number, size: number, fill: string, body: string, extra = '') =>
    `<text x="${num(x)}" y="${num(y)}" font-size="${size}" fill="${fill}"${extra}>${body}</text>`

  // tiles
  for (const p of lay.placed) {
    if (p.kind !== 'entry' && p.kind !== 'exit') continue
    const b = p.box
    const focused = lit.tile(p)
    const stroke = focused ? FOCUS : p.color
    const name = fit(p.id, b.w - 60, 12)
    const summary = fit(p.summary, b.w - 60 - name.length * 12 * TEXT_EM - 8, 9)
    const body =
      `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" rx="10" fill="${FILL}" stroke="${stroke}" stroke-width="${focused ? 2 : 1.5}"/>` +
      `<circle cx="${num(b.x + 20)}" cy="${num(b.y + 20)}" r="6" fill="none" stroke="${p.color}" stroke-width="1.5"/><circle cx="${num(b.x + 20)}" cy="${num(b.y + 20)}" r="2.5" fill="${p.color}"/>` +
      text(
        b.x + 34,
        b.y + 24,
        12,
        TEXT,
        `<tspan class="tile-name" font-weight="bold">${xml(name)}</tspan>${summary ? `<tspan dx="8" font-size="9" fill="${DIM}">${xml(summary)}</tspan>` : ''}`,
      )
    out.push(group(p.kind, p.id, `${p.id}: ${p.summary}`, body))
  }
  for (const p of ofKind(lay, 'oncall')) {
    const b = p.box
    out.push(
      `<g data-kind="oncall"><line x1="${num(b.x + 12)}" y1="${num(b.y)}" x2="${num(right(b) - 12)}" y2="${num(b.y)}" stroke="${FAINT}" stroke-width="1"/>` +
        text(b.x + 14, b.y + 16, 9, DIM, xml(`${p.folded ? '▸' : '▾'} ON CALL · ${p.count}`), ' letter-spacing="0.5"') +
        '</g>',
    )
  }

  // stages
  for (const p of stages.values()) {
    const b = p.box
    const focused = lit.stage(p.id)
    const name = fit(p.id, b.w - 24, 11)
    const nameW = name.length * 11 * TEXT_EM
    const summary = fit(p.summary, b.w - 36 - nameW, 9)
    const body =
      `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" rx="6" fill="${FILL}" stroke="${focused ? FOCUS : p.color}" stroke-width="${focused ? 2 : 1}"${focused ? '' : ' stroke-opacity="0.55"'}/>` +
      text(b.x + 12, b.y + 24, 11, p.color, xml(name), ' font-weight="bold" class="stage-name"') +
      (summary ? text(right(b) - 12, b.y + 24, 9, DIM, xml(summary), ' text-anchor="end" class="stage-summary"') : '')
    out.push(group('stage', p.id, `${p.id}: ${p.summary}`, body))
  }

  // transitions
  for (const p of ofKind(lay, 'transition')) {
    const focused = lit.transition(p)
    const color = focused ? FOCUS : p.back ? YELLOW : DIM
    const word = p.back ? fit(oneWord(p.label), BACK_LABEL, 9) : fit(p.label, FORWARD_LABEL, 9)
    const { from, to } = transitionEnds(p.id)
    const body =
      `<path d="${p.path}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="4 3"/>` +
      arrowheads(p.path, color) +
      (word ? text(p.labelAt.x, p.labelAt.y, 9, color, xml(word), p.back ? ' text-anchor="end"' : '') : '')
    out.push(group('transition', p.id, `${from} → ${to.join(' ∥ ')}${p.back ? ' (back)' : ''}${p.label ? `: ${p.label}` : ''}`, body))
  }

  // nodes
  for (const p of nodes.values()) {
    const b = p.box
    const color = lit.node(p.id) ? FOCUS : p.color
    const box = p.stage !== undefined ? stages.get(p.stage)?.box : entry?.box
    const room = (box ? right(box) : RIGHT) - 8 - (right(b) + 10)
    const body =
      nodeIcon(b, p.type, color) +
      text(right(b) + 10, b.y + b.h / 2 - 1, 12, TEXT, xml(fit(p.id, room, 12)), ' font-weight="bold" class="node-name"') +
      text(right(b) + 10, b.y + b.h / 2 + 12, 9, DIM, xml(fit(p.summary, room, 9)), ' class="node-summary"')
    out.push(group('node', p.id, `${p.id}: ${p.summary}`, body))
  }

  // agent-to-agent lines and stubs over the nodes, so a swarm's stacked squares never hide an arrowhead
  for (const p of ofKind(lay, 'line')) {
    const color = lit.line(p) ? FOCUS : (nodes.get(p.from)?.color ?? DIM)
    const start = subpaths(p.path)[0]?.[0]
    const anchor = start && p.labelAt.x < start.x ? ' text-anchor="end"' : ''
    const body =
      `<path d="${p.path}" fill="none" stroke="${color}" stroke-width="1.2"/>` + arrowheads(p.path, color) + text(p.labelAt.x, p.labelAt.y, 9, color, xml(fit(oneWord(p.label), BACK_LABEL, 9)), anchor)
    out.push(group('handover', p.id, `${p.from} → ${p.to}: ${p.label}`, body))
  }

  // stubs: a hollow circle for the entry node, an arrow to or from the agent
  for (const p of ofKind(lay, 'stub')) {
    const n = nodes.get(p.node)
    if (!n) continue
    const focused = lit.stub(p)
    const color = focused ? FOCUS : FAINT
    const near = n.box.x - 3
    const far = p.at.x + 3
    const path = p.direction === 'in' ? `M${num(far)} ${num(p.at.y)} H${num(near)}` : `M${num(near)} ${num(p.at.y)} H${num(far)}`
    const label = focused || showAll ? fit(oneWord(p.label), STUB_REACH - 6, 9) : ''
    const labelY = p.direction === 'in' ? p.at.y - 3 : p.at.y + 9
    const body =
      `<circle cx="${num(p.at.x)}" cy="${num(p.at.y)}" r="3" fill="none" stroke="${color}" stroke-width="1.2"/>` +
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.2"/>` +
      arrowheads(path, color) +
      (label ? text((p.at.x + n.box.x) / 2, labelY, 9, color, xml(label), ' text-anchor="middle" class="stub-label"') : '')
    const [from, to] = p.direction === 'in' ? [entry?.id ?? ENTRY, p.node] : [p.node, entry?.id ?? ENTRY]
    out.push(group('handover', p.id, `${from} → ${to}: ${p.label}`, body))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lay.width} ${num(lay.height)}" width="${lay.width}" height="${num(lay.height)}" font-family="${FONT}"><rect width="${lay.width}" height="${num(lay.height)}" fill="${BACKGROUND}"/>${out.join('')}</svg>`
}

// Terminal.

type Style = Omit<Span, 'text'>
type Cell = { ch: string } & Style

const NODE_GLYPH: Record<NodeType, string> = { entry: '◉', exit: '◉', agent: '●', swarm: '◍' }
const LIGHT = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
const HEAVY = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }
const ROUND = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }

/**
 * The layout as lines of spans for a pane `columns` wide (at least 40): framed entry and exit rows, the on-call
 * section, each step's stage frames side by side with `∥` between, node lines inside, `┆ label` lines for forward
 * transitions, a right-hand channel per back transition, and a legend. Text is cut with an ellipsis before it
 * overflows its frame.
 */
export function renderTerminal(lay: Layout, view: View, columns: number): Span[][] {
  const C = Math.max(40, Math.floor(columns))
  const lit = focusOf(lay, view)
  const showAll = sparse(lay)
  const entry = ofKind(lay, 'entry')[0]
  const exit = ofKind(lay, 'exit')[0]
  const oncall = ofKind(lay, 'oncall')[0]
  const nodes = ofKind(lay, 'node')
  const stages = ofKind(lay, 'stage')
  const steps = ofKind(lay, 'step').sort((a, b) => a.box.y - b.box.y)
  const transitions = ofKind(lay, 'transition')
  const stubs = ofKind(lay, 'stub')
  const lines = ofKind(lay, 'line')
  const backs = transitions.filter(t => t.back)
  const channelOf = (t: Of<'transition'>) => Math.max(...(subpaths(t.path)[0] ?? [{ x: 0, y: 0 }]).map(p => p.x))
  const channelXs = [...new Set(backs.map(channelOf))].sort((a, b) => a - b)
  // the last column of the frames; the back channels take the columns right of it
  const R = C - 1 - (channelXs.length > 0 ? channelXs.length + 1 : 0)

  const grid: Cell[][] = []
  const addLine = () => grid.push(Array.from({ length: C }, () => ({ ch: ' ' }))) - 1
  const put = (line: number, col: number, text: string, style: Style = {}) => {
    ;[...text].forEach((ch, i) => {
      if (col + i >= 0 && col + i < C) grid[line]![col + i] = { ch, ...style }
    })
    return col + [...text].length
  }
  /** Writes `text` from `col` but not past `end`, cut with an ellipsis; returns the column after it. */
  const putCut = (line: number, col: number, end: number, text: string, style: Style = {}) => (end - col < 1 ? col : put(line, col, cut(text, end - col), style))

  // Where every stage frame and row sits once drawn.
  type Frame = { top: number; bottom: number; left: number; width: number }
  const frames = new Map<string, Frame>()
  const rowOf = new Map<number, Frame>()

  /** The lines a column of nodes takes: a line per node, with a line of handover arrows between linked neighbours. */
  type Painter = (line: number, left: number, end: number) => void
  const nodePainters = (ids: Of<'node'>[], color: string): Painter[] => {
    const out: Painter[] = []
    ids.forEach((n, i) => {
      out.push((line, left, end) => {
        const focused = lit.node(n.id)
        const own = stubs.filter(s => s.node === n.id)
        const hasIn = own.some(s => s.direction === 'in')
        const hasOut = own.some(s => s.direction === 'out')
        const stubLit = own.some(s => lit.stub(s))
        const glyph = hasIn && hasOut ? '○⇄' : hasIn ? '○→' : hasOut ? '○←' : '  '
        put(line, left, glyph, stubLit ? { color: FOCUS } : { color: FAINT })
        put(line, left + 3, NODE_GLYPH[n.type], { color: focused ? FOCUS : color })
        let col = putCut(line, left + 5, end, n.id, { color: TEXT, bold: true })
        if (end - col >= 5 && n.summary) col = putCut(line, col + 2, end, n.summary, { dim: true })
        const words = own
          .filter(s => showAll || lit.stub(s))
          .map(s => ({ text: `${s.direction === 'in' ? '→' : '←'}${oneWord(s.label)}`, lit: lit.stub(s) }))
        for (const w of words) {
          if (end - col < w.text.length + 2) break
          col = put(line, col + 2, w.text, w.lit ? { color: FOCUS } : { color: FAINT })
        }
      })
      const next = ids[i + 1]
      if (!next) return
      const between = lines.filter(l => (l.from === n.id && l.to === next.id) || (l.from === next.id && l.to === n.id))
      if (between.length === 0) return
      out.push((line, left, end) => {
        let col = left + 3
        for (const l of between) {
          const style = lit.line(l) ? { color: FOCUS } : { color }
          if (end - col < 3) break
          col = put(line, col, l.from === n.id ? '↓' : '↑', style)
          col = putCut(line, col + 1, end, oneWord(l.label), style) + 2
        }
      })
    })
    return out
  }
  const byY = (a: { box: Box }, b: { box: Box }) => a.box.y - b.box.y

  /** Draws a frame's border; the title is drawn by the caller on the top line. */
  const border = (f: Frame, glyphs: typeof LIGHT, style: Style) => {
    put(f.top, f.left, glyphs.tl, style)
    put(f.top, f.left + f.width - 1, glyphs.tr, style)
    put(f.bottom, f.left, glyphs.bl + glyphs.h.repeat(Math.max(0, f.width - 2)) + glyphs.br, style)
    for (let l = f.top + 1; l < f.bottom; l++) {
      put(l, f.left, glyphs.v, style)
      put(l, f.left + f.width - 1, glyphs.v, style)
    }
  }

  /** A tile: `╭ ◉ name  summary ───╮`, the on-call section inside, `╰───╯`. */
  const tile = (p: Tile | undefined, inner: Painter[]) => {
    if (!p) return
    const top = addLine()
    inner.forEach(() => addLine())
    const f: Frame = { top, bottom: addLine(), left: 0, width: R + 1 }
    const style = { color: lit.tile(p) ? FOCUS : p.color }
    border(f, ROUND, style)
    const end = f.width - 3
    put(top, 2, '◉', { color: p.color })
    let col = putCut(top, 4, end, p.id, { color: TEXT, bold: true })
    if (end - col >= 5 && p.summary) col = putCut(top, col + 2, end, p.summary, { dim: true })
    put(top, col, ` ${'─'.repeat(Math.max(0, f.width - 2 - col))}`, style)
    inner.forEach((paint, i) => paint(top + 1 + i, 2, f.width - 2))
    rowOf.set(p.kind === 'entry' ? -1 : steps.length, f)
  }

  // the entry tile with its on-call section
  const onCallNodes = nodes.filter(n => n.stage === undefined).sort(byY)
  const section: Painter[] = []
  if (oncall) {
    section.push((line, left, end) => putCut(line, left, end, `${oncall.folded ? '▸' : '▾'} ON CALL · ${oncall.count}`, { dim: true }))
    if (!oncall.folded) section.push(...nodePainters(onCallNodes, TEAL))
  }
  tile(entry, section)

  /** The line under a row: `┆ label` under each source of a forward transition. */
  const gap = (sources: Array<{ id: string; left: number; end: number }>) => {
    const line = addLine()
    for (const s of sources) {
      let col = s.left + 2
      for (const t of transitions.filter(t => !t.back && transitionEnds(t.id).from === s.id)) {
        if (s.end - col < 1) break
        const style = lit.transition(t) ? { color: FOCUS } : { dim: true }
        col = put(line, col, '┆', style)
        const { to } = transitionEnds(t.id)
        const skip = to.some(id => !isNext(s.id, id))
        const label = `${t.label}${skip ? ` → ${to.join(' ∥ ')}` : ''}`
        col = (label ? putCut(line, col + 1, s.end, label, style) : col) + 2
      }
    }
  }
  const stepOfStage = new Map(stages.map(s => [s.id, s.step]))
  const rowIndex = (id: string) => (id === ENTRY ? -1 : id === EXIT ? steps.length : steps.findIndex(s => s.index === stepOfStage.get(id)))
  const isNext = (from: string, to: string) => rowIndex(to) === rowIndex(from) + 1
  gap([{ id: ENTRY, left: 0, end: R }])

  // the steps
  steps.forEach((step, r) => {
    const row = stages.filter(s => s.step === step.index).sort((a, b) => a.box.x - b.box.x)
    const k = row.length
    const width = Math.floor((R + 1 - 3 * (k - 1)) / k)
    const content = row.map(s => nodePainters(nodes.filter(n => n.stage === s.id).sort(byY), s.color))
    const height = Math.max(...content.map(c => c.length))
    const top = addLine()
    for (let i = 0; i < height; i++) addLine()
    const bottomLine = addLine()
    row.forEach((s, j) => {
      const left = j * (width + 3)
      const f: Frame = { top, bottom: bottomLine, left, width: j === k - 1 ? R + 1 - left : width }
      frames.set(s.id, f)
      const focused = lit.stage(s.id)
      const style = { color: focused ? FOCUS : s.color, bold: focused || undefined }
      border(f, focused ? HEAVY : LIGHT, style)
      if (j > 0) put(top, left - 2, '∥', { dim: true })
      // ┌ name ─── summary ┐
      const end = left + f.width - 2
      let col = putCut(top, left + 2, end, s.id, { color: s.color, bold: true })
      const rest = end - col - 1
      const summary = rest >= 6 ? cut(s.summary, rest - 3) : ''
      const dashes = Math.max(0, summary ? end - col - 2 - [...summary].length : end - col - 1)
      put(top, col, ' ', {})
      col = put(top, col + 1, (focused ? HEAVY : LIGHT).h.repeat(dashes), style)
      if (summary) put(top, col + 1, summary, { dim: true })
      content[j]!.forEach((paint, i) => paint(top + 1 + i, left + 2, left + f.width - 2))
      // back labels sit in the bottom border, right-aligned: └──── fix ─┘
      const words = backs
        .filter(t => transitionEnds(t.id).from === s.id)
        .map(t => oneWord(t.label))
        .filter(Boolean)
      if (words.length > 0) {
        const label = cut(words.join(' · '), Math.max(1, f.width - 6))
        const lighted = backs.some(t => transitionEnds(t.id).from === s.id && lit.transition(t))
        put(bottomLine, left + f.width - 3 - [...label].length - 1, ` ${label} `, { color: lighted ? FOCUS : YELLOW })
      }
    })
    rowOf.set(r, { top, bottom: bottomLine, left: 0, width: R + 1 })
    gap(row.map((s, j) => ({ id: s.id, left: j * (width + 3), end: j === k - 1 ? R : j * (width + 3) + width })))
  })

  tile(exit, [])

  // the back channels: ◀┐ into the target row, ┆ up the channel, ┄┘ from the source's bottom line
  const into = (t: Of<'transition'>) => rowIndex(transitionEnds(t.id).to[0]!)
  backs.forEach(t => {
    const c = R + 2 + channelXs.indexOf(channelOf(t))
    const target = rowOf.get(into(t))
    const source = frames.get(transitionEnds(t.id).from)
    if (!target || !source) return
    const rank = backs
      .filter(o => into(o) === into(t))
      .sort((a, b) => channelOf(b) - channelOf(a))
      .indexOf(t)
    const entryLine = Math.min(target.top + rank, target.bottom)
    const style = { color: lit.transition(t) ? FOCUS : YELLOW }
    for (let l = entryLine + 1; l < source.bottom; l++) put(l, c, '┆', style)
    put(entryLine, R + 1, `◀${'┄'.repeat(c - R - 2)}┐`, style)
    put(source.bottom, R + 1, `${'┄'.repeat(c - R - 1)}┘`, style)
  })

  // the legend
  const legend = addLine()
  const keys: Array<[string, Style, string]> = [
    ['○', { color: FAINT }, 'orchestrator'],
    ['●', { color: TEXT }, 'agent'],
    ['◍', { color: TEXT }, 'swarm'],
    ['┆', { dim: true }, 'next'],
    ['◀┐', { color: YELLOW }, 'back'],
  ]
  let col = 0
  for (const [glyph, style, word] of keys) {
    if (C - col < glyph.length + word.length + 2) break
    col = put(legend, col, glyph, style)
    col = put(legend, col + 1, word, { dim: true }) + 2
  }

  return grid.map(cells => {
    let last = cells.length
    while (last > 0 && cells[last - 1]!.ch === ' ') last--
    const spans: Span[] = []
    for (const cell of cells.slice(0, last)) {
      const { ch, ...style } = cell
      const prev = spans[spans.length - 1]
      if (prev && prev.color === style.color && prev.dim === style.dim && prev.bold === style.bold) prev.text += ch
      else {
        const span: Span = { text: ch }
        if (style.color !== undefined) span.color = style.color
        if (style.dim) span.dim = true
        if (style.bold) span.bold = true
        spans.push(span)
      }
    }
    return spans
  })
}
