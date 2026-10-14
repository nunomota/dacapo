import type { Elements } from 'claude-code'

import type { Activity, AgentStats, Phase, QaRow, Row, Run, Ui, WorkerRow } from '../types'
import { ZERO, addUsage, costOf, fmtCost, fmtTokens, totalTokens, type Price } from './cost'

/** The three elements every surface has; the hook resolves the table and hands these in. */
export type Els = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
}

export type Snapshot = { run: Run | null; rows: Row[]; ui: Ui }

export type Actions = {
  toggleIteration: (n: number) => void
  toggleRow: (id: string) => void
  openPane: () => void
  hideBand: () => void
}

export type Theme = { prices: Record<string, Price> }

export const PHASES: readonly Phase[] = ['clarify', 'research', 'plan', 'implement', 'qa', 'release']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => `${n}`.padStart(2, '0')

export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** `14 Oct 18:50`. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${hhmm(ms)}`
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${hhmm(ms)}:${two(d.getSeconds())}`
}

export function elapsed(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.floor((toMs - fromMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${two(s % 60)}s`
  const h = Math.floor(m / 60)
  return `${h}h${two(m % 60)}m`
}

export function cut(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (width <= 1) return one.slice(0, 1)
  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}

export const isAgentRow = (row: Row): row is WorkerRow | QaRow => row.kind === 'worker' || row.kind === 'qa'
export const isActive = (row: Row): boolean => isAgentRow(row) && (row.status === 'running' || row.status === 'stale')

export const statusWord: Record<WorkerRow['status'] | QaRow['status'], string> = {
  pending: 'waiting to start',
  running: 'running',
  finished: 'finished',
  merged: 'merged',
  failed: 'failed',
  invalid: 'report invalid',
  stale: 'stale',
  timeout: 'timed out',
  cancelled: 'cancelled',
}

export const verdictWord = (row: QaRow | undefined): string | undefined =>
  !row ? undefined : row.summary ? (row.summary.verdict === 'fix' ? 'fix needed' : row.summary.verdict === 'pass' ? 'pass' : 'pass, recommendations') : statusWord[row.status]

export function scoreLine(row: QaRow): string {
  if (!row.summary) return row.status === 'running' || row.status === 'stale' || row.status === 'pending' ? 'report not ready' : 'no report'
  const s = row.summary
  return `${s.strong} strong · ${s.acceptable} acceptable · ${s.unacceptable} unacceptable → ${verdictWord(row)}`
}

/** Tokens and cost of a set of agent rows plus, when given, the orchestrator's own usage. */
export function spend(rows: readonly (WorkerRow | QaRow)[], prices: Record<string, Price>, orchestrator?: Run['orchestrator']) {
  let usage = ZERO
  let cost = 0
  let priced = true
  for (const r of rows) {
    usage = addUsage(usage, r.stats.usage)
    const c = costOf(r.stats.modelId ?? r.model, r.stats.usage, prices)
    if (c === undefined) priced = false
    else cost += c
  }
  if (orchestrator) {
    usage = addUsage(usage, orchestrator)
    const c = costOf(orchestrator.modelId, orchestrator, prices)
    if (c === undefined) priced = false
    else cost += c
  }
  return { tokens: totalTokens(usage), cost: priced ? cost : undefined }
}

export const spendText = (s: { tokens: number; cost: number | undefined }) =>
  s.tokens === 0 ? '' : `${fmtTokens(s.tokens)} tok${s.cost !== undefined ? ` · ~${fmtCost(s.cost)}` : ''}`

const SEP = '  ·  '

/** Border colors: the person white, the orchestrator purple, QA cyan, a sub-agent by its status. */
export const PURPLE = '#a855f7'
export const CYAN = 'cyan'

export function cardColor(row: Row): string {
  if (row.kind === 'user') return 'white'
  if (row.kind === 'orchestrator') return PURPLE
  if (row.kind === 'qa') return CYAN
  switch (row.status) {
    case 'finished':
    case 'merged':
      return 'green'
    case 'failed':
    case 'timeout':
    case 'cancelled':
      return 'red'
    default:
      return 'yellow'
  }
}

/** Two-line icons, four columns wide, drawn in the card's color on the left of every card. */
export const ART: Record<Row['kind'], readonly [string, string]> = {
  worker: ['╭●●╮', '╰┬┬╯'],
  qa: ['▛✓▜ ', '▙──▟'],
  user: [' ◯  ', '╱█╲ '],
  orchestrator: [' ◆  ', '╱│╲ '],
}

// ---------- the pane ----------

export function drawPane(els: Els, snap: Snapshot, act: Actions, columns: number, theme: Theme): JSX.Element {
  const { Box, Text } = els
  const { run, rows, ui } = snap
  if (!run) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No task-loop run in this session. Start one with /task-loop.</Text>
      </Box>
    )
  }
  const width = Math.max(28, columns)
  const inner = width - 4
  const now = ui.tick
  const isOver = run.status === 'done' || run.status === 'aborted'
  const endAt = isOver ? (rows[rows.length - 1]?.at ?? now) : now
  const agents = rows.filter(isAgentRow)
  const total = spend(agents, theme.prices, run.orchestrator)
  const ordered = [...rows].sort((a, b) => a.at - b.at)

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        <Text bold wrap="truncate-end">
          {cut(run.task, inner)}
        </Text>
        <Text wrap="truncate-end">
          {run.status === 'aborted' ? (
            <Text>
              <Text color="error">Aborted</Text>
              <Text dimColor>{SEP}</Text>
            </Text>
          ) : (
            ''
          )}
          {elapsed(run.startedAt, endAt)}
          <Text dimColor>{SEP}</Text>
          {`${agents.length}`}
          <Text dimColor>{agents.length === 1 ? ' agent' : ' agents'}</Text>
          <Text dimColor>{SEP}</Text>
          {fmtTokens(total.tokens)}
          <Text dimColor> tokens</Text>
          {total.cost !== undefined ? (
            <Text>
              <Text dimColor>{`${SEP}~`}</Text>
              {fmtCost(total.cost)}
            </Text>
          ) : (
            ''
          )}
        </Text>
        {drawPhases(els, run.phase, inner)}
      </Box>
      {run.overview && (
        <Box paddingX={1} marginTop={1}>
          <Text dimColor wrap="wrap">
            {run.overview}
          </Text>
        </Box>
      )}
      <Box marginY={1}>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(10, width - 2))}
        </Text>
      </Box>
      {ordered.map(row => drawCard(els, row, ui, act, width, theme, now))}
    </Box>
  )
}

function drawPhases(els: Els, current: Phase, width: number): JSX.Element {
  const { Text } = els
  const at = PHASES.indexOf(current)
  const sep = width < 56 ? ' › ' : '  ›  '
  return (
    <Text wrap="truncate-end">
      {PHASES.map((p, i) => (
        <Text key={`phase-${p}`}>
          {i > 0 ? <Text dimColor>{sep}</Text> : ''}
          {i < at ? (
            <Text dimColor>{p}</Text>
          ) : i === at ? (
            <Text color="claude" bold>
              {p}
            </Text>
          ) : (
            <Text color="inactive">{p}</Text>
          )}
        </Text>
      ))}
    </Text>
  )
}

/** The card's text block: the header is the button that expands it; one dim subline is always shown; the body when expanded. */
type Card = { key: string; title: string; subline: string; body: JSX.Element[] }

function drawCard(els: Els, row: Row, ui: Ui, act: Actions, width: number, theme: Theme, now: number): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  const color = cardColor(row)
  const art = ART[row.kind]
  const textWidth = Math.max(10, width - 4 - 6)
  const card = cardOf(els, row, theme, now, textWidth)
  return (
    <Box key={`card-${row.id}`} borderStyle="round" borderColor={color} paddingX={1} flexDirection="row" marginBottom={1}>
      <Box flexDirection="column" width={5} flexShrink={0}>
        <Text color={color}>{art[0]}</Text>
        <Text color={color}>{art[1]}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Button key={card.key} plain onPress={() => act.toggleRow(row.id)}>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text bold color={color}>
            {cut(card.title, textWidth - 2)}
          </Text>
        </Button>
        <Text dimColor wrap="truncate-end">
          {cut(card.subline, textWidth)}
        </Text>
        {isOpen && card.body.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {card.body}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function statsLine(stats: AgentStats, model: string, prices: Record<string, Price>): string {
  const money = spendText(spend([{ stats, model } as WorkerRow], prices))
  const bits = [`${stats.toolCalls} tool call${stats.toolCalls === 1 ? '' : 's'}`]
  if (money) bits.push(money)
  return bits.join(' · ')
}

function drawActivity(els: Els, items: readonly Activity[], width: number): JSX.Element[] {
  const { Text } = els
  return items.map((a, i) => (
    <Text key={`act-${i}-${a.at}`} wrap="truncate-end">
      <Text color={a.kind === 'tool' ? 'claude' : undefined} dimColor={a.kind === 'text'}>
        {a.kind === 'tool' ? '⚙ ' : '“ '}
      </Text>
      <Text dimColor={a.kind === 'text'}>{cut(a.text, Math.max(10, width - 3))}</Text>
    </Text>
  ))
}

function cardOf(els: Els, row: Row, theme: Theme, now: number, width: number): Card {
  const { Box, Text } = els
  if (row.kind === 'user' || row.kind === 'orchestrator') {
    return {
      key: `note-${row.id}`,
      title: row.kind === 'user' ? 'User message' : 'Orchestrator',
      subline: row.text,
      body: [
        <Text key="text" wrap="wrap">
          {row.text.trim()}
        </Text>,
      ],
    }
  }
  const span = row.status === 'pending' ? 'waiting' : elapsed(row.at, isActive(row) ? now : (row.endedAt ?? now))
  if (row.kind === 'worker') {
    return {
      key: `worker-${row.id}`,
      title: row.title,
      subline: [span, row.model, statusWord[row.status]].join(' · '),
      body: [
        <Text key="stats" dimColor wrap="truncate-end">
          {statsLine(row.stats, row.model, theme.prices)}
        </Text>,
        ...(row.stats.activity.length > 0
          ? [
              <Box key="feed" marginTop={1} flexDirection="column">
                {drawActivity(els, row.stats.activity, width)}
              </Box>,
            ]
          : []),
        ...(row.note
          ? [
              <Box key="note" marginTop={1}>
                <Text wrap="wrap">
                  <Text dimColor>↳ </Text>
                  {row.note.trim()}
                </Text>
              </Box>,
            ]
          : []),
      ],
    }
  }
  return {
    key: `qa-${row.id}`,
    title: `QA round ${row.round}${row.summary ? `: ${verdictWord(row)}` : ''}`,
    subline: [span, row.model, row.summary ? scoreLine(row) : statusWord[row.status]].join(' · '),
    body: [
      <Text key="stats" dimColor wrap="truncate-end">
        {statsLine(row.stats, row.model, theme.prices)}
      </Text>,
      <Text key="score" wrap="wrap">
        {scoreLine(row)}
      </Text>,
      row.overview ? (
        <Box key="overview" marginTop={1}>
          <Text wrap="wrap">{row.overview}</Text>
        </Box>
      ) : (
        <Text key="overview" dimColor>
          {row.status === 'running' || row.status === 'stale' || row.status === 'pending'
            ? 'The QA agent is still working; the overview appears when its report is collected.'
            : (row.note ?? 'No overview was collected.')}
        </Text>
      ),
      ...(row.items && row.items.some(i => i.score !== 'strong')
        ? [
            <Box key="items" flexDirection="column" marginTop={1}>
              {row.items
                .filter(i => i.score !== 'strong')
                .map(i => (
                  <Text key={`item-${row.id}-${i.id}`} wrap="wrap">
                    <Text color={i.score === 'unacceptable' ? 'error' : 'warning'}>{i.score}</Text>
                    {` ${i.title}${i.note ? `: ${i.note}` : ''}`}
                  </Text>
                ))}
            </Box>,
          ]
        : []),
      ...(row.stats.activity.length > 0
        ? [
            <Box key="feed" marginTop={1} flexDirection="column">
              {drawActivity(els, row.stats.activity, width)}
            </Box>,
          ]
        : []),
    ],
  }
}

// ---------- the band above the prompt ----------

export function drawBand(els: Els, snap: Snapshot, act: Actions, columns: number, maxRows: number, theme: Theme): JSX.Element | null {
  const { Box, Text, Button } = els
  const { run, rows, ui } = snap
  if (!run || ui.isBandHidden || run.status === 'done' || run.status === 'aborted') return null
  const current = rows.filter(r => r.iteration === run.iteration)
  const workers = current.filter((r): r is WorkerRow => r.kind === 'worker')
  const running = workers.filter(w => w.status === 'running' || w.status === 'stale').length
  const waiting = workers.filter(w => w.status === 'pending').length
  const done = workers.filter(w => w.status === 'finished' || w.status === 'merged').length
  const trouble = workers.length - running - waiting - done
  const qa = current.filter((r): r is QaRow => r.kind === 'qa').pop()
  const money = spendText(spend(rows.filter(isAgentRow), theme.prices, run.orchestrator))

  const workerBits: string[] = []
  if (running > 0) workerBits.push(`${running} running`)
  if (waiting > 0) workerBits.push(`${waiting} waiting`)
  if (done > 0) workerBits.push(`${done} done`)
  if (trouble > 0) workerBits.push(`${trouble} failed`)
  const second: string[] = []
  if (workerBits.length > 0) second.push(`agents ${workerBits.join(', ')}`)
  if (qa) second.push(`QA ${verdictWord(qa)}`)
  if (money) second.push(money)

  const first = `task-loop${SEP}${run.phase}`
  const buttons = (
    <Box flexDirection="row" flexShrink={0}>
      <Button key="open-pane" plain onPress={() => act.openPane()}>
        timeline
      </Button>
      <Text dimColor>{'  '}</Text>
      <Button key="hide-band" plain dimColor onPress={() => act.hideBand()}>
        hide
      </Button>
    </Box>
  )

  if (maxRows < 4) {
    const one = [first, ...second].join(SEP)
    return (
      <Box flexDirection="row">
        <Text dimColor wrap="truncate-end">
          {cut(one, Math.max(10, columns - 18))}{' '}
        </Text>
        {buttons}
      </Box>
    )
  }
  const inner = Math.max(10, columns - 4)
  return (
    <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="claude" bold>
          task-loop
        </Text>
        <Text dimColor>{SEP}</Text>
        <Text bold>{run.phase}</Text>
        <Text dimColor>{`${SEP}${cut(run.task, Math.max(8, inner - 24 - run.phase.length))}`}</Text>
      </Text>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {cut(second.join(SEP) || 'nothing running yet', Math.max(8, inner - 18))}
        </Text>
        {buttons}
      </Box>
    </Box>
  )
}
