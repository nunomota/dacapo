import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const DENY = 'the call did not answer the person\'s own input'

/** The engine beneath the mod: records spawns, sends and views, answers views with a deny. */
function world(on: On) {
  const spawned: string[] = []
  const sends: Array<{ to: string; text: string }> = []
  const views: Array<string | undefined> = []
  const toasts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    views.push(e.agentId)
    return { value: { deny: DENY } }
  })
  const agents: unknown[] = []
  on('agent.spawn', (_, e) => {
    // beneath the plugins the spawn arrives as the Agent tool's input, background already set
    const input = e as unknown as { subagent_type?: string; run_in_background?: boolean; description?: string }
    spawned.push(`${input.subagent_type} background=${input.run_in_background === true} name=${(e as { name?: string }).name ?? '-'}`)
    const id = `agent-${spawned.length}`
    agents.push({ id, description: input.description, type: input.subagent_type, status: 'running', background: true, fork: false })
    return { model: 'sonnet', agentId: id }
  })
  on('agent.list', () => ({ value: agents as never }))
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const session = mock.session(on)
  return { spawned, sends, views, toasts, session }
}

test('start, view, send, the prompt hook and the end of the interview', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const started = (await $.command.run({ command: 'spike-start', args: '' } as never) as { text: string }).text
  expect(w.spawned).toEqual(['general-purpose background=true name=-'])
  expect(w.views).toEqual(['agent-1'])
  expect(w.spawned).toEqual(['general-purpose background=true name=-'])
  expect(w.views).toEqual(['agent-1'])
  expect(started).toContain('Interviewer agent-1 holds the floor.')
  expect(started).toContain(`spike-start: view agent-1 → deny: ${DENY}`)
  expect(w.toasts).toContain(`spike-start: view agent-1 → deny: ${DENY}`)

  expect((await $.command.run({ command: 'spike-view', args: '' } as never) as { text: string }).text).toBe(`spike-view: view agent-1 → deny: ${DENY}`)
  expect((await $.command.run({ command: 'spike-main', args: '' } as never) as { text: string }).text).toBe(`spike-main: view main → deny: ${DENY}`)
  expect(w.views).toEqual(['agent-1', 'agent-1', undefined])

  // typed text goes to the agent and leaves the main conversation; a command passes
  const typed = await $.prompt.submit({ text: 'I build loops', wait: false, origin: { kind: 'composer' } } as never)
  expect(typed).toEqual({ drop: '→ interviewer (agent-1)' })
  const slash = await $.prompt.submit({ text: '/help', wait: false, origin: { kind: 'composer' } } as never)
  expect(slash).toMatchObject({ text: '/help' })

  expect((await $.command.run({ command: 'spike-send', args: 'reviews are slow' } as never) as { text: string }).text).toBe('spike-send: send → delivered')
  expect(w.sends).toEqual([
    { to: 'agent-1', text: 'I build loops' },
    { to: 'agent-1', text: 'reviews are slow' },
  ])

  // the agent's answers come back as [interviewer] rows; the last one returns the floor
  await $.turn.complete({ answer: 'Thanks. Last question?', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'Report written.\nspike: reported', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-1', reason: 'answer' } as never)
  const rows = w.session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('[interviewer] Thanks. Last question?'))).toBe(true)
  expect(w.toasts).toContain('[interviewer] Thanks. Last question?')
  expect(w.toasts).toContain('floor returned')

  // once the floor is back, typing stays in the main conversation
  const after = await $.prompt.submit({ text: 'hello main', wait: false, origin: { kind: 'composer' } } as never)
  expect(after).toMatchObject({ text: 'hello main' })
  expect(w.sends.length).toBe(2)

  const status = (await $.command.run({ command: 'spike-status', args: '' } as never) as { text: string }).text
  expect(status.split('\n')).toEqual([
    'floor: none',
    'agent: -',
    'log:',
    '  spike-start: spawned agent-1 (id from $.agent.list)',
    `  spike-start: view agent-1 → deny: ${DENY}`,
    `  spike-view: view agent-1 → deny: ${DENY}`,
    `  spike-main: view main → deny: ${DENY}`,
    '  prompt.submit: send → delivered',
    '  spike-send: send → delivered',
    '  turn.complete: agent-1 reason answer',
    '  turn.complete: agent-1 reason answer',
    '  floor returned',
  ])
})

test('spike-team starts a named agent and says when it is no teammate; spike-back clears the floor', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'spike-team', args: '' } as never) as { text: string }).text
  expect(w.spawned).toEqual(['general-purpose background=true name=spike-interviewer'])
  expect(text).toBe('spike-team: spawn → id agent-1, not a teammate\nNot a teammate: a mod can only name the agent through $.agent.spawn, and this session made it a plain subagent.')
  expect((await $.command.run({ command: 'spike-status', args: '' } as never) as { text: string }).text).toMatch(/^floor: agent-1\nagent: status running\n/)
  expect((await $.command.run({ command: 'spike-back', args: '' } as never) as { text: string }).text).toBe('Floor cleared (was agent-1).')
  const typed = await $.prompt.submit({ text: 'stays here', wait: false, origin: { kind: 'composer' } } as never)
  expect(typed).toMatchObject({ text: 'stays here' })
  expect(w.sends).toEqual([])
})
