import type { Elements } from 'claude-code'

import type { Activity, AgentStats, OrchestratorRow, Phase, QaRow, Row, Run, Ui, UserRow, WorkerRow } from '../types'
import { ZERO, addUsage, costOf, fmtCost, fmtTokens, totalTokens, type Price } from './cost'

/** The three elements every surface has; the hook resolves the table and hands these in. */
export type Els = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
  /** Present on the surfaces that draw vector icons (desktop, VS Code, mobile); the terminal gets a glyph. */
  Svg?: Elements['desktop']['Svg']
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

/** The terminal's one-glyph stand-in for each icon. */
export const GLYPH: Record<Row['kind'], string> = { worker: '⚒', qa: '⚖', user: '✎', orchestrator: '◆' }

/** Vector icons for the surfaces that draw SVG (desktop, VS Code, mobile), in the card's color. */
export function icon(kind: Row['kind'], color: string): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
  const close = '</svg>'
  switch (kind) {
    case 'worker':
      // a robot head: antenna, face plate, two eyes, a mouth
      return `${open}<line x1="12" y1="2.5" x2="12" y2="6"/><circle cx="12" cy="2.5" r="0.9" fill="${color}"/><rect x="4" y="6" width="16" height="13" rx="3"/><circle cx="9" cy="12" r="1.4" fill="${color}" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="${color}" stroke="none"/><line x1="9" y1="16" x2="15" y2="16"/><line x1="2" y1="11" x2="4" y2="11"/><line x1="20" y1="11" x2="22" y2="11"/>${close}`
    case 'user':
      // a person: head and shoulders
      return `${open}<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5"/>${close}`
    case 'orchestrator':
      // a hub with three spokes: the one that coordinates the others
      return `${open}<circle cx="12" cy="12" r="3" fill="${color}" stroke="none"/><circle cx="12" cy="3.5" r="1.8"/><circle cx="4.5" cy="18" r="1.8"/><circle cx="19.5" cy="18" r="1.8"/><line x1="12" y1="9" x2="12" y2="5.3"/><line x1="9.6" y1="13.8" x2="6" y2="16.8"/><line x1="14.4" y1="13.8" x2="18" y2="16.8"/>${close}`
    case 'qa':
      // a clipboard with a check mark
      return `${open}<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2.5" width="6" height="3" rx="1" fill="${color}" stroke="none"/><path d="M8.5 13l2.5 2.5 4.5-5"/>${close}`
  }
}

/** Consecutive messages from the person, or from the orchestrator, fold into one card. */
export type Entry = { kind: 'messages'; rows: (UserRow | OrchestratorRow)[] } | { kind: 'agent'; row: WorkerRow | QaRow }

export function entriesOf(rows: readonly Row[]): Entry[] {
  const out: Entry[] = []
  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    if (row.kind === 'user' || row.kind === 'orchestrator') {
      const last = out[out.length - 1]
      if (last && last.kind === 'messages' && last.rows[0]!.kind === row.kind) last.rows.push(row)
      else out.push({ kind: 'messages', rows: [row] })
    } else out.push({ kind: 'agent', row })
  }
  return out
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
  const now = ui.tick
  const isOver = run.status === 'done' || run.status === 'aborted'
  const endAt = isOver ? (rows[rows.length - 1]?.at ?? now) : now
  const agents = rows.filter(isAgentRow)
  const total = spend(agents, theme.prices, run.orchestrator)

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        <Text bold wrap="truncate-end">
          {run.task}
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
        {drawPhases(els, run.phase, width - 4)}
      </Box>
      {run.pushProblem && (
        <Box paddingX={1} marginTop={1}>
          <Text color="warning" wrap="wrap">
            {run.pushProblem}
          </Text>
        </Box>
      )}
      {run.overview && (
        <Box paddingX={1} marginTop={1}>
          <Text dimColor wrap="wrap">
            {run.overview}
          </Text>
        </Box>
      )}
      <Box marginY={1}>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(10, width - 12))}
        </Text>
      </Box>
      {entriesOf(rows).map(entry => drawCard(els, entry, ui, act, width, theme, now))}
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
type Card = { id: string; key: string; kind: Row['kind']; color: string; title: string; subline: string; body: JSX.Element[] }

function drawCard(els: Els, entry: Entry, ui: Ui, act: Actions, width: number, theme: Theme, now: number): JSX.Element {
  const { Box, Text, Button, Svg } = els
  const card = entry.kind === 'agent' ? agentCard(els, entry.row, theme, now, width - 12) : messagesCard(els, entry.rows)
  const isOpen = ui.expanded.includes(card.id)
  // the text column gets an explicit width: border and padding take 4, the icon column 7 or 4, and a few cells of slack
  // because the desktop's column count is approximate for its font; without a bound the surface never truncates or wraps
  const iconCols = Svg ? 7 : 4
  const textWidth = Math.max(16, width - 4 - iconCols - 4)
  return (
    <Box key={`card-${card.id}`} borderStyle="round" borderColor={card.color} paddingX={1} flexDirection="row" marginBottom={1} overflow="hidden">
      <Box flexDirection="column" width={iconCols - 1} flexShrink={0} marginRight={1}>
        {Svg ? (
          <Svg source={icon(card.kind, card.color)} alt={card.kind} width={34} height={34} />
        ) : (
          <Text color={card.color}>{GLYPH[card.kind]}</Text>
        )}
      </Box>
      <Box flexDirection="column" width={textWidth} flexShrink={0}>
        <Button key={card.key} plain onPress={() => act.toggleRow(card.id)}>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text bold color={card.color} wrap="truncate-end">
            {card.title}
          </Text>
        </Button>
        <Text dimColor wrap="truncate-end">
          {card.subline.replace(/\s+/g, ' ').trim()}
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

function messagesCard(els: Els, rows: (UserRow | OrchestratorRow)[]): Card {
  const { Box, Text } = els
  const first = rows[0]!
  const last = rows[rows.length - 1]!
  const who = first.kind === 'user' ? 'User message' : 'Orchestrator'
  return {
    id: first.id,
    key: `note-${first.id}`,
    kind: first.kind,
    color: cardColor(first),
    title: rows.length > 1 ? `${who === 'User message' ? 'User messages' : who} (${rows.length})` : who,
    subline: last.text,
    body: rows.map((r, i) => (
      <Box key={`msg-${r.id}`} marginTop={i > 0 ? 1 : 0}>
        <Text wrap="wrap">{r.text.trim()}</Text>
      </Box>
    )),
  }
}

function statsLine(stats: AgentStats, model: string, prices: Record<string, Price>): string {
  const money = spendText(spend([{ stats, model } as WorkerRow], prices))
  const bits = [`${stats.toolCalls} tool call${stats.toolCalls === 1 ? '' : 's'}`]
  if (money) bits.push(money)
  return bits.join(' · ')
}

function drawActivity(els: Els, items: readonly Activity[]): JSX.Element[] {
  const { Text } = els
  return items.map((a, i) => (
    <Text key={`act-${i}-${a.at}`} wrap="truncate-end">
      <Text color={a.kind === 'tool' ? 'claude' : undefined} dimColor={a.kind === 'text'}>
        {a.kind === 'tool' ? '⚙ ' : '“ '}
      </Text>
      <Text dimColor={a.kind === 'text'}>{a.text.replace(/\s+/g, ' ')}</Text>
    </Text>
  ))
}

function agentCard(els: Els, row: WorkerRow | QaRow, theme: Theme, now: number, width: number): Card {
  const { Box, Text } = els
  const span = row.status === 'pending' ? 'waiting' : elapsed(row.at, isActive(row) ? now : (row.endedAt ?? now))
  const color = cardColor(row)
  if (row.kind === 'worker') {
    return {
      id: row.id,
      key: `worker-${row.id}`,
      kind: 'worker',
      color,
      title: row.title,
      subline: [span, row.model, statusWord[row.status], ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · '),
      body: [
        <Text key="stats" dimColor wrap="truncate-end">
          {statsLine(row.stats, row.model, theme.prices)}
        </Text>,
        ...(row.stats.activity.length > 0
          ? [
              <Box key="feed" marginTop={1} flexDirection="column">
                {drawActivity(els, row.stats.activity)}
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
    id: row.id,
    key: `qa-${row.id}`,
    kind: 'qa',
    color,
    title: `QA round ${row.round}${row.summary ? `: ${verdictWord(row)}` : ''}`,
    subline: [span, row.model, row.summary ? scoreLine(row) : statusWord[row.status], ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · '),
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
              {drawActivity(els, row.stats.activity)}
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
