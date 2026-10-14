import { describe, expect, mock, test } from 'claude-code/testing'

import { summarize, validateReport, validateRubric } from '../hooks/report'
import { cut, elapsed } from '../hooks/pane'

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

describe('timeline formatting', () => {
  test('elapsed reads as seconds, minutes or hours', () => {
    expect(elapsed(0, 42_000)).toBe('42s')
    expect(elapsed(0, 4 * 60_000 + 12_000)).toBe('4m12s')
    expect(elapsed(0, 2 * 3_600_000 + 5 * 60_000)).toBe('2h05m')
  })

  test('cut shortens with an ellipsis and folds whitespace', () => {
    expect(cut('a   long\nline here', 8)).toBe('a long …')
    expect(cut('short', 10)).toBe('short')
  })
})

const PANE = {
  component: 'Pane' as const,
  requestId: 'task-loop',
  props: { title: 'Task loop', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

describe('the pane', () => {
  test('with no run it says so on every surface', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'task-loop', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /No task-loop run/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the /task-loop prompt opens a run and becomes the first row', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 10, 12, 0, 0) })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('session.cwd', () => ({ value: '/tmp/task-loop-test' }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__task-loop__${e.name}` } }))
    on('agent.register', (_, e) => ({ value: { agent: `task-loop:${e.name}` } }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
    await $.session.start({ cwd: '/tmp/task-loop-test', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/task-loop build a todo app', wait: false, origin: { kind: 'composer' } })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'task-loop', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /build a todo app/ })).toBeDefined()
      expect(await ui.find({ key: 'iter-1' })).toBeDefined()
      const row = await ui.find({ text: /User message/ })
      expect(row).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('the loop', () => {
  test('a worker completion wakes the orchestrator; merge, QA collection, guards, folding and stale marking', async ($, on) => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0)
    const clock = mock.clock(on, { now: t0 })
    const files = new Map<string, string>()
    const prompts: string[] = []
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    on('session.cwd', () => ({ value: '/repo' }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__task-loop__${e.name}` } }))
    on('agent.register', (_, e) => ({ value: { agent: `task-loop:${e.name}` } }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
    on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
    on('process.run', (_, e) => {
      const argv = e.argv
      const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (argv[1] === 'rev-parse' && argv[2] === '--show-toplevel') return out('/repo\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--path-format=absolute') return out('/repo/.git\n')
      if (argv[1] === 'rev-parse' && argv[2] === '--verify') return out(String(argv[4]).startsWith('refs/heads/task/') ? '' : 'abc\n', String(argv[4]).startsWith('refs/heads/task/') ? 1 : 0)
      if (argv[1] === 'worktree' && argv[2] === 'list') return out('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.workspaces/dev\nHEAD abc\nbranch refs/heads/dev\n\n')
      if (argv[1] === 'diff' && argv[3] === '--quiet') return out('', 1)
      if (argv[1] === 'rev-parse' && argv[2] === '--short') return out('beef1\n')
      return out('')
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('turn.start', () => ({ turnId: 'wake' }))
    on('tool.call', { tool: 'TaskStop' }, () => ({ result: 'stopped' }))
    on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
    on('tool.call', { tool: 'Read' }, () => ({ result: 'read' }))
    const agentCalls: Array<Record<string, unknown>> = []
    let nextAgent = 0
    on('tool.call', { tool: 'Agent' }, (_, e) => {
      agentCalls.push({ ...e })
      nextAgent += 1
      return { result: { agentId: `agent-${nextAgent}`, content: [{ type: 'text' as const, text: 'started' }] } }
    })
    const startAgent = (prompt: string) => $.tool.call({ tool: 'Agent', prompt, description: 'x', subagent_type: 'task-loop:worker' })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: '/task-loop build a login page', wait: false, origin: { kind: 'composer' } })
    const started = await $.tool.call({ tool: 'mcp__task-loop__start', task: 'Build a login page' } as never)
    expect('result' in started && started.result).toMatch(/Run .* ready/)
    const runId = /Run (\S+) ready/.exec(String('result' in started ? started.result : ''))?.[1] ?? ''

    const bad = await $.tool.call({
      tool: 'mcp__task-loop__dispatch',
      title: 'Login page and docs',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build it', model: 'sonnet', commit: 'update(login): stuff' }],
    } as never)
    expect('isError' in bad && bad.isError).toBe(true)

    const dispatched = await $.tool.call({
      tool: 'mcp__task-loop__dispatch',
      title: 'Login page and docs',
      overview: 'Build the login page first; docs follow.',
      tasks: [{ id: 'login', title: 'Login page', prompt: 'Build the login page.', model: 'sonnet', commit: 'feat: add login page', build: 'npm run build' }],
    } as never)
    expect('result' in dispatched && dispatched.result).toMatch(/prompt: "task-loop worker login"/)
    expect('result' in dispatched && dispatched.result).toMatch(/Login page and docs/)
    expect(files.get('/repo/.workspaces/task/1-login/.context/brief.md')).toMatch(/npm run build/)
    expect(files.get(`/repo/.workspaces/.task-loop/${runId}/iteration-1-login.md`)).toMatch(/clean-commits/)
    const pendingStatus = await $.tool.call({ tool: 'mcp__task-loop__status' } as never)
    expect('result' in pendingStatus && pendingStatus.result).toMatch(/login \[pending-worker-1-login\] waiting to start/)
    // a merge cannot run while a worker is still to be started
    const early = await $.tool.call({ tool: 'mcp__task-loop__merge' } as never)
    expect('isError' in early && early.isError).toBe(true)
    // an Agent call that names nothing pending is refused; the right one is filled in from the run
    const wrong = await startAgent('task-loop worker nope')
    expect('deny' in wrong && typeof wrong.deny === 'string').toBe(true)
    await clock.advance(1_000)
    const startedWorker = await startAgent('task-loop worker login')
    expect('result' in startedWorker).toBe(true)
    const call = agentCalls[0]!
    expect(call.subagent_type).toBe('task-loop:worker')
    expect(call.model).toBe('sonnet')
    expect(call.run_in_background).toBe(true)
    expect(String(call.prompt)).toMatch(/^\[task-loop worktree: \/repo\/.workspaces\/task\/1-login\]/)
    expect(String(call.prompt)).toMatch(/npm run build/)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'task-loop', surface, ...PANE })
      expect(await ui.find({ text: /Login page/ })).toBeDefined()
      expect(await ui.find({ text: /Build the login page first/ })).toBeDefined()
      expect(await ui.find({ text: /implement/ })).toBeDefined()
      await ui.unmount()
    }

    // the orchestrator may not edit while the run is active; a worker may, inside its worktree only
    const denied = await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })
    expect('deny' in denied && typeof denied.deny === 'string').toBe(true)
    const outside = await $.tool.call({ tool: 'Write', file_path: '/repo/src/x.ts', content: 'x', agentId: 'agent-1' } as never)
    expect('deny' in outside && typeof outside.deny === 'string').toBe(true)
    const inside = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/task/1-login/src/x.ts', content: 'x', agentId: 'agent-1' } as never)
    expect('result' in inside && inside.result).toBe('written')

    await clock.advance(90_000)
    await $.turn.complete({ answer: 'Done. Build passes.', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' })
    // the wake-up is sent by the ticker, not inside the agent's own completion
    expect(prompts.some(p => p.startsWith('[task-loop]'))).toBe(false)
    await clock.advance(1_000)
    expect(prompts.some(p => p.startsWith('[task-loop]') && /all 1 worker\(s\) have ended/.test(p))).toBe(true)
    // undelivered, it is sent again after 30 seconds and at most three times; a started turn marks it delivered
    await clock.advance(31_000)
    expect(prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length).toBe(2)
    await $.turn.start({ text: prompts.find(p => /all 1 worker\(s\) have ended/.test(p))! } as never)
    await clock.advance(31_000)
    expect(prompts.filter(p => /all 1 worker\(s\) have ended/.test(p)).length).toBe(2)
    const statusAfter = await $.tool.call({ tool: 'mcp__task-loop__status' } as never)
    expect('result' in statusAfter && statusAfter.result).toMatch(/login \[agent-1\] finished \(1m30s/)

    const merged = await $.tool.call({ tool: 'mcp__task-loop__merge' } as never)
    expect('result' in merged && merged.result).toMatch(/feat: add login page \(beef1\)/)

    const qa = await $.tool.call({
      tool: 'mcp__task-loop__qa',
      rubric: [{ id: 'login', title: 'A user can log in', category: 'core' }, { id: 'copy', title: 'Error copy is clear', category: 'ui-ux' }],
      harness: 'Run `npm start`, open http://localhost:3000/login, use user@example.com / secret.',
    } as never)
    expect('result' in qa && qa.result).toMatch(/prompt: "task-loop qa 1-1"/)
    expect(files.get('/repo/.workspaces/qa/1-1/.context/qa-brief.md')).toMatch(/npm start/)
    const reportPath = '/repo/.workspaces/qa/1-1/.context/qa-report.json'
    const startedQa = await startAgent('task-loop qa 1-1')
    expect('result' in startedQa).toBe(true)
    expect(agentCalls[1]?.subagent_type).toBe('task-loop:qa')
    expect(agentCalls[1]?.model).toBe('opus')

    // QA may not read source, only its .context folder; and only writes its report
    const peek = await $.tool.call({ tool: 'Read', file_path: '/repo/.workspaces/qa/1-1/src/login.ts', agentId: 'agent-2' } as never)
    expect('deny' in peek && typeof peek.deny === 'string').toBe(true)
    const brief = await $.tool.call({ tool: 'Read', file_path: '.context/qa-brief.md', agentId: 'agent-2' } as never)
    expect('result' in brief && brief.result).toBe('read')
    const wrongWrite = await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/qa/1-1/.context/notes.md', content: 'x', agentId: 'agent-2' } as never)
    expect('deny' in wrongWrite && typeof wrongWrite.deny === 'string').toBe(true)

    files.set(reportPath, JSON.stringify({ items: [{ id: 'login', score: 'strong', note: 'ok' }, { id: 'copy', score: 'unacceptable', note: 'says "error"' }], overview: 'Login works; the error copy needs words.' }))
    await $.turn.complete({ answer: 'Report written.', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-2', reason: 'answer' })
    await clock.advance(1_000)
    const wakeQa = prompts.find(p => /QA round 1 for iteration 1/.test(p))
    expect(wakeQa).toMatch(/1 strong, 0 acceptable, 1 unacceptable → verdict: fix/)
    expect(wakeQa).toMatch(/Login works; the error copy needs words\./)
    expect(files.get(`/repo/.workspaces/.task-loop/${runId}/qa-1-1.json`)).toMatch(/"verdict": "fix"/)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'task-loop', surface, ...PANE })
      expect(await ui.find({ text: /QA round 1: fix needed/ })).toBeDefined()
      expect(await ui.find({ text: /error copy needs words/ })).toBeUndefined()
      await ui.press({ plugin: 'task-loop', key: 'qa-agent-2' })
      expect(await ui.find({ text: /1 strong · 0 acceptable · 1 unacceptable → fix needed/ })).toBeDefined()
      expect(await ui.find({ text: /error copy needs words/ })).toBeDefined()
      await ui.press({ plugin: 'task-loop', key: 'qa-agent-2' })
      expect(await ui.find({ text: /error copy needs words/ })).toBeUndefined()
      await ui.unmount()
    }

    // a second dispatch starts iteration 2 and folds iteration 1
    const again = await $.tool.call({
      tool: 'mcp__task-loop__dispatch',
      title: 'Fix error copy',
      tasks: [{ id: 'copy', title: 'Fix error copy', prompt: 'Explain errors.', model: 'sonnet', commit: 'fix: explain login errors' }],
    } as never)
    expect('result' in again && again.result).toMatch(/Iteration 2/)
    await startAgent('task-loop worker copy')
    const ui = await $.ui.mount({ plugin: 'task-loop', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'iter-2' })).toBeDefined()
    expect(await ui.find({ text: /Fix error copy/ })).toBeDefined()
    expect(await ui.find({ text: /Build the login page first/ })).toBeUndefined()
    await ui.press({ plugin: 'task-loop', key: 'iter-1' })
    expect(await ui.find({ text: /Build the login page first/ })).toBeDefined()
    await ui.unmount()

    // a silent worker is marked stale after 30 minutes and the orchestrator is told; activity clears it
    await clock.advance(31 * 60_000)
    expect(prompts.some(p => /Worker copy \[agent-3\] looks stale/.test(p))).toBe(true)
    const stale = await $.tool.call({ tool: 'mcp__task-loop__status' } as never)
    expect('result' in stale && stale.result).toMatch(/copy \[agent-3\] stale/)
    await $.tool.call({ tool: 'Write', file_path: '/repo/.workspaces/task/2-copy/a.ts', content: 'x', agentId: 'agent-3' } as never)
    const back = await $.tool.call({ tool: 'mcp__task-loop__status' } as never)
    expect('result' in back && back.result).toMatch(/copy \[agent-3\] running/)

    // two idle hours stop it, distinct from a failure
    await clock.advance(2 * 60 * 60_000 + 1_000)
    const timed = await $.tool.call({ tool: 'mcp__task-loop__status' } as never)
    expect('result' in timed && timed.result).toMatch(/copy \[agent-3\] timed out/)
    expect(prompts.some(p => /Worker copy \[agent-3\] timed out/.test(p))).toBe(true)

    const finished = await $.tool.call({ tool: 'mcp__task-loop__finish' } as never)
    expect('result' in finished && finished.result).toMatch(/Run .* finished/)
    const after = await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })
    expect('result' in after && after.result).toBe('written')
  })
})
