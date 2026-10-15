import type { Elements } from 'claude-code'

import type { Activity, AgentStats, OrchestratorRow, Phase, Pr, PrState, QaRow, Row, Run, Ui, UserRow, WorkerRow } from '../types'
import { ZERO, addUsage, costOf, fmtCost, fmtTokens, totalTokens, type Price } from './cost'

/** The elements every surface has; the hook resolves the table and hands these in. */
export type Els = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
  Link: Elements['terminal']['Link']
  /** Present on the surfaces that draw vector icons (desktop, VS Code, mobile); the terminal gets a glyph. */
  Svg?: Elements['desktop']['Svg']
}

export type Snapshot = { run: Run | null; rows: Row[]; ui: Ui }

export type Actions = {
  toggleRow: (id: string) => void
  togglePrList: () => void
  openPane: () => void
  hideBand: () => void
}

export type Theme = { prices: Record<string, Price> }

export const PHASES: readonly Phase[] = ['clarify', 'research', 'plan', 'implement', 'qa', 'release']

const two = (n: number) => `${n}`.padStart(2, '0')

export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
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

/** How many rows `text` takes when wrapped at `width`: the estimate the timeline's vertical line is drawn from. */
export function rowsOf(text: string, width: number): number {
  const w = Math.max(8, width)
  let rows = 0
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(line.length / w))
  return rows
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

/** Entry colors: the person white, the orchestrator purple, QA cyan, a sub-agent by its status. */
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

/** Vector icons for the surfaces that draw SVG (desktop, VS Code, mobile), in the entry's color. */
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

// ---------- pull requests ----------

/** GitHub's colors for a pull request's state. */
export const PR_COLOR: Record<PrState, string> = { draft: '#8b949e', open: '#2da44e', merged: '#8957e5', closed: '#e5534b' }

export const PR_GLYPH: Record<PrState, string> = { draft: '◌', open: '●', merged: '◆', closed: '⊘' }

/** GitHub's octicons for a pull request's state (git-pull-request, -draft, -closed, git-merge; MIT, github.com/primer/octicons). */
const PR_PATH: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  draft:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
  closed:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  merged:
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
}

export const prIcon = (state: PrState): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="${PR_COLOR[state]}"><path d="${PR_PATH[state]}"/></svg>`

/** The pull requests of one branch, newest first. */
export const prsOf = (run: Run, branch: string): Pr[] => run.prs.filter(p => p.head === branch).sort((a, b) => b.createdAt - a.createdAt)

export const prWord: Record<PrState, string> = { draft: 'draft', open: 'open', merged: 'merged', closed: 'closed' }

/** `#12 feat: add login (open, checks failing)` for the text surfaces of the run. */
export const prText = (pr: Pr): string => `#${pr.number} ${pr.title} (${prWord[pr.state]}${pr.checks === 'failing' ? ', checks failing' : pr.checks === 'pending' ? ', checks running' : ''}${pr.mergeable === 'conflicting' ? ', conflicting' : ''})`

/** One pull request as a line: its state icon, its title as a link to GitHub, and a red cross when its checks fail. */
function drawPr(els: Els, pr: Pr, key: string): JSX.Element {
  const { Box, Text, Link, Svg } = els
  const color = PR_COLOR[pr.state]
  return (
    <Box key={key} flexDirection="row" alignItems="center" overflow="hidden">
      <Box flexShrink={0} marginRight={1}>
        {Svg ? <Svg source={prIcon(pr.state)} alt={`pull request ${prWord[pr.state]}`} width={14} height={14} /> : <Text color={color}>{PR_GLYPH[pr.state]}</Text>}
      </Box>
      <Box flexShrink={1} overflow="hidden">
        <Link href={pr.url}>
          <Text color={color} wrap="truncate-end">
            {pr.title}
          </Text>
        </Link>
      </Box>
      {pr.checks === 'failing' ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text color="error">✕</Text>
        </Box>
      ) : (
        ''
      )}
    </Box>
  )
}

/** Consecutive messages from the person, or from the orchestrator, fold into one entry. */
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
  const { Box, Text, Button } = els
  const { run, rows, ui } = snap
  if (!run) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No dacapo run in this session. Start one with /dacapo.</Text>
      </Box>
    )
  }
  const width = Math.max(28, columns)
  const now = ui.tick
  const isOver = run.status === 'done' || run.status === 'aborted'
  const endAt = isOver ? (rows[rows.length - 1]?.at ?? now) : now
  const agents = rows.filter(isAgentRow)
  const total = spend(agents, theme.prices, run.orchestrator)
  const prs = [...run.prs].sort((a, b) => a.createdAt - b.createdAt)
  const counts = (['merged', 'open', 'draft', 'closed'] as const).map(s => [s, prs.filter(p => p.state === s).length] as const).filter(([, n]) => n > 0)
  const entries = entriesOf(rows)

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        {run.task ? (
          <Text bold wrap="truncate-end">
            {run.task.replace(/\s+/g, ' ').trim()}
          </Text>
        ) : (
          <Text dimColor italic wrap="truncate-end">
            Clarifying the task…
          </Text>
        )}
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
          {prs.length > 0 ? (
            <Text>
              <Text dimColor>{SEP}</Text>
              {`${prs.length}`}
              <Text dimColor>{prs.length === 1 ? ' PR' : ' PRs'}</Text>
            </Text>
          ) : (
            ''
          )}
        </Text>
        {drawPhases(els, run.phase, width - 4)}
        {prs.length > 0 && (
          <Box flexDirection="column">
            <Button key="pr-list" plain onPress={() => act.togglePrList()}>
              <Text dimColor>{ui.isPrListOpen ? '▾ ' : '▸ '}</Text>
              <Text wrap="truncate-end">
                {`${prs.length} pull request${prs.length === 1 ? '' : 's'}`}
                <Text dimColor>{counts.map(([s, n]) => ` · ${n} ${s}`).join('')}</Text>
              </Text>
            </Button>
            {ui.isPrListOpen && (
              <Box flexDirection="column" paddingLeft={2}>
                {prs.map(pr => drawPr(els, pr, `top-pr-${pr.number}`))}
              </Box>
            )}
          </Box>
        )}
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
      {entries.map((entry, i) => drawEntry(els, entry, ui, act, width, theme, now, run, i === entries.length - 1))}
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

/**
 * One timeline entry: the header is the button that expands it; the subline is always shown, dim; the body when
 * expanded. `bodyRows` is the body's height as estimated, so the vertical line can be drawn beside it.
 */
type Card = { id: string; key: string; kind: Row['kind']; color: string; title: string; subline: JSX.Element; body: JSX.Element[]; bodyRows: number }

/** The icon column: the entry's icon where a timeline dot would be, and the line running down from it. */
const ICON_COLS = 3

function drawEntry(els: Els, entry: Entry, ui: Ui, act: Actions, width: number, theme: Theme, now: number, run: Run, isLast: boolean): JSX.Element {
  const { Box, Text, Button, Svg } = els
  // the text column gets an explicit width: the desktop's column count is approximate for its font, and without a
  // bound the surface never truncates or wraps
  const textWidth = Math.max(16, width - ICON_COLS - 3)
  const card = entry.kind === 'agent' ? agentCard(els, entry.row, theme, now, run, textWidth) : messagesCard(els, entry.rows, textWidth)
  const isOpen = ui.expanded.includes(card.id)
  // the line covers the subline, the body when open, and the blank row before the next entry
  const lineRows = 1 + (isOpen ? card.bodyRows : 0) + (isLast ? 0 : 1)
  return (
    <Box key={`entry-${card.id}`} flexDirection="row" alignItems="flex-start" overflow="hidden">
      <Box flexDirection="column" width={ICON_COLS} flexShrink={0} alignItems="center">
        {Svg ? (
          <Svg source={icon(card.kind, card.color)} alt={card.kind} width={16} height={16} />
        ) : (
          <Text color={card.color}>{GLYPH[card.kind]}</Text>
        )}
        {lineRows > 0 ? <Text dimColor>{Array.from({ length: lineRows }, () => '│').join('\n')}</Text> : ''}
      </Box>
      <Box flexDirection="column" width={textWidth} flexShrink={0} marginLeft={1} paddingBottom={isLast ? 0 : 1}>
        <Button key={card.key} plain onPress={() => act.toggleRow(card.id)}>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text bold color={card.color} wrap="truncate-end">
            {card.title}
          </Text>
        </Button>
        {card.subline}
        {isOpen && card.body.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {card.body}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function messagesCard(els: Els, rows: (UserRow | OrchestratorRow)[], textWidth: number): Card {
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
    subline: (
      <Text dimColor wrap="truncate-end">
        {last.text.replace(/\s+/g, ' ').trim()}
      </Text>
    ),
    body: rows.map((r, i) => (
      <Box key={`msg-${r.id}`} marginTop={i > 0 ? 1 : 0}>
        <Text wrap="wrap">{r.text.trim()}</Text>
      </Box>
    )),
    bodyRows: 1 + rows.reduce((n, r, i) => n + rowsOf(r.text.trim(), textWidth) + (i > 0 ? 1 : 0), 0),
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

function agentCard(els: Els, row: WorkerRow | QaRow, theme: Theme, now: number, run: Run, textWidth: number): Card {
  const { Box, Text } = els
  const span = row.status === 'pending' ? 'waiting' : elapsed(row.at, isActive(row) ? now : (row.endedAt ?? now))
  const color = cardColor(row)
  const feed = row.stats.activity.length > 0 ? [<Box key="feed" marginTop={1} flexDirection="column">{drawActivity(els, row.stats.activity)}</Box>] : []
  const feedRows = row.stats.activity.length > 0 ? 1 + row.stats.activity.length : 0
  if (row.kind === 'worker') {
    const prs = prsOf(run, row.branch)
    const latest = prs[0]
    const lead = [span, row.model, ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · ')
    const subline = latest ? (
      <Box flexDirection="row" alignItems="center" overflow="hidden">
        <Box flexShrink={0}>
          <Text dimColor>{`${lead} · `}</Text>
        </Box>
        {drawPr(els, latest, `pr-${row.id}-${latest.number}`)}
      </Box>
    ) : (
      <Text dimColor wrap="truncate-end">
        {lead}
      </Text>
    )
    const noteRows = row.note ? 1 + rowsOf(row.note.trim(), textWidth) : 0
    return {
      id: row.id,
      key: `worker-${row.id}`,
      kind: 'worker',
      color,
      title: row.title,
      subline,
      body: [
        <Text key="stats" dimColor wrap="truncate-end">
          {statsLine(row.stats, row.model, theme.prices)}
        </Text>,
        ...(prs.length > 1 ? [<Box key="prs" flexDirection="column" marginTop={1}>{prs.map(pr => drawPr(els, pr, `pr-${row.id}-${pr.number}`))}</Box>] : []),
        ...feed,
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
      bodyRows: 1 + 1 + (prs.length > 1 ? 1 + prs.length : 0) + feedRows + noteRows,
    }
  }
  const weak = row.items ? row.items.filter(i => i.score !== 'strong') : []
  const overviewText = row.overview
    ? row.overview
    : row.status === 'running' || row.status === 'stale' || row.status === 'pending'
      ? 'The QA agent is still working; the overview appears when its report is collected.'
      : (row.note ?? 'No overview was collected.')
  return {
    id: row.id,
    key: `qa-${row.id}`,
    kind: 'qa',
    color,
    title: `QA round ${row.round}${row.summary ? `: ${verdictWord(row)}` : ''}`,
    subline: (
      <Text dimColor wrap="truncate-end">
        {[span, row.model, row.summary ? scoreLine(row) : statusWord[row.status], ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · ')}
      </Text>
    ),
    body: [
      <Text key="stats" dimColor wrap="truncate-end">
        {statsLine(row.stats, row.model, theme.prices)}
      </Text>,
      <Text key="score" wrap="wrap">
        {scoreLine(row)}
      </Text>,
      <Box key="overview" marginTop={1}>
        <Text wrap="wrap" dimColor={!row.overview}>
          {overviewText}
        </Text>
      </Box>,
      ...(weak.length > 0
        ? [
            <Box key="items" flexDirection="column" marginTop={1}>
              {weak.map(i => (
                <Text key={`item-${row.id}-${i.id}`} wrap="wrap">
                  <Text color={i.score === 'unacceptable' ? 'error' : 'warning'}>{i.score}</Text>
                  {` ${i.title}${i.note ? `: ${i.note}` : ''}`}
                </Text>
              ))}
            </Box>,
          ]
        : []),
      ...feed,
    ],
    bodyRows:
      1 +
      1 +
      rowsOf(scoreLine(row), textWidth) +
      1 +
      rowsOf(overviewText, textWidth) +
      (weak.length > 0 ? 1 + weak.reduce((n, i) => n + rowsOf(`${i.score} ${i.title}: ${i.note}`, textWidth), 0) : 0) +
      feedRows,
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
  const openPrs = run.prs.filter(p => p.state === 'open' || p.state === 'draft').length

  const workerBits: string[] = []
  if (running > 0) workerBits.push(`${running} running`)
  if (waiting > 0) workerBits.push(`${waiting} waiting`)
  if (done > 0) workerBits.push(`${done} done`)
  if (trouble > 0) workerBits.push(`${trouble} failed`)
  const second: string[] = []
  if (workerBits.length > 0) second.push(`agents ${workerBits.join(', ')}`)
  if (openPrs > 0) second.push(`${openPrs} open PR${openPrs === 1 ? '' : 's'}`)
  if (run.status === 'releasing' && run.release) second.push(`release PR #${run.release.number} waiting on checks`)
  if (qa) second.push(`QA ${verdictWord(qa)}`)
  if (money) second.push(money)

  const first = `dacapo${SEP}${run.phase}`
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
          dacapo
        </Text>
        <Text dimColor>{SEP}</Text>
        <Text bold>{run.phase}</Text>
        <Text dimColor>{`${SEP}${cut(run.task || 'clarifying the task', Math.max(8, inner - 24 - run.phase.length))}`}</Text>
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
