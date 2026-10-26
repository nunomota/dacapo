import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { checksOf, parsePrs } from '../hooks/gh'
import { PHASES, PHASE_COLOR, STAGE_PALETTE, cut, drawBar, type Els, elapsed, phasesOf, rowsOf, stageColor, stepsOf } from '../hooks/pane'
import type { Run } from '../types'
import { DEFAULT_CONF, describeConf, loadConf, parseConf } from '../hooks/conf'
import { REVIEW_CATEGORIES, summarize, validateReport, validateRubric } from '../hooks/report'
import { SHIPPED_LOOP_FILES } from '../loops/shipped'

/**
 * The shipped loops as the plugin's root holds them, for a fake file system: any path outside /repo, /home and /tmp
 * that ends in loops/<path> is the shipped file at <path>. Tests get no file system, so the loops come from here.
 */
function shippedRel(path: string): string | null {
  if (/^\/(repo|home|tmp)\//.test(path)) return null
  const m = /\/loops(?:\/(.*))?$/.exec(path)
  return m ? (m[1] ?? '') : null
}
/** The names directly under `dir` among `paths`. */
function namesUnder(dir: string, paths: Iterable<string>): string[] {
  const base = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`
  const out = new Set<string>()
  for (const p of paths) if (p.startsWith(base) && p.length > base.length) out.add(p.slice(base.length).split('/')[0]!)
  return [...out]
}
/** Reads a fake file: a shipped loop file, else one of `files`; undefined when neither holds it. */
function fileAt(files: Map<string, string>, path: string): string | undefined {
  const rel = shippedRel(path)
  return rel !== null ? SHIPPED_LOOP_FILES[rel] : files.get(path)
}
/** Whether a fake path exists: a file or a folder of the shipped loops or of `files`. */
function existsAt(files: Map<string, string>, path: string): boolean {
  const rel = shippedRel(path)
  if (rel !== null) return rel === '' || rel in SHIPPED_LOOP_FILES || namesUnder(rel, Object.keys(SHIPPED_LOOP_FILES)).length > 0
  return files.has(path) || namesUnder(path, files.keys()).length > 0
}
/** Answers `$.fs.list` over the shipped loops and `files`. */
function listFs(on: On, files: Map<string, string>) {
  on('fs.list', (_, e) => {
    const rel = shippedRel(e.path)
    const names = rel !== null ? namesUnder(rel, Object.keys(SHIPPED_LOOP_FILES)) : namesUnder(e.path, files.keys())
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
}
/** A user loop `core-wide` made from core-deep: QA and the review side by side in one step, QA holding one collector at once. */
function wideLoop(files: Map<string, string>, root = '/home/u/.claude/dacapo/loops/core-wide') {
  const deep = JSON.parse(SHIPPED_LOOP_FILES['core-deep/loop.json']!) as { steps: { stages: unknown[] }[]; transitions: { from: string; to: string[]; back?: boolean }[] }
  const wide = {
    ...deep,
    name: 'core-wide',
    description: 'QA and the engineering review side by side.',
    steps: [...deep.steps.slice(0, 4), { stages: [deep.steps[4]!.stages[0], deep.steps[5]!.stages[0]] }, deep.steps[6]],
    transitions: deep.transitions.map(t => (t.back ? t : t.from === 'implement' ? { ...t, to: ['qa', 'review'] } : t.from === 'qa' ? { ...t, to: ['merge'] } : t)),
  }
  files.set(`${root}/loop.json`, JSON.stringify(wide, null, 2))
  for (const [rel, text] of Object.entries(SHIPPED_LOOP_FILES)) {
    const m = /^core-deep\/nodes\/(.+)$/.exec(rel)
    if (m) files.set(`${root}/nodes/${m[1]}`, m[1] === 'qa.md' ? text.replace('collectors: 3', 'collectors: 1') : text)
  }
}

const RUBRIC = [
  { id: 'login', title: 'A user can log in', category: 'core' as const },
  { id: 'errors', title: 'Errors are explained', category: 'ui-ux' as const },
]

describe('QA report validation', () => {
  test('a complete report is accepted and summarized', () => {
    const text = JSON.stringify({
      items: [
        { id: 'login', score: 'strong', note: 'logged in with the fixture account' },
        { id: 'errors', score: 'acceptable', note: 'wrong password says "error" only' },
      ],
      overview: 'Works end to end; error copy could be clearer.',
    })
    const out = validateReport(text, RUBRIC)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.summary).toEqual({ strong: 1, acceptable: 1, unacceptable: 0, verdict: 'pass-with-recommendations' })
    expect(out.items[1]?.title).toBe('Errors are explained')
  })

  test('a missing item, a bad score and an unknown id are each named', () => {
    const text = JSON.stringify({
      items: [
        { id: 'login', score: 'great', note: '' },
        { id: 'signup', score: 'strong', note: '' },
      ],
      overview: 'x',
    })
    const out = validateReport(text, RUBRIC)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems.some(p => p.includes('"login"') && p.includes('great'))).toBe(true)
    expect(out.problems.some(p => p.includes('"signup"'))).toBe(true)
    expect(out.problems.some(p => p.includes('"errors"') && p.includes('no score'))).toBe(true)
  })

  test('text that is not JSON, and an empty overview, are refused', () => {
    expect(validateReport('not json', RUBRIC).ok).toBe(false)
    const out = validateReport(JSON.stringify({ items: [], overview: '  ' }), RUBRIC)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems.some(p => p.includes('overview'))).toBe(true)
  })

  test('one unacceptable item means fix; all strong means pass', () => {
    const base = { title: 't', category: 'core' as const, note: '' }
    expect(summarize([{ ...base, id: 'a', score: 'strong' }, { ...base, id: 'b', score: 'unacceptable' }]).verdict).toBe('fix')
    expect(summarize([{ ...base, id: 'a', score: 'strong' }]).verdict).toBe('pass')
  })

  test('a rubric needs kebab-case ids, titles and a known category', () => {
    expect(validateRubric(RUBRIC).ok).toBe(true)
    expect(validateRubric([]).ok).toBe(false)
    expect(validateRubric([{ id: 'Bad Id', title: 't', category: 'core' }]).ok).toBe(false)
    expect(validateRubric([{ id: 'a', title: 't', category: 'perf' }]).ok).toBe(false)
    expect(validateRubric([{ id: 'a', title: 't', category: 'core' }, { id: 'a', title: 'u', category: 'core' }]).ok).toBe(false)
  })

  test('the engineering rubric has its own categories, and neither rubric accepts the other\'s', () => {
    expect(validateRubric([{ id: 'errors', title: 'Errors follow the codebase\'s style', category: 'consistency' }], REVIEW_CATEGORIES).ok).toBe(true)
    expect(validateRubric([{ id: 'a', title: 't', category: 'quality' }]).ok).toBe(false)
    const out = validateRubric([{ id: 'a', title: 't', category: 'core' }], REVIEW_CATEGORIES)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problem).toMatch(/"quality", "consistency", "cleanup"/)
  })
})

describe('the configuration', () => {
  test('key = value lines with comments and lists; a wrong value is named and the earlier one kept', () => {
    const parsed = parseConf(
      '# a comment\nloop = core-deep\nworkers = fable, opus , sonnet  # trailing comment\nloop = Not A Loop\nnope\ncolor = red\nprs-skill = /my-prs\ncommits-skill = a, b\ncommits-skill = Not A Skill\nbase-branch = release/2.0\nbase-branch = Not A Branch\nqa-collectors = 2\nqa-collectors = many\nqa-collectors = 9\n',
    )
    expect(parsed.values).toEqual({ loop: ['core-deep'], workers: ['fable', 'opus', 'sonnet'], 'prs-skill': ['my-prs'], 'base-branch': ['release/2.0'], 'qa-collectors': ['2'] })
    expect(parsed.problems).toEqual([
      'line 4: "loop" must be one loop name, like core or core-deep',
      'line 5: not "key = value": nope',
      'line 6: unknown key "color" (one of loop, workers, qa, review, commits-skill, prs-skill, base-branch, qa-collectors)',
      'line 8: "commits-skill" must be one skill name, like dacapo:rules-commits or my-rules',
      'line 9: "commits-skill" must be one skill name, like dacapo:rules-commits or my-rules',
      'line 11: "base-branch" must be one git branch name, like main or develop',
      'line 13: "qa-collectors" must be a whole number from 0 to 8',
      'line 14: "qa-collectors" must be a whole number from 0 to 8',
    ])
  })

  test('later files override earlier ones key by key, over the defaults, and each value names its file', () => {
    const loaded = loadConf([
      { path: '/plugin/dacapo.conf', text: 'loop = core\nqa = opus, sonnet\n' },
      { path: '/home/u/.claude/dacapo.conf', text: 'qa = sonnet\nloop = core-fast\ncommits-skill = other:rules\nbase-branch = develop\nqa-collectors = 0\n' },
      { path: '/repo/.dacapo.conf', text: null },
    ])
    expect(loaded.conf).toEqual({ ...DEFAULT_CONF, qa: ['sonnet'], loop: 'core-fast', 'commits-skill': 'other:rules', 'base-branch': 'develop', 'qa-collectors': 0 })
    expect(loaded.origin['qa-collectors']).toBe('/home/u/.claude/dacapo.conf')
    expect(loaded.origin.qa).toBe('/home/u/.claude/dacapo.conf')
    expect(loaded.origin.workers).toBe('default')
    expect(loaded.origin['prs-skill']).toBe('default')
    expect(describeConf(loaded)).toMatch(/\ncommits-skill = other:rules  \(\/home\/u\/.claude\/dacapo.conf\)\nprs-skill = dacapo:rules-prs  \(default\)\nbase-branch = develop  \(\/home\/u\/.claude\/dacapo.conf\)\nqa-collectors = 0  \(\/home\/u\/.claude\/dacapo.conf\)\n/)
    expect(loaded.read).toEqual(['/plugin/dacapo.conf', '/home/u/.claude/dacapo.conf'])
    expect(describeConf(loaded)).toMatch(/^loop = core-fast  \(\/home\/u\/.claude\/dacapo.conf\)\n/)
    expect(describeConf(loadConf([]))).toMatch(/Files read: none; defaults\./)
  })

  test('level and judges are gone: a file that still sets one is told depth is a loop now, and nothing is applied', () => {
    const parsed = parseConf('level = deep\njudges = parallel\nloop = core\n')
    expect(parsed.values).toEqual({ loop: ['core'] })
    expect(parsed.problems).toEqual([
      'line 1: "level" was removed in 0.22; depth is a loop now (loop = core-fast | core | core-deep)',
      'line 2: "judges" was removed in 0.22; depth is a loop now (loop = core-fast | core | core-deep)',
    ])
    expect(DEFAULT_CONF.loop).toBe('core')
    expect(describeConf(loadConf([]))).toMatch(/^loop = core  \(default\)\n/)
  })
})

describe('pull requests as gh lists them', () => {
  test('check runs and statuses fold into one word, a failure first', () => {
    expect(checksOf([])).toBe('none')
    expect(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
    expect(checksOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('pending')
    expect(checksOf([{ __typename: 'CheckRun', status: 'QUEUED' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
    expect(checksOf([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('failing')
  })

  test('the list keeps only the run\'s heads and maps state and draft', () => {
    const json = JSON.stringify([
      { number: 1, url: 'u1', title: 'feat: a', state: 'OPEN', isDraft: true, headRefName: 'run--a', baseRefName: 'run', mergeable: 'UNKNOWN', statusCheckRollup: null, createdAt: '2026-10-10T12:00:00Z' },
      { number: 2, url: 'u2', title: 'feat: b', state: 'MERGED', isDraft: false, headRefName: 'run--b', baseRefName: 'run', mergeable: 'MERGEABLE', statusCheckRollup: [], createdAt: '2026-10-10T12:01:00Z' },
      { number: 3, url: 'u3', title: 'other', state: 'OPEN', isDraft: false, headRefName: 'elsewhere', baseRefName: 'main', mergeable: 'CONFLICTING', statusCheckRollup: [], createdAt: '2026-10-10T12:02:00Z' },
    ])
    const prs = parsePrs(json, new Set(['run--a', 'run--b']))
    expect(prs?.map(p => `${p.number}:${p.state}:${p.mergeable}:${p.checks}`)).toEqual(['1:draft:unknown:none', '2:merged:mergeable:none'])
    expect(parsePrs('nope', new Set(['x']))).toBe(null)
  })
})

describe('timeline formatting', () => {
  test('elapsed reads as seconds, minutes or hours', () => {
    expect(elapsed(0, 42_000)).toBe('42s')
    expect(elapsed(0, 4 * 60_000 + 12_000)).toBe('4m12s')
    expect(elapsed(0, 2 * 3_600_000 + 5 * 60_000)).toBe('2h05m')
  })

  test('each level walks its own phases: no qa at fast, a review after qa at deep', () => {
    expect(phasesOf('fast')).toEqual(['clarify', 'research', 'plan', 'implement', 'merge'])
    expect(phasesOf('balanced')).toEqual(['clarify', 'research', 'plan', 'implement', 'qa', 'merge'])
    expect(phasesOf('deep')).toEqual(['clarify', 'research', 'plan', 'implement', 'qa', 'review', 'merge'])
  })

  test('cut shortens with an ellipsis and folds whitespace; rowsOf counts wrapped rows', () => {
    expect(cut('a   long\nline here', 8)).toBe('a long …')
    expect(cut('short', 10)).toBe('short')
    expect(rowsOf('short', 40)).toBe(1)
    expect(rowsOf('x'.repeat(85), 40)).toBe(3)
    expect(rowsOf('a\nb', 40)).toBe(2)
  })
})

const PANE = {
  component: 'Pane' as const,
  requestId: 'dacapo',
  props: { title: 'Da capo', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

describe('the pane', () => {
  test('with no run it says so on every surface', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /No dacapo run/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the /dacapo:core prompt opens a run and becomes the first row', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 10, 12, 0, 0) })
    mock.env(on, { HOME: '/home/u' })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('session.cwd', () => ({ value: '/tmp/dacapo-test' }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__dacapo__${e.name}` } }))
    on('agent.register', (_, e) => ({ value: { agent: `dacapo:${e.name}` } }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
    await $.session.start({ cwd: '/tmp/dacapo-test', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core build a todo app', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'also keep it tiny', wait: false, origin: { kind: 'composer' } })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /Clarifying the task/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^build a todo app$/ })).toBeUndefined()
      expect(await ui.find({ text: /User messages \(2\)/ })).toBeDefined()
      expect(await ui.find({ text: /also keep it tiny/ })).toBeDefined()
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      else expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

/** A run as the store keeps it, at the implement phase of the balanced level and with no loop: a run saved before loops. */
const LEGACY_RUN: Run = {
  id: 'r1',
  task: 'Ship loops',
  startedAt: Date.UTC(2026, 9, 10, 12, 0, 0),
  status: 'active',
  iteration: 1,
  root: '/repo',
  branch: 'ship-loops',
  worktree: '/repo/.workspaces/ship-loops',
  baseBranch: 'main',
  level: 'balanced',
  runDir: '/repo/.workspaces/.dacapo/r1',
  phase: 'implement',
  iterations: [],
  orchestrator: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0 },
  wakes: [],
  prs: [],
}

/** Four steps, the third holding QA and the review side by side. */
const LOOP: NonNullable<Run['loop']> = {
  name: 'core-deep',
  level: 'plugin',
  steps: [
    { stages: [{ id: 'plan', summary: 'Plan the work' }] },
    { stages: [{ id: 'implement', summary: 'Workers land it' }] },
    { stages: [{ id: 'qa', summary: 'QA as the end user' }, { id: 'review', summary: 'Engineering review' }] },
    { stages: [{ id: 'merge', summary: 'Merge the run' }] },
  ],
}

/** Answers the plugin's reads of its run with `held.run`, beneath the plugin as the kit's store would; set it to change the run. */
function seedRun(on: On, run: Run): { run: Run } {
  const held = { run }
  let version = 0
  on('state.get', (_, e, next) => (e.plugin === 'dacapo' && e.key === 'run' ? { value: { value: held.run, version: ++version } } : next(e)))
  return held
}
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** An element as a fake table builds it, to read drawBar's tree outside a surface. */
type Node = { type: string; props: { children?: unknown[] } & Record<string, unknown> }
const element = (type: string) => (props: Node['props']): Node => ({ type, props })
/** The terminal's table as drawBar sees it: no Svg, so it draws glyph rows. */
const GLYPH_ELS = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Link: element('Link') } as unknown as Els
/** A remote surface's table: an Svg, so it draws one vector bar. */
const SVG_ELS = { ...GLYPH_ELS, Svg: element('Svg') } as unknown as Els

const childrenOf = (node: unknown): unknown[] => {
  const kids = (node as Node).props.children
  return kids === undefined ? [] : Array.isArray(kids) ? kids.flat(Infinity) : [kids]
}
/** The text of each child of the bar's outer Box: the glyph row, then the label. */
const textOf = (tree: unknown): string[] => {
  const flat = (node: unknown): string => (typeof node === 'string' ? node : typeof node === 'object' && node ? childrenOf(node).map(flat).join('') : '')
  return childrenOf(tree).map(flat)
}
/** The first node of the tree, outermost first, that matches. */
const findNode = (tree: unknown, match: (n: Node) => boolean): Node | undefined => {
  if (typeof tree !== 'object' || !tree) return undefined
  if (match(tree as Node)) return tree as Node
  for (const kid of childrenOf(tree)) {
    const hit = findNode(kid, match)
    if (hit) return hit
  }
  return undefined
}
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}

describe('the bar from loop steps', () => {
  test('a run without a loop walks its level\'s phases, one stage per step', () => {
    expect(stepsOf(LEGACY_RUN)).toHaveLength(6)
    expect(stepsOf({ ...LEGACY_RUN, level: 'fast' })).toHaveLength(5)
    expect(stepsOf({ ...LEGACY_RUN, level: 'fast' }).map(s => s.stages.map(st => st.id).join())).toEqual(['clarify', 'research', 'plan', 'implement', 'merge'])
    expect(stepsOf({ ...LEGACY_RUN, loop: LOOP })).toHaveLength(4)
  })

  test('a phase keeps its color; other stages take distinct palette colors', () => {
    expect(stageColor('qa', 7)).toBe(PHASE_COLOR.qa)
    const ten = Array.from({ length: 10 }, (_, i) => stageColor(`stage-${i}`, i))
    expect(new Set(ten).size).toBe(10)
    expect(ten.slice(0, 7)).toEqual(PHASES.map(p => PHASE_COLOR[p]))
    expect(STAGE_PALETTE.length).toBeGreaterThanOrEqual(8)
  })

  test('the terminal bar halves a two-stage column and names every current stage', () => {
    const steps = stepsOf({ ...LEGACY_RUN, loop: LOOP })
    const both = drawBar(GLYPH_ELS, steps, ['qa', 'review'], 'active')
    expect(textOf(both)).toEqual(['█████ █████ ▀▀▀▄▄ ░░░░░', 'qa ∥ review'])
    expect(findNode(both, n => n.props.children?.[0] === 'qa ∥ review')?.props.color).toBe(PHASE_COLOR.qa)
    expect(findNode(both, n => n.props.children?.[0] === '▄▄')?.props.color).toBe(PHASE_COLOR.review)
    // QA still running, the review reported: the review's half is grey, the label names QA alone
    const one = drawBar(GLYPH_ELS, steps, ['qa'], 'active')
    expect(textOf(one)).toEqual(['█████ █████ ▀▀▀▄▄ ░░░░░', 'qa'])
    expect(findNode(one, n => n.props.children?.[0] === '▄▄')?.props.dimColor).toBe(true)
    expect(textOf(drawBar(GLYPH_ELS, steps, ['merge'], 'done'))).toEqual(['█████ █████ ▀▀▀▄▄ █████', 'merged'])
    // a run without a loop draws its level's phases as it always has
    expect(textOf(drawBar(GLYPH_ELS, stepsOf(LEGACY_RUN), ['implement'], 'active'))).toEqual(['█████ █████ █████ █████ ░░░░░ ░░░░░', 'implement'])
  })

  test('the terminal bar narrows its blocks past seven steps and stays within the deep bar\'s width', () => {
    for (let n = 1; n <= 21; n++) {
      const steps = Array.from({ length: n }, (_, i) => ({ stages: [{ id: `stage-${i}` }] }))
      const [bar] = textOf(drawBar(GLYPH_ELS, steps, ['stage-0'], 'active'))
      expect(bar!.length).toBeLessThanOrEqual(41)
      if (n <= 7) expect(bar!.length).toBe(n * 6 - 1)
    }
  })

  test('the SVG bar stacks a two-stage column in the same height and colors each current stage\'s name', () => {
    const steps = stepsOf({ ...LEGACY_RUN, loop: LOOP })
    const svg = findNode(drawBar(SVG_ELS, steps, ['qa', 'review'], 'active'), n => n.type === 'Svg')
    expect(svg?.props.alt).toBe('stage qa ∥ review')
    const source = String(svg?.props.source)
    expect(source).toContain(`<rect x="104" y="0" width="46" height="5.5" rx="2.75" fill="${PHASE_COLOR.qa}"/>`)
    expect(source).toContain(`<rect x="104" y="7.5" width="46" height="5.5" rx="2.75" fill="${PHASE_COLOR.review}"/>`)
    expect(source).toContain(`<tspan fill="${PHASE_COLOR.qa}">qa</tspan><tspan fill="#6e7681"> ∥ </tspan><tspan fill="${PHASE_COLOR.review}">review</tspan>`)
    const legacy = findNode(drawBar(SVG_ELS, stepsOf(LEGACY_RUN), ['implement'], 'active'), n => n.type === 'Svg')
    expect(legacy?.props.alt).toBe('stage implement')
    expect(String(legacy?.props.source)).toContain(`<rect x="156" y="0" width="46" height="13" rx="3" fill="${PHASE_COLOR.implement}"/>`)
  })

  test('a loop run shows its loop in the header, never the word phase, on every surface', async ($, on) => {
    const held = seedRun(on, { ...LEGACY_RUN, phase: 'qa', loop: LOOP, stage: 'qa', activeStages: ['qa', 'review'] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /^Loop$/ })).toBeDefined()
      expect(await ui.find({ text: /^Level$/ })).toBeUndefined()
      expect(await ui.find({ text: /^core-deep · plugin · 5 stages in 4 steps$/ })).toBeDefined()
      expect(await ui.find({ text: /phase/ })).toBeUndefined()
      if (surface !== 'terminal') expect((await ui.findAll({ type: 'Svg' })).map(n => n.props.alt).find(alt => String(alt).startsWith('stage '))).toBe('stage qa ∥ review')
      await ui.unmount()
    }
    held.run = { ...held.run, activeStages: ['qa'] }
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /^Loop$/ })).toBeDefined()
      if (surface !== 'terminal') expect((await ui.findAll({ type: 'Svg' })).map(n => n.props.alt).find(alt => String(alt).startsWith('stage '))).toBe('stage qa')
      await ui.unmount()
    }
  })

  test('the band names the loop and its current stages; a run without a loop keeps its level and phase', async ($, on) => {
    const held = seedRun(on, { ...LEGACY_RUN, phase: 'qa', loop: LOOP, stage: 'qa', activeStages: ['qa', 'review'] })
    let ui = await $.ui.mount({ plugin: 'dacapo', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /^dacapo  ·  core-deep  ·  qa ∥ review  ·  Ship loops$/ })).toBeDefined()
    await ui.unmount()
    held.run = LEGACY_RUN
    ui = await $.ui.mount({ plugin: 'dacapo', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /^dacapo  ·  balanced  ·  implement  ·  Ship loops$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a run without a loop keeps its Level line and its phase on every surface', async ($, on) => {
    seedRun(on, LEGACY_RUN)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /^Level$/ })).toBeDefined()
      expect(await ui.find({ text: /^Loop$/ })).toBeUndefined()
      expect(await ui.find({ text: /^balanced$/ })).toBeDefined()
      if (surface !== 'terminal') expect((await ui.findAll({ type: 'Svg' })).map(n => n.props.alt).find(alt => String(alt).startsWith('stage '))).toBe('stage implement')
      await ui.unmount()
    }
  })
})

type ListedPr = {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  mergeable: string
  statusCheckRollup: Array<Record<string, string>>
  createdAt: string
}

describe('the loop', () => {
  // the longest test: near the kit's 5 s default on a loaded machine, so it gets more
  test('workers land through pull requests; sync, QA, resume, guards, stale marking and the final merge', { timeoutMs: 15_000 }, async ($, on) => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0)
    const clock = mock.clock(on, { now: t0 })
    mock.env(on, { HOME: '/home/u' })
    const files = new Map<string, string>()
    // the user's conf: a key removed with levels, QA models fast first, one line the plugin does not know
    files.set('/home/u/.claude/dacapo.conf', '# mine\njudges = parallel\nqa = sonnet, opus  # fast first\nqa-collectors = 1\nbogus = 1\n')
    // the user's own loop, QA and the review side by side
    wideLoop(files)
    listFs(on, files)
    const prompts: string[] = []
    const ghCalls: string[][] = []
    let ghMissing = true
    let pushFails = false
    const prList: ListedPr[] = []
    const RUN = 'build-a-login-page'
    const WORK = `${RUN}--login`
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    on('session.cwd', () => ({ value: '/repo' }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__dacapo__${e.name}` } }))
    const registered: string[] = []
    on('agent.register', (_, e) => {
      registered.push(e.name)
      return { value: { agent: `dacapo:${e.name}` } }
    })
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => ({ value: fileAt(files, e.path) ?? '' }))
    on('fs.exists', (_, e) => ({ value: existsAt(files, e.path) || e.path.startsWith('/repo/.workspaces/') }))
    on('process.run', (_, e) => {
      const argv = e.argv
      const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (argv[0]?.endsWith('gh')) {
        if (ghMissing) return out('', 127)
        ghCalls.push([...argv.map(String)])
        if (argv[1] === '--version') return out('gh version 2.80.0\n')
        if (argv[1] === 'auth') return out('Logged in to github.com\n')
        if (argv[1] === 'repo') return out(JSON.stringify({ nameWithOwner: 'x/y', url: 'https://github.com/x/y' }))
        if (argv[1] === 'pr' && argv[2] === 'list') return out(JSON.stringify(prList))
        if (argv[1] === 'pr' && argv[2] === 'create') return out('https://github.com/x/y/pull/9\n')
        return out('')
      }
      if (argv[1] === 'rev-parse' && argv[2] === '--show-toplevel') return out('/repo\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--path-format=absolute') return out('/repo/.git\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--verify') return String(argv[4]) === 'refs/heads/main' ? out('abc\n') : out('', 1)
      if (argv[1] === 'ls-remote') return out('')
      if (argv[1] === 'worktree' && argv[2] === 'list') return out('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n')
      if (argv[1] === 'rev-list') return out('2\n')
      if (argv[1] === 'remote') return out('git@github.com:x/y.git\n')
      if (argv[1] === 'push') return pushFails ? out('', 1) : out('')
      return out('')
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('turn.start', () => ({ turnId: 'wake' }))
    on('tool.call', { tool: 'TaskStop' }, () => ({ result: 'stopped' }))
    on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
    on('tool.call', { tool: 'Read' }, () => ({ result: 'read' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
    const agentCalls: Array<Record<string, unknown>> = []
    let nextAgent = 0
    on('tool.call', { tool: 'Agent' }, (_, e) => {
      agentCalls.push({ ...e })
      nextAgent += 1
      return { result: { agentId: `agent-${nextAgent}`, content: [{ type: 'text' as const, text: 'started' }] } }
    })
    const startAgent = (prompt: string) => $.tool.call({ tool: 'Agent', prompt, description: 'x', subagent_type: 'dacapo:worker' })
    const workPr = (state: string, checks: Array<Record<string, string>>, isDraft = false): ListedPr => ({
      number: 3,
      url: 'https://github.com/x/y/pull/3',
      title: 'feat: add login page',
      state,
      isDraft,
      headRefName: WORK,
      baseRefName: RUN,
      mergeable: 'MERGEABLE',
      statusCheckRollup: checks,
      createdAt: new Date(t0 + 60_000).toISOString(),
    })
    const finalPr = (checks: Array<Record<string, string>>, mergeable = 'MERGEABLE'): ListedPr => ({
      number: 9,
      url: 'https://github.com/x/y/pull/9',
      title: 'feat: add a login page',
      state: 'OPEN',
      isDraft: false,
      headRefName: RUN,
      baseRefName: 'main',
      mergeable,
      statusCheckRollup: checks,
      createdAt: new Date(t0 + 3 * 3_600_000).toISOString(),
    })
    const GREEN = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    const RED = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    // the loop flag names the loop before the task is clear; a task that begins with "build" is just a task
    await $.prompt.submit({ text: '/dacapo:core --loop core-wide build a login page', wait: false, origin: { kind: 'composer' } })

    // without gh the run cannot start, and the orchestrator is told how to help
    const noGh = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('isError' in noGh && noGh.isError).toBe(true)
    expect('result' in noGh && noGh.result).toMatch(/brew install gh/)
    ghMissing = false
    const badLoop = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page', loop: 'turbo' } as never)
    expect('isError' in badLoop && badLoop.isError).toBe(true)
    expect('result' in badLoop && badLoop.result).toMatch(/there is no loop "turbo"; the loops available: core-wide, core, core-deep, core-fast/)
    const started = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('result' in started && started.result).toMatch(/Run .* ready on x\/y/)
    expect('result' in started && started.result).toMatch(/loop core-wide \(user\): clarify → research → plan → implement → qa ∥ review → merge/)
    expect('result' in started && started.result).toMatch(/qa \(scores; opus, sonnet; up to 1 dacapo:qa-collector at once/)
    expect('result' in started && started.result).toMatch(/reviewer \(scores; opus, sonnet\)/)
    // the session registered the agents of the configured loop; the --loop prompt added the one its loop adds, before its turn began
    expect(registered.slice(0, 3).sort()).toEqual(['qa', 'qa-collector', 'worker'])
    expect(registered).toContain('reviewer')
    expect('result' in started && started.result).not.toMatch(/registered now/)
    // the configuration in force, with where each value came from, and the loop with the orchestrator's role; agents never read the files
    const config = await $.tool.call({ tool: 'mcp__dacapo__config' } as never)
    expect('result' in config && config.result).toMatch(/loop = core  \(default\)/)
    expect('result' in config && config.result).toMatch(/Ignored:[\s\S]*"judges" was removed in 0\.22; depth is a loop now/)
    expect('result' in config && config.result).toMatch(/qa = sonnet, opus/)
    expect('result' in config && config.result).toMatch(/Loop: core-wide \(user level, \/home\/u\/.claude\/dacapo\/loops\/core-wide\)/)
    expect('result' in config && config.result).toMatch(/5\. qa: as the end user \(qa, qa-collector\) ∥ review: as an engineer \(reviewer\)/)
    expect('result' in config && config.result).toMatch(/- worker: builds one task \(agent type dacapo:worker, works in implement\)\. swarm, contract lands; models opus, sonnet; skills dacapo:rules-commits, dacapo:rules-prs/)
    expect('result' in config && config.result).toMatch(/## Your role\n\nYou are the orchestrator of this loop/)
    expect('result' in config && config.result).toMatch(/qa-collectors = 1  \(\/home\/u\/.claude\/dacapo.conf\)/)
    expect('result' in config && config.result).toMatch(/commits-skill = dacapo:rules-commits  \(default\)/)
    expect('result' in config && config.result).toMatch(/Ignored:[\s\S]*unknown key "bogus"/)
    // a model the configuration does not list is refused
    const fable = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build it', model: 'fable', commit: 'feat: add login page' }],
    } as never)
    expect('isError' in fable && fable.isError).toBe(true)
    expect('result' in fable && fable.result).toMatch(/one of opus, sonnet/)
    // once set up, the loop is fixed
    const reloop = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page', loop: 'core-fast' } as never)
    expect('isError' in reloop && reloop.isError).toBe(true)
    expect('result' in reloop && reloop.result).toMatch(/never changed mid-run/)
    // a judge takes the categories of its node only, and only a scores node judges
    const wrongCategory = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'reviewer', rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }] } as never)
    expect('isError' in wrongCategory && wrongCategory.isError).toBe(true)
    expect('result' in wrongCategory && wrongCategory.result).toMatch(/category must be one of "quality", "consistency", "cleanup"/)
    const notJudge = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'qa-collector', rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }], harness: 'x' } as never)
    expect('result' in notJudge && notJudge.result).toMatch(/not a scores node of the loop "core-wide"; its judges: qa, reviewer/)
    expect('result' in started && started.result).toMatch(new RegExp(`run branch "${RUN}" cut from origin/main`))
    expect('result' in started && started.result).toMatch(/Pushed build-a-login-page to origin/)
    const runId = /Run (\S+) ready/.exec(String('result' in started ? started.result : ''))?.[1] ?? ''

    const bad = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build it', model: 'sonnet', commit: 'update(login): stuff' }],
    } as never)
    expect('isError' in bad && bad.isError).toBe(true)
    const noPrior = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build it', model: 'sonnet', commit: 'feat: add login page', resume: true }],
    } as never)
    expect('isError' in noPrior && noPrior.isError).toBe(true)

    const dispatched = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      title: 'Login page',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build the login page.', model: 'sonnet', commit: 'feat: add login page', build: 'npm run build' }],
    } as never)
    expect('result' in dispatched && dispatched.result).toMatch(/prompt: "dacapo worker login"/)
    const brief = files.get(`/repo/.workspaces/${WORK}/.context/brief.md`) ?? ''
    expect(brief).toMatch(/npm run build/)
    expect(brief).toMatch(new RegExp(`Base branch \\(the pull request's target\\): \`${RUN}\``))
    expect(brief).toMatch(/Pull request title.*`feat: add login page`/)
    // the brief names the rules skills for the worker to load, and no longer carries their text
    expect(brief).toMatch(/Commit rules: the `dacapo:rules-commits` skill\. Load it with the Skill tool/)
    expect(brief).toMatch(/Pull request rules: the `dacapo:rules-prs` skill\. Load it with the Skill tool/)
    expect(brief).not.toMatch(/Conventional Commits/)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/round-1-login.md`)).toMatch(/dacapo:rules-commits/)
    const pendingStatus = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in pendingStatus && pendingStatus.result).toMatch(/login \[pending-worker-1-login\] waiting to start/)
    expect('result' in pendingStatus && pendingStatus.result).toMatch(/loop core-wide \(user\), stage implement/)
    // an Agent call that names nothing pending is refused; the right one is filled in from the run
    const wrong = await startAgent('dacapo worker nope')
    expect('deny' in wrong && typeof wrong.deny === 'string').toBe(true)
    await clock.advance(1_000)
    const startedWorker = await startAgent('dacapo worker login')
    expect('result' in startedWorker).toBe(true)
    const call = agentCalls[0]!
    expect(call.subagent_type).toBe('dacapo:worker')
    expect(call.model).toBe('sonnet')
    expect(call.run_in_background).toBe(true)
    expect(String(call.prompt)).toMatch(new RegExp(`^\\[dacapo worktree: /repo/.workspaces/${WORK}\\]`))
    expect(String(call.prompt)).toMatch(/Merge method: squash/)

    // the orchestrator may not edit, merge or open pull requests while the run is active; a worker may write inside its worktree only
    const denied = await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })
    expect('deny' in denied && typeof denied.deny === 'string').toBe(true)
    const byHand = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 3 --squash' })
    expect('deny' in byHand && typeof byHand.deny === 'string').toBe(true)
    const outside = await $.tool.call({ tool: 'Write', file_path: '/repo/src/x.ts', content: 'x', agentId: 'agent-1' } as never)
    expect('deny' in outside && typeof outside.deny === 'string').toBe(true)
    const inside = await $.tool.call({ tool: 'Write', file_path: `/repo/.workspaces/${WORK}/src/x.ts`, content: 'x', agentId: 'agent-1' } as never)
    expect('result' in inside && inside.result).toBe('written')

    // the worker's pull request shows up in the pane as a link once polled
    prList.push(workPr('OPEN', GREEN, true))
    await clock.advance(21_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /Login page/ })).toBeDefined()
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      expect(await ui.find({ text: /feat: add login page/ })).toBeDefined()
      expect(await ui.find({ text: /PRs \(1\)/ })).toBeDefined()
      expect(await ui.find({ text: /Agents \(1\)/ })).toBeDefined()
      await ui.unmount()
    }

    await clock.advance(90_000)
    prList[0] = workPr('OPEN', GREEN)
    await $.turn.complete({ answer: 'Done. Build passes. Pull request: #3 merged.', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' })
    // the wake-up is sent by the ticker, not inside the agent's own completion
    expect(prompts.some(p => p.startsWith('[dacapo]'))).toBe(false)
    await clock.advance(1_000)
    const wakeWorkers = prompts.find(p => p.startsWith('[dacapo]') && /all 1 worker\(s\) have ended/.test(p))
    expect(wakeWorkers).toMatch(/PR #3 feat: add login page \(open\)/)
    expect(wakeWorkers).toMatch(/call mcp__dacapo__sync/)
    // undelivered, it is sent again after 30 seconds and at most three times; a started turn marks it delivered
    await clock.advance(31_000)
    expect(prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length).toBe(2)
    await $.turn.start({ text: `The dacapo plugin sent a message: ${wakeWorkers!}` } as never)
    await clock.advance(31_000)
    expect(prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length).toBe(2)

    // a worker that finished while its pull request is still open has not landed
    const notLanded = await $.tool.call({ tool: 'mcp__dacapo__sync' } as never)
    expect('result' in notLanded && notLanded.result).toMatch(/Finished without landing/)
    const unlanded = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in unlanded && unlanded.result).toMatch(/login \[agent-1\] failed .*finished without landing/)

    // a finished agent that acts again is live again, and its next completion wakes the orchestrator once more
    await $.tool.call({ tool: 'Write', file_path: `/repo/.workspaces/${WORK}/src/y.ts`, content: 'y', agentId: 'agent-1' } as never)
    const revived = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in revived && revived.result).toMatch(/login \[agent-1\] running \(restarted 1x\)/)
    const before = prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length
    prList[0] = workPr('MERGED', GREEN)
    await $.turn.complete({ answer: 'Done again; merged.\n\ndacapo: done with limitations', durationMs: 1, isAborted: false, turnId: 't1b', agentId: 'agent-1', reason: 'answer' })
    await clock.advance(1_000)
    expect(prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length).toBe(before + 1)
    await $.turn.start({ text: `The dacapo plugin sent a message: ${prompts[prompts.length - 1]!}` } as never)

    // once merged, sync prunes the branch and fast-forwards the run worktree
    const synced = await $.tool.call({ tool: 'mcp__dacapo__sync' } as never)
    expect('result' in synced && synced.result).toMatch(/1 pull request\(s\) landed/)
    expect('result' in synced && synced.result).toMatch(/login: #3 feat: add login page \(merged\)/)
    expect('result' in synced && synced.result).toMatch(/fast-forwarded by 2 commit/)
    const afterSync = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterSync && afterSync.result).toMatch(/login \[agent-1\] merged with limitations/)

    const noHarness = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'qa', rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }] } as never)
    expect('result' in noHarness && noHarness.result).toMatch(/"harness" must say how to run and use the deliverable/)
    const qa = await $.tool.call({
      tool: 'mcp__dacapo__judge',
      node: 'qa',
      rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }, { id: 'copy', title: 'Error copy is clear', category: 'ui-ux' }],
      harness: 'Run `npm start`, open http://localhost:3000/login, use user@example.com / secret.',
      model: 'sonnet',
    } as never)
    expect('result' in qa && qa.result).toMatch(/prompt: "dacapo judge qa 1-1"/)
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/npm start/)
    const reportPath = '/repo/.workspaces/qa/1-1/.context/qa-report.json'
    const startedQa = await startAgent('dacapo judge qa 1-1')
    expect('result' in startedQa).toBe(true)
    expect(agentCalls[1]?.subagent_type).toBe('dacapo:qa')
    expect(agentCalls[1]?.model).toBe('sonnet')

    // judges whose stages share a step run side by side: the review starts while QA runs, and a QA verdict of fix stops it
    expect('result' in qa && qa.result).toMatch(/shares a step with "reviewer": call mcp__dacapo__judge for it now as well/)
    const alongside = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'reviewer', rubric: [{ id: 'style', title: 'Matches the codebase', category: 'consistency' }] } as never)
    expect('result' in alongside && alongside.result).toMatch(/Review round 1 of "reviewer" prepared/)
    await startAgent('dacapo judge reviewer 1-1')
    expect(agentCalls[2]?.subagent_type).toBe('dacapo:reviewer')
    expect(agentCalls[2]?.model).toBe('opus')
    const sideBySide = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in sideBySide && sideBySide.result).toMatch(/stages qa ∥ review/)

    // QA may not read source, only its .context folder; and only writes its report
    const peek = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/src/login.ts', agentId: 'agent-2' } as never)
    expect('deny' in peek && typeof peek.deny === 'string').toBe(true)
    const qaBriefRead = await $.tool.call({ tool: 'Read', file_path: '.context/qa-brief.md', agentId: 'agent-2' } as never)
    expect('result' in qaBriefRead && qaBriefRead.result).toBe('read')
    const wrongWrite = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/qa/1-1/.context/notes.md', content: 'x', agentId: 'agent-2' } as never)
    expect('deny' in wrongWrite && typeof wrongWrite.deny === 'string').toBe(true)

    // QA may split the rubric among evidence collectors: only its own kind, as many at once as the conf allows, on the fast tier, bound like QA
    expect('result' in qa && qa.result).toMatch(/"qa" may start up to 1 dacapo:qa-collector agents/)
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/Up to 1 `dacapo:qa-collector` agent may run at once/)
    const notCollector = await $.tool.call({ tool: 'Agent', prompt: 'read the login code', description: 'x', subagent_type: 'dacapo:worker', agentId: 'agent-2' } as never)
    expect('deny' in notCollector && String(notCollector.deny)).toMatch(/only agent you may start is dacapo:qa-collector/)
    const collector = await $.tool.call({ tool: 'Agent', prompt: 'Items: login. Use the fixture account on the login page; the server is shared.', description: 'login slice', subagent_type: 'dacapo:qa-collector', model: 'fable', agentId: 'agent-2' } as never)
    expect('result' in collector).toBe(true)
    const spawned = agentCalls[agentCalls.length - 1]!
    expect(spawned.subagent_type).toBe('dacapo:qa-collector')
    expect(spawned.model).toBe('sonnet')
    expect(spawned.run_in_background).toBe(false)
    expect(String(spawned.prompt)).toMatch(/^\[dacapo worktree: \/repo\/.workspaces\/qa\/1-1\]/)
    expect(String(spawned.prompt)).toMatch(/qa-brief\.md[\s\S]*## Your slice, from QA[\s\S]*fixture account/)
    const oneAtATime = await $.tool.call({ tool: 'Agent', prompt: 'Items: errors.', description: 'errors slice', subagent_type: 'dacapo:qa-collector', agentId: 'agent-2' } as never)
    expect('deny' in oneAtATime && String(oneAtATime.deny)).toMatch(/1 collector may run at once/)
    const withCollector = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in withCollector && withCollector.result).toMatch(/QA round 1 \(qa\) \[agent-2\] running \([^)]*1 of 1 collectors live\)/)
    // the collector is bound like QA: the product, never the source; it writes evidence, not the report; it starts no agents
    const collectorPeek = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/src/login.ts', agentId: 'agent-4' } as never)
    expect('deny' in collectorPeek && String(collectorPeek.deny)).toMatch(/dacapo QA collector: .*never open source/)
    const collectorBrief = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/.context/qa-brief.md', agentId: 'agent-4' } as never)
    expect('result' in collectorBrief && collectorBrief.result).toBe('read')
    const evidence = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/qa/1-1/.context/evidence/login.md', content: 'x', agentId: 'agent-4' } as never)
    expect('result' in evidence && evidence.result).toBe('written')
    const collectorReport = await $.tool.call({ tool: 'Write', file_path: reportPath, content: 'x', agentId: 'agent-4' } as never)
    expect('deny' in collectorReport && String(collectorReport.deny)).toMatch(/write only under .*\.context\/evidence/)
    const nested = await $.tool.call({ tool: 'Agent', prompt: 'Items: errors.', description: 'x', subagent_type: 'dacapo:qa-collector', agentId: 'agent-4' } as never)
    expect('deny' in nested && String(nested.deny)).toMatch(/collectors never start agents/)
    // a collector ending in error is not QA ending: the round goes on, its slot frees, and the run records the failure as it does for a worker
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/start one again on the same slice, once/)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'tc', agentId: 'agent-4', reason: 'error' })
    await clock.advance(1_000)
    expect(prompts.some(p => /QA round 1 of "qa":/.test(p))).toBe(false)
    const afterFailed = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterFailed && afterFailed.result).toMatch(/QA round 1 \(qa\) \[agent-2\] running \([^)]*1 collector ended, 1 failed\)/)
    // QA runs the slice again; the second collector reports with gaps, which QA walks itself
    const secondCollector = await $.tool.call({ tool: 'Agent', prompt: 'Items: login, again. Same fixture account.', description: 'login slice again', subagent_type: 'dacapo:qa-collector', agentId: 'agent-2' } as never)
    expect('result' in secondCollector).toBe(true)
    const withTwo = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in withTwo && withTwo.result).toMatch(/1 of 2 collectors live, 1 failed/)
    await $.turn.complete({ answer: 'login: entered the fixture account, saw the dashboard.\n\nNot covered: the lockout after five tries, the server rate-limits the shared account.\n\ndacapo: collected with gaps', durationMs: 1, isAborted: false, turnId: 'tc2', agentId: 'agent-5', reason: 'answer' })
    await clock.advance(1_000)
    const afterCollector = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterCollector && afterCollector.result).toMatch(/QA round 1 \(qa\) \[agent-2\] running \([^)]*2 collectors ended, 1 failed, 1 with gaps\)/)

    files.set(reportPath, JSON.stringify({ items: [{ id: 'login', score: 'strong', note: 'ok' }, { id: 'copy', score: 'unacceptable', note: 'says "error"' }], overview: 'Login works; the error copy needs words.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-2', reason: 'answer' })
    await clock.advance(1_000)
    const wakeQa = prompts.find(p => /QA round 1 of "qa":/.test(p))
    expect(wakeQa).toMatch(/1 strong, 0 acceptable, 1 unacceptable → verdict: fix/)
    expect(wakeQa).toMatch(/Login works; the error copy needs words\./)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/qa-1-1.json`)).toMatch(/"verdict": "fix"/)
    expect(wakeQa).toMatch(/Review round 1 of "reviewer" was stopped: the fix verdict of "qa" preempts it/)
    expect(wakeQa).toMatch(/Next: plan the fixes and call mcp__dacapo__dispatch/)
    const preempted = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in preempted && preempted.result).toMatch(/Review round 1 \(reviewer\) \[agent-3\] cancelled/)
    expect('result' in preempted && preempted.result).toMatch(/loop core-wide/)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /QA round 1: fix needed/ })).toBeDefined()
      expect(await ui.find({ text: /error copy needs words/ })).toBeUndefined()
      await ui.press({ plugin: 'dacapo', key: 'qa-agent-2' })
      expect(await ui.find({ text: /→ fix needed/ })).toBeDefined()
      expect(await ui.find({ text: /QA \(1\)/ })).toBeDefined()
      expect(await ui.find({ text: /error copy needs words/ })).toBeDefined()
      await ui.press({ plugin: 'dacapo', key: 'qa-agent-2' })
      expect(await ui.find({ text: /error copy needs words/ })).toBeUndefined()
      expect(await ui.find({ text: /^Loop$/ })).toBeDefined()
      expect(await ui.find({ text: /^core-wide · user/ })).toBeDefined()
      await ui.unmount()
    }

    // the reviewer reads the run's change and scores the engineering rubric; it reads source, writes only its report
    const review = await $.tool.call({
      tool: 'mcp__dacapo__judge',
      node: 'reviewer',
      rubric: [{ id: 'errors', title: 'Errors are raised and shown the way the codebase already does', category: 'consistency' }, { id: 'dead', title: 'No dead code or leftover scaffolding', category: 'cleanup' }],
      brief: 'The briefs pointed both tasks at the existing form components.',
    } as never)
    expect('result' in review && review.result).toMatch(/Review round 2 of "reviewer" prepared/)
    expect('result' in review && review.result).toMatch(/subagent_type: "dacapo:reviewer".*prompt: "dacapo judge reviewer 1-2"/)
    expect(files.get('/repo/.workspaces/reviewer/1-2/.context/reviewer-brief.md')).toMatch(/git diff origin\/main\.\.\.HEAD/)
    expect(files.get('/repo/.workspaces/reviewer/1-2/.context/reviewer-brief.md')).toMatch(/existing form components/)
    const startedReview = await startAgent('dacapo judge reviewer 1-2')
    expect('result' in startedReview).toBe(true)
    expect(agentCalls[5]?.subagent_type).toBe('dacapo:reviewer')
    const reviewerReads = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/reviewer/1-2/src/login.ts', agentId: 'agent-6' } as never)
    expect('result' in reviewerReads && reviewerReads.result).toBe('read')
    const reviewerEdits = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/reviewer/1-2/src/login.ts', content: 'x', agentId: 'agent-6' } as never)
    expect('deny' in reviewerEdits && typeof reviewerEdits.deny === 'string').toBe(true)
    const reviewReport = '/repo/.workspaces/reviewer/1-2/.context/reviewer-report.json'
    const reviewerWrites = await $.tool.call({ tool: 'Write', file_path: reviewReport, content: 'x', agentId: 'agent-6' } as never)
    expect('result' in reviewerWrites && reviewerWrites.result).toBe('written')
    files.set(reviewReport, JSON.stringify({ items: [{ id: 'errors', score: 'strong', note: 'uses the shared toast' }, { id: 'dead', score: 'strong', note: 'nothing left over' }], overview: 'Clean; the legacy form helper could be shared later.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't3', agentId: 'agent-6', reason: 'answer' })
    await clock.advance(1_000)
    const wakeReview = prompts.find(p => /Review round 2 of "reviewer":/.test(p))
    expect(wakeReview).toMatch(/2 strong, 0 acceptable, 0 unacceptable → verdict: pass/)
    expect(wakeReview).toMatch(/Overview from "reviewer":/)
    // QA asked for fixes on this round, so the review's pass does not send the run to finish yet
    expect(wakeReview).toMatch(/QA round 1 of "qa" asked for fixes this round: .*call mcp__dacapo__dispatch/)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/reviewer-1-2.json`)).toMatch(/"verdict": "pass"/)
    const afterReview = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterReview && afterReview.result).toMatch(/Review round 2 \(reviewer\) \[agent-6\] finished .*2 strong/)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dacapo', surface, ...PANE })
      expect(await ui.find({ text: /Review \(2\)/ })).toBeDefined()
      expect(await ui.find({ text: /Review round 2: pass/ })).toBeDefined()
      await ui.unmount()
    }

    // a second dispatch starts round 2; resuming a task reuses its branch and names its pull request
    const again = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      tasks: [{ id: 'login', title: 'Fix error copy', prompt: 'Explain errors.', model: 'sonnet', commit: 'fix: explain login errors', resume: true }],
    } as never)
    expect('result' in again && again.result).toMatch(/Round 2/)
    expect('result' in again && again.result).toMatch(new RegExp(`login: ${WORK} at /repo/.workspaces/${WORK} \\(sonnet, resumed\\)`))
    expect(files.get(`/repo/.workspaces/${WORK}/.context/brief.md`)).toMatch(/already holds the commits of an earlier worker.*pull request #3 \(merged\)/)
    await startAgent('dacapo worker login')
    const ui = await $.ui.mount({ plugin: 'dacapo', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /Fix error copy/ })).toBeDefined()
    expect(await ui.find({ text: /Login page/ })).toBeDefined()
    await ui.unmount()

    // a silent worker is marked stale after 30 minutes and the orchestrator is told; activity clears it
    await clock.advance(31 * 60_000)
    expect(prompts.some(p => /Worker login \[agent-7\] looks stale/.test(p))).toBe(true)
    const stale = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in stale && stale.result).toMatch(/login \[agent-7\] stale/)
    await $.tool.call({ tool: 'Write', file_path: `/repo/.workspaces/${WORK}/a.ts`, content: 'x', agentId: 'agent-7' } as never)
    const back = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in back && back.result).toMatch(/login \[agent-7\] running/)

    // two idle hours stop it, distinct from a failure; the wake-up lists the options
    await clock.advance(2 * 60 * 60_000 + 1_000)
    const timed = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in timed && timed.result).toMatch(/login \[agent-7\] timed out/)
    expect(prompts.some(p => /Worker login \[agent-7\] timed out/.test(p))).toBe(true)
    expect(prompts.some(p => /Round 2: all 1 worker\(s\) have ended/.test(p) && /resume it: dispatch the same task id with resume: true/.test(p))).toBe(true)

    // the end: a final pull request from the run branch into main, merged by the run once green
    const noTitle = await $.tool.call({ tool: 'mcp__dacapo__finish' } as never)
    expect('isError' in noTitle && noTitle.isError).toBe(true)
    const tainted = await $.tool.call({ tool: 'mcp__dacapo__finish', title: 'feat: add a login page', body: 'Adds login.\n\nCo-Authored-By: someone' } as never)
    expect('isError' in tainted && tainted.isError).toBe(true)
    expect('result' in tainted && tainted.result).toMatch(/dacapo:rules-prs/)
    const finished = await $.tool.call({ tool: 'mcp__dacapo__finish', title: 'feat: add a login page', body: 'Users can log in with email and password.\n\nVerified: npm run build, npm test' } as never)
    expect('result' in finished && finished.result).toMatch(/Final pull request #9 opened: https:\/\/github.com\/x\/y\/pull\/9/)
    expect(ghCalls.some(c => c[1] === 'pr' && c[2] === 'create' && c.includes('--base') && c.includes('main') && c.includes('--head') && c.includes(RUN))).toBe(true)
    const stillBlocked = await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })
    expect('deny' in stillBlocked && typeof stillBlocked.deny === 'string').toBe(true)
    // failing checks wake the orchestrator instead of merging
    prList.push(finalPr(RED))
    await clock.advance(21_000)
    expect(prompts.some(p => /final pull request #9 has failing checks/.test(p))).toBe(true)
    expect(ghCalls.some(c => c[1] === 'pr' && c[2] === 'merge')).toBe(false)
    // green and mergeable: merged with a merge commit titled as planned, then everything is pruned
    prList[1] = finalPr(GREEN)
    await clock.advance(21_000)
    const mergeCall = ghCalls.find(c => c[1] === 'pr' && c[2] === 'merge')
    expect(mergeCall).toBeDefined()
    expect(mergeCall).toContain('--merge')
    expect(mergeCall).toContain('feat: add a login page')
    expect(prompts.some(p => /Merged into main: pull request #9 "feat: add a login page"/.test(p))).toBe(true)
    const after = await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })
    expect('result' in after && after.result).toBe('written')
    const done = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in done && done.result).toMatch(/: done, /)
    expect('result' in done && done.result).toMatch(/Final PR #9 .*: merged/)
  })

  test('with rules skills of the user\'s own, workers are told to load them and the mod checks neither titles nor attribution', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 10, 12, 0, 0) })
    mock.env(on, { HOME: '/home/u' })
    const files = new Map<string, string>()
    files.set('/repo/.dacapo.conf', 'commits-skill = /my-commits\nprs-skill = team:pull-requests\nbase-branch = develop\n')
    listFs(on, files)
    const ghCalls: string[][] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__dacapo__${e.name}` } }))
    on('agent.register', (_, e) => ({ value: { agent: `dacapo:${e.name}` } }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => ({ value: fileAt(files, e.path) ?? '' }))
    on('fs.exists', (_, e) => ({ value: existsAt(files, e.path) || e.path.startsWith('/repo/.workspaces/') }))
    on('process.run', (_, e) => {
      const argv = e.argv
      const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (argv[0]?.endsWith('gh')) {
        ghCalls.push([...argv.map(String)])
        if (argv[1] === '--version') return out('gh version 2.80.0\n')
        if (argv[1] === 'auth') return out('Logged in to github.com\n')
        if (argv[1] === 'repo') return out(JSON.stringify({ nameWithOwner: 'x/y', url: 'https://github.com/x/y' }))
        if (argv[1] === 'pr' && argv[2] === 'list') return out('[]')
        if (argv[1] === 'pr' && argv[2] === 'create') return out('https://github.com/x/y/pull/4\n')
        return out('')
      }
      if (argv[1] === 'rev-parse' && argv[2] === '--show-toplevel') return out('/repo\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--path-format=absolute') return out('/repo/.git\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--verify') return String(argv[4]) === 'refs/heads/main' ? out('abc\n') : out('', 1)
      if (argv[1] === 'ls-remote') return out('')
      if (argv[1] === 'worktree' && argv[2] === 'list') return out('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n')
      if (argv[1] === 'rev-list') return out('2\n')
      if (argv[1] === 'remote') return out('git@github.com:x/y.git\n')
      return out('')
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('turn.start', () => ({ turnId: 'wake' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core --loop core-fast add a login page', wait: false, origin: { kind: 'composer' } })
    const config = await $.tool.call({ tool: 'mcp__dacapo__config' } as never)
    expect('result' in config && config.result).toMatch(/commits-skill = my-commits  \(\/repo\/.dacapo.conf\)/)
    expect('result' in config && config.result).toMatch(/prs-skill = team:pull-requests  \(\/repo\/.dacapo.conf\)/)
    expect('result' in config && config.result).toMatch(/base-branch = develop  \(\/repo\/.dacapo.conf\)/)
    // the configured base branch is the one the run is cut from when start names none
    const started = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a login page' } as never)
    expect('result' in started && started.result).toMatch(/rules: commits follow the my-commits skill, pull requests the team:pull-requests skill/)
    expect('result' in started && started.result).toMatch(/run branch "add-a-login-page" cut from origin\/develop/)
    // a commit title the shipped skill would refuse is the user's business now
    const dispatched = await $.tool.call({
      tool: 'mcp__dacapo__dispatch',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build the login page.', model: 'opus', commit: '[JIRA-12] Login page' }],
    } as never)
    expect('result' in dispatched && dispatched.result).toMatch(/prompt: "dacapo worker login"/)
    const brief = files.get('/repo/.workspaces/add-a-login-page--login/.context/brief.md') ?? ''
    expect(brief).toMatch(/Commit rules: the `my-commits` skill\. Load it with the Skill tool/)
    expect(brief).toMatch(/Pull request rules: the `team:pull-requests` skill\. Load it with the Skill tool/)
    const empty = await $.tool.call({ tool: 'mcp__dacapo__dispatch', tasks: [{ id: 'x', title: 'X', prompt: 'Build it.', model: 'opus', commit: '' }] } as never)
    expect('isError' in empty && empty.isError).toBe(true)
    // so are the final title and an attribution line in the body
    const cancelled = await $.tool.call({ tool: 'mcp__dacapo__cancel', agentId: 'pending-worker-1-login', reason: 'not needed' } as never)
    expect('result' in cancelled && cancelled.result).toMatch(/cancel/i)
    const finished = await $.tool.call({ tool: 'mcp__dacapo__finish', title: '[JIRA-12] Login page', body: 'Adds login.\n\nSigned-off-by: someone' } as never)
    expect('result' in finished && finished.result).toMatch(/Final pull request #4 opened/)
    expect(ghCalls.some(c => c[1] === 'pr' && c[2] === 'create' && c.includes('[JIRA-12] Login page'))).toBe(true)
    // and the final pull request goes into it
    const create = ghCalls.find(c => c[1] === 'pr' && c[2] === 'create') ?? []
    expect(create[create.indexOf('--base') + 1]).toBe('develop')
  })
})

/** A node file as a loop folder holds it. */
const nodeFile = (front: string, role: string) => `---\n${front.trim()}\n---\n\n${role}\n`

/**
 * A repository at /repo on GitHub as x/y with gh logged in, the shipped loops under the plugin's root and `files`
 * beside them; returns the agent types, tools and Agent calls the plugin made.
 */
function repoHarness(on: On, files: Map<string, string>, env: Record<string, string> = {}) {
  const registered: Array<{ name: string; prompt: string; skills?: readonly string[]; disallowedTools?: readonly string[]; omitClaudeMd?: boolean }> = []
  const tools: string[] = []
  const agentCalls: Array<Record<string, unknown>> = []
  const opened: string[] = []
  mock.clock(on, { now: Date.UTC(2026, 9, 10, 12, 0, 0) })
  mock.env(on, { HOME: '/home/u', ...env })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.register', (_, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__dacapo__${e.name}` } }
  })
  on('agent.register', (_, e) => {
    registered.push({ ...e })
    return { value: { agent: `dacapo:${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: fileAt(files, e.path) ?? '' }))
  on('fs.exists', (_, e) => ({ value: existsAt(files, e.path) || e.path.startsWith('/repo/.workspaces/') }))
  listFs(on, files)
  on('process.run', (_, e) => {
    const argv = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'rm' && argv[1] === '-rf') {
      const gone = String(argv[2])
      for (const path of [...files.keys()]) if (path === gone || path.startsWith(`${gone}/`)) files.delete(path)
      return out('')
    }
    if (argv[0]?.endsWith('gh')) {
      if (argv[1] === '--version') return out('gh version 2.80.0\n')
      if (argv[1] === 'auth') return out('Logged in to github.com\n')
      if (argv[1] === 'repo') return out(JSON.stringify({ nameWithOwner: 'x/y', url: 'https://github.com/x/y' }))
      if (argv[1] === 'pr' && argv[2] === 'list') return out('[]')
      return out('')
    }
    if (argv[1] === 'rev-parse' && argv[2] === '--show-toplevel') return out('/repo\n')
    if (argv[1] === 'rev-parse' && argv[2] === '--path-format=absolute') return out('/repo/.git\n')
    // only main exists locally, so every branch the run cuts is free
    if (argv[1] === 'rev-parse' && argv[2] === '--verify') return String(argv[4]) === 'refs/heads/main' ? out('abc\n') : out('', 1)
    if (argv[1] === 'ls-remote') return out('')
    if (argv[1] === 'worktree' && argv[2] === 'list') return out('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n')
    if (argv[1] === 'remote') return out('git@github.com:x/y.git\n')
    return out('')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    agentCalls.push({ ...e })
    return { result: { agentId: `agent-${agentCalls.length}`, content: [{ type: 'text' as const, text: `answer ${agentCalls.length}` }] } }
  })
  return { registered, tools, agentCalls, opened }
}

const resultOf = (r: unknown): string => String((r as { result?: unknown }).result ?? '')
const isRefused = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

describe('the active loop', () => {
  test('the shipped core registers its agents from its files: role and contract as the prompt, its skills and denials', async ($, on) => {
    const files = new Map<string, string>()
    const { registered, tools } = repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(registered.map(r => r.name).sort()).toEqual(['qa', 'qa-collector', 'worker'])
    const worker = registered.find(r => r.name === 'worker')!
    expect(worker.prompt).toMatch(/^You are a worker subagent in a dacapo run\./)
    expect(worker.prompt).toMatch(/Landing the work, in this order:[\s\S]*`dacapo: failed` \(not merged\)\.$/)
    expect(worker.skills).toEqual(['dacapo:rules-commits', 'dacapo:rules-prs'])
    expect(worker.disallowedTools).toEqual(['Agent', 'EnterWorktree', 'ExitWorktree'])
    expect(worker.omitClaudeMd).toBeUndefined()
    const qa = registered.find(r => r.name === 'qa')!
    expect(qa.prompt).toMatch(/^You are the QA subagent in a dacapo run\./)
    expect(qa.prompt).toMatch(/each in one of the categories core, ui-ux[\s\S]*Only the report file is read/)
    expect(qa.omitClaudeMd).toBe(true)
    const collector = registered.find(r => r.name === 'qa-collector')!
    expect(collector.prompt).toMatch(/Your final message is read by QA\.[\s\S]*`dacapo: failed` \(nothing usable was gathered\)\.$/)
    expect(collector.omitClaudeMd).toBe(true)
    // the loop's tools replace the level's: stage, judge and ask in, phase, qa and review out
    expect(tools).toEqual(expect.arrayContaining(['config', 'start', 'stage', 'dispatch', 'judge', 'ask', 'finish', 'sync', 'cancel', 'status']))
    for (const gone of ['phase', 'qa', 'review']) expect(tools).not.toContain(gone)
    // the project's loops stay out of git
    expect(files.get('/repo/.git/info/exclude')).toMatch(/^\.claude\/dacapo\/$/m)
  })

  test('start refuses an unknown loop and names the loops there are', async ($, on) => {
    const files = new Map<string, string>()
    repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core add a page', wait: false, origin: { kind: 'composer' } })
    const refused = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.', loop: 'nope' } as never)
    expect(isRefused(refused)).toBe(true)
    expect(resultOf(refused)).toMatch(/there is no loop "nope"; the loops available: core, core-deep, core-fast/)
  })

  test('stage, dispatch and judge hold the orchestrator to the loop: its stages, its node\'s models and categories; status names the loop', async ($, on) => {
    const files = new Map<string, string>()
    repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core add a page', wait: false, origin: { kind: 'composer' } })
    const opened = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect(resultOf(opened)).toMatch(/loop core \(plugin\), stage clarify/)
    const unknown = await $.tool.call({ tool: 'mcp__dacapo__stage', stage: 'review' } as never)
    expect(isRefused(unknown)).toBe(true)
    expect(resultOf(unknown)).toMatch(/"review" is not a stage of the loop "core"; its stages: clarify, research, plan, implement, qa, merge/)
    const research = await $.tool.call({ tool: 'mcp__dacapo__stage', stage: 'research' } as never)
    expect(resultOf(research)).toBe('Stage: research.')
    const started = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.' } as never)
    expect(resultOf(started)).toMatch(/loop core \(plugin\): clarify → research → plan → implement → qa → merge/)
    const planning = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect(resultOf(planning)).toMatch(/loop core \(plugin\), stage plan/)
    const haiku = await $.tool.call({ tool: 'mcp__dacapo__dispatch', tasks: [{ id: 'page', title: 'Page', prompt: 'Build it.', model: 'haiku', commit: 'feat: add a page' }] } as never)
    expect(isRefused(haiku)).toBe(true)
    expect(resultOf(haiku)).toMatch(/model must be one of opus, sonnet \(the models of the node "worker"/)
    const notLands = await $.tool.call({ tool: 'mcp__dacapo__dispatch', node: 'qa', tasks: [{ id: 'page', title: 'Page', prompt: 'Build it.', model: 'opus', commit: 'feat: add a page' }] } as never)
    expect(resultOf(notLands)).toMatch(/"qa" is not a lands node of the loop "core"; its lands nodes: worker/)
    const dispatched = await $.tool.call({ tool: 'mcp__dacapo__dispatch', tasks: [{ id: 'page', title: 'Page', prompt: 'Build it.', model: 'opus', commit: 'feat: add a page' }] } as never)
    expect(resultOf(dispatched)).toMatch(/subagent_type: "dacapo:worker".*prompt: "dacapo worker page"/)
    expect(resultOf(await $.tool.call({ tool: 'mcp__dacapo__status' } as never))).toMatch(/loop core \(plugin\), stage implement/)
    await $.tool.call({ tool: 'mcp__dacapo__cancel', agentId: 'pending-worker-1-page' } as never)
    const quality = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'qa', rubric: [{ id: 'clean', title: 'No dead code', category: 'quality' }], harness: 'Open the page.' } as never)
    expect(isRefused(quality)).toBe(true)
    expect(resultOf(quality)).toMatch(/category must be one of "core", "ui-ux"/)
    const sonnetOnly = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'qa', rubric: [{ id: 'page', title: 'The page opens', category: 'core' }], harness: 'Open the page.', model: 'fable' } as never)
    expect(resultOf(sonnetOnly)).toMatch(/"model" must be one of opus, sonnet/)
    const judged = await $.tool.call({ tool: 'mcp__dacapo__judge', node: 'qa', rubric: [{ id: 'page', title: 'The page opens', category: 'core' }], harness: 'Open the page.' } as never)
    expect(resultOf(judged)).toMatch(/prompt: "dacapo judge qa 1-1"/)
    expect(resultOf(await $.tool.call({ tool: 'mcp__dacapo__status' } as never))).toMatch(/loop core \(plugin\), stage qa\n/)
  })

  test('ask runs a node on call in the foreground in the run worktree, and its answer is the Agent result', async ($, on) => {
    const files = new Map<string, string>()
    const root = '/home/u/.claude/dacapo/loops/core-plus'
    const core = JSON.parse(SHIPPED_LOOP_FILES['core/loop.json']!) as Record<string, unknown>
    files.set(`${root}/loop.json`, JSON.stringify({ ...core, name: 'core-plus', onCall: { scout: [] } }))
    for (const [rel, text] of Object.entries(SHIPPED_LOOP_FILES)) if (rel.startsWith('core/nodes/')) files.set(`${root}/${rel.slice('core/'.length)}`, text)
    files.set(`${root}/nodes/scout.md`, nodeFile('type: agent\nsummary: reads the docs\ncontract: none\nmodels: [sonnet]\nskills: []\ntools: { deny: [Edit] }', 'You read documentation and answer in a paragraph.'))
    const { registered, agentCalls } = repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core --loop core-plus add a page', wait: false, origin: { kind: 'composer' } })
    expect(registered.find(r => r.name === 'scout')?.prompt).toBe('You read documentation and answer in a paragraph.')
    const notAskable = await $.tool.call({ tool: 'mcp__dacapo__ask', node: 'worker', prompt: 'hi' } as never)
    expect(resultOf(notAskable)).toMatch(/those nodes: scout/)
    await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.' } as never)
    const asked = await $.tool.call({ tool: 'mcp__dacapo__ask', node: 'scout', prompt: 'Which router does the docs site use?' } as never)
    expect(resultOf(asked)).toMatch(/subagent_type: "dacapo:scout".*prompt: "dacapo ask scout 1"/)
    const ran = await $.tool.call({ tool: 'Agent', prompt: 'dacapo ask scout 1', description: 'scout', subagent_type: 'dacapo:scout' })
    expect(resultOf(ran)).toBeDefined()
    const call = agentCalls[0]!
    expect(call.run_in_background).toBe(false)
    expect(call.model).toBe('sonnet')
    expect(String(call.prompt)).toBe('[dacapo worktree: /repo/.workspaces/add-a-page]\n\nWhich router does the docs site use?')
    const status = resultOf(await $.tool.call({ tool: 'mcp__dacapo__status' } as never))
    expect(status).toMatch(/ask scout \[agent-1\] finished \([^)]*sonnet\): answer 1/)
    // an asked node is no worker of the round: the first dispatch is still round 1
    const dispatched = await $.tool.call({ tool: 'mcp__dacapo__dispatch', tasks: [{ id: 'page', title: 'Page', prompt: 'Build it.', model: 'opus', commit: 'feat: add a page' }] } as never)
    expect(resultOf(dispatched)).toMatch(/^Round 1:/)
  })

  test('a loop whose node shares an id but not a role with the session\'s agents is refused; a broken loop leaves the tools working', async ($, on) => {
    const files = new Map<string, string>()
    const odd = '/home/u/.claude/dacapo/loops/odd'
    files.set(`${odd}/loop.json`, SHIPPED_LOOP_FILES['core-fast/loop.json']!.replace('"name": "core-fast"', '"name": "odd"'))
    for (const [rel, text] of Object.entries(SHIPPED_LOOP_FILES)) if (rel.startsWith('core-fast/nodes/')) files.set(`${odd}/${rel.slice('core-fast/'.length)}`, rel.endsWith('worker.md') ? text.replace('You are a worker subagent', 'You are an odd worker') : text)
    files.set('/home/u/.claude/dacapo/loops/broken/loop.json', '{ not json')
    repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core add a page', wait: false, origin: { kind: 'composer' } })
    const clash = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.', loop: 'odd' } as never)
    expect(isRefused(clash)).toBe(true)
    expect(resultOf(clash)).toMatch(/dacapo:worker is registered in this session by the loop "core" with a different role[\s\S]*begin a new session with `\/dacapo:core --loop odd <task>`/)
    const broken = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.', loop: 'broken' } as never)
    expect(resultOf(broken)).toMatch(/the loop "broken" \(user, .*\) cannot run:\n- loop\.json: loop\.json is not JSON/)
  })

  test('a configured loop that cannot load leaves the mod usable: config and start say why', async ($, on) => {
    const files = new Map<string, string>()
    files.set('/home/u/.claude/dacapo.conf', 'loop = missing\n')
    const { registered, tools } = repoHarness(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([])
    expect(tools).toContain('start')
    const config = resultOf(await $.tool.call({ tool: 'mcp__dacapo__config' } as never))
    expect(config).toMatch(/loop = missing  \(\/home\/u\/.claude\/dacapo.conf\)/)
    expect(config).toMatch(/Loop: "missing" cannot be used: there is no loop "missing"; the loops available: core, core-deep, core-fast/)
    await $.prompt.submit({ text: '/dacapo:core add a page', wait: false, origin: { kind: 'composer' } })
    const refused = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.' } as never)
    expect(resultOf(refused)).toMatch(/there is no loop "missing"/)
    const named = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Add a page', overview: 'A page.', loop: 'core-fast' } as never)
    expect(resultOf(named)).toMatch(/loop core-fast \(plugin\)/)
    expect(registered.map(r => r.name)).toEqual(['worker'])
  })
})

/** The loops pane as a surface mounts it. */
const LOOPS = {
  plugin: 'dacapo',
  component: 'Pane' as const,
  requestId: 'dacapo-loops',
  props: { title: 'Loops', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}
/** The dacapo plugin's own store, in memory, so a test reads what the mod kept and seeds the next session. */
function storeOf(on: On): Map<string, unknown> {
  const held = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    held.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))
  return held
}
const call = ($: { tool: { call: (e: never) => Promise<unknown> } }, tool: string, args: Record<string, unknown> = {}) => $.tool.call({ tool: `mcp__dacapo__${tool}`, ...args } as never)
/** Lets the pane's button handlers, which run unawaited, finish their file work. */
async function settle(until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i++) await Promise.resolve()
}

describe('the loop viewer and the architect', () => {
  const HOME = '/home/u/dh'
  const SECURITY = [
    { op: 'stage.add', id: 'security', summary: 'checks for holes', alongside: 'qa' },
    { op: 'node.add', id: 'security', type: 'agent', contract: 'scores', summary: 'reviews for risk', stage: 'security', models: ['opus'], categories: ['quality', 'risk'] },
    { op: 'node.role', id: 'security', text: 'You review the change for security holes.\n\nGround rules:\n- You never change the code.' },
  ]

  test('design opens the library; edits make a draft; save refuses the plugin loop and writes a copy; discard, default, buttons and the next session', async ($, on) => {
    const files = new Map<string, string>()
    const { opened } = repoHarness(on, files, { DACAPO_HOME: HOME })
    const store = storeOf(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(opened).not.toContain('dacapo-loops')

    // the entry: /dacapo:design opens the loops pane before the turn
    await $.prompt.submit({ text: '/dacapo:design', wait: false, origin: { kind: 'composer' } })
    expect(opened).toContain('dacapo-loops')

    const list = resultOf(await call($, 'loops', { action: 'list' }))
    expect(list).toMatch(/^3 loops\. Runs use core by default\./)
    expect(list).toMatch(/^core \(plugin\) · .+ · 6 stages in 6 steps · 5 nodes · \d+ edges · \S+\/loops\/core \[default\]$/m)
    expect(list).toMatch(/^core-deep \(plugin\) · /m)
    expect(list).toMatch(/^core-fast \(plugin\) · /m)
    expect(list).toMatch(/Roots: plugin \S+\/loops \(read-only\) · user \/home\/u\/dh\/loops · project \/repo\/\.claude\/dacapo\/loops · drafts \/home\/u\/dh\/drafts$/)

    const core = resultOf(await call($, 'loops', { action: 'open', name: 'core' }))
    expect(core).toMatch(/^Loop core \(plugin\) at \S+\/loops\/core\n/)
    expect(core).toMatch(/No draft: this is the saved loop\./)
    expect(core).toMatch(/Entry orchestrator, its whole role:\nYou are/)
    expect(core).toMatch(/\nNodes:\n- orchestrator: talks to you\. entry; contract none; the entry; skills dacapo:loop\.\n/)
    expect(core).toMatch(/^- worker: builds one task\. swarm; contract lands; in stage implement; models opus, sonnet; skills dacapo:rules-commits, dacapo:rules-prs; .*Role: You are a worker/m)
    expect(core).toMatch(/^- qa: judges as the user\. agent; contract scores; in stage qa; .*categories core, ui-ux/m)
    expect(core).toMatch(/\nTransitions:\n- /)
    expect(core).toMatch(/\nHandovers:\n- /)

    // a batch of draft ops opens the draft under DACAPO_HOME and writes the four kinds of file
    const edited = await call($, 'loop_edit', { ops: SECURITY })
    expect(isRefused(edited)).toBe(false)
    expect(resultOf(edited)).toBe(
      [
        'Changed in the draft of core (plugin):',
        '- added stage security alongside qa',
        '- added agent security (scores) in stage security',
        '- rewrote the role of security',
        'The draft holds 1 change. The draft is not saved: press Save in the pane or say "save".',
        'This is a plugin loop, so save is refused: copy it with loop.new to keep edits in a loop of your own.',
        'The viewer shows stage security.',
      ].join('\n'),
    )
    const draft = `${HOME}/drafts/plugin--core`
    for (const f of ['loop.json', 'nodes/security.md', 'nodes/worker.md', 'LOOP.md', 'draft.json']) expect(files.has(`${draft}/${f}`)).toBe(true)
    expect(JSON.parse(files.get(`${draft}/draft.json`)!).changes).toEqual(['added stage security alongside qa; added agent security (scores) in stage security; rewrote the role of security'])
    expect(files.get(`${draft}/nodes/security.md`)).toMatch(/^---\ntype: agent\nsummary: reviews for risk\ncontract: scores\nmodels: \[opus\][\s\S]*categories: \[quality, risk\][\s\S]*You review the change for security holes\./)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...LOOPS, surface })
      expect(await ui.find({ text: /^ DRAFT $/ })).toBeDefined()
      expect(await ui.find({ text: / 1 change · since / })).toBeDefined()
      expect(await ui.find({ key: 'focus-stage-security' })).toBeDefined()
      expect(await ui.find({ key: 'focus-node-security' })).toBeDefined()
      await ui.unmount()
    }
    // a draft that comes back on open says DRAFT with its changes
    expect(resultOf(await call($, 'loops', { action: 'open', name: 'core' }))).toMatch(/\nDRAFT: 1 change, kept in \/home\/u\/dh\/drafts\/plugin--core\n- added stage security alongside qa; /)
    const focused = resultOf(await call($, 'loops', { action: 'focus', target: 'node:security' }))
    expect(focused).toMatch(/^security · agent · security\n/)
    expect(focused).toMatch(/The whole role of security:\nYou review the change for security holes\.\n\nGround rules:/)
    expect(isRefused(await call($, 'loops', { action: 'focus', target: 'nope' }))).toBe(true)
    expect(resultOf(await call($, 'loops', { action: 'fold' }))).toBe('The on-call section is folded.')

    // a bad op is named by its index, and nothing is written
    const before = new Map(files)
    const bad = await call($, 'loop_edit', { ops: [{ op: 'stage.add', id: 'lint', summary: 'runs the linter' }, { op: 'stage.add', id: 'x' }] })
    expect(isRefused(bad)).toBe(true)
    expect(resultOf(bad)).toBe('Refused op 1 (stage.add): stage.add needs "summary", a string. Nothing was written.')
    const broken = await call($, 'loop_edit', { ops: [{ op: 'node.add', id: 'judge', type: 'agent', contract: 'scores', summary: 'judges', stage: 'qa', models: ['opus'] }] })
    expect(resultOf(broken)).toBe('Refused: after the last op the loop breaks these rules.\n- nodes.judge.categories: a scores node needs categories: the rubric categories it accepts\nNothing was written.')
    const mixed = await call($, 'loop_edit', { ops: [{ op: 'loop.new', name: 'x', level: 'user' }, { op: 'loop.describe', description: 'x' }] })
    expect(resultOf(mixed)).toMatch(/go in a batch of their own/)
    expect(files).toEqual(before)

    // the plugin loop is never saved
    const refused = await call($, 'loop_save')
    expect(isRefused(refused)).toBe(true)
    expect(resultOf(refused)).toMatch(/^Not saved: the plugin's loops are read-only; copy it to user or project first\. Copy it with loop\.new/)

    // a copy at the user level, saved
    const made = await call($, 'loop_edit', { ops: [{ op: 'loop.new', name: 'mine', level: 'user', from: { name: 'core', level: 'plugin' } }] })
    expect(resultOf(made)).toMatch(/^Started loop mine \(user\) as a draft: a copy of core \(plugin\); the original stays as it was\./)
    expect(files.has(`${HOME}/drafts/user--mine/draft.json`)).toBe(true)
    expect(files.has(`${HOME}/loops/mine/loop.json`)).toBe(false)
    const saved = await call($, 'loop_save')
    expect(isRefused(saved)).toBe(false)
    expect(resultOf(saved)).toMatch(/^Saved mine \(user\) to \/home\/u\/dh\/loops\/mine\. The draft is cleared\.\nFiles:\n/)
    expect(resultOf(saved)).toMatch(/Run it with \/dacapo:core --loop mine <task>\.$/)
    for (const f of ['loop.json', 'nodes/worker.md', 'nodes/qa.md', 'loop.d2', 'LOOP.md']) expect(files.has(`${HOME}/loops/mine/${f}`)).toBe(true)
    expect(JSON.parse(files.get(`${HOME}/loops/mine/loop.json`)!).name).toBe('mine')
    expect([...files.keys()].some(k => k.startsWith(`${HOME}/drafts/user--mine/`))).toBe(false)
    expect(store.get('viewer.last')).toEqual({ name: 'mine', level: 'user', view: { folded: false, tab: 'canvas' } })

    // discard drops the draft and shows the saved loop
    await call($, 'loop_edit', { ops: [{ op: 'loop.describe', description: 'My loop.' }] })
    expect(files.has(`${HOME}/drafts/user--mine/draft.json`)).toBe(true)
    expect(resultOf(await call($, 'loop_discard'))).toBe('Discarded the draft of mine (user). The viewer shows the saved loop again.')
    expect([...files.keys()].some(k => k.startsWith(`${HOME}/drafts/user--mine/`))).toBe(false)

    // the default for runs goes into the user's conf
    expect(resultOf(await call($, 'loop_edit', { ops: [{ op: 'loop.default', name: 'mine' }] }))).toMatch(/^Wrote loop = mine to \/home\/u\/\.claude\/dacapo\.conf\./)
    expect(files.get('/home/u/.claude/dacapo.conf')).toBe('loop = mine\n')
    expect(resultOf(await call($, 'loops', { action: 'list' }))).toMatch(/^mine \(user\) · .* \[default\]$/m)

    // the pane's Save button saves through the same path
    await call($, 'loops', { action: 'open', name: 'mine' })
    await call($, 'loop_edit', { ops: [{ op: 'loop.describe', description: 'Saved from the pane.' }] })
    const ui = await $.ui.mount({ ...LOOPS, surface: 'desktop' })
    await ui.press({ plugin: 'dacapo', key: 'save' })
    await settle(() => !files.has(`${HOME}/drafts/user--mine/draft.json`))
    await ui.unmount()
    expect(files.has(`${HOME}/drafts/user--mine/draft.json`)).toBe(false)
    expect(JSON.parse(files.get(`${HOME}/loops/mine/loop.json`)!).description).toBe('Saved from the pane.')

    // the next session reopens the viewer on the loop open last
    await call($, 'loops', { action: 'list' })
    opened.length = 0
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(opened).toContain('dacapo-loops')
    const again = await $.ui.mount({ ...LOOPS, surface: 'terminal' })
    expect(await again.find({ text: /^saved · \/home\/u\/dh\/loops\/mine$/ })).toBeDefined()
    await again.unmount()

    // delete takes the folder and goes back to the library
    const deleted = resultOf(await call($, 'loop_edit', { ops: [{ op: 'loop.delete', name: 'mine', level: 'user' }] }))
    expect(deleted).toMatch(/^Deleted mine \(user\): its folder and its draft are gone\.\n\n3 loops\./)
    expect([...files.keys()].some(k => k.startsWith(`${HOME}/loops/mine/`))).toBe(false)
    expect(store.has('viewer.last')).toBe(false)
  })

  test('a session whose last loop is gone opens nothing; the dacapo-loops command opens the library', async ($, on) => {
    const files = new Map<string, string>()
    const { opened } = repoHarness(on, files, { DACAPO_HOME: HOME })
    const store = storeOf(on)
    store.set('viewer.last', { name: 'gone', level: 'user', view: { folded: false, tab: 'canvas' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(opened).not.toContain('dacapo-loops')
    expect(await $.command.run({ command: 'dacapo-loops' } as never)).toEqual({ text: 'dacapo loops opened.' })
    expect(opened).toContain('dacapo-loops')
    const ui = await $.ui.mount({ ...LOOPS, surface: 'terminal' })
    expect(await ui.find({ text: /^Loops · 3 loops · default for runs: core \(plugin\)$/ })).toBeDefined()
    await ui.unmount()
  })
})
