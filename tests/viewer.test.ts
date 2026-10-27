import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { Loop, LoopNode, LoopRef, ViewerFocus, ViewerState } from '../types/loops'
import { countsOf, graphFromJson, nodeFromFile, nodeOrder, withDefaultTransitions } from '../hooks/loops'
import type { Els } from '../hooks/pane'
import { LOOPS_PANE, drawViewer, focusText, viewerText, type ViewerActions } from '../hooks/viewer'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** A shipped loop read from loops/shipped.ts, its default transitions spelled out. */
function shippedLoop(name: string): Loop {
  const { graph } = graphFromJson(SHIPPED_LOOP_FILES[`${name}/loop.json`]!, name)
  const nodes: Record<string, LoopNode> = {}
  for (const [path, text] of Object.entries(SHIPPED_LOOP_FILES)) {
    const id = path.startsWith(`${name}/nodes/`) && path.endsWith('.md') ? path.slice(`${name}/nodes/`.length, -'.md'.length) : null
    if (id) nodes[id] = nodeFromFile(id, text).node
  }
  return { ...withDefaultTransitions(graph), nodes }
}

const NAMES = ['core', 'core-deep', 'core-fast'] as const
const LOOPS = Object.fromEntries(NAMES.map(n => [n, shippedLoop(n)])) as Record<(typeof NAMES)[number], Loop>
const refOf = (name: (typeof NAMES)[number]): LoopRef => {
  const loop = LOOPS[name]
  return { name, level: 'plugin', dir: `/plugin/loops/${name}`, description: loop.description, counts: countsOf(loop, Object.keys(loop.nodes).length) }
}
const LIBRARY = NAMES.map(refOf)
const SHAPES = Object.fromEntries(NAMES.map(n => [`plugin/${n}`, LOOPS[n].steps.map(s => s.stages.map(st => st.id))]))
const CORE_FILES = Object.keys(SHIPPED_LOOP_FILES)
  .filter(p => p.startsWith('core/'))
  .map(p => `/plugin/loops/${p}`)

const library = (): ViewerState => ({ screen: 'library', library: LIBRARY, defaultLoop: 'core', shapes: SHAPES, view: { folded: false, tab: 'canvas' } })
const core = (o: Partial<ViewerState['view']> = {}): ViewerState => ({
  ...library(),
  screen: 'loop',
  open: { ref: LIBRARY[0]!, loop: LOOPS.core, d2Newer: false, problems: [], files: CORE_FILES },
  view: { folded: false, tab: 'canvas', ...o },
})

type Call = { name: keyof ViewerActions; args: unknown[] }
/** The state the test's hook draws and every action pressed, recorded. */
type Held = { state: ViewerState; calls: Call[] }

/**
 * Registers the test's own `ui.render` hook for the viewer's pane, standing for the mod that will wire it: it draws
 * `held.state` with drawViewer and records each action. The terminal's table loses its Svg, as the mod's does.
 */
function viewer(on: On, state: ViewerState): Held {
  const held: Held = { state, calls: [] }
  const record =
    (name: keyof ViewerActions) =>
    (...args: unknown[]) => {
      held.calls.push({ name, args })
    }
  const act: ViewerActions = {
    back: record('back'),
    open: record('open') as ViewerActions['open'],
    focus: record('focus') as ViewerActions['focus'],
    fold: record('fold'),
    tab: record('tab') as ViewerActions['tab'],
    save: record('save'),
    discard: record('discard'),
  }
  on('ui.render', { component: 'Pane', requestId: LOOPS_PANE }, async ($, e) => {
    const resolved = $.ui.resolve(e) as unknown as Els
    const els: Els = e.surface === 'terminal' ? { Box: resolved.Box, Text: resolved.Text, Button: resolved.Button, Link: resolved.Link } : resolved
    return drawViewer(els, held.state, act, e.props.bodyColumns)
  })
  return held
}

const PANE = {
  plugin: 'dacapo',
  component: 'Pane' as const,
  requestId: LOOPS_PANE,
  props: { title: 'Loops', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

describe('the loop viewer: library', () => {
  test('lists the three shipped loops with their counts, the default chip and a View button, on every surface', async ($, on) => {
    viewer(on, library())
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /^Loops · 3 loops · default for runs: core \(plugin\)$/ })).toBeDefined()
      expect(await ui.find({ text: /^Project  \.claude\/dacapo\/loops\// })).toBeDefined()
      expect(await ui.find({ text: /^User  ~\/\.claude\/dacapo\/loops\// })).toBeDefined()
      expect(await ui.find({ text: /^Plugin  shipped with dacapo · read-only · copy to edit$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core\s+default\s+read-only\s*$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core-deep\s+read-only\s*$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core-fast\s+read-only\s*$/ })).toBeDefined()
      expect(await ui.find({ text: /^6 stages in 6 steps · 5 nodes · 15 edges$/ })).toBeDefined()
      expect(await ui.find({ text: /^7 stages in 7 steps · 6 nodes · 19 edges$/ })).toBeDefined()
      expect(await ui.find({ text: /^5 stages in 5 steps · 3 nodes · 9 edges$/ })).toBeDefined()
      expect(await ui.findAll({ type: 'Button', text: 'View' })).toHaveLength(3)
      expect(await ui.find({ type: 'Button', text: 'Open' })).toBeUndefined()
      expect(await ui.find({ text: /^\/plugin\/loops\/core-fast$/ })).toBeDefined()
      expect(await ui.findAll({ text: /^No loops here\.$/ })).toHaveLength(2)
      expect(await ui.find({ text: /Open and View only navigate/ })).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      else expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('stages: clarify, research, plan, implement, qa, merge')
      await ui.unmount()
    }
  })

  test('a project loop reads Open and hides the plugin loop of its name; pressing it calls open', async ($, on) => {
    const mine: LoopRef = { ...LIBRARY[0]!, level: 'project', dir: '/repo/.claude/dacapo/loops/core', hides: ['plugin'], draft: { dir: '/drafts/x', base: null, since: 0, changes: ['a'] } }
    const held = viewer(on, { ...library(), library: [mine, { ...LIBRARY[0]!, shadowedBy: 'project' }, ...LIBRARY.slice(1)] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /^Loops · 4 loops · default for runs: core \(project\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core\s+default\s+draft\s+hides plugin\s*$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core\s+read-only\s+hidden by project\s*$/ })).toBeDefined()
      expect(await ui.findAll({ text: /^No loops here\.$/ })).toHaveLength(1)
      held.calls = []
      await ui.press({ plugin: 'test', key: 'open-project/core' })
      expect(held.calls).toEqual([{ name: 'open', args: ['core', 'project'] }])
      await ui.unmount()
    }
  })
})

describe('the loop viewer: loop screen', () => {
  test('shows the name, the level chip, saved without a draft, the canvas and the footer on every surface', async ($, on) => {
    viewer(on, core())
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Button', text: '‹ Loops' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^core\s+plugin\s*$/ })).toBeDefined()
      expect(await ui.find({ text: /^saved · \/plugin\/loops\/core$/ })).toBeDefined()
      expect(await ui.find({ text: /DRAFT/ })).toBeUndefined()
      expect(await ui.find({ type: 'Button', text: 'Save' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', text: 'Canvas' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: 'Files' })).toBeDefined()
      expect(await ui.find({ text: /^Press a stage or a node to see it here\.$/ })).toBeDefined()
      expect(await ui.find({ text: /^This pane only shows\./ })).toBeDefined()
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Svg' })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: /┌ implement / })).toBeDefined()
      } else {
        expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('core canvas')
        expect(await ui.find({ text: /orchestrator\s+● agent\s+◍ swarm/ })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('a draft shows the DRAFT chip, its change count, Save and Discard, and they call their actions', async ($, on) => {
    const since = new Date(2026, 9, 26, 14, 5).getTime()
    const state = core()
    state.open = { ...state.open!, draft: { dir: '/home/me/.claude/dacapo/drafts/abc', base: 'h', since, changes: ['one', 'two', 'three'] } }
    const held = viewer(on, state)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^ DRAFT  3 changes · since 2026-10-26 · kept across sessions$/ })).toBeDefined()
      expect(await ui.find({ text: /^saved/ })).toBeUndefined()
      held.calls = []
      await ui.press({ plugin: 'test', key: 'save' })
      await ui.press({ plugin: 'test', key: 'discard' })
      expect(held.calls.map(c => c.name)).toEqual(['save', 'discard'])
      await ui.unmount()
    }
  })

  test('the focus chips name every stage and every node, and pressing one calls focus with its target', async ($, on) => {
    const held = viewer(on, core())
    const loop = LOOPS.core
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const st of loop.steps.flatMap(s => s.stages)) expect((await ui.find({ type: 'Button', key: `focus-stage-${st.id}` }))?.text.trim()).toBe(st.id)
      for (const id of nodeOrder(loop)) expect((await ui.find({ type: 'Button', key: `focus-node-${id}` }))?.text.trim()).toBe(id)
      held.calls = []
      await ui.press({ plugin: 'test', key: 'focus-node-worker' })
      await ui.press({ plugin: 'test', key: 'focus-stage-qa' })
      expect(held.calls).toEqual([
        { name: 'focus', args: [{ kind: 'node', id: 'worker' }] },
        { name: 'focus', args: [{ kind: 'stage', id: 'qa' }] },
      ])
      await ui.unmount()
    }
  })

  test('pressing the focused chip again clears the focus; a handover in the panel focuses the handover', async ($, on) => {
    const held = viewer(on, core({ focus: { kind: 'node', id: 'worker' } }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      held.calls = []
      await ui.press({ plugin: 'test', key: 'focus-node-worker' })
      await ui.press({ plugin: 'test', key: 'panel-handover-worker>orchestrator' })
      expect(held.calls).toEqual([
        { name: 'focus', args: [null] },
        { name: 'focus', args: [{ kind: 'handover', id: 'worker>orchestrator' } satisfies ViewerFocus] },
      ])
      await ui.unmount()
    }
  })

  test('focusing worker shows its models, skills, contract, tools, role and both handovers', async ($, on) => {
    viewer(on, core({ focus: { kind: 'node', id: 'worker' } }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^worker\s+swarm\s+implement\s*$/ })).toBeDefined()
      expect(await ui.find({ text: /^nodes\/worker\.md$/ })).toBeDefined()
      expect(await ui.find({ text: /^Models$/ })).toBeDefined()
      expect(await ui.find({ text: /^opus, sonnet$/ })).toBeDefined()
      expect(await ui.find({ text: /^Skills$/ })).toBeDefined()
      expect(await ui.find({ text: /^dacapo:rules-commits, dacapo:rules-prs$/ })).toBeDefined()
      expect(await ui.find({ text: /^Contract$/ })).toBeDefined()
      expect(await ui.find({ text: /^lands \(builds and lands work\) · reports done \/ done with limitations \/ failed$/ })).toBeDefined()
      expect(await ui.find({ text: /^never: Agent, EnterWorktree, ExitWorktree$/ })).toBeDefined()
      expect(await ui.find({ text: /^You are a worker subagent/ })).toBeDefined()
      expect(await ui.find({ text: /^… \d+ lines?$/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /^○→ worker  brief: the task/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /^worker →○  report: done, done with limitations/ })).toBeDefined()
      expect(await ui.find({ text: /^Try saying: “let workers use fable”/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('focusing a stage shows its step, nodes and transitions; a transition shows When and Then', async ($, on) => {
    const held = viewer(on, core({ focus: { kind: 'stage', id: 'qa' } }))
    for (const surface of SURFACES) {
      held.state = core({ focus: { kind: 'stage', id: 'qa' } })
      let ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^qa\s+stage\s*$/ })).toBeDefined()
      expect(await ui.find({ text: /^step 5 of 6$/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'panel-node-qa-collector' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /^implement → qa  all landed · when every task of the round has landed$/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /^qa ⇢ implement  fix · when a verdict is fix/ })).toBeDefined()
      expect(await ui.find({ text: /^Try saying: “move qa after merge”/ })).toBeDefined()
      await ui.unmount()

      held.state = core({ focus: { kind: 'transition', id: 'qa>implement' } })
      ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^qa ⇢ implement\s+transition · back\s*$/ })).toBeDefined()
      expect(await ui.find({ text: /^When$/ })).toBeDefined()
      expect(await ui.find({ text: /^a verdict is fix or pass-with-recommendations$/ })).toBeDefined()
      expect(await ui.find({ text: /^Then$/ })).toBeDefined()
      expect(await ui.find({ text: /^every item below strong/ })).toBeDefined()
      expect(await ui.find({ text: /^Try saying: “change when qa goes to implement” · “remove this transition”$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the Files tab lists the files with their full paths and the draft folder; the tabs call tab', async ($, on) => {
    const state = core({ tab: 'files' })
    state.open = { ...state.open!, draft: { dir: '/drafts/core', base: 'h', since: 0, changes: [] } }
    const held = viewer(on, state)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const f of CORE_FILES) expect(await ui.find({ type: 'Text', text: f })).toBeDefined()
      expect(await ui.find({ text: /^\/drafts\/core$/ })).toBeDefined()
      expect((await ui.findAll({ type: 'Svg' })).map(n => n.props.alt)).not.toContain('core canvas')
      expect(await ui.find({ type: 'Text', text: /┌ implement / })).toBeUndefined()
      expect(await ui.find({ text: /^Press a stage/ })).toBeUndefined()
      held.calls = []
      await ui.press({ plugin: 'test', key: 'tab-canvas' })
      await ui.press({ plugin: 'test', key: 'back' })
      expect(held.calls).toEqual([
        { name: 'tab', args: ['canvas'] },
        { name: 'back', args: [] },
      ])
      await ui.unmount()
    }
  })

  test('a notice line shows when set, and the hand-edited diagram warning when loop.d2 is newer', async ($, on) => {
    const state = core()
    state.notice = 'saved'
    state.open = { ...state.open!, d2Newer: true }
    viewer(on, state)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^saved$/ })).toBeDefined()
      expect(await ui.find({ text: /^loop\.d2 was edited by hand since the last save; say “import the diagram” to fold it in$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a loop with an on-call section offers the fold button, which calls fold', async ($, on) => {
    const loop: Loop = JSON.parse(JSON.stringify(LOOPS.core))
    loop.nodes.architect = { id: 'architect', type: 'agent', summary: 'reshapes the plan', contract: 'none', models: ['opus'], skills: [], tools: { deny: [] }, role: 'The architect.' }
    loop.onCall = { architect: [] }
    const state = core()
    state.open = { ...state.open!, loop }
    const held = viewer(on, state)
    for (const surface of SURFACES) {
      held.state = state
      let ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Button', text: '▾ on call · 1' })).toBeDefined()
      held.calls = []
      await ui.press({ plugin: 'test', key: 'fold' })
      expect(held.calls).toEqual([{ name: 'fold', args: [] }])
      await ui.unmount()
      held.state = { ...state, view: { ...state.view, focus: { kind: 'node', id: 'architect' } } }
      ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^architect\s+agent\s+on call\s*$/ })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('the loop viewer as text', () => {
  test('viewerText of core holds every stage and node name and the focus text', () => {
    const state = core({ focus: { kind: 'node', id: 'worker' } })
    const text = viewerText(state, 80)
    const loop = LOOPS.core
    for (const st of loop.steps.flatMap(s => s.stages)) expect(text).toContain(st.id)
    for (const id of Object.keys(loop.nodes)) expect(text).toContain(id)
    expect(text.startsWith('core · plugin\nsaved · /plugin/loops/core\n')).toBe(true)
    expect(text.endsWith(focusText(state).join('\n'))).toBe(true)
    expect(focusText(state)).toContain('Contract: lands (builds and lands work) · reports done / done with limitations / failed')
    expect(focusText(core({ focus: { kind: 'node', id: 'orchestrator' } }))).toContain('Contract: none (answers a prompt)')
    expect(focusText(core({ focus: { kind: 'node', id: 'qa' } }))).toContain('Contract: scores (judges a rubric) · strong / acceptable / unacceptable · core, ui-ux · up to 3 collectors')
    expect(focusText(core({ focus: { kind: 'node', id: 'qa-collector' } }))).toContain('Contract: collects (gathers evidence)')
    // a transition into the exit names it by its node id
    expect(focusText(core({ focus: { kind: 'transition', id: 'merge>exit' } }))[0]).toBe('merge → done · transition · forward')
  })

  test('the whole role, once: the focus reply gives every line where the panel gives the first ones', () => {
    const state = core({ focus: { kind: 'node', id: 'worker' } })
    const whole = focusText(state, { wholeRole: true })
    const role = LOOPS.core.nodes.worker!.role.trim()
    expect(whole.join('\n')).toContain(role.split('\n').map(l => (l ? `  ${l}` : '')).join('\n'))
    expect(whole.filter(l => l.includes('You are a worker subagent'))).toHaveLength(1)
    expect(whole.some(l => /^ {2}… \d+ lines?$/.test(l))).toBe(false)
    expect(focusText(state)).toContain('Tools: never: Agent, EnterWorktree, ExitWorktree')
  })

  test('the phrases to try fit the focused node: the entry, a judge, a collector, a worker, a node on call', () => {
    const tryLine = (state: ViewerState) => focusText(state).find(l => l.startsWith('Try saying: '))
    expect(tryLine(core({ focus: { kind: 'node', id: 'orchestrator' } }))).toBe(
      'Try saying: “add a scout the orchestrator can ask anything, any time” · “rewrite the orchestrator\'s role to clarify in one message”',
    )
    expect(tryLine(core({ focus: { kind: 'node', id: 'qa' } }))).toBe('Try saying: “add the category risk to qa” · “let qa use fable” · “give qa two collectors”')
    expect(tryLine(core({ focus: { kind: 'node', id: 'qa-collector' } }))).toBe('Try saying: “let qa-collector use haiku” · “never let qa-collector use Edit”')
    expect(tryLine(core({ focus: { kind: 'node', id: 'worker' } }))).toMatch(/^Try saying: “let workers use fable” · “add my lint skill to workers”/)
    expect(tryLine(core({ focus: { kind: 'node', id: 'done' } }))).toBe('Try saying: “rename done to finished”')

    const loop: Loop = JSON.parse(JSON.stringify(LOOPS.core))
    loop.nodes.scout = { id: 'scout', type: 'agent', summary: 'answers any question', contract: 'none', models: ['sonnet'], skills: [], tools: { deny: [] }, role: 'The scout.' }
    loop.nodes.reader = { ...loop.nodes.scout, id: 'reader', summary: 'reads folders' }
    loop.onCall = { scout: ['reader'] }
    const state = (id: string) => ({ ...core({ focus: { kind: 'node', id } }), open: { ...core().open!, loop } })
    expect(tryLine(state('scout'))).toBe('Try saying: “move scout into clarify” · “give scout a helper reader-2 that summarises folders”')
    expect(tryLine(state('reader'))).toBe('Try saying: “move reader on call” · “move reader into clarify”')
  })

  test('a transition shows When and Then only when it has them; a default one says so', () => {
    const at = (id: string, loop = LOOPS.core) => focusText({ ...core({ focus: { kind: 'transition', id } }), open: { ...core().open!, loop } })
    expect(at('implement>qa')).toEqual([
      'implement → qa · transition · forward',
      'Label: all landed',
      'When: every task of the round has landed',
      'Try saying: “change when implement goes to qa” · “remove this transition”',
    ])
    expect(at('research>plan').filter(l => /^(When|Then):/.test(l))).toEqual([])
    expect(at('qa>implement').filter(l => /^(When|Then):/.test(l)).map(l => l.split(':')[0])).toEqual(['When', 'Then'])
    const loop: Loop = JSON.parse(JSON.stringify(LOOPS.core))
    loop.transitions = loop.transitions.filter(t => !(t.from === 'research' && !t.back))
    const defaults = withDefaultTransitions(loop)
    expect(at('research>plan', { ...defaults, nodes: loop.nodes }).slice(1, 3)).toEqual(['Label: none, a default transition', 'When: a default transition'])
  })

  test('the phrases under a stage name only what the loop has: core, core-fast and a one-step loop', () => {
    const tryLine = (id: string, loop: Loop = LOOPS.core) => focusText({ ...core({ focus: { kind: 'stage', id } }), open: { ...core().open!, loop } }).find(l => l.startsWith('Try saying: '))
    expect(tryLine('qa')).toBe('Try saying: “move qa after merge” · “move qa alongside implement” · “rename qa to …” · “delete the qa stage” · “add a node qa-helper in qa”')
    expect(tryLine('clarify')).toBe(
      'Try saying: “move clarify after research” · “move clarify alongside research” · “rename clarify to …” · “delete the clarify stage” · “add a node clarify-helper in clarify”',
    )
    expect(tryLine('merge')).toBe('Try saying: “move merge alongside qa” · “rename merge to …” · “delete the merge stage” · “add a node merge-helper in merge”')
    expect(tryLine('implement', LOOPS['core-fast'])).toBe(
      'Try saying: “move implement after merge” · “move implement alongside plan” · “rename implement to …” · “delete the implement stage” · “add a node implement-helper in implement”',
    )
    expect(tryLine('merge', LOOPS['core-fast'])).toBe('Try saying: “move merge alongside implement” · “rename merge to …” · “delete the merge stage” · “add a node merge-helper in merge”')

    const one: Loop = { ...JSON.parse(JSON.stringify(LOOPS.core)), steps: [{ stages: [{ id: 'build', summary: 'builds it', nodes: ['worker'] }] }], transitions: [] }
    expect(tryLine('build', one)).toBe('Try saying: “rename build to …” · “delete the build stage” · “add a node build-helper in build”')
    one.steps[0]!.stages.push({ id: 'check', summary: 'checks it', nodes: [] })
    one.nodes['check-helper'] = { ...one.nodes.worker!, id: 'check-helper' }
    expect(tryLine('check', one)).toBe('Try saying: “split check into its own step” · “rename check to …” · “delete the check stage” · “add a node check-helper-2 in check”')
  })

  test('the phrases under a transition and a handover fit it: real names, remove only a stored one, a back edge only where none is', () => {
    const tryLine = (kind: 'transition' | 'handover', id: string, loop: Loop = LOOPS.core) =>
      focusText({ ...core({ focus: { kind, id } }), open: { ...core().open!, loop } }).find(l => l.startsWith('Try saying: '))
    expect(tryLine('transition', 'plan>implement')).toBe('Try saying: “change when plan goes to implement” · “remove this transition” · “add a back transition from implement to plan”')
    expect(tryLine('transition', 'implement>qa')).toBe('Try saying: “change when implement goes to qa” · “remove this transition”')
    expect(tryLine('transition', 'merge>implement')).toBe('Try saying: “change when merge goes to implement” · “remove this transition”')
    expect(tryLine('transition', 'entry>clarify')).toBe('Try saying: “change when orchestrator goes to clarify” · “remove this transition”')
    expect(tryLine('transition', 'merge>exit')).toBe('Try saying: “change when merge goes to done” · “remove this transition”')
    expect(tryLine('transition', 'implement>merge', LOOPS['core-fast'])).toBe('Try saying: “change when implement goes to merge” · “remove this transition”')
    expect(tryLine('transition', 'plan>implement', LOOPS['core-fast'])).toBe(
      'Try saying: “change when plan goes to implement” · “remove this transition” · “add a back transition from implement to plan”',
    )

    // a default transition cannot be removed; a forward one that leads back can be marked back
    const loop: Loop = JSON.parse(JSON.stringify(LOOPS.core))
    loop.transitions = loop.transitions.filter(t => !(t.from === 'research' && !t.back))
    loop.transitions.push({ from: 'qa', to: ['plan'], label: 'replan' })
    const defaults = { ...withDefaultTransitions(loop), nodes: loop.nodes }
    expect(tryLine('transition', 'research>plan', defaults)).toBe('Try saying: “change when research goes to plan” · “add a back transition from plan to research”')
    expect(tryLine('transition', 'qa>plan', defaults)).toBe('Try saying: “change when qa goes to plan” · “remove this transition” · “make this a back transition”')
    const one: Loop = { ...JSON.parse(JSON.stringify(LOOPS.core)), steps: [{ stages: [{ id: 'build', summary: 'builds it', nodes: [] }, { id: 'check', summary: 'checks it', nodes: [] }] }], transitions: [] }
    expect(tryLine('transition', 'entry>build+check', one)).toBe('Try saying: “change when orchestrator goes to build and check”')

    for (const name of ['core', 'core-fast'] as const) {
      expect(tryLine('handover', 'orchestrator>worker', LOOPS[name])).toBe('Try saying: “change what orchestrator hands to worker” · “remove this handover”')
    }
    expect(tryLine('handover', 'qa>qa-collector')).toBe('Try saying: “change what qa hands to qa-collector” · “remove this handover”')
    const oneWay: Loop = { ...JSON.parse(JSON.stringify(LOOPS.core)) }
    oneWay.handovers = oneWay.handovers.filter(h => !(h.from === 'worker' && h.to === 'orchestrator'))
    expect(tryLine('handover', 'orchestrator>worker', oneWay)).toBe('Try saying: “change what orchestrator hands to worker” · “remove this handover” · “add a handover from worker to orchestrator”')
  })

  test('focusText says when nothing is focused and when the focus is gone', () => {
    expect(focusText(core())).toEqual(['Press a stage or a node to see it here.'])
    expect(focusText(core({ focus: { kind: 'stage', id: 'nope' } }))).toEqual(['No stage nope in this loop.'])
    expect(focusText(library())).toEqual([])
  })

  test('viewerText of the library lists every level and loop', () => {
    const text = viewerText(library(), 80)
    expect(text.split('\n')[0]).toBe('Loops · 3 loops · default for runs: core (plugin)')
    for (const level of ['Project', 'User', 'Plugin']) expect(text).toContain(`\n${level}  `)
    for (const n of NAMES) expect(text).toContain(`  ${n}`)
    expect(text).toContain('core [default] [read-only] · 6 stages in 6 steps · 5 nodes · 15 edges')
  })

  test('the text library marks what hides what, a draft with its changes, and a draft alone in place of a folder', () => {
    const fresh: LoopRef = { ...LIBRARY[0]!, level: 'user', dir: '/u/loops/core', hides: ['plugin'], unsaved: true, draft: { dir: '/d/user--core', base: null, since: 0, changes: ['a', 'b'] } }
    const state: ViewerState = {
      ...library(),
      library: [fresh, { ...LIBRARY[0]!, shadowedBy: 'user' }, ...LIBRARY.slice(1)],
      roots: { plugin: '/plugin/loops', user: '/u/loops', project: null, drafts: '/d' },
    }
    const text = viewerText(state, 80)
    expect(text.split('\n')[0]).toBe('Loops · 4 loops · default for runs: core (user)')
    expect(text).toContain('\nProject  no repository here · this repository · kept out of git\n  No loops here.\n')
    expect(text).toContain('\nUser  /u/loops · every repository\n  core [default] [draft: 2 changes] [hides plugin] · ')
    expect(text).toContain('\n    draft, not saved yet\n')
    expect(text).toContain('\nPlugin  shipped with dacapo · read-only · copy to edit\n  core [read-only] [hidden by user] · ')
    // [default] marks one loop only
    expect(text.match(/\[default\]/g)).toHaveLength(1)
    expect(text.endsWith('\n\nDrafts: /d')).toBe(true)
  })
})
