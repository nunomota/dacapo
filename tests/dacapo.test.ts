import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { checksOf, parsePrs } from '../hooks/gh'
import { PHASES, PHASE_COLOR, STAGE_PALETTE, cut, drawBar, type Els, elapsed, phasesOf, rowsOf, stageColor, stepsOf } from '../hooks/pane'
import type { Run } from '../types'
import { DEFAULT_CONF, describeConf, loadConf, parseConf } from '../hooks/conf'
import { REVIEW_CATEGORIES, summarize, validateReport, validateRubric } from '../hooks/report'

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
      '# a comment\nlevel = deep\nworkers = fable, opus , sonnet  # trailing comment\njudges = sideways\nnope\ncolor = red\nprs-skill = /my-prs\ncommits-skill = a, b\ncommits-skill = Not A Skill\nbase-branch = release/2.0\nbase-branch = Not A Branch\nqa-collectors = 2\nqa-collectors = many\nqa-collectors = 9\n',
    )
    expect(parsed.values).toEqual({ level: ['deep'], workers: ['fable', 'opus', 'sonnet'], 'prs-skill': ['my-prs'], 'base-branch': ['release/2.0'], 'qa-collectors': ['2'] })
    expect(parsed.problems).toEqual([
      'line 4: "judges" must be one of sequential, parallel',
      'line 5: not "key = value": nope',
      'line 6: unknown key "color" (one of level, judges, workers, qa, review, commits-skill, prs-skill, base-branch, qa-collectors)',
      'line 8: "commits-skill" must be one skill name, like dacapo:rules-commits or my-rules',
      'line 9: "commits-skill" must be one skill name, like dacapo:rules-commits or my-rules',
      'line 11: "base-branch" must be one git branch name, like main or develop',
      'line 13: "qa-collectors" must be a whole number from 0 to 8',
      'line 14: "qa-collectors" must be a whole number from 0 to 8',
    ])
  })

  test('later files override earlier ones key by key, over the defaults, and each value names its file', () => {
    const loaded = loadConf([
      { path: '/plugin/dacapo.conf', text: 'level = balanced\nqa = opus, sonnet\n' },
      { path: '/home/u/.claude/dacapo.conf', text: 'qa = sonnet\njudges = parallel\ncommits-skill = other:rules\nbase-branch = develop\nqa-collectors = 0\n' },
      { path: '/repo/.dacapo.conf', text: null },
    ])
    expect(loaded.conf).toEqual({ ...DEFAULT_CONF, qa: ['sonnet'], judges: 'parallel', 'commits-skill': 'other:rules', 'base-branch': 'develop', 'qa-collectors': 0 })
    expect(loaded.origin['qa-collectors']).toBe('/home/u/.claude/dacapo.conf')
    expect(loaded.origin.qa).toBe('/home/u/.claude/dacapo.conf')
    expect(loaded.origin.workers).toBe('default')
    expect(loaded.origin['prs-skill']).toBe('default')
    expect(describeConf(loaded)).toMatch(/\ncommits-skill = other:rules  \(\/home\/u\/.claude\/dacapo.conf\)\nprs-skill = dacapo:rules-prs  \(default\)\nbase-branch = develop  \(\/home\/u\/.claude\/dacapo.conf\)\nqa-collectors = 0  \(\/home\/u\/.claude\/dacapo.conf\)\n/)
    expect(loaded.read).toEqual(['/plugin/dacapo.conf', '/home/u/.claude/dacapo.conf'])
    expect(describeConf(loaded)).toMatch(/^level = balanced  \(\/plugin\/dacapo.conf\)\n/)
    expect(describeConf(loadConf([]))).toMatch(/Files read: none; defaults\./)
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
  test('workers land through pull requests; sync, QA, resume, guards, stale marking and the final merge', async ($, on) => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0)
    const clock = mock.clock(on, { now: t0 })
    mock.env(on, { HOME: '/home/u' })
    const files = new Map<string, string>()
    // the user's conf: judges in parallel, QA on the fast tier first, one line the plugin does not know
    files.set('/home/u/.claude/dacapo.conf', '# mine\njudges = parallel\nqa = sonnet, opus  # fast first\nqa-collectors = 1\nbogus = 1\n')
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
    on('agent.register', (_, e) => ({ value: { agent: `dacapo:${e.name}` } }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
    on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith('/repo/.workspaces/') }))
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
      if (argv[1] === 'rev-parse' && argv[2] === '--balanced') return String(argv[4]) === 'refs/heads/main' ? out('abc\n') : out('', 1)
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
    // the level flag sets the level before the task is clear; a task that begins with "build" is just a task
    await $.prompt.submit({ text: '/dacapo:core --deep build a login page', wait: false, origin: { kind: 'composer' } })

    // without gh the run cannot start, and the orchestrator is told how to help
    const noGh = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('isError' in noGh && noGh.isError).toBe(true)
    expect('result' in noGh && noGh.result).toMatch(/brew install gh/)
    ghMissing = false
    const badLevel = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page', level: 'turbo' } as never)
    expect('isError' in badLevel && badLevel.isError).toBe(true)
    const started = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('result' in started && started.result).toMatch(/Run .* ready on x\/y/)
    expect('result' in started && started.result).toMatch(/level deep: QA as the end user and an engineering review side by side/)
    expect('result' in started && started.result).toMatch(/QA sonnet, opus; review opus, sonnet/)
    // the configuration in force, with where each value came from; agents never read the files
    const config = await $.tool.call({ tool: 'mcp__dacapo__config' } as never)
    expect('result' in config && config.result).toMatch(/level = balanced  \(default\)/)
    expect('result' in config && config.result).toMatch(/judges = parallel  \(\/home\/u\/.claude\/dacapo.conf\)/)
    expect('result' in config && config.result).toMatch(/qa = sonnet, opus/)
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
    // once set up, the level is fixed
    const relevel = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page', level: 'fast' } as never)
    expect('isError' in relevel && relevel.isError).toBe(true)
    // the reviewer runs after QA reported on the round, never before
    const early = await $.tool.call({ tool: 'mcp__dacapo__review', rubric: [{ id: 'style', title: 'Matches the codebase', category: 'consistency' }] } as never)
    expect('isError' in early && early.isError).toBe(true)
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
    expect('result' in pendingStatus && pendingStatus.result).toMatch(/level deep \(judges in parallel\), phase implement/)
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

    const qa = await $.tool.call({
      tool: 'mcp__dacapo__qa',
      rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }, { id: 'copy', title: 'Error copy is clear', category: 'ui-ux' }],
      harness: 'Run `npm start`, open http://localhost:3000/login, use user@example.com / secret.',
    } as never)
    expect('result' in qa && qa.result).toMatch(/prompt: "dacapo qa 1-1"/)
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/npm start/)
    const reportPath = '/repo/.workspaces/qa/1-1/.context/qa-report.json'
    const startedQa = await startAgent('dacapo qa 1-1')
    expect('result' in startedQa).toBe(true)
    expect(agentCalls[1]?.subagent_type).toBe('dacapo:qa')
    expect(agentCalls[1]?.model).toBe('sonnet')

    // judges in parallel: the review starts while QA runs, and a QA verdict of fix stops it
    expect('result' in qa && qa.result).toMatch(/judges run in parallel: call mcp__dacapo__review now/)
    const alongside = await $.tool.call({ tool: 'mcp__dacapo__review', rubric: [{ id: 'style', title: 'Matches the codebase', category: 'consistency' }] } as never)
    expect('result' in alongside && alongside.result).toMatch(/Review round 1 prepared/)
    await startAgent('dacapo review 1-1')
    expect(agentCalls[2]?.subagent_type).toBe('dacapo:reviewer')
    expect(agentCalls[2]?.model).toBe('opus')

    // QA may not read source, only its .context folder; and only writes its report
    const peek = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/src/login.ts', agentId: 'agent-2' } as never)
    expect('deny' in peek && typeof peek.deny === 'string').toBe(true)
    const qaBriefRead = await $.tool.call({ tool: 'Read', file_path: '.context/qa-brief.md', agentId: 'agent-2' } as never)
    expect('result' in qaBriefRead && qaBriefRead.result).toBe('read')
    const wrongWrite = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/qa/1-1/.context/notes.md', content: 'x', agentId: 'agent-2' } as never)
    expect('deny' in wrongWrite && typeof wrongWrite.deny === 'string').toBe(true)

    // QA may split the rubric among evidence collectors: only its own kind, as many at once as the conf allows, on the fast tier, bound like QA
    expect('result' in qa && qa.result).toMatch(/QA may start up to 1 dacapo:qa-collector agents/)
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/Up to 1 `dacapo:qa-collector` agent may run at once/)
    const notCollector = await $.tool.call({ tool: 'Agent', prompt: 'read the login code', description: 'x', subagent_type: 'dacapo:worker', agentId: 'agent-2' } as never)
    expect('deny' in notCollector && String(notCollector.deny)).toMatch(/only agent you may start is dacapo:qa-collector/)
    const collector = await $.tool.call({ tool: 'Agent', prompt: 'Items: login. Use the fixture account on the login page; the server is shared.', description: 'login slice', subagent_type: 'dacapo:qa-collector', model: 'fable', agentId: 'agent-2' } as never)
    expect('result' in collector).toBe(true)
    const spawned = agentCalls[agentCalls.length - 1]!
    expect(spawned.subagent_type).toBe('dacapo:qa-collector')
    expect(spawned.model).toBe('opus')
    expect(spawned.run_in_background).toBe(false)
    expect(String(spawned.prompt)).toMatch(/^\[dacapo worktree: \/repo\/.workspaces\/qa\/1-1\]/)
    expect(String(spawned.prompt)).toMatch(/qa-brief\.md[\s\S]*## Your slice, from QA[\s\S]*fixture account/)
    const oneAtATime = await $.tool.call({ tool: 'Agent', prompt: 'Items: errors.', description: 'errors slice', subagent_type: 'dacapo:qa-collector', agentId: 'agent-2' } as never)
    expect('deny' in oneAtATime && String(oneAtATime.deny)).toMatch(/1 collector may run at once/)
    const withCollector = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in withCollector && withCollector.result).toMatch(/QA round 1 \[agent-2\] running \([^)]*1 of 1 collectors live\)/)
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
    expect(prompts.some(p => /QA round 1:/.test(p))).toBe(false)
    const afterFailed = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterFailed && afterFailed.result).toMatch(/QA round 1 \[agent-2\] running \([^)]*1 collector ended, 1 failed\)/)
    // QA runs the slice again; the second collector reports with gaps, which QA walks itself
    const secondCollector = await $.tool.call({ tool: 'Agent', prompt: 'Items: login, again. Same fixture account.', description: 'login slice again', subagent_type: 'dacapo:qa-collector', agentId: 'agent-2' } as never)
    expect('result' in secondCollector).toBe(true)
    const withTwo = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in withTwo && withTwo.result).toMatch(/1 of 2 collectors live, 1 failed/)
    await $.turn.complete({ answer: 'login: entered the fixture account, saw the dashboard.\n\nNot covered: the lockout after five tries, the server rate-limits the shared account.\n\ndacapo: collected with gaps', durationMs: 1, isAborted: false, turnId: 'tc2', agentId: 'agent-5', reason: 'answer' })
    await clock.advance(1_000)
    const afterCollector = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterCollector && afterCollector.result).toMatch(/QA round 1 \[agent-2\] running \([^)]*2 collectors ended, 1 failed, 1 with gaps\)/)

    files.set(reportPath, JSON.stringify({ items: [{ id: 'login', score: 'strong', note: 'ok' }, { id: 'copy', score: 'unacceptable', note: 'says "error"' }], overview: 'Login works; the error copy needs words.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-2', reason: 'answer' })
    await clock.advance(1_000)
    const wakeQa = prompts.find(p => /QA round 1:/.test(p))
    expect(wakeQa).toMatch(/1 strong, 0 acceptable, 1 unacceptable → verdict: fix/)
    expect(wakeQa).toMatch(/Login works; the error copy needs words\./)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/qa-1-1.json`)).toMatch(/"verdict": "fix"/)
    expect(wakeQa).toMatch(/Review round 1 was stopped: QA's fix verdict preempts it/)
    const preempted = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in preempted && preempted.result).toMatch(/Review round 1 \[agent-3\] cancelled/)
    expect('result' in preempted && preempted.result).toMatch(/judges in parallel/)

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
      expect(await ui.find({ text: /^deep$/ })).toBeDefined()
      expect(await ui.find({ text: /QA, then engineering review/ })).toBeDefined()
      await ui.unmount()
    }

    // at level deep the reviewer reads the run's change and scores the engineering rubric; it reads source, writes only its report
    const review = await $.tool.call({
      tool: 'mcp__dacapo__review',
      rubric: [{ id: 'errors', title: 'Errors are raised and shown the way the codebase already does', category: 'consistency' }, { id: 'dead', title: 'No dead code or leftover scaffolding', category: 'cleanup' }],
      brief: 'The briefs pointed both tasks at the existing form components.',
    } as never)
    expect('result' in review && review.result).toMatch(/Review round 2 prepared/)
    expect('result' in review && review.result).toMatch(/subagent_type: "dacapo:reviewer".*prompt: "dacapo review 1-2"/)
    expect(files.get('/repo/.workspaces/review/1-2/.context/review-brief.md')).toMatch(/git diff origin\/main\.\.\.HEAD/)
    expect(files.get('/repo/.workspaces/review/1-2/.context/review-brief.md')).toMatch(/existing form components/)
    const startedReview = await startAgent('dacapo review 1-2')
    expect('result' in startedReview).toBe(true)
    expect(agentCalls[5]?.subagent_type).toBe('dacapo:reviewer')
    const reviewerReads = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/review/1-2/src/login.ts', agentId: 'agent-6' } as never)
    expect('result' in reviewerReads && reviewerReads.result).toBe('read')
    const reviewerEdits = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/review/1-2/src/login.ts', content: 'x', agentId: 'agent-6' } as never)
    expect('deny' in reviewerEdits && typeof reviewerEdits.deny === 'string').toBe(true)
    const reviewReport = '/repo/.workspaces/review/1-2/.context/review-report.json'
    const reviewerWrites = await $.tool.call({ tool: 'Write', file_path: reviewReport, content: 'x', agentId: 'agent-6' } as never)
    expect('result' in reviewerWrites && reviewerWrites.result).toBe('written')
    files.set(reviewReport, JSON.stringify({ items: [{ id: 'errors', score: 'strong', note: 'uses the shared toast' }, { id: 'dead', score: 'strong', note: 'nothing left over' }], overview: 'Clean; the legacy form helper could be shared later.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't3', agentId: 'agent-6', reason: 'answer' })
    await clock.advance(1_000)
    const wakeReview = prompts.find(p => /Review round 2:/.test(p))
    expect(wakeReview).toMatch(/2 strong, 0 acceptable, 0 unacceptable → verdict: pass/)
    expect(wakeReview).toMatch(/Overview from the reviewer:/)
    expect(wakeReview).toMatch(/call mcp__dacapo__finish/)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/review-1-2.json`)).toMatch(/"verdict": "pass"/)
    const afterReview = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in afterReview && afterReview.result).toMatch(/Review round 2 \[agent-6\] finished .*2 strong/)
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
    on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
    on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith('/repo/.workspaces/') }))
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
      if (argv[1] === 'rev-parse' && argv[2] === '--balanced') return String(argv[4]) === 'refs/heads/main' ? out('abc\n') : out('', 1)
      if (argv[1] === 'ls-remote') return out('')
      if (argv[1] === 'worktree' && argv[2] === 'list') return out('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n')
      if (argv[1] === 'rev-list') return out('2\n')
      if (argv[1] === 'remote') return out('git@github.com:x/y.git\n')
      return out('')
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('turn.start', () => ({ turnId: 'wake' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/dacapo:core --fast add a login page', wait: false, origin: { kind: 'composer' } })
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
