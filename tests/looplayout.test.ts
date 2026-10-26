import { describe, expect, test } from 'claude-code/testing'

import type { Loop, LoopNode } from '../types/loops'
import { readLoop, type LoopFs } from '../hooks/loops'
import { layout, renderSvg, renderTerminal, type Box, type Layout, type Placed, type Span, type View } from '../hooks/looplayout'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'

/** A read-only file system over the shipped loops, placed under `/loops`. */
const shippedFs: LoopFs = {
  read: async path => {
    const text = SHIPPED_LOOP_FILES[path.replace(/^\/loops\//, '')]
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  },
  write: async () => {},
  exists: async path => Object.keys(SHIPPED_LOOP_FILES).some(k => `/loops/${k}`.startsWith(path)),
  list: async dir => {
    const under = `${dir.replace(/^\/loops\//, '')}/`
    return [...new Set(Object.keys(SHIPPED_LOOP_FILES).filter(k => k.startsWith(under)).map(k => k.slice(under.length).split('/')[0]!))].sort()
  },
  remove: async () => {},
}

const shipped = async (name: string): Promise<Loop> => (await readLoop(shippedFs, `/loops/${name}`)).loop

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const node = (id: string, o: Partial<LoopNode> = {}): LoopNode => ({ id, type: 'agent', summary: 'does a thing', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: `The ${id}.`, ...o })

const open: View = { folded: false }

const of = <K extends Placed['kind']>(lay: Layout, kind: K) => lay.placed.filter(p => p.kind === kind) as Extract<Placed, { kind: K | 'entry' | 'exit' }>[]
const find = (lay: Layout, kind: Placed['kind'], id: string) => lay.placed.find(p => p.kind === kind && 'id' in p && p.id === id)
const boxOf = (lay: Layout, kind: Placed['kind'], id: string): Box => {
  const p = find(lay, kind, id)
  if (!p || !('box' in p)) throw new Error(`no ${kind} ${id}`)
  return p.box
}
const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** core-deep with qa and review in one step. */
async function parallel(): Promise<Loop> {
  const loop = clone(await shipped('core-deep'))
  const qa = loop.steps.findIndex(s => s.stages[0]!.id === 'qa')
  loop.steps[qa]!.stages.push(...loop.steps[qa + 1]!.stages)
  loop.steps.splice(qa + 1, 1)
  loop.transitions = loop.transitions.filter(t => !(t.from === 'implement' || t.from === 'qa' || t.from === 'review'))
  loop.transitions.push(
    { from: 'implement', to: ['qa', 'review'], label: 'all landed' },
    { from: 'qa', to: ['merge'], label: 'qa passes' },
    { from: 'review', to: ['merge'], label: 'review passes' },
    { from: 'qa', to: ['implement'], back: true, label: 'fix' },
  )
  return loop
}

/** core with an on-call architect and its scout helper. */
async function withOnCall(): Promise<Loop> {
  const loop = clone(await shipped('core'))
  loop.nodes.architect = node('architect', { summary: 'reshapes the plan' })
  loop.nodes.scout = node('scout', { summary: 'reads the code' })
  loop.onCall = { architect: ['scout'] }
  loop.handovers.push(
    { from: 'orchestrator', to: 'architect', label: 'question', spec: 'what to reshape' },
    { from: 'architect', to: 'scout', label: 'look', spec: 'where to look' },
    { from: 'scout', to: 'architect', label: 'findings', spec: 'what it found' },
  )
  return loop
}

const lineText = (line: Span[]) => line.map(s => s.text).join('')
const cells = (line: Span[]) => [...lineText(line)].length

/** Every tag closes in order, and no `&` stands outside an entity. */
function wellFormed(svg: string): string | null {
  const stack: string[] = []
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue
    if (!m[1]) stack.push(m[2]!)
    else if (stack.pop() !== m[2]) return `</${m[2]}> closes the wrong tag`
  }
  if (stack.length > 0) return `<${stack[stack.length - 1]}> is never closed`
  if (/&(?!amp;|lt;|gt;|quot;|#[0-9]+;)/.test(svg)) return 'an unescaped &'
  return null
}

const count = (text: string, part: string) => text.split(part).length - 1

describe('layout', () => {
  test('core: entry first, the stages in row order, the exit last, nodes inside their stages, no overlaps', async () => {
    const loop = await shipped('core')
    const lay = layout(loop, open)
    expect(lay.width).toBe(528)
    const tiles = lay.placed.filter(p => p.kind === 'entry' || p.kind === 'stage' || p.kind === 'exit')
    expect(tiles[0]!.kind).toBe('entry')
    expect(tiles[tiles.length - 1]!.kind).toBe('exit')
    const stages = of(lay, 'stage') as Extract<Placed, { kind: 'stage' }>[]
    expect(stages.map(s => s.id)).toEqual(loop.steps.flatMap(s => s.stages.map(st => st.id)))
    const ys = tiles.map(t => ('box' in t ? t.box.y : 0))
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    expect(boxOf(lay, 'exit', 'done').y + 40).toBeLessThanOrEqual(lay.height)
    for (const n of of(lay, 'node') as Extract<Placed, { kind: 'node' }>[]) {
      expect(inside(n.box, boxOf(lay, 'stage', n.stage!))).toBe(true)
    }
    for (const kind of ['stage', 'node', 'step'] as const) {
      const boxes = lay.placed.filter(p => p.kind === kind).map(p => (p as { box: Box }).box)
      boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => expect(overlap(a, b)).toBe(false)))
    }
  })

  test('two stages in one step sit side by side with equal widths and one forward transition into the step', async () => {
    const lay = layout(await parallel(), open)
    const qa = boxOf(lay, 'stage', 'qa')
    const review = boxOf(lay, 'stage', 'review')
    expect(qa.y).toBe(review.y)
    expect(qa.w).toBe(review.w)
    expect(review.x - (qa.x + qa.w)).toBe(16)
    const into = (of(lay, 'transition') as Extract<Placed, { kind: 'transition' }>[]).filter(t => !t.back && /^[^>]*>(qa|review)\b/.test(t.id))
    expect(into.map(t => t.id)).toEqual(['implement>qa+review'])
    expect(into[0]!.path).toMatch(/^M70 /)
    // straight into qa, a branch into review
    expect(into[0]!.path).toContain(`V${qa.y}`)
    expect(into[0]!.path).toContain(`H${review.x + 54} V${review.y}`)
  })

  test('on-call nodes and their helpers sit inside the entry tile when open, only the header when folded', async () => {
    const loop = await withOnCall()
    const lay = layout(loop, open)
    const entry = boxOf(lay, 'entry', 'orchestrator')
    const section = of(lay, 'oncall')[0] as Extract<Placed, { kind: 'oncall' }>
    expect(section.count).toBe(2)
    expect(section.folded).toBe(false)
    expect(inside(section.box, entry)).toBe(true)
    for (const id of ['architect', 'scout']) expect(inside(boxOf(lay, 'node', id), section.box)).toBe(true)
    expect(find(lay, 'node', 'architect')).toMatchObject({ onCall: true })
    expect(find(lay, 'node', 'scout')).toMatchObject({ helperOf: 'architect' })
    expect(boxOf(lay, 'node', 'scout').y).toBeGreaterThan(boxOf(lay, 'node', 'architect').y)
    const onCallLines = (of(lay, 'line') as Extract<Placed, { kind: 'line' }>[]).filter(l => l.from === 'scout' || l.to === 'scout')
    expect(onCallLines.map(l => l.id).sort()).toEqual(['architect>scout', 'scout>architect'])
    expect(find(lay, 'stub', 'orchestrator>architect')).toMatchObject({ node: 'architect', direction: 'in' })

    const folded = layout(loop, { folded: true })
    expect(find(folded, 'node', 'architect')).toBeUndefined()
    expect(find(folded, 'node', 'scout')).toBeUndefined()
    expect(of(folded, 'oncall')[0]).toMatchObject({ folded: true, count: 2 })
    expect(boxOf(folded, 'entry', 'orchestrator').h).toBeLessThan(entry.h)
    expect(folded.height).toBeLessThan(lay.height)
  })

  test('a back transition ends at the right edge of its target row, each in a channel of its own', async () => {
    const lay = layout(await shipped('core-deep'), open)
    const implement = boxOf(lay, 'stage', 'implement')
    const backs = (of(lay, 'transition') as Extract<Placed, { kind: 'transition' }>[]).filter(t => t.back)
    expect(backs.map(t => t.id).sort()).toEqual(['merge>implement', 'qa>implement', 'review>implement'])
    const channels = backs.map(t => {
      const m = /H([0-9.]+) V([0-9.]+) H([0-9.]+)$/.exec(t.path)!
      expect(Number(m[3])).toBe(implement.x + implement.w)
      expect(Number(m[2])).toBeGreaterThan(implement.y)
      expect(Number(m[2])).toBeLessThan(implement.y + implement.h)
      return Number(m[1])
    })
    expect(new Set(channels).size).toBe(3)
    // the shortest loop takes the first channel
    expect(channels[backs.findIndex(t => t.id === 'qa>implement')]).toBe(496)
    expect(Math.max(...channels)).toBeLessThanOrEqual(lay.width)
  })
})

describe('renderSvg', () => {
  test('core-deep: well formed, small, every node name and stage summary drawn once', async () => {
    const loop = await shipped('core-deep')
    const svg = renderSvg(layout(loop, open), open)
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 528 ')
    expect(wellFormed(svg)).toBeNull()
    expect(svg).not.toMatch(/<script|href=|url\(/)
    expect(svg.length).toBeLessThan(120000)
    for (const id of Object.keys(loop.nodes).filter(id => id !== loop.entry && id !== loop.exit)) expect(count(svg, `class="node-name">${id}</text>`)).toBe(1)
    for (const s of loop.steps.flatMap(st => st.stages)) expect(count(svg, `>${s.summary}</text>`)).toBe(1)
    expect(svg).toContain('<title>qa → implement (back): fix</title>')
  })

  test('a loop of 30 nodes stays under 120000 characters', () => {
    const nodes: Record<string, LoopNode> = { boss: node('boss', { type: 'entry' }), end: node('end', { type: 'exit' }) }
    const steps = Array.from({ length: 10 }, (_, i) => {
      const ids = [0, 1, 2].map(j => `n${i}-${j}`)
      ids.forEach((id, j) => (nodes[id] = node(id, { type: j === 1 ? 'swarm' : 'agent', summary: 'does a careful thing' })))
      return { stages: [{ id: `s${i}`, summary: 'a stage & more', nodes: ids }] }
    })
    const handovers = Object.keys(nodes)
      .filter(id => id.startsWith('n'))
      .flatMap(id => [
        { from: 'boss', to: id, label: 'brief', spec: '' },
        { from: id, to: 'boss', label: 'report', spec: '' },
      ])
    const loop: Loop = { name: 'big', description: 'Big.', entry: 'boss', exit: 'end', steps, onCall: {}, transitions: [], handovers, nodes }
    const svg = renderSvg(layout(loop, open), { folded: false, focus: { kind: 'node', id: 'n3-1' } })
    expect(wellFormed(svg)).toBeNull()
    expect(svg.length).toBeLessThan(120000)
  })

  test('focus on a node shows its stub labels and draws it white; focus on a stage keeps its colour and marks its frame', async () => {
    const loop = clone(await shipped('core'))
    // three nodes in qa: stubs are unlabeled without focus
    loop.nodes.triage = node('triage')
    loop.steps.find(s => s.stages[0]!.id === 'qa')!.stages[0]!.nodes.push('triage')
    const lay = layout(loop, open)
    const plain = renderSvg(lay, open)
    expect(plain).not.toContain('class="stub-label"')
    const worker = renderSvg(lay, { folded: false, focus: { kind: 'node', id: 'worker' } })
    const group = (svg: string, id: string) => [...svg.matchAll(/<g data-kind="(?:node|stage)" data-id="([^"]*)">.*?<\/g>/g)].find(m => m[1] === id)![0]
    expect(worker).toContain('class="stub-label">brief</text>')
    expect(worker).toContain('class="stub-label">report</text>')
    expect(worker).not.toContain('class="stub-label">judge</text>')
    expect(group(worker, 'worker')).toContain('stroke="#e6edf3"')
    expect(group(plain, 'worker')).not.toContain('stroke="#e6edf3"')

    const qa = renderSvg(lay, { folded: false, focus: { kind: 'stage', id: 'qa' } })
    const color = (find(lay, 'stage', 'qa') as Extract<Placed, { kind: 'stage' }>).color
    expect(group(qa, 'qa')).toMatch(/<rect[^>]*stroke="#e6edf3" stroke-width="2"/)
    expect(group(qa, 'qa')).toContain(`fill="${color}" font-weight="bold" class="stage-name">qa</text>`)
    expect(group(plain, 'qa')).not.toContain('stroke="#e6edf3"')
  })
})

describe('renderTerminal', () => {
  test('core at 60 columns fits, names every stage and node; at 40 columns it still renders', async () => {
    const loop = await shipped('core')
    const lay = layout(loop, open)
    for (const columns of [60, 40]) {
      const lines = renderTerminal(lay, open, columns)
      expect(lines.length).toBeGreaterThan(10)
      for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(columns)
      const text = lines.map(lineText).join('\n')
      if (columns === 60) for (const id of [...loop.steps.flatMap(s => s.stages.map(st => st.id)), ...Object.keys(loop.nodes)]) expect(text).toContain(id)
      expect(text).toContain('╭ ◉ orchestrator')
      expect(text).toContain('┆')
      expect(text).toContain('◀')
    }
  })

  test('parallel stages split the width with ∥ between; the on-call section folds', async () => {
    const lines = renderTerminal(layout(await parallel(), open), open, 60).map(lineText)
    expect(lines.some(l => /┌ qa .*┐ ∥ ┌ review .*┐/.test(l))).toBe(true)
    const loop = await withOnCall()
    const unfolded = renderTerminal(layout(loop, open), open, 60).map(lineText).join('\n')
    expect(unfolded).toContain('▾ ON CALL · 2')
    expect(unfolded).toContain('architect')
    const folded = renderTerminal(layout(loop, { folded: true }), { folded: true }, 60).map(lineText).join('\n')
    expect(folded).toContain('▸ ON CALL · 2')
    expect(folded).not.toContain('scout')
  })

  test('focus on a node draws its glyph white; focus on a stage marks its frame', async () => {
    const lay = layout(await shipped('core'), open)
    const worker = renderTerminal(lay, { folded: false, focus: { kind: 'node', id: 'worker' } }, 60)
    const line = worker.find(l => lineText(l).includes('worker'))!
    // the worker is a swarm
    expect(line.some(s => s.text === '◍' && s.color === '#e6edf3')).toBe(true)
    const qa = renderTerminal(lay, { folded: false, focus: { kind: 'stage', id: 'qa' } }, 60).map(lineText)
    expect(qa.some(l => l.startsWith('┏ qa '))).toBe(true)
  })
})
