import { describe, expect, test } from 'claude-code/testing'

import type { Loop } from '../types/loops'
import { applyOps, describeOp, loopDelete, loopMove, loopNew, loopRename, parseOp, saveDraft, setDefaultLoop, type Op } from '../hooks/architect'
import { blankLoop, draftKey, hashLoop, openDraft, readLoop, validateLoop, withDefaultTransitions, writeLoop, type LoopFs, type Roots } from '../hooks/loops'
import { toD2 } from '../hooks/loopd2'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'

/** An in-memory file system: files by absolute path, folders implied by them (as in tests/loops.test.ts). */
function memFs(initial: Record<string, string> = {}) {
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
  return { fs, files }
}

/** The shipped loops placed under `/plugin/loops`. */
function shippedFs() {
  return memFs(Object.fromEntries(Object.entries(SHIPPED_LOOP_FILES).map(([k, v]) => [`/plugin/loops/${k}`, v])))
}

async function core(): Promise<Loop> {
  const { fs } = shippedFs()
  return (await readLoop(fs, '/plugin/loops/core')).loop
}

async function coreDeep(): Promise<Loop> {
  const { fs } = shippedFs()
  return (await readLoop(fs, '/plugin/loops/core-deep')).loop
}

const ROOTS: Roots = { plugin: '/plugin/loops', user: '/home/dacapo/loops', project: '/repo/.claude/dacapo/loops' }
const DRAFTS = '/home/dacapo/drafts'
const REPO = '/repo'

/** Applies ops that must succeed; returns the result. */
function ok(loop: Loop, ops: Op[], ctx: { d2?: string; opaque?: string[] } = {}) {
  const out = applyOps(loop, ops, ctx)
  if (!out.ok) throw new Error('unchanged' in out ? 'unchanged' : `refused at ${out.index} (${out.op}): ${out.problems.join(' | ')}`)
  return out
}

/** Applies ops that must be refused; returns the refusal. */
function refused(loop: Loop, ops: Op[], ctx: { d2?: string; opaque?: string[] } = {}) {
  const out = applyOps(loop, ops, ctx)
  if (out.ok) throw new Error(`not refused: ${out.changes.join(' | ')}`)
  if ('unchanged' in out) throw new Error('not refused: unchanged')
  expect(Object.keys(out).sort()).toEqual(['index', 'ok', 'op', 'problems'])
  return out
}

const stageIds = (loop: Loop) => loop.steps.map(s => s.stages.map(st => st.id))
const transition = (loop: Loop, from: string, to: string[]) => loop.transitions.find(t => t.from === from && t.to.join() === to.join())
/** The forward transitions with the defaults spelled out, as `from > a+b`. */
const forward = (loop: Loop) =>
  withDefaultTransitions(loop)
    .transitions.filter(t => !t.back)
    .map(t => `${t.from} > ${t.to.join('+')}`)

describe('each op on core', () => {
  test('stage.add alongside qa joins the qa step and the transition into it', async () => {
    const c = await core()
    const out = ok(c, [{ op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' }])
    // the new stage leads on by default to where qa leads, and takes the label of qa's transition there
    expect(out.changes).toEqual(['added stage security alongside qa; security → merge: all pass, the label of qa → merge'])
    expect(stageIds(out.loop)[4]).toEqual(['qa', 'security'])
    expect(out.loop.steps[4]!.stages[1]).toEqual({ id: 'security', summary: 'checks for holes', nodes: [] })
    expect(transition(out.loop, 'implement', ['qa', 'security'])?.label).toBe('all landed')
    expect(out.loop.transitions.length).toBe(c.transitions.length + 1)
    expect(transition(out.loop, 'security', ['merge'])?.label).toBe('all pass')
  })

  test('stage.add after a step makes a step of its own; the architect rewires', async () => {
    const out = ok(await core(), [
      { op: 'stage.add', id: 'docs', summary: 'write the docs', after: 3 },
      { op: 'transition.remove', from: 'implement', to: ['qa'] },
      { op: 'transition.set', from: 'implement', to: ['docs'], label: 'all landed' },
    ])
    expect(out.changes).toEqual(['added stage docs after step 4', 'removed transition implement to qa', 'set transition implement to docs: all landed'])
    expect(stageIds(out.loop)).toEqual([['clarify'], ['research'], ['plan'], ['implement'], ['docs'], ['qa'], ['merge']])
    expect(out.loop.transitions.some(t => t.from === 'docs')).toBe(false)
  })

  test('stage.add with neither after nor alongside is a new last step', async () => {
    const out = ok(await core(), [
      { op: 'stage.add', id: 'announce', summary: 'tell the team' },
      { op: 'transition.set', from: 'merge', to: ['announce'], label: 'integrated' },
      { op: 'transition.remove', from: 'merge', to: ['exit'] },
    ])
    expect(out.changes[0]).toBe('added stage announce as the last step')
    expect(stageIds(out.loop).at(-1)).toEqual(['announce'])
  })

  test('stage.remove of qa puts qa on call with qa-collector as its helper', async () => {
    const c = await core()
    const out = ok(c, [{ op: 'stage.remove', id: 'qa' }])
    expect(out.changes).toEqual(['removed stage qa and put its nodes on call'])
    expect(out.loop.onCall).toEqual({ qa: ['qa-collector'] })
    expect(stageIds(out.loop)).toEqual([['clarify'], ['research'], ['plan'], ['implement'], ['merge']])
    expect(out.loop.transitions.filter(t => t.from === 'qa' || t.to.includes('qa'))).toEqual([])
    expect(out.loop.nodes.qa).toEqual(c.nodes.qa)
    expect(out.loop.handovers.length).toBe(c.handovers.length)
    expect(ok(c, [{ op: 'stage.remove', id: 'research' }]).changes[0]).toBe('removed stage research')
  })

  test('stage.remove of one stage of a shared step keeps the others in the transition', async () => {
    const out = ok(await core(), [
      { op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' },
      { op: 'stage.remove', id: 'security' },
      { op: 'loop.describe', description: 'Mine.' },
    ])
    expect(transition(out.loop, 'implement', ['qa'])?.label).toBe('all landed')
  })

  test('stage.move alongside another stage rewires the transitions and says how', async () => {
    const out = ok(await core(), [{ op: 'stage.move', id: 'research', alongside: 'clarify' }])
    expect(out.changes).toEqual([
      'moved stage research alongside clarify; dropped the transition clarify → research; orchestrator now leads to clarify ∥ research; clarify → plan: findings noted, the label of research → plan',
    ])
    expect(stageIds(out.loop).slice(0, 2)).toEqual([['clarify', 'research'], ['plan']])
    expect(transition(out.loop, 'entry', ['clarify', 'research'])?.label).toBe('handed over')
    expect(forward(out.loop).slice(0, 3)).toEqual(['entry > clarify+research', 'research > plan', 'plan > implement'])
    expect(forward(out.loop)).toContain('clarify > plan')
  })

  test('stage.move review alongside qa on core-deep validates as it is', async () => {
    const out = ok(await coreDeep(), [{ op: 'stage.move', id: 'review', alongside: 'qa' }])
    expect(out.changes).toEqual(['moved stage review alongside qa; dropped the transition qa → review; implement now leads to qa ∥ review; qa → merge: all pass, the label of review → merge'])
    expect(stageIds(out.loop).slice(3)).toEqual([['implement'], ['qa', 'review'], ['merge']])
    expect(validateLoop({ ...withDefaultTransitions(out.loop), nodes: out.loop.nodes })).toEqual([])
    expect(transition(out.loop, 'implement', ['qa', 'review'])?.label).toBe('all landed')
    expect(forward(out.loop)).toContain('qa > merge')
    expect(forward(out.loop)).toContain('review > merge')
    // the step reads alike: both judges lead to merge on all pass
    expect(transition(out.loop, 'qa', ['merge'])?.label).toBe('all pass')
    expect(transition(out.loop, 'qa', ['merge'])?.when).toBeUndefined()
    expect(out.loop.transitions.filter(t => t.back).map(t => `${t.from} > ${t.to.join('+')}`)).toEqual(['qa > implement', 'review > implement', 'merge > implement'])
  })

  test('stage.move alongside an earlier stage re-points what led into its emptied step and drops what turned back', async () => {
    const out = ok(await coreDeep(), [{ op: 'stage.move', id: 'review', alongside: 'implement' }])
    expect(out.changes).toEqual(['moved stage review alongside implement; dropped the transition review ⇢ implement; plan now leads to implement ∥ review; qa now leads to merge'])
    expect(stageIds(out.loop).slice(3)).toEqual([['implement', 'review'], ['qa'], ['merge']])
    expect(transition(out.loop, 'qa', ['merge'])?.label).toBe('all pass')
    expect(transition(out.loop, 'review', ['merge'])?.label).toBe('all pass')
  })

  test('stage.move alongside the stage of the next step leads into the shared step', async () => {
    const out = ok(await core(), [{ op: 'stage.move', id: 'research', alongside: 'plan' }])
    expect(out.changes).toEqual(['moved stage research alongside plan; dropped the transition research → plan; clarify now leads to plan ∥ research; research → implement: plan shown, the label of plan → implement'])
    expect(transition(out.loop, 'clarify', ['plan', 'research'])?.label).toBe('nothing open')
    expect(forward(out.loop)).toContain('research > implement')
  })

  test('stage.move after a step counts the steps before the move', async () => {
    const out = ok(await core(), [
      { op: 'stage.move', id: 'clarify', after: 1 },
      { op: 'transition.remove', from: 'entry', to: ['clarify'] },
      { op: 'transition.set', from: 'entry', to: ['research'], label: 'handed over' },
      { op: 'transition.remove', from: 'clarify', to: ['research'] },
      { op: 'transition.set', from: 'clarify', to: ['plan'], label: 'nothing open' },
      { op: 'transition.remove', from: 'research', to: ['plan'] },
      { op: 'transition.set', from: 'research', to: ['clarify'], label: 'findings noted' },
    ])
    expect(out.changes[0]).toBe('moved stage clarify after step 2')
    expect(stageIds(out.loop).slice(0, 3)).toEqual([['research'], ['clarify'], ['plan']])
    expect(transition(out.loop, 'clarify', ['plan'])?.when).toBeUndefined()
  })

  test('stage.split takes a stage out of a shared step into the next, and the stages left lead to it', async () => {
    const out = ok(await core(), [
      { op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' },
      { op: 'stage.split', id: 'security' },
    ])
    expect(out.changes[1]).toBe('split stage security into its own step; implement now leads to qa; qa now leads to security')
    expect(stageIds(out.loop).slice(4)).toEqual([['qa'], ['security'], ['merge']])
    expect(transition(out.loop, 'implement', ['qa'])?.label).toBe('all landed')
    expect(transition(out.loop, 'qa', ['security'])?.label).toBe('all pass')
    expect(forward(out.loop)).toContain('security > merge')
  })

  test('stage.split undoes a move alongside on core-deep', async () => {
    const out = ok(await coreDeep(), [
      { op: 'stage.move', id: 'review', alongside: 'qa' },
      { op: 'stage.split', id: 'review' },
    ])
    expect(out.changes[1]).toBe('split stage review into its own step; implement now leads to qa; qa now leads to review')
    expect(transition(out.loop, 'qa', ['review'])?.label).toBe('all pass')
    expect(stageIds(out.loop).slice(3)).toEqual([['implement'], ['qa'], ['review'], ['merge']])
    expect(forward(out.loop)).toEqual(expect.arrayContaining(['implement > qa', 'qa > review', 'review > merge']))
  })

  test('stage.rename follows into every transition', async () => {
    const out = ok(await core(), [{ op: 'stage.rename', id: 'qa', to: 'judge' }])
    expect(out.changes).toEqual(['renamed stage qa to judge'])
    expect(stageIds(out.loop)[4]).toEqual(['judge'])
    expect(out.loop.steps[4]!.stages[0]!.nodes).toEqual(['qa', 'qa-collector'])
    expect(out.loop.transitions.filter(t => t.from === 'judge').map(t => t.to)).toEqual([['merge'], ['implement']])
    expect(transition(out.loop, 'implement', ['judge'])).toBeDefined()
    expect(out.loop.transitions.some(t => t.from === 'qa' || t.to.includes('qa'))).toBe(false)
  })

  test('stage.summary', async () => {
    const out = ok(await core(), [{ op: 'stage.summary', id: 'implement', summary: 'build every task' }])
    expect(out.changes).toEqual(['set the summary of stage implement to "build every task"'])
    expect(out.loop.steps[3]!.stages[0]!.summary).toBe('build every task')
  })

  test('node.add on call, as a helper and into a stage, with defaults and a stub role', async () => {
    const out = ok(await core(), [
      { op: 'node.add', id: 'scout', type: 'agent', contract: 'none', summary: 'answers any question', onCall: true, models: ['sonnet'] },
      { op: 'node.add', id: 'reader', type: 'agent', contract: 'none', summary: 'reads the docs', helperOf: 'scout' },
      { op: 'node.add', id: 'docs-writer', type: 'swarm', contract: 'none', summary: 'writes the docs', stage: 'implement' },
    ])
    expect(out.changes).toEqual(['added agent scout (none) on call', 'added agent reader (none) as a helper of scout', 'added swarm docs-writer (none) in stage implement'])
    expect(out.loop.onCall).toEqual({ scout: ['reader'] })
    expect(out.loop.steps[3]!.stages[0]!.nodes).toEqual(['worker', 'docs-writer'])
    expect(out.loop.nodes.scout).toEqual({ id: 'scout', type: 'agent', summary: 'answers any question', contract: 'none', models: ['sonnet'], skills: [], tools: { deny: [] }, role: 'Role to be written.' })
  })

  test('node.remove drops its handovers and its place', async () => {
    const out = ok(await core(), [{ op: 'node.remove', id: 'qa-collector' }])
    expect(out.changes).toEqual(['removed node qa-collector'])
    expect(out.loop.nodes['qa-collector']).toBeUndefined()
    expect(out.loop.steps[4]!.stages[0]!.nodes).toEqual(['qa'])
    expect(out.loop.handovers.some(h => h.from === 'qa-collector' || h.to === 'qa-collector')).toBe(false)
    expect(out.loop.handovers.length).toBe(4)
  })

  test('node.remove of an on-call node leaves its helpers on call', async () => {
    const out = ok(await core(), [
      { op: 'node.add', id: 'scout', type: 'agent', contract: 'none', summary: 'answers any question', onCall: true },
      { op: 'node.add', id: 'reader', type: 'agent', contract: 'none', summary: 'reads the docs', helperOf: 'scout' },
      { op: 'node.remove', id: 'scout' },
    ])
    expect(out.loop.onCall).toEqual({ reader: [] })
  })

  test('node.move on call keeps its handovers', async () => {
    const c = await core()
    const out = ok(c, [{ op: 'node.move', id: 'worker', onCall: true }])
    expect(out.changes).toEqual(['moved worker on call'])
    expect(out.loop.onCall).toEqual({ worker: [] })
    expect(out.loop.steps[3]!.stages[0]!.nodes).toEqual([])
    expect(out.loop.handovers).toEqual(c.handovers)
  })

  test('node.move into a stage and as a helper', async () => {
    const out = ok(await core(), [
      { op: 'node.move', id: 'qa', onCall: true },
      { op: 'node.move', id: 'qa-collector', helperOf: 'qa' },
      { op: 'node.move', id: 'qa', stage: 'merge' },
    ])
    expect(out.changes).toEqual(['moved qa on call', 'moved qa-collector as a helper of qa', 'moved qa into stage merge'])
    expect(out.loop.onCall).toEqual({ 'qa-collector': [] })
    expect(out.loop.steps[5]!.stages[0]!.nodes).toEqual(['qa'])
  })

  test('node.set replaces each given field whole', async () => {
    const c = await core()
    const out = ok(c, [{ op: 'node.set', id: 'worker', models: ['opus', 'sonnet', 'fable'] }])
    expect(out.changes).toEqual(['set worker models to opus, sonnet, fable'])
    expect(out.loop.nodes.worker).toEqual({ ...c.nodes.worker!, models: ['opus', 'sonnet', 'fable'] })
  })

  test('node.set to a contract other than scores drops categories and collectors', async () => {
    const out = ok(await core(), [
      { op: 'node.set', id: 'qa', contract: 'none' },
      { op: 'node.set', id: 'qa-collector', contract: 'none', tools: { deny: [] }, summary: 'looks around' },
    ])
    expect(out.changes).toEqual(['set qa contract to none', 'set qa-collector contract to none; summary to "looks around"; denied tools to none'])
    expect(out.loop.nodes.qa!.categories).toBeUndefined()
    expect(out.loop.nodes.qa!.collectors).toBeUndefined()
  })

  test('node.role replaces the body', async () => {
    const out = ok(await core(), [{ op: 'node.role', id: 'worker', text: 'You build one task.\n\nGround rules:\n- Run the linter before every commit.' }])
    expect(out.changes).toEqual(['rewrote the role of worker'])
    expect(out.loop.nodes.worker!.role).toBe('You build one task.\n\nGround rules:\n- Run the linter before every commit.')
  })

  test('node.rename follows into stages, handovers and the entry', async () => {
    const out = ok(await core(), [
      { op: 'node.rename', id: 'worker', to: 'builder' },
      { op: 'node.rename', id: 'orchestrator', to: 'conductor' },
    ])
    expect(out.changes).toEqual(['renamed node worker to builder', 'renamed node orchestrator to conductor'])
    expect(out.notes).toEqual([
      'the role of builder still says "worker"; rewrite it',
      'the roles of conductor and builder still say "orchestrator"; rewrite them',
    ])
    expect(out.loop.nodes.worker).toBeUndefined()
    expect(out.loop.nodes.builder!.id).toBe('builder')
    expect(Object.keys(out.loop.nodes)).toEqual(['done', 'conductor', 'qa-collector', 'qa', 'builder'])
    expect(out.loop.steps[3]!.stages[0]!.nodes).toEqual(['builder'])
    expect(out.loop.entry).toBe('conductor')
    expect(out.loop.handovers.slice(0, 2).map(h => [h.from, h.to])).toEqual([
      ['conductor', 'builder'],
      ['builder', 'conductor'],
    ])
  })

  test('transition.set replaces by from and set of to, else adds', async () => {
    const c = await core()
    const out = ok(c, [
      { op: 'transition.set', from: 'qa', to: ['merge'], label: 'every judge passes' },
      { op: 'transition.set', from: 'qa', to: ['plan'], back: true, label: 'replan', when: 'the plan was wrong' },
    ])
    expect(out.changes).toEqual(['set transition qa to merge: every judge passes', 'set back transition qa to plan: replan'])
    expect(out.loop.transitions.length).toBe(c.transitions.length + 1)
    expect(transition(out.loop, 'qa', ['merge'])).toEqual({ from: 'qa', to: ['merge'], back: undefined, label: 'every judge passes', when: undefined, then: undefined })
    expect(transition(out.loop, 'qa', ['plan'])?.back).toBe(true)
  })

  test('transition.remove', async () => {
    const c = await core()
    const out = ok(c, [{ op: 'transition.remove', from: 'merge', to: ['implement'] }])
    expect(out.changes).toEqual(['removed transition merge to implement'])
    expect(out.loop.transitions.length).toBe(c.transitions.length - 1)
    expect(transition(out.loop, 'merge', ['implement'])).toBeUndefined()
  })

  test('handover.set replaces or adds by pair; handover.remove', async () => {
    const c = await core()
    const out = ok(c, [
      { op: 'handover.set', from: 'orchestrator', to: 'worker', label: 'brief', spec: 'the task and its commands' },
      { op: 'handover.remove', from: 'worker', to: 'orchestrator' },
    ])
    expect(out.changes).toEqual(['set handover orchestrator to worker: brief', 'removed handover worker to orchestrator'])
    expect(out.loop.handovers[0]).toEqual({ from: 'orchestrator', to: 'worker', label: 'brief', spec: 'the task and its commands' })
    expect(out.loop.handovers.length).toBe(c.handovers.length - 1)
  })

  test('loop.describe and loop.rename change the loop only', async () => {
    const out = ok(await core(), [
      { op: 'loop.describe', description: 'Core, for docs only.' },
      { op: 'loop.rename', to: 'docs-only' },
    ])
    expect(out.changes).toEqual(['changed the description to "Core, for docs only."', 'renamed the loop to docs-only'])
    expect([out.loop.name, out.loop.description]).toEqual(['docs-only', 'Core, for docs only.'])
  })

  test('import-d2 folds a diagram adding a stage into the draft and returns its opaque blocks', async () => {
    const c = await core()
    const security = '  security: Security {\n    class: stage\n    summary: checks the threats\n    security: Security { class: agent; summary: reviews security }\n  }\n'
    const d2 = toD2(c).replace('step5: {\n', 'step5: {\n  grid-columns: 2\n').replace('  }\n}\n\nstep6: {', `  }\n${security}}\n\nstep6: {`) + '\nlegend: { note: kept }\n'
    const out = ok(c, [{ op: 'import-d2' }], { d2, opaque: ['old: {}'] })
    expect(out.changes).toEqual(['imported the hand-edited loop.d2'])
    expect(stageIds(out.loop)[4]).toEqual(['qa', 'security'])
    expect(out.loop.nodes.security!.role).toBe('Role to be written.')
    expect(out.opaque).toEqual(['legend: { note: kept }'])
  })

  test('opaque blocks pass through a batch without import-d2; the input loop is never changed', async () => {
    const c = await core()
    const before = JSON.stringify(c)
    const out = ok(c, [
      { op: 'stage.remove', id: 'qa' },
      { op: 'node.rename', id: 'worker', to: 'builder' },
      { op: 'node.set', id: 'builder', models: ['opus'] },
    ], { opaque: ['legend: {}'] })
    expect(out.opaque).toEqual(['legend: {}'])
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe('the entry and the exit', () => {
  test('a transition end may name the entry or exit node by its id; the change line names it so, the loop stores the word', async () => {
    const out = ok(await core(), [{ op: 'transition.set', from: 'merge', to: ['done'], label: 'landed' }])
    expect(out.changes).toEqual(['set transition merge to done: landed'])
    expect(transition(out.loop, 'merge', ['exit'])?.label).toBe('landed')
    const removed = ok(await core(), [{ op: 'transition.remove', from: 'orchestrator', to: ['clarify'] }])
    expect(removed.changes).toEqual(['removed transition orchestrator to clarify'])
    expect(removed.loop.transitions.some(t => t.from === 'entry')).toBe(false)
  })
})

describe('batches', () => {
  const judge: Op = { op: 'node.add', id: 'judge', type: 'agent', contract: 'scores', summary: 'judges the merge', stage: 'merge', models: ['opus'] }

  test('a batch valid only at its end succeeds', async () => {
    const out = ok(await core(), [judge, { op: 'node.set', id: 'judge', categories: ['core'] }])
    expect(out.changes).toEqual(['added agent judge (scores) in stage merge', 'set judge categories to core'])
    expect(out.loop.nodes.judge!.categories).toEqual(['core'])
    expect(validateLoop(out.loop)).toEqual([])
  })

  test('a batch invalid at its end is refused with the problems, named by the op that brought them in', async () => {
    const out = refused(await core(), [{ op: 'loop.describe', description: 'Mine.' }, judge])
    expect([out.index, out.op]).toEqual([1, 'node.add'])
    expect(out.problems).toEqual(['node judge scores but has no categories; give it the rubric categories it accepts'])
  })

  test('problems brought in by two ops name both as culprits; one there before the first names none', async () => {
    const two = applyOps(await core(), [{ op: 'stage.add', id: 'docs', summary: 'write the docs', after: 3 }, judge], {})
    if (two.ok || 'unchanged' in two) throw new Error('not refused')
    expect([two.index, two.op]).toEqual([2, 'batch'])
    expect(two.culprits).toEqual([
      { index: 0, op: 'stage.add' },
      { index: 1, op: 'node.add' },
    ])
    expect(two.problems).toHaveLength(2)
    const c = await core()
    delete c.nodes.qa!.categories
    const before = applyOps(c, [{ op: 'loop.describe', description: 'Mine.' }], {})
    expect(before).toEqual({ ok: false, index: 1, op: 'batch', culprits: [], problems: ['node qa scores but has no categories; give it the rubric categories it accepts'] })
  })

  test('a batch that changes nothing is unchanged, not refused', async () => {
    const c = await core()
    const same = { ok: false, unchanged: true }
    expect(applyOps(c, [{ op: 'node.set', id: 'worker', models: [...c.nodes.worker!.models] }], {})).toEqual(same)
    const back = [
      { op: 'stage.rename', id: 'qa', to: 'judge' },
      { op: 'stage.rename', id: 'judge', to: 'qa' },
    ] satisfies Op[]
    expect(applyOps(c, back, {})).toEqual(same)
    const label = c.transitions.find(t => t.from === 'qa' && !t.back)!
    expect(applyOps(c, [{ op: 'transition.set', from: 'qa', to: ['merge'], label: label.label, ...(label.when ? { when: label.when } : {}), ...(label.then ? { then: label.then } : {}) }], {})).toEqual(same)
  })

  test('the first failing op stops the batch and is named', async () => {
    const out = refused(await core(), [judge, { op: 'stage.remove', id: 'nope' }, { op: 'stage.remove', id: 'qa' }])
    expect(out).toEqual({ ok: false, index: 1, op: 'stage.remove', problems: ['there is no stage "nope"; name one of clarify, research, plan, implement, qa or merge'] })
  })

  test('an empty batch is refused', async () => {
    expect(refused(await core(), []).problems).toEqual(['the batch holds no ops; send at least one'])
  })

  test('a forward transition without a label where the default goes is not stored', async () => {
    const out = ok(await core(), [
      { op: 'stage.add', id: 'docs', summary: 'write the docs', after: 3 },
      { op: 'transition.remove', from: 'implement', to: ['qa'] },
      { op: 'transition.set', from: 'implement', to: ['docs'], label: 'all landed' },
      { op: 'transition.set', from: 'docs', to: ['qa'], label: '' },
    ])
    expect(out.loop.transitions.some(t => t.from === 'docs')).toBe(false)
  })
})

describe('prose left stale', () => {
  test('a rename notes the roles and the description that still say the old id, as a whole word', async () => {
    const out = ok(await core(), [
      { op: 'loop.describe', description: 'Workers build; the worker lands and the qa-collector-worker helps.' },
      { op: 'node.rename', id: 'worker', to: 'builder' },
    ])
    expect(out.notes).toEqual(['the role of builder and the description still say "worker"; rewrite them'])
  })

  test('a stage removed or renamed notes the prose that names it; an id still in use is not stale', async () => {
    const c = await core()
    for (const n of Object.values(c.nodes)) n.role = 'You do one thing; merges are not yours.'
    c.nodes.qa!.role = 'You never touch the Merge stage.'
    c.nodes.orchestrator!.role = 'After merge, say what landed.'
    const removed = ok(c, [{ op: 'stage.remove', id: 'merge' }])
    expect(removed.changes).toEqual(['removed stage merge'])
    expect(removed.notes).toEqual(['the roles of orchestrator and qa and the description still say "merge"; rewrite them', 'qa → done has no label now; give it one'])
    c.description = 'The default loop.'
    expect(ok(c, [{ op: 'stage.rename', id: 'merge', to: 'land' }]).notes).toEqual(['the roles of orchestrator and qa still say "merge"; rewrite them'])
    expect(ok(c, [{ op: 'stage.rename', id: 'qa', to: 'judge' }]).notes).toEqual([])
  })

  test('a collector moved away from its judge notes the collectors the judge still allows', async () => {
    const deep = await coreDeep()
    expect(ok(deep, [{ op: 'node.move', id: 'qa-collector', onCall: true }]).notes).toEqual([
      'qa allows up to 3 collectors but no collector node hands evidence to it now; set its collectors to 0 or move qa-collector back',
    ])
    // with its collectors set to 0 in the same batch, nothing is stale
    expect(ok(deep, [{ op: 'node.move', id: 'qa-collector', onCall: true }, { op: 'node.set', id: 'qa', collectors: 0 }]).notes).toEqual([])
    // a judge on call keeps a collector that is its helper
    expect(ok(deep, [{ op: 'node.move', id: 'qa', onCall: true }, { op: 'node.move', id: 'qa-collector', helperOf: 'qa' }]).notes).toEqual([])
  })

  test('a transition left without a label where the ones around it had labels is noted', async () => {
    const c = await core()
    c.description = 'The default loop.'
    expect(ok(c, [{ op: 'stage.remove', id: 'research' }]).notes).toEqual(['clarify → plan has no label now; give it one'])
    // a label set in the same batch leaves nothing to note
    expect(ok(c, [{ op: 'stage.remove', id: 'research' }, { op: 'transition.set', from: 'clarify', to: ['plan'], label: 'nothing open' }]).notes).toEqual([])
  })

  test('a reorder notes a description that names the stage or the order', async () => {
    const c = await core()
    const stale = 'the description may be out of date; say how the loop should be described'
    expect(ok(c, [{ op: 'stage.move', id: 'research', alongside: 'clarify' }]).notes).toContain(stale)
    expect(ok(c, [{ op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' }]).notes).toEqual([stale])
    // described again in the same batch, or a description that names neither, is not noted
    expect(ok(c, [{ op: 'stage.move', id: 'research', alongside: 'clarify' }, { op: 'loop.describe', description: 'Mine.' }]).notes).not.toContain(stale)
    c.description = 'The default loop.'
    expect(ok(c, [{ op: 'stage.move', id: 'research', alongside: 'clarify' }]).notes).not.toContain(stale)
    // a node edit is no reorder
    expect(ok(await core(), [{ op: 'node.set', id: 'worker', models: ['opus'] }]).notes).toEqual([])
  })

  test('a role rewritten in the same batch is not noted', async () => {
    const out = ok(await core(), [
      { op: 'node.rename', id: 'worker', to: 'builder' },
      { op: 'node.role', id: 'builder', text: 'You are a builder. You build one task.' },
    ])
    expect(out.changes).toEqual(['renamed node worker to builder', 'rewrote the role of builder'])
  })
})

describe('refusals', () => {
  const STAGES = 'name one of clarify, research, plan, implement, qa or merge'
  const NODES = 'name one of done, orchestrator, qa-collector, qa or worker'
  const ID_RULE = 'use lowercase letters, digits and inner hyphens'
  const cases: [string, Op[], string][] = [
    ['an unknown stage', [{ op: 'stage.remove', id: 'nope' }], `there is no stage "nope"; ${STAGES}`],
    ['an unknown node', [{ op: 'node.role', id: 'nope', text: 'x' }], `there is no node "nope"; ${NODES}`],
    ['a duplicate stage', [{ op: 'stage.add', id: 'qa', summary: 'again' }], 'there is already a stage "qa"; pick another id or rename the existing one'],
    ['a duplicate node', [{ op: 'node.add', id: 'worker', type: 'agent', contract: 'none', summary: 'again', onCall: true }], 'there is already a node "worker"; pick another id or rename the existing one'],
    ['a stage where a node is needed', [{ op: 'node.remove', id: 'implement' }], `"implement" is a stage, not a node; ${NODES}`],
    ['a node where a stage is needed', [{ op: 'stage.split', id: 'worker' }], `"worker" is a node, not a stage; ${STAGES}`],
    ['a node as a transition end', [{ op: 'transition.set', from: 'worker', to: ['qa'], label: 'x' }], '"worker" is a node, not a stage; a transition joins stages, the entry and the exit, so name its stage implement'],
    ['an unknown transition end', [{ op: 'transition.set', from: 'qa', to: ['nope'], label: 'x' }], `there is no stage "nope"; a transition joins stages, the entry and the exit, so ${STAGES}`],
    ['after out of range', [{ op: 'stage.add', id: 'docs', summary: 'write the docs', after: 6 }], 'after is 6, but the steps run from 0 to 5; give a step in that range, or -1 to put the stage first'],
    ['after and alongside together', [{ op: 'stage.add', id: 'docs', summary: 'write the docs', after: 1, alongside: 'qa' }], 'give after or alongside, not both'],
    ['alongside unknown', [{ op: 'stage.add', id: 'docs', summary: 'write the docs', alongside: 'nope' }], `alongside names "nope", which is not a stage; ${STAGES}`],
    ['alongside itself', [{ op: 'stage.move', id: 'qa', alongside: 'qa' }], 'stage "qa" cannot go alongside itself; name another stage to share a step with'],
    [
      'a second lands node in a stage',
      [{ op: 'node.add', id: 'builder', type: 'swarm', contract: 'lands', summary: 'builds too', stage: 'implement', models: ['opus'] }],
      'stage implement already holds a lands node (worker); a stage holds at most one, so put builder in another stage or on call',
    ],
    ['a missing placement', [{ op: 'node.add', id: 'scout', type: 'agent', contract: 'none', summary: 'answers' }], 'node scout needs a place; give one of stage, onCall: true or helperOf'],
    ['two placements', [{ op: 'node.move', id: 'worker', stage: 'qa', onCall: true }], 'node worker goes in one place, not stage and onCall; keep one of them'],
    ['a helper of a node not on call', [{ op: 'node.move', id: 'qa-collector', helperOf: 'qa' }], '"qa" is not on call; a helper hangs off an on-call node, so move qa on call first'],
    ['removing the entry', [{ op: 'node.remove', id: 'orchestrator' }], '"orchestrator" is the entry; a loop keeps its entry and exit, so rename it or rewrite its role instead'],
    ['moving the exit', [{ op: 'node.move', id: 'done', onCall: true }], '"done" is the exit; the entry and the exit stay where they are, so add a node on call instead or rename the exit'],
    [
      'moving the entry on call',
      [{ op: 'node.move', id: 'orchestrator', onCall: true }],
      '"orchestrator" is the entry; the entry and the exit stay where they are, so add a node on call instead or rename the entry',
    ],
    ['moving the entry into a stage', [{ op: 'node.move', id: 'orchestrator', stage: 'qa' }], '"orchestrator" is the entry; the entry and the exit stay where they are, so add a node in qa instead or rename the entry'],
    ['a summary of six words', [{ op: 'stage.add', id: 'docs', summary: 'write all of the docs now', after: 3 }], 'the summary "write all of the docs now" has 6 words; write a summary of 1 to 5 words'],
    ['an empty summary', [{ op: 'node.set', id: 'worker', summary: ' ' }], 'the summary " " has 0 words; write a summary of 1 to 5 words'],
    ['a stage id that is not an id', [{ op: 'stage.add', id: 'Security', summary: 'checks' }], `"Security" is not a stage id; ${ID_RULE}, like security`],
    ['a node id that is not an id', [{ op: 'node.rename', id: 'worker', to: 'big_worker' }], `"big_worker" is not a node id; ${ID_RULE}, like big-worker`],
    ['a stage called exit', [{ op: 'stage.rename', id: 'merge', to: 'exit' }], '"exit" is the word transitions use for the exit node; pick another id for the stage'],
    ['a rename to the same id', [{ op: 'stage.rename', id: 'qa', to: 'qa' }], 'stage qa is already called qa; give a new id in to'],
    ['a split of a stage alone in its step', [{ op: 'stage.split', id: 'qa' }], 'stage qa is alone in its step; a split takes a stage out of a shared step, so move it instead'],
    ['a transition that is not there', [{ op: 'transition.remove', from: 'qa', to: ['plan'] }], 'there is no transition from qa to plan; name one of qa → merge or qa ⇢ implement'],
    ['a handover that is not there', [{ op: 'handover.remove', from: 'qa', to: 'worker' }], 'there is no handover from qa to worker; name one of qa → orchestrator or qa → qa-collector'],
    ['an empty role', [{ op: 'node.role', id: 'worker', text: '\n' }], 'the role of worker would be empty; give the whole role text'],
    ['node.set with nothing', [{ op: 'node.set', id: 'worker' }], 'nothing to change was given; give at least one of contract, summary, models, skills, tools, categories or collectors'],
    ['a loop name that is not an id', [{ op: 'loop.rename', to: 'Docs Only' }], `"Docs Only" is not a loop id; ${ID_RULE}, like docs-only`],
    ['an empty description', [{ op: 'loop.describe', description: '' }], 'the description would be empty; say in a sentence what the loop is for'],
    ['import-d2 with no diagram', [{ op: 'import-d2' }], 'there is no loop.d2 to import; save the loop once to write one, then edit it'],
  ]
  for (const [name, ops, message] of cases) {
    test(name, async () => {
      const out = refused(await core(), ops)
      expect(out.problems).toEqual([message])
      expect(out.op).toBe(ops[0]!.op)
    })
  }

  test('removing a default transition says it is only a default', async () => {
    const out = refused(await core(), [
      { op: 'stage.add', id: 'docs', summary: 'write the docs', after: 3 },
      { op: 'transition.remove', from: 'docs', to: ['qa'] },
    ])
    expect(out.problems).toEqual(['there is no transition from docs to qa; docs leads on only by default, so there is none to remove; set a transition of its own instead'])
  })

  test("the loop's problems after the last op are said with their fix", async () => {
    const problems = async (ops: Op[]) => refused(await core(), ops).problems
    expect(await problems([{ op: 'stage.add', id: 'docs', summary: 'write the docs', after: 3 }])).toEqual(['stage docs is not reachable from entry; lead a transition into it from the stage before'])
    expect(
      await problems([
        { op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' },
        { op: 'transition.set', from: 'implement', to: ['qa'], label: 'qa only' },
      ]),
    ).toEqual([
      'the transition from implement must lead to every stage of the next step: qa and security; remove the one from implement to qa, and set one from implement to qa and security',
    ])
    expect(await problems([{ op: 'transition.set', from: 'qa', to: ['plan'], label: 'replan' }])).toEqual([
      'the transition from qa to plan leads to an earlier step or its own; set it again with back: true, or point it at a later step',
    ])
    expect(await problems([{ op: 'transition.set', from: 'plan', to: ['qa'], back: true, label: 'skip' }])).toEqual([
      'the back transition from plan to qa does not lead to one earlier step; point it at a stage of an earlier step, or set it again without back',
    ])
    expect(await problems([{ op: 'node.add', id: 'judge', type: 'agent', contract: 'scores', summary: 'judges the merge', stage: 'merge', categories: ['core'] }])).toEqual([
      'node judge scores but has no model; give it at least one',
    ])
    expect(await problems([{ op: 'node.add', id: 'scout', type: 'agent', contract: 'none', summary: 'answers', onCall: true, categories: ['core'] }])).toEqual([
      'node scout does not score, so it takes no categories; leave categories out: a none node does not score, or give it the scores contract',
    ])
    expect(await problems([{ op: 'node.set', id: 'worker', models: ['GPT'] }])).toEqual(['node worker: "GPT" is not a model name like opus or claude-sonnet-5; set its models'])
    expect(await problems([{ op: 'handover.remove', from: 'qa', to: 'qa-collector' }])).toEqual([
      'node qa-collector collects evidence but no scores node hands over to it; add a handover to qa-collector from qa, or remove qa-collector',
    ])
  })

  test('removing the only judge names a fix that does not point at it', async () => {
    const out = refused(await core(), [{ op: 'node.remove', id: 'qa' }])
    expect(out.problems).toEqual([
      'node qa-collector collects evidence but no scores node hands over to it; no scores node is left to hand it slices, so remove qa-collector, or give it another contract',
    ])
    expect(out.problems[0]).not.toMatch(/from qa\b/)
  })

  test('import-d2 with a broken diagram is refused with its problems', async () => {
    const c = await core()
    const out = refused(c, [{ op: 'import-d2' }], { d2: toD2(c).replace('step1 -> step2', 'step1 -> nowhere') })
    expect(out.problems).toEqual(['loop.d2 line 58: the edge names "nowhere", which is not drawn; an edge joins a step, stage or node by its dotted path'])
  })
})

describe('parsing', () => {
  test('a well-formed op comes back with only its known keys', () => {
    expect(parseOp({ op: 'node.set', id: 'worker', models: ['opus', 'fable'] })).toEqual({ op: { op: 'node.set', id: 'worker', models: ['opus', 'fable'] } })
    expect(parseOp({ op: 'import-d2' })).toEqual({ op: { op: 'import-d2' } })
    expect(parseOp({ op: 'stage.add', id: 'x', summary: 'y', after: -1 })).toEqual({ op: { op: 'stage.add', id: 'x', summary: 'y', after: -1 } })
  })

  test('each malformed op says what is wrong', () => {
    const problem = (v: unknown) => ('problem' in parseOp(v) ? (parseOp(v) as { problem: string }).problem : null)
    expect(problem('stage.add')).toBe('each op is one object that names itself in op, beside its fields; send each op so')
    expect(problem({ id: 'x' })).toBe('the op does not name itself; give op, the change it makes, as the design skill lists them')
    expect(problem({ op: 'stage.grow' })).toBe('"stage.grow" is not a change the architect makes; name one the design skill lists')
    expect(problem({ op: 'stage.add', id: 'x', summary: 'y', alongSide: 'qa' })).toBe('a new stage takes id, summary, and after or alongside; "alongSide" is not one of them (did you mean alongside?)')
    expect(problem({ op: 'node.set', node: 'worker', models: ['opus'] })).toBe(
      'it changes a node\'s models, skills, tools, contract, summary, categories or collectors; "node" is not something it changes (did you mean id?)',
    )
    expect(problem({ op: 'node.set', id: 'worker', colour: 'red' })).toBe('it changes a node\'s models, skills, tools, contract, summary, categories or collectors; "colour" is not something it changes')
    expect(problem({ op: 'stage.add', id: 'x' })).toBe('the stage needs a summary of two to four words')
    expect(problem({ op: 'handover.set', from: 'a', to: 'b', spec: 'x' })).toBe('the handover needs a label of one or two words')
    expect(problem({ op: 'transition.set', from: 'a', label: 'x' })).toBe('the transition needs the stages it leads to, as a list in to')
    expect(problem({ op: 'loop.describe' })).toBe('the loop needs a description: a sentence on what it is for')
    expect(problem({ op: 'stage.add', id: 'x', summary: 'y', after: 1.5 })).toBe('after is not a whole number; give after as a whole number')
    expect(problem({ op: 'node.add', id: 'x', type: 'robot', contract: 'none', summary: 'y' })).toBe('type is not agent or swarm; give type as agent or swarm')
    expect(problem({ op: 'node.set', id: 'x', contract: 'judges' })).toBe('contract is not one of lands, scores, collects, none, interviews; give contract as one of lands, scores, collects, none, interviews')
    expect(problem({ op: 'node.move', id: 'x', onCall: false })).toBe('onCall is not true; give onCall as true')
    expect(problem({ op: 'node.set', id: 'x', tools: ['Edit'] })).toBe(
      'tools is not the tools to deny: deny with a list of tool names, like Edit; give tools as the tools to deny: deny with a list of tool names, like Edit',
    )
    expect(problem({ op: 'transition.set', from: 'a', to: 'b', label: 'x' })).toBe('to is not a list of strings; give to as a list of strings')
    expect(problem({ op: 'loop.new', name: 'x', level: 'user' })).toBe('it changes loop folders, not the draft; send it in a batch of its own')
    // no raw shapes: a person reads these through the architect
    for (const v of ['stage.add', { id: 'x' }, { op: 'node.set', id: 'x', tools: ['Edit'] }]) expect(problem(v)).not.toMatch(/[{}[\]]/)
  })

  test('every op parses back to itself and describes in one lower-case line', () => {
    const ops: Op[] = [
      { op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' },
      { op: 'stage.remove', id: 'qa' },
      { op: 'stage.move', id: 'qa', after: 5 },
      { op: 'stage.split', id: 'review' },
      { op: 'stage.rename', id: 'qa', to: 'judge' },
      { op: 'stage.summary', id: 'qa', summary: 'as the user' },
      { op: 'node.add', id: 'scout', type: 'agent', contract: 'none', summary: 'answers', onCall: true, tools: { deny: ['Edit'] } },
      { op: 'node.remove', id: 'scout' },
      { op: 'node.move', id: 'worker', onCall: true },
      { op: 'node.set', id: 'qa', categories: ['core'], collectors: 2 },
      { op: 'node.role', id: 'qa', text: 'You judge.' },
      { op: 'node.rename', id: 'worker', to: 'builder' },
      { op: 'transition.set', from: 'qa', to: ['merge'], label: 'all pass', when: 'every judge passes' },
      { op: 'transition.remove', from: 'qa', to: ['merge'] },
      { op: 'handover.set', from: 'qa', to: 'worker', label: 'notes', spec: 'what to fix' },
      { op: 'handover.remove', from: 'qa', to: 'worker' },
      { op: 'loop.describe', description: 'A loop.' },
      { op: 'loop.rename', to: 'mine' },
      { op: 'import-d2' },
    ]
    for (const op of ops) {
      expect(parseOp(JSON.parse(JSON.stringify(op)))).toEqual({ op })
      const line = describeOp(op)
      expect(line.split('\n').length).toBe(1)
      expect(line[0]).toBe(line[0]!.toLowerCase())
    }
    expect(describeOp({ op: 'stage.move', id: 'qa' })).toBe('moved stage qa to the last step')
    expect(describeOp({ op: 'stage.add', id: 'qa', summary: 'x', after: -1 })).toBe('added stage qa as the first step')
  })
})

describe('loops on disk', () => {
  const userDir = (name: string) => `${ROOTS.user}/${name}`
  const draftDir = (level: 'user' | 'project', name: string) => `${DRAFTS}/${draftKey({ level, name, repoRoot: REPO })}`

  test('a new loop from the plugin core is a draft until saved; the saved folder holds the four files and validates', async () => {
    const { fs, files } = shippedFs()
    const made = await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user', from: { name: 'core', level: 'plugin' } })
    if (!made.ok) throw new Error(made.problem)
    const description = `A copy of core (plugin): ${(await core()).description}`
    const change = `new from core (plugin), described as "${description}"`
    expect(made.info).toMatchObject({ dir: draftDir('user', 'mine'), base: null, changes: [change] })
    expect(made.ref).toMatchObject({ name: 'mine', level: 'user', dir: userDir('mine'), counts: { stages: 6, steps: 6, nodes: 5 } })
    expect(made.loop.name).toBe('mine')
    expect(made.loop.description).toBe(description)
    expect(made.ref.description).toBe(description)
    expect([...files.keys()].some(k => k.startsWith(`${ROOTS.user}/`))).toBe(false)
    expect(files.get(`${made.info.dir}/loop.d2`)).toBe(SHIPPED_LOOP_FILES['core/loop.d2'])
    expect(JSON.parse(files.get(`${made.info.dir}/draft.json`)!).changes).toEqual([change])

    expect(await saveDraft(fs, { ref: made.ref, loop: made.loop, info: made.info, opaque: [] })).toBeNull()
    for (const f of ['loop.json', 'loop.d2', 'LOOP.md', 'nodes/worker.md']) expect(files.has(`${userDir('mine')}/${f}`)).toBe(true)
    expect(files.get(`${userDir('mine')}/LOOP.md`)!.split('\n')[2]).toBe('# mine')
    const back = await readLoop(fs, userDir('mine'))
    expect(back.problems).toEqual([])
    expect(validateLoop(back.loop)).toEqual([])
    expect(back.loop.name).toBe('mine')
    expect(await fs.exists(made.info.dir)).toBe(false)

    const again = await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user' })
    expect(again).toEqual({ ok: false, problem: 'a loop named mine already exists at the user level; pick another name or open that loop' })
  })

  test('a new blank loop; a second draft of the same name and a project loop without a repository are refused', async () => {
    const { fs } = memFs()
    const made = await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'fresh', level: 'project' })
    if (!made.ok) throw new Error(made.problem)
    expect(made.loop).toEqual(blankLoop('fresh'))
    expect(made.info.changes).toEqual(['new loop fresh'])
    expect(await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'fresh', level: 'project' })).toEqual({ ok: false, problem: 'a draft of fresh at the project level is already open; continue it or discard it' })
    expect(await loopNew(fs, { ...ROOTS, project: null }, DRAFTS, null, { name: 'other', level: 'project' })).toEqual({
      ok: false,
      problem: 'there is no repository here, so there is no project level; use the user level',
    })
    expect(await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'other', level: 'user', from: { name: 'nope', level: 'plugin' } })).toEqual({
      ok: false,
      problem: 'there is no loop nope at the plugin level; check the name and level in the library',
    })
    expect(await loopNew(fs, ROOTS, DRAFTS, REPO, { name: 'Other', level: 'user' })).toEqual({ ok: false, problem: '"Other" is not a loop id; use lowercase letters, digits and inner hyphens, like other' })
  })

  /** A user loop `mine`, a copy of core, saved, with an open draft based on it. */
  async function savedWithDraft() {
    const { fs, files } = shippedFs()
    const loop = { ...(await core()), name: 'mine' }
    await writeLoop(fs, userDir('mine'), loop, { 'loop.d2': `${toD2(loop)}\nlegend: { note: kept }\n` })
    const draft = await openDraft(fs, DRAFTS, { level: 'user', name: 'mine', repoRoot: REPO }, loop)
    return { fs, files, loop, draft }
  }

  test('save refuses a plugin loop, an invalid draft and a changed base unless forced', async () => {
    const { fs, files, loop, draft } = await savedWithDraft()
    const ref = { name: 'mine', level: 'user' as const, dir: userDir('mine'), description: '', counts: { stages: 0, steps: 0, nodes: 0, edges: 0 } }
    expect(await saveDraft(fs, { ref: { ...ref, level: 'plugin' }, loop, info: draft.info, opaque: [] })).toBe(`the plugin's loops are read-only; copy it first: say "new loop <name> at user level from mine", then change the copy`)
    expect(await saveDraft(fs, { ref, loop: { ...loop, description: '' }, info: draft.info, opaque: [] })).toBe('the draft does not validate: the description is empty; say in a sentence what the loop is for')

    await writeLoop(fs, userDir('mine'), { ...loop, description: 'Changed elsewhere.' })
    const edited = { ...loop, description: 'Changed here.' }
    expect(await saveDraft(fs, { ref, loop: edited, info: draft.info, opaque: [] })).toBe('mine changed on disk since the draft began; save with force to overwrite it')
    expect(await saveDraft(fs, { ref, loop: edited, info: draft.info, opaque: ['legend: {}'], force: true })).toBeNull()
    expect((await readLoop(fs, userDir('mine'))).loop.description).toBe('Changed here.')
    expect(files.get(`${userDir('mine')}/loop.d2`)!.endsWith('\nlegend: {}\n')).toBe(true)
    expect(await fs.exists(draft.info.dir)).toBe(false)
  })

  test('loopMove moves the folder and the draft; plugin, taken and repository-less moves are refused', async () => {
    const { fs, files, draft } = await savedWithDraft()
    expect(await loopMove(fs, ROOTS, DRAFTS, REPO, { name: 'core', from: 'plugin', to: 'user' })).toBe(`the plugin's loops are read-only; copy it first: say "new loop <name> at user level from core", then change the copy`)
    expect(await loopMove(fs, { ...ROOTS, project: null }, DRAFTS, null, { name: 'mine', from: 'user', to: 'project' })).toBe('there is no repository here, so there is no project level; use the user level')
    expect(await loopMove(fs, ROOTS, DRAFTS, REPO, { name: 'mine', from: 'user', to: 'user' })).toBe('the loop is already at the user level; name the other level to move it')
    // check runs the refusals alone: nothing moves
    expect(await loopMove(fs, ROOTS, DRAFTS, REPO, { name: 'mine', from: 'user', to: 'project', check: true })).toEqual({ draftMoved: false })
    expect(await fs.exists(userDir('mine'))).toBe(true)
    expect(await loopMove(fs, ROOTS, DRAFTS, REPO, { name: 'mine', from: 'user', to: 'project' })).toEqual({ draftMoved: true })
    const moved = `${ROOTS.project}/mine`
    expect(await fs.exists(userDir('mine'))).toBe(false)
    expect((await readLoop(fs, moved)).problems).toEqual([])
    expect(files.get(`${moved}/loop.d2`)!.endsWith('legend: { note: kept }\n')).toBe(true)
    expect(await fs.exists(draft.info.dir)).toBe(false)
    expect(JSON.parse(files.get(`${draftDir('project', 'mine')}/draft.json`)!).base).toBe(draft.info.base)

    await writeLoop(fs, userDir('mine'), blankLoop('mine'))
    expect(await loopMove(fs, ROOTS, DRAFTS, REPO, { name: 'mine', from: 'project', to: 'user' })).toBe('a loop named mine already exists at the user level; rename or delete one of them first')
  })

  test('loopRename renames the folder, the name, the title and the draft, which still saves', async () => {
    const { fs, files, loop } = await savedWithDraft()
    expect(await loopRename(fs, ROOTS, DRAFTS, REPO, { name: 'core', level: 'plugin', to: 'x' })).toBe(`the plugin's loops are read-only; copy it first: say "new loop <name> at user level from core", then change the copy`)
    expect(await loopRename(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user', to: 'mine' })).toBe('the loop is already called mine; give a new name in to')
    expect(await loopRename(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user', to: 'ours' })).toBeNull()
    expect(await fs.exists(userDir('mine'))).toBe(false)
    const back = await readLoop(fs, userDir('ours'))
    expect(back.problems).toEqual([])
    expect(back.loop).toEqual({ ...loop, name: 'ours' })
    expect(files.get(`${userDir('ours')}/LOOP.md`)!.split('\n')[2]).toBe('# ours')
    expect(files.get(`${userDir('ours')}/loop.d2`)).toBe(`${toD2(loop)}\nlegend: { note: kept }\n`)

    expect(await fs.exists(draftDir('user', 'mine'))).toBe(false)
    const info = JSON.parse(files.get(`${draftDir('user', 'ours')}/draft.json`)!)
    expect(info.base).toBe(hashLoop(back.loop))
    const draft = await readLoop(fs, draftDir('user', 'ours'))
    expect(draft.loop.name).toBe('ours')
    const ref = { name: 'ours', level: 'user' as const, dir: userDir('ours'), description: '', counts: { stages: 0, steps: 0, nodes: 0, edges: 0 } }
    expect(await saveDraft(fs, { ref, loop: draft.loop, info: { ...info, dir: draftDir('user', 'ours') }, opaque: [] })).toBeNull()

    await writeLoop(fs, userDir('theirs'), blankLoop('theirs'))
    expect(await loopRename(fs, ROOTS, DRAFTS, REPO, { name: 'ours', level: 'user', to: 'theirs' })).toBe('a loop named theirs already exists at the user level; pick another name, or rename or delete that one first')
  })

  test('loopDelete removes the folder and the draft; a plugin loop is refused', async () => {
    const { fs, draft } = await savedWithDraft()
    expect(await loopDelete(fs, ROOTS, DRAFTS, REPO, { name: 'core', level: 'plugin' })).toBe(`the plugin's loops are read-only and cannot be deleted; to stop using core, make another loop the default: say "make <name> the default"`)
    expect(await loopDelete(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user' })).toBeNull()
    expect(await fs.exists(userDir('mine'))).toBe(false)
    expect(await fs.exists(draft.info.dir)).toBe(false)
    expect(await fs.exists('/plugin/loops/core/loop.json')).toBe(true)
    expect(await loopDelete(fs, ROOTS, DRAFTS, REPO, { name: 'mine', level: 'user' })).toBe('there is no loop mine at the user level; check the name and level in the library')
  })

  test('setDefaultLoop replaces the loop line and keeps every other line, or adds one', async () => {
    const { fs, files } = memFs({ '/home/.claude/dacapo.conf': '# my conf\nworkers = opus, sonnet\nloop = core  # the default\nqa = opus\n' })
    expect(await setDefaultLoop(fs, '/home/.claude/dacapo.conf', 'docs-only')).toBeNull()
    expect(files.get('/home/.claude/dacapo.conf')).toBe('# my conf\nworkers = opus, sonnet\nloop = docs-only  # the default\nqa = opus\n')
    files.set('/repo/.dacapo.conf', 'base-branch = main')
    expect(await setDefaultLoop(fs, '/repo/.dacapo.conf', 'mine')).toBeNull()
    expect(files.get('/repo/.dacapo.conf')).toBe('base-branch = main\nloop = mine\n')
    expect(await setDefaultLoop(fs, '/new/.dacapo.conf', 'mine')).toBeNull()
    expect(files.get('/new/.dacapo.conf')).toBe('loop = mine\n')
    expect(await setDefaultLoop(fs, '/new/.dacapo.conf', 'Mine')).toBe('"Mine" is not a loop id; use lowercase letters, digits and inner hyphens, like mine')
  })
})

describe('the interviews contract', () => {
  const add = (o: Partial<Extract<Op, { op: 'node.add' }>> = {}): Op => ({ op: 'node.add', id: 'functionality', type: 'agent', contract: 'interviews', summary: 'interviews the user', stage: 'clarify', models: ['sonnet'], ...o })

  test('node.add puts an interviewing node in a stage, and a second one may join it', async () => {
    const out = ok(await core(), [add(), add({ id: 'design' })])
    expect(out.loop.nodes.functionality).toMatchObject({ contract: 'interviews', models: ['sonnet'] })
    expect(out.loop.steps[0]!.stages[0]!.nodes).toEqual(['functionality', 'design'])
    expect(out.changes[0]).toBe('added agent functionality (interviews) in stage clarify')
    expect(validateLoop(out.loop)).toEqual([])
  })

  test('the op parser takes interviews and names the five contracts when the contract is missing', () => {
    expect(parseOp({ op: 'node.set', id: 'worker', contract: 'interviews' })).toEqual({ op: { op: 'node.set', id: 'worker', contract: 'interviews' } })
    expect(JSON.stringify(parseOp({ op: 'node.add', id: 'x', type: 'agent', summary: 'x', onCall: true }))).toContain('a contract: lands, scores, collects, none or interviews')
  })

  test('node.set turns a node into an interviewer and drops what only a judge carries', async () => {
    const out = ok(await coreDeep(), [{ op: 'node.set', id: 'reviewer', contract: 'interviews' }])
    expect(out.loop.nodes.reviewer!.contract).toBe('interviews')
    expect(out.loop.nodes.reviewer!.categories).toBeUndefined()
    expect(out.changes).toEqual(['set reviewer contract to interviews'])
  })

  test('an interviewer with no model, with categories or with collectors is refused, and nothing changed', async () => {
    const loop = await core()
    const before = JSON.stringify(loop)
    expect(refused(loop, [add({ models: [] })]).problems).toEqual(['node functionality talks to the user but has no model; give it at least one'])
    expect(refused(loop, [add({ categories: ['ux'] })]).problems).toEqual([
      'node functionality does not score, so it takes no categories; leave categories out: an interviews node does not score, or give it the scores contract',
    ])
    expect(refused(loop, [add({ collectors: 1 })]).problems).toEqual([
      'node functionality does not score, so it takes no collectors; leave collectors out: an interviews node does not score, or give it the scores contract',
    ])
    expect(JSON.stringify(loop)).toBe(before)
  })

  test('node.set on a node that does not score gets the same leave-it-out hint, whatever its contract', async () => {
    const loop = await core()
    expect(refused(loop, [{ op: 'node.set', id: 'worker', categories: ['ux'] }]).problems).toEqual([
      'node worker does not score, so it takes no categories; leave categories out: a lands node does not score, or give it the scores contract',
    ])
    const talker = ok(loop, [add({})]).loop
    expect(refused(talker, [{ op: 'node.set', id: 'functionality', categories: ['ux'] }]).problems).toEqual([
      'node functionality does not score, so it takes no categories; leave categories out: an interviews node does not score, or give it the scores contract',
    ])
    expect(refused(talker, [{ op: 'node.set', id: 'functionality', collectors: 1 }]).problems).toEqual([
      'node functionality does not score, so it takes no collectors; leave collectors out: an interviews node does not score, or give it the scores contract',
    ])
  })
})
