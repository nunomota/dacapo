import { describe, expect, test } from 'claude-code/testing'

import type { Loop, LoopNode, Problem } from '../types/loops'
import { graphFromJson, graphOf, nodeFromFile, validateLoop, withDefaultTransitions } from '../hooks/loops'
import { d2Differs, fromD2, toD2 } from '../hooks/loopd2'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'

const NAMES = ['core', 'core-fast', 'core-deep']

/** A shipped loop read from the mirror: loop.json through graphFromJson, each node file through nodeFromFile. */
function shipped(name: string): Loop {
  const { graph } = graphFromJson(SHIPPED_LOOP_FILES[`${name}/loop.json`]!, name)
  const nodes: Record<string, LoopNode> = {}
  for (const [path, text] of Object.entries(SHIPPED_LOOP_FILES)) {
    const m = /^([^/]+)\/nodes\/(.+)\.md$/.exec(path)
    if (m && m[1] === name) nodes[m[2]!] = nodeFromFile(m[2]!, text).node
  }
  return { ...graph, nodes }
}

const node = (id: string, o: Partial<LoopNode> = {}): LoopNode => ({ id, type: 'agent', summary: 'does a thing', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: `The ${id}.`, ...o })

/** A small loop with a parallel step, on-call helpers, a quoted summary and handovers between helpers. */
function small(): Loop {
  const graph = graphOf({
    name: 'small',
    description: 'A small loop.',
    entry: 'boss',
    exit: 'done',
    steps: [
      { stages: [{ id: 'a', summary: 'first', nodes: [] }] },
      {
        stages: [
          { id: 'b', summary: 'left', nodes: ['builder'] },
          { id: 'c', summary: "the user's view", nodes: [] },
        ],
      },
      { stages: [{ id: 'd', summary: 'last: a check', nodes: [] }] },
    ],
    onCall: { scout: ['reader'], helper: [] },
    transitions: [
      { from: 'b', to: ['d'], label: 'built' },
      { from: 'd', to: ['c'], back: true, label: 'again', when: 'the check fails' },
    ],
    handovers: [
      { from: 'boss', to: 'builder', label: 'brief', spec: 'the task' },
      { from: 'scout', to: 'reader', label: 'what to read', spec: 'paths' },
      { from: 'reader', to: 'boss', label: 'notes', spec: 'what it read' },
    ],
  })
  return {
    ...graph,
    nodes: {
      boss: node('boss', { type: 'entry', summary: 'talks to you' }),
      scout: node('scout'),
      reader: node('reader'),
      helper: node('helper'),
      builder: node('builder', { type: 'swarm', contract: 'lands', models: ['opus'] }),
      done: node('done', { type: 'exit', summary: 'the run ends' }),
    },
  }
}

/** The loop as drawn: with its default transitions. */
const drawn = (loop: Loop): Loop => ({ ...withDefaultTransitions(loop), nodes: loop.nodes })

/** The 1-based line of the first occurrence of `needle`. */
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length

/** Asserts a problem whose message holds every one of `words`. */
function expectProblem(problems: Problem[], ...words: string[]) {
  const hit = problems.find(p => p.path === 'loop.d2' && words.every(w => p.message.includes(w)))
  expect(hit, `no problem naming ${JSON.stringify(words)} in ${JSON.stringify(problems)}`).toBeDefined()
}

describe('writing loop.d2', () => {
  test('the shipped loop.d2 files are what toD2 writes', () => {
    for (const name of NAMES) expect(toD2(shipped(name))).toBe(SHIPPED_LOOP_FILES[`${name}/loop.d2`]!)
  })

  test('a parallel step, a stage path, on-call helpers and a quoted summary are drawn', () => {
    const text = toD2(small())
    expect(text).toContain('step2: {\n  grid-columns: 2\n  b: {\n    class: stage\n    summary: left\n    builder: { class: swarm; summary: does a thing }\n  }\n')
    expect(text).toContain("  c: { class: stage; summary: the user's view }\n")
    expect(text).toContain('  d: { class: stage; summary: "last: a check" }\n')
    expect(text).toContain('  on-call: {\n    scout: {\n      class: agent\n      summary: does a thing\n      reader: { class: agent; summary: does a thing }\n    }\n    helper: { class: agent; summary: does a thing }\n  }\n')
    expect(text).toContain('boss -> step1 { class: transition }\n')
    expect(text).toContain('step1 -> step2 { class: transition }\n')
    expect(text).toContain('step2.b -> step3: built { class: transition }\n')
    expect(text).toContain('step3 -> step2.c: again { class: back }\n')
    expect(text).toContain('boss.on-call.scout -> boss.on-call.scout.reader: what to read { class: handover }\n')
    expect(text).toContain('boss -> step2.b.builder: brief { class: handover }\n')
  })

  test('the classes are valid D2: a swarm draws as a stack through style.multiple, and no shape carries a label', () => {
    for (const name of NAMES) {
      const text = SHIPPED_LOOP_FILES[`${name}/loop.d2`]!
      expect(text).toContain('  swarm: { style.multiple: true }\n')
      expect(text).not.toMatch(/^\s*multiple:/m)
      expect(text).not.toMatch(/^\s*[a-z0-9-]+: [A-Z]/m)
    }
    const deep = SHIPPED_LOOP_FILES['core-deep/loop.d2']!
    expect(deep).toContain('  qa: {\n    class: stage\n')
    expect(deep).toContain('    qa-collector: { class: swarm; summary: gathers evidence }\n')
  })
})

describe('reading loop.d2', () => {
  test('each shipped loop comes back from its diagram unchanged', () => {
    for (const name of NAMES) {
      const loop = shipped(name)
      const out = fromD2(toD2(loop), loop)
      expect(out.problems).toEqual([])
      expect(out.opaque).toEqual([])
      expect(drawn(out.loop)).toEqual(drawn(loop))
    }
  })

  test('a parallel step, on-call helpers and the when of a back transition survive the round trip', () => {
    const loop = small()
    const out = fromD2(toD2(loop), loop)
    expect(out.problems).toEqual([])
    expect(out.loop).toEqual(loop)
  })

  test('comments, single quotes, extra whitespace, any block order and edges without a class read as written', () => {
    const text = [
      '# the small loop, by hand',
      "done: 'Done' { class: exit; summary: \"the run ends\" }",
      '',
      "step3: { d: D { class: stage; summary: 'last: a check' } }",
      'step2: {',
      '  grid-columns: 2',
      '  b: B {',
      '    class: stage',
      '    summary:   left    # a trailing comment',
      '    builder: Builder { class: swarm; summary: does a thing }',
      '  }',
      "  c: C { class: stage; summary: the user's view }",
      '}',
      'step1: { a: A { class: stage; summary: first } }',
      'boss: Boss {',
      '  class: entry; summary: talks to you',
      '  on-call: {',
      '    scout: Scout { class: agent; summary: does a thing',
      '      reader: Reader { class: agent; summary: does a thing }',
      '    }',
      '    helper: Helper { class: agent; summary: does a thing }',
      '  }',
      '}',
      'step2.b -> step3: built',
      "step3 -> step2.c: 'again'",
      'boss -> step2.b.builder: brief',
      'boss.on-call.scout -> boss.on-call.scout.reader: "what to read" { class: handover }',
      'boss.on-call.scout.reader->boss: notes',
      '',
    ].join('\n')
    const out = fromD2(text, small())
    expect(out.problems).toEqual([])
    expect(out.opaque).toEqual([])
    expect(out.loop).toEqual(small())
  })

  test('the classes block reads in either form: style.multiple or the older multiple', () => {
    const core = shipped('core')
    const text = toD2(core)
    const old = text.replace('swarm: { style.multiple: true }', 'swarm: { multiple: true }')
    expect(old).not.toBe(text)
    for (const t of [text, old]) {
      const out = fromD2(t, core)
      expect(out.problems).toEqual([])
      expect(out.opaque).toEqual([])
      expect(drawn(out.loop)).toEqual(drawn(core))
    }
  })

  test('an unknown top-level block comes back verbatim and is written back after the generated part', () => {
    const core = shipped('core')
    const legend = 'legend: Legend {\n  near: top-right   # a D2 position\n  label: "a { brace"\n}'
    const out = fromD2(`${toD2(core)}\nnotes: { a: Hello }\n\n${legend}\n`, core)
    expect(out.problems).toEqual([])
    expect(out.opaque).toEqual(['notes: { a: Hello }', legend])
    expect(drawn(out.loop)).toEqual(drawn(core))
    const again = toD2(out.loop, out.opaque)
    expect(again.endsWith(`\nnotes: { a: Hello }\n\n${legend}\n`)).toBe(true)
    expect(fromD2(again, core).opaque).toEqual(out.opaque)
  })

  test('a forward edge without a label where the default goes is not stored; one elsewhere is', () => {
    const loop = small()
    expect(fromD2(toD2(loop), loop).loop.transitions).toEqual(loop.transitions)
    const text = toD2(loop).replace('boss -> step1 { class: transition }', 'boss -> step1: go { class: transition }').replace('step3 -> done { class: transition }', 'step3 -> step1 { class: back }')
    const out = fromD2(text, loop)
    expect(out.problems).toEqual([])
    expect(out.loop.transitions.find(t => t.from === 'entry')).toEqual({ from: 'entry', to: ['a'], back: undefined, label: 'go', when: undefined, then: undefined })
    expect(out.loop.transitions.find(t => t.from === 'd' && t.to[0] === 'a')).toEqual({ from: 'd', to: ['a'], back: true, label: '', when: undefined, then: undefined })
  })

  test('a stage drawn beside qa brings a new node with the stub role, in the qa step', () => {
    const core = shipped('core')
    const security = '  security: Security {\n    class: stage\n    summary: checks the threats\n    security: Security { class: agent; summary: reviews security }\n  }\n'
    const text = toD2(core).replace('step5: {\n', 'step5: {\n  grid-columns: 2\n').replace('  }\n}\n\nstep6: {', `  }\n${security}}\n\nstep6: {`)
    const out = fromD2(text, core)
    expect(out.problems).toEqual([])
    const step = out.loop.steps[4]!
    expect(step.stages.map(s => s.id)).toEqual(['qa', 'security'])
    expect(step.stages[1]).toEqual({ id: 'security', summary: 'checks the threats', nodes: ['security'] })
    expect(out.loop.nodes.security).toEqual({ id: 'security', type: 'agent', summary: 'reviews security', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: 'Role to be written.' })
    expect(out.loop.nodes.qa).toEqual(core.nodes.qa)
    const fromSecurity = out.loop.transitions.filter(t => t.from === 'security')
    expect(fromSecurity.map(t => [t.to, t.label, !!t.back, t.when])).toEqual([
      [['merge'], 'all pass', false, undefined],
      [['implement'], 'fix', true, undefined],
    ])
    expect(out.loop.transitions.find(t => t.from === 'qa' && !t.back)?.when).toBe('every judge of the loop passes')
    expect(validateLoop(out.loop)).toEqual([])
  })
})

describe('problems in loop.d2', () => {
  const core = () => shipped('core')

  test('unbalanced braces: a block never closed and a brace that closes none', () => {
    const text = toD2(core())
    const open = text.replace('step1: {\n  clarify: { class: stage; summary: until nothing is open }\n}\n', 'step1: {\n  clarify: { class: stage; summary: until nothing is open }\n')
    expectProblem(fromD2(open, core()).problems, `line ${lineOf(open, 'step1: {')}:`, 'never closed')
    const stray = `${text}}\n`
    expectProblem(fromD2(stray, core()).problems, `line ${stray.split('\n').length - 1}:`, 'closes no block')
  })

  test('an edge naming an unknown path', () => {
    const text = `${toD2(core())}step9 -> done: skip { class: transition }\n`
    expectProblem(fromD2(text, core()).problems, `line ${lineOf(text, 'step9 ->')}:`, '"step9"', 'not drawn')
  })

  test('a node under two parents', () => {
    const text = toD2(core()).replace('  merge: { class: stage; summary: integrate the run }\n', '  merge: Merge {\n    class: stage\n    summary: integrate the run\n    worker: Worker { class: swarm; summary: builds one task }\n  }\n')
    expectProblem(fromD2(text, core()).problems, `line ${lineOf(text, '    worker: Worker { class: swarm; summary: builds one task }\n  }\n}\n\ndone')}:`, '"worker" is already drawn on line', 'one parent')
  })

  test('a stage in two steps', () => {
    const text = toD2(core()).replace('  merge: { class: stage; summary: integrate the run }\n', '  merge: Merge { class: stage; summary: integrate the run }\n  plan: Plan { class: stage; summary: again }\n')
    expectProblem(fromD2(text, core()).problems, `line ${lineOf(text, '  plan: Plan { class: stage; summary: again }')}:`, 'the stage "plan" is already drawn', 'one step')
  })

  test('an unknown attribute in a known block is a problem, not an opaque block', () => {
    const text = toD2(core()).replace('    summary: build in parallel\n', '    summary: build in parallel\n    colour: red\n')
    const out = fromD2(text, core())
    expectProblem(out.problems, `line ${lineOf(text, 'colour: red')}:`, 'unknown attribute "colour"')
    expect(out.opaque).toEqual([])
  })
})

describe('telling a hand edit from a save', () => {
  test('the diagram toD2 writes differs from no shipped loop, with or without opaque blocks', () => {
    for (const name of NAMES) {
      const loop = shipped(name)
      expect(d2Differs(SHIPPED_LOOP_FILES[`${name}/loop.d2`]!, loop), name).toBe(false)
      expect(d2Differs(toD2(loop, ['notes: { a: Hello }']), loop), name).toBe(false)
    }
    expect(d2Differs(toD2(small()), small())).toBe(false)
  })

  test('what the diagram does not carry never counts: roles, models, skills, tools, specs', () => {
    const core = shipped('core')
    const text = toD2(core)
    const changed: Loop = {
      ...core,
      handovers: core.handovers.map(h => ({ ...h, spec: 'changed' })),
      nodes: { ...core.nodes, worker: { ...core.nodes.worker!, role: 'Another role.', models: ['haiku'], skills: [], tools: { deny: [] } } },
    }
    expect(d2Differs(text, changed)).toBe(false)
  })

  test('a changed summary, an added stage, a moved edge or an unparsable text is an edit', () => {
    const core = shipped('core')
    const text = toD2(core)
    expect(d2Differs(text.replace('summary: builds one task', 'summary: builds a task'), core)).toBe(true)
    expect(d2Differs(text.replace('step6: {\n', 'step6: {\n  grid-columns: 2\n  extra: { class: stage; summary: one more }\n'), core)).toBe(true)
    expect(d2Differs(text.replace('step5 -> step4: fix { class: back }', 'step5 -> step3: fix { class: back }'), core)).toBe(true)
    expect(d2Differs(text.replace(/\n}\n\nstep6/, '\n\nstep6'), core)).toBe(true)
    expect(d2Differs('this is { not a diagram', core)).toBe(true)
  })
})
