import { describe, expect, test } from 'claude-code/testing'

import type { Loop, LoopGraph, LoopNode, Problem } from '../types/loops'
import {
  discardDraft,
  draftKey,
  draftsRoot,
  fnv1a,
  hashLoop,
  listLoops,
  nodeFromFile,
  nodeToFile,
  openDraft,
  parseFrontmatter,
  readDraft,
  readLoop,
  roots,
  serializeFrontmatter,
  toSpec,
  validateLoop,
  withDefaultTransitions,
  writeDraft,
  writeLoop,
  type LoopFs,
} from '../hooks/loops'
import { d2Differs, toD2 } from '../hooks/loopd2'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'
import { FIXTURE_LOOP_FILES } from './fixtures/talk'

/** An in-memory file system: files by absolute path, folders implied by them, an optional clock for stat. */
function memFs(initial: Record<string, string> = {}, mtimes?: Record<string, number>) {
  const files = new Map(Object.entries(initial))
  const under = (dir: string) => `${dir.replace(/\/+$/, '')}/`
  const fs: LoopFs = {
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => void files.set(path, text),
    exists: async path => files.has(path) || [...files.keys()].some(k => k.startsWith(under(path))),
    list: async dir => [...new Set([...files.keys()].filter(k => k.startsWith(under(dir))).map(k => k.slice(under(dir).length).split('/')[0]!))].sort(),
    remove: async path => {
      for (const k of [...files.keys()]) if (k === path || k.startsWith(under(path))) files.delete(k)
    },
  }
  if (mtimes) fs.stat = async path => (path in mtimes ? { mtime: mtimes[path]! } : null)
  return { fs, files }
}

/** The shipped loops placed under `/plugin/loops`. */
function shippedFs() {
  return memFs(Object.fromEntries(Object.entries(SHIPPED_LOOP_FILES).map(([k, v]) => [`/plugin/loops/${k}`, v])))
}

async function shipped(name: string): Promise<Loop> {
  const { fs } = shippedFs()
  return (await readLoop(fs, `/plugin/loops/${name}`)).loop
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const node = (id: string, o: Partial<LoopNode> = {}): LoopNode => ({ id, type: 'agent', summary: 'does a thing', contract: 'none', models: [], skills: [], tools: { deny: [] }, role: `The ${id}.`, ...o })

/** A small valid loop with a parallel step: a, then b ∥ c, then d. */
function small(): Loop {
  return {
    name: 'small',
    description: 'A small loop.',
    entry: 'boss',
    exit: 'done',
    steps: [
      { stages: [{ id: 'a', summary: 'first', nodes: [] }] },
      {
        stages: [
          { id: 'b', summary: 'left', nodes: ['builder'] },
          { id: 'c', summary: 'right', nodes: [] },
        ],
      },
      { stages: [{ id: 'd', summary: 'last', nodes: [] }] },
    ],
    onCall: {},
    transitions: [],
    handovers: [],
    nodes: {
      boss: node('boss', { type: 'entry', summary: 'talks to you' }),
      builder: node('builder', { type: 'swarm', contract: 'lands', models: ['opus'] }),
      done: node('done', { type: 'exit', summary: 'the run ends' }),
    },
  }
}

/** Asserts a problem at `path` whose message holds `words`. */
function expectProblem(problems: Problem[], path: string, words: string) {
  const hit = problems.find(p => p.path === path && p.message.includes(words))
  expect(hit, `no problem at ${path} naming "${words}" in ${JSON.stringify(problems)}`).toBeDefined()
}

describe('frontmatter', () => {
  test('a node file reads into a node and writes back to the same text', async () => {
    const text = SHIPPED_LOOP_FILES['core/nodes/qa.md']!
    const { node: qa, problems } = nodeFromFile('qa', text)
    expect(problems).toEqual([])
    expect(qa).toMatchObject({ type: 'agent', summary: 'judges as the user', contract: 'scores', models: ['opus', 'sonnet'], skills: [], categories: ['core', 'ui-ux'], collectors: 3 })
    expect(qa.tools).toEqual({ deny: ['Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'] })
    expect(qa.role).toStartWith('You are the QA subagent')
    expect(nodeToFile(qa)).toBe(text)
  })

  test('serialize then parse is the identity on the subset', () => {
    const data = { type: 'swarm', summary: 'builds one task', models: ['opus', 'sonnet'], skills: [], tools: { deny: ['Agent'] }, collectors: 0 }
    const text = serializeFrontmatter(data, '\nThe role.\n\nTwo paragraphs.  \n')
    expect(text).toBe('---\ntype: swarm\nsummary: builds one task\nmodels: [opus, sonnet]\nskills: []\ntools: { deny: [Agent] }\ncollectors: 0\n---\n\nThe role.\n\nTwo paragraphs.\n')
    expect(parseFrontmatter(text)).toEqual({ data, body: 'The role.\n\nTwo paragraphs.', problems: [] })
    expect(parseFrontmatter(serializeFrontmatter({ type: 'exit' }, ''))).toEqual({ data: { type: 'exit' }, body: '', problems: [] })
  })

  test('each malformed shape is a problem naming its line', () => {
    expect(parseFrontmatter('type: agent\n').problems[0]).toContain('must start with a "---" line')
    expect(parseFrontmatter('---\ntype: agent\n').problems[0]).toContain('no closing "---"')
    const out = parseFrontmatter(['---', 'type: agent', '- a list item', 'models: [opus, sonnet', 'tools: { allow: Edit }', 'type: swarm', 'summary:', '---', 'body'].join('\n'))
    expect(out.problems).toEqual([
      'line 3: not "key: value": - a list item',
      'line 4: "models" is not a list like [a, b]: [opus, sonnet',
      'line 5: "tools" is not like { deny: [a, b] }: { allow: Edit }',
      'line 6: "type" is set twice',
      'line 7: "summary" has no value',
    ])
    expect(out.data).toEqual({ type: 'agent' })
    expect(out.body).toBe('body')
  })

  test('a node file with unknown keys, wrong values or missing keys names each', () => {
    const text = ['---', 'type: robot', 'contract: ships', 'models: opus', 'skills: [a]', 'tools: { allow: [Edit] }', 'collectors: many', 'colour: blue', '---', '', 'Role.'].join('\n')
    const { node: n, problems } = nodeFromFile('x', text)
    expectProblem(problems, 'nodes.x.colour', 'unknown key "colour"')
    expectProblem(problems, 'nodes.x.type', 'must be one of entry, agent, swarm, exit')
    expectProblem(problems, 'nodes.x.contract', 'must be one of lands, scores, collects, none')
    expectProblem(problems, 'nodes.x.summary', '"summary" is missing')
    expectProblem(problems, 'nodes.x.models', 'must be a list')
    expectProblem(problems, 'nodes.x.tools', '{ deny: [Edit, Agent] }')
    expectProblem(problems, 'nodes.x.collectors', 'whole number')
    expect(n.skills).toEqual(['a'])
    expect(n.role).toBe('Role.')
    const bare = nodeFromFile('y', '---\nsummary: x\n---\n')
    expectProblem(bare.problems, 'nodes.y.type', '"type" is missing')
    expectProblem(bare.problems, 'nodes.y.contract', '"contract" is missing')
    expectProblem(nodeFromFile('z', 'no frontmatter').problems, 'nodes.z', 'nodes/z.md line 1')
  })
})

describe('default transitions', () => {
  test('every source without a forward transition goes to the next step; the last goes to exit', () => {
    const out = withDefaultTransitions(small())
    expect(out.transitions).toEqual([
      { from: 'entry', to: ['a'], label: '' },
      { from: 'a', to: ['b', 'c'], label: '' },
      { from: 'b', to: ['d'], label: '' },
      { from: 'c', to: ['d'], label: '' },
      { from: 'd', to: ['exit'], label: '' },
    ])
  })

  test('a listed forward transition replaces the default; a back one does not', () => {
    const g: LoopGraph = { ...small(), transitions: [{ from: 'a', to: ['d'], label: 'skip' }, { from: 'd', to: ['a'], back: true, label: 'again' }] }
    const out = withDefaultTransitions(g).transitions
    expect(out.filter(t => t.from === 'a')).toEqual([{ from: 'a', to: ['d'], label: 'skip' }])
    expect(out.filter(t => t.from === 'd' && !t.back)).toEqual([{ from: 'd', to: ['exit'], label: '' }])
    expect(withDefaultTransitions({ ...small(), steps: [] }).transitions).toEqual([{ from: 'entry', to: ['exit'], label: '' }])
  })

  test('the shipped loops list every transition, so none is added', async () => {
    for (const name of ['core', 'core-fast', 'core-deep']) {
      const loop = await shipped(name)
      expect(withDefaultTransitions(loop).transitions).toEqual(loop.transitions)
    }
  })
})

describe('validation', () => {
  const broken = (base: Loop, change: (l: Loop) => void) => {
    const l = clone(base)
    change(l)
    return validateLoop(l)
  }

  test('the small loop and a blank loop are valid; a none node with models is fine', () => {
    expect(validateLoop(small())).toEqual([])
    expect(broken(small(), l => (l.nodes.builder!.contract = 'none'))).toEqual([])
  })

  test('the loop: a name that is an id, a description', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.name = '')), 'name', 'a name is required')
    expectProblem(broken(core, l => (l.name = 'My Loop')), 'name', 'is not an id')
    expectProblem(broken(core, l => (l.description = ' ')), 'description', 'description is empty')
  })

  test('exactly one entry and one exit node, named by entry and exit', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.nodes.boss = node('boss', { type: 'entry' }))), 'entry', 'exactly one entry node; it has 2')
    expectProblem(broken(core, l => (l.entry = 'worker')), 'entry', 'the entry must name the entry node')
    expectProblem(broken(core, l => delete l.nodes.done), 'exit', 'exactly one exit node; it has 0')
    expectProblem(broken(core, l => (l.exit = 'nobody')), 'exit', 'is not a node')
  })

  test('ids match the pattern; summaries have 1 to 5 words', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.nodes.Worker = { ...l.nodes.worker!, id: 'Worker' })), 'nodes.Worker', 'is not an id')
    expectProblem(broken(core, l => (l.nodes.worker!.id = 'builder')), 'nodes.worker', 'ids must match their file')
    expectProblem(broken(core, l => (l.steps[0]!.stages[0]!.id = 'Clarify')), 'steps[0].stages[0]', 'is not an id')
    expectProblem(broken(core, l => (l.steps[0]!.stages[0]!.id = 'exit')), 'steps[0].stages[0]', 'a stage needs another id')
    expectProblem(broken(core, l => (l.nodes.worker!.summary = 'builds one task and then some')), 'nodes.worker.summary', 'a summary has 1 to 5 words')
    expectProblem(broken(core, l => (l.steps[1]!.stages[0]!.summary = '')), 'steps[1].stages[0].summary', 'a summary has 1 to 5 words')
  })

  test('every stage is in exactly one step; every step has a stage', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => l.steps.push({ stages: [{ id: 'plan', summary: 'again', nodes: [] }] })), 'steps[6].stages[0]', 'every stage is in exactly one step')
    expectProblem(broken(core, l => l.steps.splice(2, 0, { stages: [] })), 'steps[2]', 'every step has at least one stage')
  })

  test('every node is in exactly one place; entry and exit in none', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.steps[3]!.stages[0]!.nodes = [])), 'nodes.worker', 'every node is in exactly one place')
    expectProblem(broken(core, l => (l.onCall = { worker: [] })), 'nodes.worker', 'placed 2 times; every node is in exactly one place')
    expectProblem(broken(core, l => l.steps[0]!.stages[0]!.nodes.push('orchestrator')), 'nodes.orchestrator', 'entry and exit are in no stage')
    expectProblem(broken(core, l => l.steps[0]!.stages[0]!.nodes.push('ghost')), 'steps[0].stages[0].nodes', 'ghost, which is not a node')
    expectProblem(broken(core, l => (l.onCall = { ghost: [] })), 'onCall.ghost', 'is on call but is not a node')
    const onCall = broken(core, l => {
      l.steps[3]!.stages[0]!.nodes = []
      l.onCall = { worker: ['helper'] }
      l.nodes.helper = node('helper')
    })
    expect(onCall).toEqual([])
  })

  test('every stage and the exit are reachable from entry, with the default transitions', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.transitions[0]!.to = ['research'])), 'steps[0].stages[0]', 'not reachable from entry')
    expectProblem(broken(core, l => (l.transitions.find(t => t.to[0] === 'exit')!.to = ['merge'])), 'exit', 'exit is not reachable from entry')
  })

  test('transitions name known stages, go back only to earlier steps, and forward to a whole step', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.transitions[1]!.from = 'nowhere')), 'transitions[1]', 'from and to name known stages or entry and exit')
    expectProblem(broken(core, l => l.transitions.push({ from: 'clarify', to: ['merge'], back: true, label: 'x' })), 'transitions[9]', 'a back transition points to an earlier step')
    expectProblem(broken(core, l => l.transitions.push({ from: 'merge', to: ['plan'], label: 'x' })), 'transitions[9]', 'is marked back')
    expectProblem(broken(small(), l => l.transitions.push({ from: 'a', to: ['b'], label: 'half' })), 'transitions[0]', 'lists every stage of one step')
    expect(broken(small(), l => l.transitions.push({ from: 'a', to: ['c', 'b'], label: 'whole' }))).toEqual([])
  })

  test('handovers name known nodes, two different ones, once per pair', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.handovers[0]!.to = 'ghost')), 'handovers[0]', 'a handover names known nodes')
    expectProblem(broken(core, l => (l.handovers[0]!.to = 'orchestrator')), 'handovers[0]', 'from differs from to')
    expectProblem(broken(core, l => l.handovers.push({ ...l.handovers[0]! })), 'handovers[6]', 'there is no duplicate pair')
  })

  test('contracts: models, categories, a scoring judge for collectors, entry and exit at none', async () => {
    const core = await shipped('core')
    expectProblem(broken(core, l => (l.nodes.worker!.models = [])), 'nodes.worker.models', 'a lands node needs at least one model')
    expectProblem(broken(core, l => (l.nodes.qa!.models = [])), 'nodes.qa.models', 'a scores node needs at least one model')
    expectProblem(broken(core, l => delete l.nodes.qa!.categories), 'nodes.qa.categories', 'a scores node needs categories')
    expectProblem(broken(core, l => (l.handovers = l.handovers.filter(h => h.to !== 'qa-collector'))), 'nodes.qa-collector.contract', 'a collects node needs a handover from a scores node')
    expectProblem(broken(core, l => (l.nodes.orchestrator!.contract = 'lands')), 'nodes.orchestrator.contract', 'entry and exit have contract none')
    expectProblem(broken(core, l => (l.nodes.done!.models = ['opus'])), 'nodes.done.models', 'entry and exit have no models')
    expectProblem(broken(core, l => (l.nodes.worker!.models = ['Opus 5'])), 'nodes.worker.models', 'is not a model name')
    expectProblem(broken(core, l => (l.nodes.worker!.skills = ['rules commits'])), 'nodes.worker.skills', 'is not a skill name')
    expectProblem(broken(core, l => (l.nodes.worker!.categories = ['core'])), 'nodes.worker.categories', 'for scores nodes only')
    expectProblem(broken(core, l => (l.nodes.qa!.collectors = -1)), 'nodes.qa.collectors', 'whole number')
  })

  test('at most one lands node per stage', async () => {
    const core = await shipped('core')
    const problems = broken(core, l => {
      l.nodes.fixer = node('fixer', { contract: 'lands', models: ['sonnet'] })
      l.steps[3]!.stages[0]!.nodes.push('fixer')
    })
    expectProblem(problems, 'steps[3].stages[0]', 'a stage holds at most one lands node')
  })
})

describe('the spec', () => {
  test('LOOP.md of core holds every role, step, transition and handover', async () => {
    const core = await shipped('core')
    const spec = toSpec(core)
    expect(spec).toBe(SHIPPED_LOOP_FILES['core/LOOP.md']!)
    expect(spec.split('\n')[0]).toBe('<!-- generated by dacapo from loop.json and nodes/*.md; edit those, not this -->')
    expect(spec).toContain('\n# core\n')
    const sections = spec.split('\n').filter(l => l.startsWith('## '))
    expect(sections).toEqual(['## Roles', '## Order', '## Transitions', '## Handovers'])
    for (const n of Object.values(core.nodes)) {
      expect(spec).toContain(`### ${n.id}\n`)
      expect(spec).toContain(n.role.trim())
    }
    const roles = spec.split('\n').filter(l => l.startsWith('### '))
    expect(roles).toEqual(['### orchestrator', '### worker', '### qa', '### qa-collector', '### done'])
    for (const s of core.steps.flatMap(s => s.stages)) expect(spec).toContain(`${s.id} (${s.summary})${s.nodes.length ? '\n' : ' (the orchestrator alone)\n'}`)
    const list = (items: string[] | undefined) => (items?.length ? items.join(', ') : 'none')
    for (const n of Object.values(core.nodes)) {
      const section = spec.slice(spec.indexOf(`### ${n.id}\n`), spec.indexOf(n.role.trim()))
      expect(section, n.id).toContain(`\n- Models: ${list(n.models)}\n- Skills: ${list(n.skills)}\n`)
      if (n.contract === 'scores') expect(section, n.id).toContain(`\n- Categories: ${list(n.categories)}\n${n.collectors !== undefined ? `- Collectors: ${n.collectors}\n` : ''}`)
      else expect(section, n.id).not.toContain('- Categories:')
      if (n.tools.deny.length) expect(section, n.id).toContain(`\n- Denied tools: ${n.tools.deny.join(', ')}\n`)
      else expect(section, n.id).not.toContain('- Denied tools:')
    }
    expect(spec).toContain('### qa\n\nJudges as the user. One agent. It works in the qa stage. Contract: scores (judges a rubric). It scores every rubric item in the categories core, ui-ux, and the host derives the verdict. It may run up to 3 collectors at once.\n\n- Models: opus, sonnet\n- Skills: none\n- Categories: core, ui-ux\n- Collectors: 3\n- Denied tools: Edit, NotebookEdit, EnterWorktree, ExitWorktree\n\nYou are the QA subagent')
    // the entry and the exit by their node ids, as everywhere a person reads them
    const end = (w: string) => (w === 'entry' ? core.entry : w === 'exit' ? core.exit : w)
    expect(spec).toContain('\n- orchestrator → clarify: handed over\n')
    expect(spec).toContain('\n- merge → done: integrated\n')
    expect(spec).not.toMatch(/→ exit|entry →/)
    for (const n of Object.values(core.nodes)) expect(spec).toContain(`Contract: ${n.contract} (`)
    expect(spec).toContain('The run ends. The exit. Contract: none (answers a prompt).\n')
    for (const t of core.transitions) {
      expect(spec).toContain(`- ${end(t.from)} → ${t.to.map(end).join(' ∥ ')}${t.back ? ' (back)' : ''}: ${t.label}`)
      if (t.when) expect(spec).toContain(`When ${t.when}.`)
      if (t.then) expect(spec).toContain(`Then ${t.then}.`)
    }
    for (const h of core.handovers) expect(spec).toContain(`- ${h.from} → ${h.to}: ${h.label}. ${h.spec[0]!.toUpperCase()}${h.spec.slice(1)}.`)
    expect(spec).not.toContain('—')
    expect(spec).not.toContain('–')
  })

  test('LOOP.md opens with a paragraph for a reader without the plugin; Collectors only where the node sets it', async () => {
    for (const name of ['core', 'core-deep', 'core-fast']) {
      const loop = await shipped(name)
      const spec = toSpec(loop)
      expect(spec, name).toBe(SHIPPED_LOOP_FILES[`${name}/LOOP.md`]!)
      const [, after] = spec.split(`${loop.description}\n\n`)
      const paragraph = after!.split('\n')[0]!
      expect(paragraph, name).toStartWith(`This file describes the ${name} loop in plain words`)
      for (const word of ['the orchestrator (the agent the user talks to)', 'A swarm is many copies', 'A transition marked (back) returns the loop to an earlier step', 'The host is whatever program runs the agents']) {
        expect(paragraph, name).toContain(word)
      }
      expect(spec, name).not.toContain('in this plugin that binding is the core skill')
    }
    const deep = toSpec(await shipped('core-deep'))
    const reviewer = deep.slice(deep.indexOf('### reviewer\n'), deep.indexOf('### done\n'))
    expect(reviewer).toContain('- Categories: quality, consistency, cleanup\n- Denied tools:')
    expect(reviewer).not.toContain('Collectors')
  })

  test('parallel stages share an order line; default transitions are marked', () => {
    const spec = toSpec(small())
    expect(spec).toContain('1. a (first) (the boss alone)\n2. b (left) ∥ c (right) (the boss alone)\n3. d (last) (the boss alone)\n')
    expect(spec).toContain('- a → b ∥ c (default)')
  })
})

describe('hashing', () => {
  test('stable over key order and role whitespace, changed by any edit', async () => {
    const core = await shipped('core')
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v
    const shuffled = reversed(core) as Loop
    expect(Object.keys(shuffled)[0]).toBe('nodes')
    expect(hashLoop(shuffled)).toBe(hashLoop(core))
    const spaced = clone(core)
    spaced.nodes.worker!.role = `\n${spaced.nodes.worker!.role}\n\n`
    expect(hashLoop(spaced)).toBe(hashLoop(core))
    const edited = clone(core)
    edited.steps[0]!.stages[0]!.summary = 'until nothing is unclear'
    expect(hashLoop(edited)).not.toBe(hashLoop(core))
    expect(hashLoop(core)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('roots and listing', () => {
  test('roots follow DACAPO_HOME and the repository', () => {
    expect(roots({ home: '/home/u', dacapoHome: null, pluginRoot: '/p', repoRoot: '/repo' })).toEqual({
      plugin: '/p/loops',
      user: '/home/u/.claude/dacapo/loops',
      project: '/repo/.claude/dacapo/loops',
    })
    expect(roots({ home: '/home/u', dacapoHome: '/tmp/dh/', pluginRoot: '/p', repoRoot: null })).toEqual({ plugin: '/p/loops', user: '/tmp/dh/loops', project: null })
    expect(draftsRoot({ home: '/home/u', dacapoHome: null })).toBe('/home/u/.claude/dacapo/drafts')
    expect(draftsRoot({ home: '/home/u', dacapoHome: '/tmp/dh' })).toBe('/tmp/dh/drafts')
  })

  test('draft keys name the level, and the repository for a project loop', () => {
    expect(draftKey({ level: 'user', name: 'mine', repoRoot: '/repo' })).toBe('user--mine')
    expect(draftKey({ level: 'plugin', name: 'core', repoRoot: null })).toBe('plugin--core')
    expect(draftKey({ level: 'project', name: 'mine', repoRoot: '/repo' })).toBe(`project--${fnv1a('/repo')}--mine`)
    expect(fnv1a('/repo')).toMatch(/^[0-9a-f]{8}$/)
  })

  test('every level is listed project first, names in order, shadowed loops marked, drafts attached', async () => {
    const { fs, files } = shippedFs()
    const r = roots({ home: '/home/u', dacapoHome: '/dh', pluginRoot: '/plugin', repoRoot: '/repo' })
    const core = await shipped('core')
    await writeLoop(fs, '/dh/loops/core', { ...core, description: 'My core.' })
    await writeLoop(fs, '/repo/.claude/dacapo/loops/zeta', { ...small(), name: 'zeta' })
    await writeLoop(fs, '/repo/.claude/dacapo/loops/core', { ...core, description: 'The team core.' })
    files.set('/dh/loops/notes/readme.md', 'not a loop')
    const refs = await listLoops(fs, r)
    expect(refs.map(x => `${x.level}:${x.name}:${x.shadowedBy ?? '-'}`)).toEqual([
      'project:core:-',
      'project:zeta:-',
      'user:core:project',
      'plugin:core:project',
      'plugin:core-deep:-',
      'plugin:core-fast:-',
    ])
    expect(refs[0]).toMatchObject({ dir: '/repo/.claude/dacapo/loops/core', description: 'The team core.', counts: { stages: 6, steps: 6, nodes: 5, edges: 15 } })
    expect(refs[1]!.counts).toEqual({ stages: 4, steps: 3, nodes: 3, edges: 5 })
    expect(refs.some(x => x.draft)).toBe(false)
    const dr = draftsRoot({ home: '/home/u', dacapoHome: '/dh' })
    await openDraft(fs, dr, { level: 'plugin', name: 'core-fast', repoRoot: '/repo' }, await shipped('core-fast'))
    await openDraft(fs, dr, { level: 'project', name: 'zeta', repoRoot: '/repo' }, null)
    const withDrafts = await listLoops(fs, r, { root: dr, repoRoot: '/repo' })
    expect(withDrafts.filter(x => x.draft).map(x => `${x.level}:${x.name}`)).toEqual(['project:zeta', 'plugin:core-fast'])
    expect(withDrafts.find(x => x.name === 'core-fast')!.draft!.dir).toBe('/dh/drafts/plugin--core-fast')
    expect((await listLoops(fs, { ...r, project: null })).map(x => x.name)).toEqual(['core', 'core', 'core-deep', 'core-fast'])
    // the loop that wins a name says what it hides
    expect(refs.find(x => x.level === 'project' && x.name === 'core')!.hides).toEqual(['user', 'plugin'])
    expect(refs.find(x => x.level === 'plugin' && x.name === 'core-fast')!.hides).toBeUndefined()
  })

  test('with drafts, a new loop not saved yet is listed at its level, unsaved, and counts for resolution; a run does not see it', async () => {
    const { fs } = shippedFs()
    const r = roots({ home: '/home/u', dacapoHome: '/dh', pluginRoot: '/plugin', repoRoot: '/repo' })
    const dr = draftsRoot({ home: '/home/u', dacapoHome: '/dh' })
    await openDraft(fs, dr, { level: 'user', name: 'core', repoRoot: '/repo' }, await shipped('core'))
    await openDraft(fs, dr, { level: 'user', name: 'alpha', repoRoot: '/repo' }, null)
    const listed = await listLoops(fs, r, { root: dr, repoRoot: '/repo' })
    expect(listed.map(x => `${x.level}:${x.name}:${x.unsaved ? 'unsaved' : 'saved'}:${x.shadowedBy ?? '-'}:${(x.hides ?? []).join('+') || '-'}`)).toEqual([
      'user:alpha:unsaved:-:-',
      'user:core:unsaved:-:plugin',
      'plugin:core:saved:user:-',
      'plugin:core-deep:saved:-:-',
      'plugin:core-fast:saved:-:-',
    ])
    expect(listed[1]).toMatchObject({ dir: '/dh/loops/core', draft: { dir: '/dh/drafts/user--core' } })
    // a run resolves saved loops only
    expect((await listLoops(fs, r)).map(x => `${x.level}:${x.name}:${x.shadowedBy ?? '-'}`)).toEqual(['plugin:core:-', 'plugin:core-deep:-', 'plugin:core-fast:-'])
  })
})

describe('reading and writing a folder', () => {
  test('a missing node file, an unreferenced one and bad JSON are problems', async () => {
    const { fs } = shippedFs()
    await fs.remove('/plugin/loops/core/nodes/worker.md')
    await fs.write('/plugin/loops/core/nodes/stray.md', nodeToFile(node('stray')))
    const read = await readLoop(fs, '/plugin/loops/core')
    expectProblem(read.problems, 'nodes.worker', 'there is no nodes/worker.md')
    expectProblem(read.problems, 'nodes.stray', 'is not referred to by loop.json')
    expect(read.d2Edited).toBe(false)
    await fs.write('/plugin/loops/core/loop.json', '{ not json')
    expectProblem((await readLoop(fs, '/plugin/loops/core')).problems, 'loop.json', 'loop.json is not JSON')
    expectProblem((await readLoop(fs, '/nowhere')).problems, 'loop.json', 'loop.json cannot be read')
    await fs.write('/plugin/loops/core/loop.json', JSON.stringify({ name: 'core', steps: [{ stages: [{ id: 1 }] }], onCall: [], transitions: [{}], handovers: [] }))
    const shapes = (await readLoop(fs, '/plugin/loops/core')).problems
    expectProblem(shapes, 'description', 'missing or not a string')
    expectProblem(shapes, 'steps[0].stages[0]', 'a stage is')
    expectProblem(shapes, 'onCall', 'not an object')
    expectProblem(shapes, 'transitions[0]', 'a transition is')
  })

  test('without a content check, d2Edited compares loop.d2 with loop.json when the file system can stat', async () => {
    const files = Object.fromEntries(Object.entries(SHIPPED_LOOP_FILES).map(([k, v]) => [`/l/${k}`, v]))
    files['/l/core/loop.d2'] = 'direction: down\n'
    const newer = await readLoop(memFs(files, { '/l/core/loop.json': 1, '/l/core/loop.d2': 2 }).fs, '/l/core')
    expect(newer.d2Edited).toBe(true)
    expect(newer.d2Newer).toBe(true)
    expect((await readLoop(memFs(files, { '/l/core/loop.json': 3, '/l/core/loop.d2': 2 }).fs, '/l/core')).d2Edited).toBe(false)
    expect((await readLoop(memFs(files).fs, '/l/core')).d2Edited).toBe(false)
  })

  test('with d2Differs, d2Edited is a content rule: false right after a save, true after a real hand edit', async () => {
    const { fs } = memFs({}, {})
    const dir = '/home/u/loops/mine'
    const core = await shipped('core')
    await writeLoop(fs, dir, core, { 'loop.d2': toD2(core, ['notes: { a: kept }']) })
    const saved = await readLoop(fs, dir, d2Differs)
    expect(saved.problems).toEqual([])
    expect(saved.d2Edited).toBe(false)
    expect(saved.d2Newer).toBe(false)
    const d2 = await fs.read(`${dir}/loop.d2`)
    const edit = async (text: string) => {
      await fs.write(`${dir}/loop.d2`, text)
      return (await readLoop(fs, dir, d2Differs)).d2Edited
    }
    expect(await edit(`${d2}\n# a comment and some space\n\n`)).toBe(false)
    expect(await edit(d2.replace('tooltip: integrate the run', 'tooltip: merge it all'))).toBe(true)
    expect(await edit(d2.replace('step6: {\n', 'step6: {\n  grid-columns: 2\n  extra: { class: stage; summary: one more }\n'))).toBe(true)
    expect(await edit('step1: { this is not D2')).toBe(true)
    await fs.remove(`${dir}/loop.d2`)
    expect((await readLoop(fs, dir, d2Differs)).d2Edited).toBe(false)
  })

  test('writing puts loop.json last, so no file of a save is newer than it', async () => {
    const order: string[] = []
    const { fs } = memFs()
    const write = fs.write
    fs.write = async (path, text) => (order.push(path.slice('/l/core/'.length)), write(path, text))
    await writeLoop(fs, '/l/core', await shipped('core-fast'), { 'loop.d2': 'direction: down\n' })
    expect(order.at(-1)).toBe('loop.json')
    expect(order.slice(0, -1).sort()).toEqual(['LOOP.md', 'loop.d2', 'nodes/done.md', 'nodes/orchestrator.md', 'nodes/worker.md'])
  })

  test('writing removes node files no longer in the loop and writes extra files', async () => {
    const { fs, files } = shippedFs()
    const fast = await shipped('core-fast')
    await writeLoop(fs, '/plugin/loops/core', fast, { 'loop.d2': 'direction: down\n' })
    expect(await fs.list('/plugin/loops/core/nodes')).toEqual(['done.md', 'orchestrator.md', 'worker.md'])
    expect(files.get('/plugin/loops/core/loop.d2')).toBe('direction: down\n')
    expect(files.get('/plugin/loops/core/LOOP.md')).toBe(toSpec(fast))
  })
})

describe('drafts', () => {
  const DR = '/dh/drafts'
  const ref = { level: 'plugin' as const, name: 'core', repoRoot: null }

  test('opening copies the loop with its base hash; opening again reads the draft', async () => {
    const { fs, files } = memFs()
    const core = await shipped('core')
    const { loop, info } = await openDraft(fs, DR, ref, core)
    expect(loop).toEqual(core)
    expect(info).toMatchObject({ dir: '/dh/drafts/plugin--core', base: hashLoop(core), changes: [] })
    expect(typeof info.since).toBe('number')
    expect(files.get('/dh/drafts/plugin--core/loop.json')).toBe(SHIPPED_LOOP_FILES['core/loop.json'])
    expect(JSON.parse(files.get('/dh/drafts/plugin--core/draft.json')!)).toEqual({ base: info.base, since: info.since, changes: [] })
    const again = await openDraft(fs, DR, ref, await shipped('core-fast'))
    expect(again.loop).toEqual(core)
    expect(again.info).toEqual(info)
  })

  test('writing a draft saves the loop and appends the change; discarding removes it', async () => {
    const { fs, files } = memFs()
    const { loop, info } = await openDraft(fs, DR, ref, await shipped('core'))
    const next = clone(loop)
    next.steps[0]!.stages[0]!.summary = 'until all is clear'
    const after = await writeDraft(fs, info, next, 'renamed the summary of clarify', toD2(next))
    expect(after.changes).toEqual(['renamed the summary of clarify'])
    const read = await readDraft(fs, DR, 'plugin--core')
    expect(read!.loop).toEqual(next)
    expect(read!.info).toEqual(after)
    // a draft is a whole loop folder: its diagram beside the other files
    expect(files.get('/dh/drafts/plugin--core/loop.d2')).toBe(toD2(next))
    // one change line per op: a batch of two adds two
    await writeDraft(fs, after, next, ['a second change', 'a third change'], toD2(next))
    expect((await readDraft(fs, DR, 'plugin--core'))!.info.changes).toEqual(['renamed the summary of clarify', 'a second change', 'a third change'])
    await discardDraft(fs, after)
    expect([...files.keys()].some(k => k.startsWith('/dh/drafts/plugin--core'))).toBe(false)
    expect(await readDraft(fs, DR, 'plugin--core')).toBeNull()
  })

  test('a new loop starts blank: an entry orchestrator, an exit done, nothing else', async () => {
    const { fs } = memFs()
    const { loop, info } = await openDraft(fs, DR, { level: 'user', name: 'mine', repoRoot: null }, null)
    expect(info.base).toBeNull()
    expect(info.dir).toBe('/dh/drafts/user--mine')
    expect(loop).toMatchObject({ name: 'mine', description: 'A new loop.', entry: 'orchestrator', exit: 'done', steps: [], onCall: {}, transitions: [], handovers: [] })
    expect(loop.nodes.orchestrator).toMatchObject({ type: 'entry', summary: 'talks to you', contract: 'none', models: [] })
    expect(loop.nodes.done).toMatchObject({ type: 'exit', summary: 'the run ends', contract: 'none' })
    expect(Object.keys(loop.nodes)).toEqual(['orchestrator', 'done'])
    expect(validateLoop(loop)).toEqual([])
    const read = await readLoop(fs, info.dir)
    expect(read.problems).toEqual([])
    expect(read.loop).toEqual(loop)
  })
})

describe('the shipped loops', () => {
  const NAMES = ['core', 'core-fast', 'core-deep']

  test('each folder reads and validates with no problems, and writes back to identical text', async () => {
    for (const name of NAMES) {
      const { fs } = shippedFs()
      const read = await readLoop(fs, `/plugin/loops/${name}`)
      expect(read.problems, name).toEqual([])
      expect(validateLoop(read.loop), name).toEqual([])
      const out = memFs()
      await writeLoop(out.fs, `/out/${name}`, read.loop, { 'loop.d2': toD2(read.loop) })
      const shippedFiles = Object.keys(SHIPPED_LOOP_FILES).filter(k => k.startsWith(`${name}/`)).sort()
      expect([...out.files.keys()].map(k => k.slice('/out/'.length)).sort()).toEqual(shippedFiles)
      for (const k of shippedFiles) expect(out.files.get(`/out/${k}`), k).toBe(SHIPPED_LOOP_FILES[k])
    }
  })

  test('core-fast drops QA; core-deep reviews after QA', async () => {
    const stages = (l: Loop) => l.steps.map(s => s.stages.map(st => st.id).join('+'))
    const [core, fast, deep] = await Promise.all(NAMES.map(shipped))
    expect(stages(core!)).toEqual(['clarify', 'research', 'plan', 'implement', 'qa', 'merge'])
    expect(stages(fast!)).toEqual(['clarify', 'research', 'plan', 'implement', 'merge'])
    expect(stages(deep!)).toEqual(['clarify', 'research', 'plan', 'implement', 'qa', 'review', 'merge'])
    expect(Object.keys(fast!.nodes).sort()).toEqual(['done', 'orchestrator', 'worker'])
    expect(Object.keys(deep!.nodes).sort()).toEqual(['done', 'orchestrator', 'qa', 'qa-collector', 'reviewer', 'worker'])
    expect(fast!.transitions.find(t => t.from === 'implement')).toMatchObject({ to: ['merge'], label: 'all landed' })
    expect(deep!.transitions.filter(t => t.from === 'review').map(t => `${t.to[0]}:${t.label}`)).toEqual(['merge:all pass', 'implement:fix'])
    expect(deep!.nodes.reviewer).toMatchObject({ contract: 'scores', categories: ['quality', 'consistency', 'cleanup'] })
    expect(core!.nodes.orchestrator!.skills).toEqual(['dacapo:loop'])
    expect(core!.nodes.worker).toMatchObject({ contract: 'lands', skills: ['dacapo:rules-commits', 'dacapo:rules-prs'], tools: { deny: ['Agent', 'EnterWorktree', 'ExitWorktree'] } })
    expect(fast!.nodes.orchestrator!.role).toContain('workers build and land it, and you decide what comes next.')
    for (const n of Object.values(fast!.nodes)) expect(n.role, n.id).not.toMatch(/judge|score|\bQA\b|review/i)
    for (const l of [core!, fast!, deep!]) {
      const worker = l.nodes.worker!.role
      expect(worker).not.toContain('gh pr merge')
      expect(worker).not.toContain('dacapo: done')
    }
  })
})

describe('the interviews contract', () => {
  /** The fixture loop talk placed under `/fixtures/loops`. */
  function fixtureFs() {
    return memFs(Object.fromEntries(Object.entries(FIXTURE_LOOP_FILES).map(([k, v]) => [`/fixtures/loops/${k}`, v])))
  }
  const talk = async () => (await readLoop(fixtureFs().fs, '/fixtures/loops/talk')).loop
  const broken = (base: Loop, change: (l: Loop) => void) => {
    const l = clone(base)
    change(l)
    return validateLoop(l)
  }

  test('the fixture loop talk reads and validates, and writes back to identical text', async () => {
    const read = await readLoop(fixtureFs().fs, '/fixtures/loops/talk')
    expect(read.problems).toEqual([])
    expect(validateLoop(read.loop)).toEqual([])
    expect(read.loop.nodes.functionality).toMatchObject({ contract: 'interviews', models: ['sonnet'], summary: 'interviews the user' })
    expect(read.loop.nodes.design).toMatchObject({ contract: 'interviews', models: ['sonnet'] })
    expect(read.loop.steps[0]!.stages[0]).toMatchObject({ id: 'clarify', nodes: ['functionality'] })
    expect(read.loop.onCall).toEqual({ design: [] })
    const out = memFs()
    await writeLoop(out.fs, '/out/talk', read.loop, { 'loop.d2': toD2(read.loop) })
    const keys = Object.keys(FIXTURE_LOOP_FILES).filter(k => k.startsWith('talk/')).sort()
    expect([...out.files.keys()].map(k => k.slice('/out/'.length)).sort()).toEqual(keys)
    for (const k of keys) expect(out.files.get(`/out/${k}`), k).toBe(FIXTURE_LOOP_FILES[k])
  })

  test('an interviews node needs a model and takes no categories and no collectors', async () => {
    const l = await talk()
    expectProblem(broken(l, x => (x.nodes.functionality!.models = [])), 'nodes.functionality.models', 'an interviews node needs at least one model')
    expectProblem(broken(l, x => (x.nodes.design!.categories = ['ux'])), 'nodes.design.categories', 'categories are for scores nodes only')
    expectProblem(broken(l, x => (x.nodes.design!.collectors = 1)), 'nodes.design.collectors', 'collectors are for scores nodes only')
    expectProblem(broken(l, x => (x.nodes.orchestrator!.contract = 'interviews')), 'nodes.orchestrator.contract', 'entry and exit have contract none')
  })

  test('several interviews nodes share a stage', async () => {
    const l = await talk()
    expect(
      broken(l, x => {
        x.onCall = {}
        x.steps[0]!.stages[0]!.nodes.push('design')
      }),
    ).toEqual([])
  })

  test('a node file with contract interviews reads back as written', () => {
    const { node: n, problems } = nodeFromFile('ux', '---\ntype: agent\nsummary: interviews the user\ncontract: interviews\nmodels: [sonnet]\nskills: []\ntools: { deny: [] }\n---\n\nYou ask.\n')
    expect(problems).toEqual([])
    expect(n.contract).toBe('interviews')
    expect(nodeFromFile('ux', nodeToFile(n)).node).toEqual(n)
    expect(nodeFromFile('ux', '---\ntype: agent\nsummary: x\ncontract: chats\n---\n').problems[0]!.message).toBe('"contract" must be one of lands, scores, collects, none, interviews, not chats')
  })

  test('LOOP.md says what an interviewing node does, in a stage and on call, and lists no categories', async () => {
    const spec = toSpec(await talk())
    expect(spec).toContain(
      'Interviews the user. One agent. It works in the clarify stage. Contract: interviews (talks to the user and writes a report). It talks to the user itself, writes a report in the format its role defines and hands the floor back.',
    )
    expect(spec).toContain(
      'Interviews the user. One agent. On call: usable at any point of the run. Contract: interviews (talks to the user and writes a report). It talks to the user itself, writes a report in the format its role defines and hands the floor back.',
    )
    const section = spec.slice(spec.indexOf('### functionality'), spec.indexOf('### worker'))
    expect(section).toContain('- Models: sonnet')
    expect(section).not.toContain('Categories')
    expect(section).toContain('# Functionality spec')
    expect(spec).toBe(FIXTURE_LOOP_FILES['talk/LOOP.md'])
  })
})
