import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

/** The spike's state: the agent holding the floor and what the hooks have seen. Module variables, as the spike needs no more. */
export const spike = { floor: null as string | null, log: [] as string[] }

const band = atom({ plugin: 'handover-spike', key: 'band' } as const, { floor: null, last: '' })
const DONE = 'spike: reported'
const SPAWN_DESCRIPTION = 'Handover spike interviewer'
const TEAM_DESCRIPTION = 'Handover spike teammate'

export const INTERVIEWER = [
  'You are an interviewer in a test of how the chat is handed to a subagent.',
  'Greet the person, then ask them three short questions, one at a time (what they are working on, what slows them down, what they would change first).',
  'After each question stop and wait for their answer: end your turn and do not answer for them.',
  'Once you have all three answers, write spike-report.md in the working directory with what you learned,',
  `and end your final message with the line \`${DONE}\` alone on the last line.`,
].join(' ')

/** Records a line in the log and answers the band to draw. */
function logged(line: string) {
  spike.log.push(line)
  return { floor: spike.floor, last: line }
}
const viewLine = (from: string, agentId: string | undefined, shown: { deny?: string }) =>
  `${from}: view ${agentId ?? 'main'} → ${shown.deny ? `deny: ${shown.deny}` : 'shown'}`
const sendLine = (from: string, sent: { isDelivered: boolean; reason?: string }) =>
  `${from}: send → ${sent.isDelivered ? 'delivered' : `not delivered: ${sent.reason}`}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'spike-start', description: 'Handover spike: starts the interviewer and tries the agent view.' }),
      $.command.register({ name: 'spike-view', description: 'Handover spike: shows the floor agent in the main view.' }),
      $.command.register({ name: 'spike-main', description: 'Handover spike: shows the main conversation again.' }),
      $.command.register({ name: 'spike-send', description: 'Handover spike: sends text to the floor agent.', argumentHint: '<text>' }),
      $.command.register({ name: 'spike-back', description: 'Handover spike: clears the floor.' }),
      $.command.register({ name: 'spike-status', description: 'Handover spike: floor, agent status and what the hooks saw.' }),
      $.command.register({ name: 'spike-team', description: 'Handover spike: starts the interviewer as a named agent (a teammate where the session has a team).' }),
    ])
    return next(e)
  })

  on('command.run', { command: 'spike-start' }, async $ => {
    const started = await $.agent.spawn({ prompt: INTERVIEWER, description: SPAWN_DESCRIPTION, subagentType: 'general-purpose' })
    if (started.deny) {
      await update($, band, () => logged(`spike-start: spawn → deny: ${started.deny}`))
      return { text: `The interviewer did not start: ${started.deny}` }
    }
    // the id is set by core; where the answer carries none, the agent list names it by its description
    const listed = started.agentId ? undefined : (await $.agent.list()).filter(a => a.description === SPAWN_DESCRIPTION).pop()?.id
    const agentId = started.agentId ?? listed
    if (!agentId) {
      await update($, band, () => logged('spike-start: spawn → no agentId, none listed'))
      return { text: 'The interviewer started with no agentId, and $.agent.list() names none.' }
    }
    spike.floor = agentId
    await update($, band, () => logged(`spike-start: spawned ${agentId}${listed ? ' (id from $.agent.list)' : ''}`))
    const shown = await $.ui.view({ agentId })
    const line = viewLine('spike-start', agentId, shown)
    await update($, band, () => logged(line))
    $.ui.toast(line, { timeoutMs: 8000 })
    return { text: `Interviewer ${agentId} holds the floor.\n${line}` }
  })

  on('command.run', { command: 'spike-view' }, async $ => {
    if (!spike.floor) return { text: 'No floor is held: run /spike-start first.' }
    const id = spike.floor
    const line = viewLine('spike-view', id, await $.ui.view({ agentId: id }))
    await update($, band, () => logged(line))
    $.ui.toast(line, { timeoutMs: 8000 })
    return { text: line }
  })

  on('command.run', { command: 'spike-main' }, async $ => {
    const line = viewLine('spike-main', undefined, await $.ui.view({}))
    await update($, band, () => logged(line))
    $.ui.toast(line, { timeoutMs: 8000 })
    return { text: line }
  })

  on('command.run', { command: 'spike-send' }, async ($, e) => {
    if (!spike.floor) return { text: 'No floor is held: run /spike-start first.' }
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /spike-send <text>' }
    const sent = await $.session.send({ to: { agentId: spike.floor }, text })
    const line = sendLine('spike-send', sent)
    await update($, band, () => logged(line))
    return { text: line }
  })

  on('command.run', { command: 'spike-back' }, async $ => {
    const was = spike.floor
    spike.floor = null
    await update($, band, () => logged(`spike-back: floor cleared (was ${was ?? 'none'})`))
    return { text: `Floor cleared (was ${was ?? 'none'}).` }
  })

  on('command.run', { command: 'spike-status' }, async $ => {
    const agents = await $.agent.list()
    const mine = spike.floor ? agents.find(a => a.id === spike.floor) : undefined
    const entry = mine ? `status ${mine.status}${mine.isTeammate ? `, teammate ${mine.teammateId ?? ''}` : ''}` : spike.floor ? 'not in $.agent.list()' : '-'
    return { text: [`floor: ${spike.floor ?? 'none'}`, `agent: ${entry}`, 'log:', ...spike.log.map(l => `  ${l}`)].join('\n') }
  })

  on('command.run', { command: 'spike-team' }, async $ => {
    // a mod cannot call the Agent tool ($.tool.call refuses it: "that is $.agent.spawn"), and $.agent.spawn takes no team and
    // pins isTeammate; a name is the one door left: the spawn's answer and the list say whether it became a teammate
    const started = await $.agent.spawn({ prompt: INTERVIEWER, description: TEAM_DESCRIPTION, subagentType: 'general-purpose', name: 'spike-interviewer' })
    if (started.deny) {
      await update($, band, () => logged(`spike-team: spawn → deny: ${started.deny}`))
      return { text: `The named interviewer did not start: ${started.deny}` }
    }
    const listed = (await $.agent.list()).filter(a => (started.agentId ? a.id === started.agentId : a.description === TEAM_DESCRIPTION)).pop()
    const id = started.agentId ?? listed?.id
    const teammate = started.teammateId ?? (listed?.isTeammate ? (listed.teammateId ?? '?') : undefined)
    const line = `spike-team: spawn → id ${id ?? 'none'}, ${teammate ? `teammate ${teammate}` : 'not a teammate'}`
    if (id) spike.floor = id
    await update($, band, () => logged(line))
    return { text: `${line}
${teammate ? 'Started as a teammate.' : 'Not a teammate: a mod can only name the agent through $.agent.spawn, and this session made it a plain subagent.'}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text
    if (!spike.floor || e.origin.kind !== 'composer' || text.trimStart().startsWith('/')) return next(e)
    const sent = await $.session.send({ to: { agentId: spike.floor }, text })
    await update($, band, () => logged(sendLine('prompt.submit', sent)))
    return { drop: sent.isDelivered ? `→ interviewer (${spike.floor})` : `Not delivered to the interviewer: ${sent.reason}` }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId && e.agentId === spike.floor) {
      const answer = e.answer.trim()
      await update($, band, () => logged(`turn.complete: ${e.agentId} reason ${e.reason}`))
      if (answer) {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[interviewer] ${answer}` }] } })
        $.ui.toast(`[interviewer] ${answer.split('\n')[0]}`, { timeoutMs: 8000 })
      }
      if (answer.endsWith(DONE)) {
        spike.floor = null
        await update($, band, () => logged('floor returned'))
        $.ui.toast('floor returned')
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (e.props.hasSurvey || !b.floor) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>handover spike · floor: {b.floor} · last: {b.last || '-'}</Text>
      </Box>
    )
  })
}
