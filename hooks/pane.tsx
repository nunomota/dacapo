import type { Elements } from 'claude-code'

import type { Activity, AgentStats, IterationInfo, OrchestratorRow, Phase, QaRow, Row, Run, Ui, UserRow, WorkerRow } from '../types'
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

const pad = (n: number) => (n > 0 ? ' '.repeat(n) : '')

export const isAgentRow = (row: Row): row is WorkerRow | QaRow => row.kind === 'worker' || row.kind === 'qa'
export const isActive = (row: Row): boolean => isAgentRow(row) && (row.status === 'running' || row.status === 'stale')

export const ICON = { worker: '⚒', qa: '⚖', user: '✎', orchestrator: '◆' } as const

/** The color a row's text and mark take from its status; `dim` for the states that are not news. */
export type Tone = { color?: string; dim?: boolean }

export function tone(row: WorkerRow | QaRow): Tone {
  switch (row.status) {
    case 'pending':
    case 'cancelled':
      return { dim: true }
    case 'running':
      return { color: 'claude' }
    case 'finished':
      return { color: 'success' }
    case 'merged':
      return { color: 'success', dim: true }
    case 'failed':
    case 'invalid':
    case 'timeout':
      return { color: 'error' }
    case 'stale':
      return { color: 'warning' }
  }
}

export function mark(row: WorkerRow | QaRow): string {
  switch (row.status) {
    case 'pending':
      return '○'
    case 'running':
      return '●'
    case 'finished':
    case 'merged':
      return '✓'
    case 'failed':
    case 'invalid':
      return '✗'
    case 'stale':
      return '…'
    case 'timeout':
      return '⏱'
    case 'cancelled':
      return '∅'
  }
}

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
  const state = run.status === 'done' ? 'Finished' : run.status === 'aborted' ? 'Aborted' : run.status === 'planning' ? 'Planning' : 'Running'
  const iterations = run.iterations.length || (rows.some(isAgentRow) ? run.iteration : 0)

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        <Text bold wrap="truncate-end">
          {cut(run.task, inner)}
        </Text>
        <Text wrap="truncate-end">
          <Text color={run.status === 'done' ? 'success' : run.status === 'aborted' ? 'error' : 'claude'}>{state}</Text>
          <Text dimColor>{SEP}</Text>
          {elapsed(run.startedAt, endAt)}
          <Text dimColor>{SEP}</Text>
          {`${agents.length}`}
          <Text dimColor>{agents.length === 1 ? ' agent' : ' agents'}</Text>
          <Text dimColor>{SEP}</Text>
          {`${iterations}`}
          <Text dimColor>{iterations === 1 ? ' iteration' : ' iterations'}</Text>
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
        <Text dimColor>{'─'.repeat(width)}</Text>
      </Box>
      {Array.from({ length: run.iteration }, (_, i) => i + 1)
        .filter(n => n <= iterations || rows.some(r => r.iteration === n))
        .map(n => drawIteration(els, snap, act, width, theme, n, now))}
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

function iterationOf(run: Run, n: number): IterationInfo {
  return run.iterations.find(i => i.n === n) ?? { n, title: `Iteration ${n}`, startedAt: run.startedAt }
}

function drawIteration(els: Els, snap: Snapshot, act: Actions, width: number, theme: Theme, n: number, now: number): JSX.Element {
  const { Box, Text, Button } = els
  const { run, rows, ui } = snap
  const info = iterationOf(run!, n)
  const isCollapsed = ui.collapsed.includes(n)
  const inner = width - 4
  const mine = rows.filter(r => r.iteration === n).sort((a, b) => a.at - b.at)
  const workers = mine.filter((r): r is WorkerRow => r.kind === 'worker')
  const qas = mine.filter((r): r is QaRow => r.kind === 'qa')
  const done = workers.filter(w => w.status === 'finished' || w.status === 'merged').length
  const verdict = verdictWord(qas[qas.length - 1])
  const money = spendText(spend(mine.filter(isAgentRow), theme.prices))
  const bits: string[] = []
  if (workers.length > 0) bits.push(`${done}/${workers.length} workers`)
  if (verdict) bits.push(`QA ${verdict}`)
  if (money) bits.push(money)
  const tail = bits.join(SEP)
  const head = `${isCollapsed ? '▸' : '▾'} `
  const title = cut(info.title, Math.max(10, inner - head.length - (tail ? tail.length + 2 : 0)))
  const fill = pad(inner - head.length - title.length - (tail ? tail.length : 0))

  return (
    <Box key={`iteration-${n}`} borderStyle="round" borderDimColor paddingX={1} flexDirection="column" marginBottom={1}>
      <Button key={`iter-${n}`} plain onPress={() => act.toggleIteration(n)}>
        {head}
        <Text bold>{title}</Text>
        {fill}
        <Text dimColor>{tail}</Text>
      </Button>
      {!isCollapsed && info.overview && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {info.overview}
          </Text>
        </Box>
      )}
      {!isCollapsed && mine.length > 0 && (
        <Box flexDirection="column" marginTop={info.overview ? 1 : 0}>
          {mine.map(row => drawRow(els, row, ui, act, inner, theme, now))}
        </Box>
      )}
    </Box>
  )
}

/** One row: `▸ ⚒  description` in the status color, the mark on the right edge; the whole line is the button that expands it. */
function line(els: Els, icon: string, isOpen: boolean, label: string, t: Tone, m: string | undefined, width: number) {
  const { Text } = els
  const head = `${isOpen ? '▾' : '▸'} ${icon}  `
  const room = width - head.length - (m ? 2 : 0)
  const text = cut(label, Math.max(6, room))
  return [
    <Text key="h" dimColor>
      {head}
    </Text>,
    <Text key="l" color={t.color} dimColor={t.dim}>
      {text}
    </Text>,
    m ? pad(room - text.length + 1) : '',
    m ? (
      <Text key="m" color={t.color} dimColor={t.dim}>
        {m}
      </Text>
    ) : (
      ''
    ),
  ]
}

function drawRow(els: Els, row: Row, ui: Ui, act: Actions, width: number, theme: Theme, now: number): JSX.Element {
  if (row.kind === 'user' || row.kind === 'orchestrator') return drawNote(els, row, ui, act, width)
  return row.kind === 'worker' ? drawWorker(els, row, ui, act, width, theme, now) : drawQa(els, row, ui, act, width, theme, now)
}

function detail(els: Els, children: JSX.Element[]): JSX.Element {
  const { Box } = els
  return (
    <Box paddingLeft={5} flexDirection="column" marginBottom={1}>
      {children}
    </Box>
  )
}

function drawNote(els: Els, row: UserRow | OrchestratorRow, ui: Ui, act: Actions, width: number): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  const label = row.kind === 'user' ? 'User message' : 'Orchestrator'
  return (
    <Box key={`row-${row.id}`} flexDirection="column">
      <Button key={`note-${row.id}`} plain onPress={() => act.toggleRow(row.id)}>
        {line(els, ICON[row.kind], isOpen, label, {}, undefined, width)}
      </Button>
      {isOpen &&
        detail(els, [
          <Text key="when" dimColor>
            {stamp(row.at)}
          </Text>,
          <Text key="text" wrap="wrap">
            {row.text.trim()}
          </Text>,
        ])}
    </Box>
  )
}

function statsBits(stats: AgentStats, model: string, prices: Record<string, Price>): string[] {
  const money = spendText(spend([{ stats, model } as WorkerRow], prices))
  const bits = [`${stats.steps} step${stats.steps === 1 ? '' : 's'}`, `${stats.toolCalls} tool call${stats.toolCalls === 1 ? '' : 's'}`]
  if (money) bits.push(money)
  return bits
}

function drawActivity(els: Els, items: readonly Activity[], width: number): JSX.Element[] {
  const { Text } = els
  return items.map((a, i) => (
    <Text key={`act-${i}-${a.at}`} wrap="truncate-end">
      <Text dimColor>{clock(a.at)} </Text>
      <Text color={a.kind === 'tool' ? 'claude' : undefined} dimColor={a.kind === 'text'}>
        {a.kind === 'tool' ? '⚙ ' : '“ '}
      </Text>
      <Text dimColor={a.kind === 'text'}>{cut(a.text, Math.max(10, width - 12))}</Text>
    </Text>
  ))
}

function drawWorker(els: Els, row: WorkerRow, ui: Ui, act: Actions, width: number, theme: Theme, now: number): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  const span = row.status === 'pending' ? 'not started' : elapsed(row.at, isActive(row) ? now : (row.endedAt ?? now))
  const first = [stamp(row.at), span, statusWord[row.status], row.stats.modelId ?? row.model, ...statsBits(row.stats, row.model, theme.prices)].join(' · ')
  return (
    <Box key={`row-${row.id}`} flexDirection="column">
      <Button key={`worker-${row.id}`} plain onPress={() => act.toggleRow(row.id)}>
        {line(els, ICON.worker, isOpen, row.title, tone(row), mark(row), width)}
      </Button>
      {isOpen &&
        detail(els, [
          <Text key="when" dimColor wrap="truncate-end">
            {first}
          </Text>,
          <Text key="branch" dimColor wrap="truncate-end">
            {row.branch} → {row.commit}
          </Text>,
          ...(row.stats.activity.length > 0
            ? [
                <Box key="feed" marginTop={1} flexDirection="column">
                  {drawActivity(els, row.stats.activity, width - 5)}
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
        ])}
    </Box>
  )
}

function drawQa(els: Els, row: QaRow, ui: Ui, act: Actions, width: number, theme: Theme, now: number): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  const span = row.status === 'pending' ? 'not started' : elapsed(row.at, isActive(row) ? now : (row.endedAt ?? now))
  const first = [stamp(row.at), span, statusWord[row.status], row.stats.modelId ?? row.model, ...statsBits(row.stats, row.model, theme.prices)].join(' · ')
  const label = `QA round ${row.round}${row.summary ? `: ${verdictWord(row)}` : ''}`
  return (
    <Box key={`row-${row.id}`} flexDirection="column">
      <Button key={`qa-${row.id}`} plain onPress={() => act.toggleRow(row.id)}>
        {line(els, ICON.qa, isOpen, label, tone(row), mark(row), width)}
      </Button>
      {isOpen &&
        detail(els, [
          <Text key="when" dimColor wrap="truncate-end">
            {first}
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
                  {drawActivity(els, row.stats.activity, width - 5)}
                </Box>,
              ]
            : []),
        ])}
    </Box>
  )
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
  const info = run.iterations.find(i => i.n === run.iteration)

  const workerBits: string[] = []
  if (running > 0) workerBits.push(`${running} running`)
  if (waiting > 0) workerBits.push(`${waiting} waiting`)
  if (done > 0) workerBits.push(`${done} done`)
  if (trouble > 0) workerBits.push(`${trouble} failed`)
  const second: string[] = []
  if (workerBits.length > 0) second.push(`${ICON.worker} ${workerBits.join(', ')}`)
  if (qa) second.push(`${ICON.qa} QA ${verdictWord(qa)}`)
  if (money) second.push(money)

  const first = `${ICON.orchestrator} task-loop${SEP}${run.phase}${info ? `${SEP}${info.title}` : ''}`
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
          {ICON.orchestrator} task-loop
        </Text>
        <Text dimColor>{SEP}</Text>
        <Text bold>{run.phase}</Text>
        {info ? <Text dimColor>{`${SEP}${cut(info.title, Math.max(8, inner - 24 - run.phase.length))}`}</Text> : ''}
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
