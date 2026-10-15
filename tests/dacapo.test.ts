import { describe, expect, mock, test } from 'claude-code/testing'

import { checksOf, parsePrs } from '../hooks/gh'
import { cut, elapsed, rowsOf } from '../hooks/pane'
import { summarize, validateReport, validateRubric } from '../hooks/report'

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
    const files = new Map<string, string>()
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
    await $.prompt.submit({ text: '/dacapo:core build a login page', wait: false, origin: { kind: 'composer' } })

    // without gh the run cannot start, and the orchestrator is told how to help
    const noGh = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('isError' in noGh && noGh.isError).toBe(true)
    expect('result' in noGh && noGh.result).toMatch(/brew install gh/)
    ghMissing = false
    const started = await $.tool.call({ tool: 'mcp__dacapo__start', task: 'Build a login page' } as never)
    expect('result' in started && started.result).toMatch(/Run .* ready on x\/y/)
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
    expect(brief).toMatch(/Verified:/)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/round-1-login.md`)).toMatch(/clean-commits/)
    const pendingStatus = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in pendingStatus && pendingStatus.result).toMatch(/login \[pending-worker-1-login\] waiting to start/)
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
    expect(agentCalls[1]?.model).toBe('opus')

    // QA may not read source, only its .context folder; and only writes its report
    const peek = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/src/login.ts', agentId: 'agent-2' } as never)
    expect('deny' in peek && typeof peek.deny === 'string').toBe(true)
    const qaBriefRead = await $.tool.call({ tool: 'Read', file_path: '.context/qa-brief.md', agentId: 'agent-2' } as never)
    expect('result' in qaBriefRead && qaBriefRead.result).toBe('read')
    const wrongWrite = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/qa/1-1/.context/notes.md', content: 'x', agentId: 'agent-2' } as never)
    expect('deny' in wrongWrite && typeof wrongWrite.deny === 'string').toBe(true)

    files.set(reportPath, JSON.stringify({ items: [{ id: 'login', score: 'strong', note: 'ok' }, { id: 'copy', score: 'unacceptable', note: 'says "error"' }], overview: 'Login works; the error copy needs words.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-2', reason: 'answer' })
    await clock.advance(1_000)
    const wakeQa = prompts.find(p => /QA round 1:/.test(p))
    expect(wakeQa).toMatch(/1 strong, 0 acceptable, 1 unacceptable → verdict: fix/)
    expect(wakeQa).toMatch(/Login works; the error copy needs words\./)
    expect(files.get(`/repo/.workspaces/.dacapo/${runId}/qa-1-1.json`)).toMatch(/"verdict": "fix"/)

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
    expect(prompts.some(p => /Worker login \[agent-3\] looks stale/.test(p))).toBe(true)
    const stale = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in stale && stale.result).toMatch(/login \[agent-3\] stale/)
    await $.tool.call({ tool: 'Write', file_path: `/repo/.workspaces/${WORK}/a.ts`, content: 'x', agentId: 'agent-3' } as never)
    const back = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in back && back.result).toMatch(/login \[agent-3\] running/)

    // two idle hours stop it, distinct from a failure; the wake-up lists the options
    await clock.advance(2 * 60 * 60_000 + 1_000)
    const timed = await $.tool.call({ tool: 'mcp__dacapo__status' } as never)
    expect('result' in timed && timed.result).toMatch(/login \[agent-3\] timed out/)
    expect(prompts.some(p => /Worker login \[agent-3\] timed out/.test(p))).toBe(true)
    expect(prompts.some(p => /Round 2: all 1 worker\(s\) have ended/.test(p) && /resume it: dispatch the same task id with resume: true/.test(p))).toBe(true)

    // the end: a final pull request from the run branch into main, merged by the run once green
    const noTitle = await $.tool.call({ tool: 'mcp__dacapo__finish' } as never)
    expect('isError' in noTitle && noTitle.isError).toBe(true)
    const tainted = await $.tool.call({ tool: 'mcp__dacapo__finish', title: 'feat: add a login page', body: 'Adds login.\n\nCo-Authored-By: someone' } as never)
    expect('isError' in tainted && tainted.isError).toBe(true)
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
})
