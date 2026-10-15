import type { Elements } from 'claude-code'

import type { Activity, AgentStats, OrchestratorRow, Phase, Pr, PrState, QaRow, QaSummary, Row, Run, Ui, UserRow, WorkerRow } from '../types'
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
  toggleSection: (name: Section) => void
  toggleTimelineFull: () => void
  openPane: () => void
  hideBand: () => void
}

export type Theme = { prices: Record<string, Price> }

/** The collapsible progress rows of the badge. */
export type Section = 'prs' | 'agents' | 'qa' | 'timeline'

/** Every phase has a color of its own; the bar shows the ones reached in it and the current one's name. */
export const PHASE_COLOR: Record<Phase, string> = { clarify: '#378ADD', research: '#7F77DD', plan: '#1D9E75', implement: '#D85A30', qa: '#EF9F27', merge: '#639922' }

/** The state colors: teal in progress, green done, yellow done with limitations or recommendations, orange failed. */
export const TEAL = '#39c5cf'
export const GREEN = '#3fb950'
export const YELLOW = '#e3b341'
export const ORANGE = '#e8723a'
/** The failure color; orange reads better than red beside the yellow. */
export const RED = ORANGE

export const PHASES: readonly Phase[] = ['clarify', 'research', 'plan', 'implement', 'qa', 'merge']

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

/** The counts of strong, acceptable and unacceptable items in green, yellow and red; a zero count is left out. */
export function scoreNumbers(els: Els, s: QaSummary, key: string): JSX.Element {
  const { Text } = els
  const parts = ([
    [s.strong, GREEN],
    [s.acceptable, YELLOW],
    [s.unacceptable, RED],
  ] as const).filter(([n]) => n > 0)
  return (
    <Text key={key}>
      {parts.map(([n, color], i) => (
        <Text key={`${key}-${color}`}>
          {i > 0 ? <Text dimColor> · </Text> : ''}
          <Text color={color}>{`${n}`}</Text>
        </Text>
      ))}
    </Text>
  )
}

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
export const CYAN = TEAL

/** A QA round's color: cyan while it runs, then green for a pass, yellow for recommendations, red for fix or a failure. */
export function qaColor(row: QaRow): string {
  if (row.status === 'running' || row.status === 'stale' || row.status === 'pending') return TEAL
  if (!row.summary) return RED
  return row.summary.verdict === 'pass' ? GREEN : row.summary.verdict === 'pass-with-recommendations' ? YELLOW : RED
}

/**
 * A worker's color: teal while it waits or runs; green once it finished and its work landed; yellow when it finished
 * with limitations; orange when it failed, timed out, was cancelled, or finished without its pull request merged.
 * A worker that ended without the status line is judged by its pull request, so `run` is needed for that.
 */
export function workerColor(row: WorkerRow, run?: Run): string {
  switch (row.status) {
    case 'pending':
    case 'running':
    case 'stale':
      return TEAL
    case 'merged':
      return row.outcome === 'limited' ? YELLOW : GREEN
    case 'finished': {
      if (row.outcome === 'limited') return YELLOW
      if (row.outcome === 'done') return GREEN
      const landed = run ? prsOf(run, row.branch).some(p => p.state === 'merged') : false
      return landed ? GREEN : ORANGE
    }
    default:
      return ORANGE
  }
}

export function cardColor(row: Row, run?: Run): string {
  if (row.kind === 'user') return 'white'
  if (row.kind === 'orchestrator') return PURPLE
  if (row.kind === 'qa') return qaColor(row)
  return workerColor(row, run)
}

/** True while a worker or QA agent is still at work: its icon moves and is drawn in teal. */
export const isInProgress = (row: Row): boolean => isAgentRow(row) && (row.status === 'pending' || row.status === 'running' || row.status === 'stale')

/** The terminal's stand-in for a moving icon: a spinner that the ticker turns once a second. */
export const spinner = (tick: number): string => ['◐', '◓', '◑', '◒'][Math.floor(tick / 1000) % 4]!

/** The terminal's one-glyph stand-in for each icon. */
export const GLYPH: Record<Row['kind'], string> = { worker: '⚒', qa: '⚖', user: '✎', orchestrator: '⟲' }

/** Vector icons for the surfaces that draw SVG (desktop, VS Code, mobile), in the entry's color. */
export function icon(kind: Row['kind'], color: string, isLive = false): string {
  // a live icon breathes: its opacity swings on a loop (SMIL, drawn when the surface runs the SVG as a frame)
  const pulse = isLive ? '<animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite"/>' : ''
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${pulse}`
  const close = '</svg>'
  switch (kind) {
    case 'worker':
      // a robot head: antenna, face plate, two eyes, a mouth
      return `${open}<line x1="12" y1="2.5" x2="12" y2="6"/><circle cx="12" cy="2.5" r="0.9" fill="${color}"/><rect x="4" y="6" width="16" height="13" rx="3"/><circle cx="9" cy="12" r="1.4" fill="${color}" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="${color}" stroke="none"/><line x1="9" y1="16" x2="15" y2="16"/><line x1="2" y1="11" x2="4" y2="11"/><line x1="20" y1="11" x2="22" y2="11"/>${close}`
    case 'user':
      // a person: head and shoulders
      return `${open}<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5"/>${close}`
    case 'orchestrator':
      // the repeat sign in a thin rounded frame: da capo, from the top, again
      return `${open}<rect x="1.75" y="1.75" width="20.5" height="20.5" rx="5" stroke-width="1.5"/><g fill="${color}" stroke="none"><rect x="6.2" y="6" width="2.6" height="12" rx="0.7"/><rect x="10.4" y="6" width="1.2" height="12" rx="0.5"/><circle cx="15.6" cy="9.8" r="1.5"/><circle cx="15.6" cy="14.2" r="1.5"/></g>${close}`
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
          <Text color={ORANGE}>✕</Text>
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

const LOGO_COLS = 9
const KEY_COLS = 9
const BLOCK_COLS = 5

/** The dacapo mark, the framed repeat sign, drawn large beside the key lines. */
function logo(els: Els): JSX.Element {
  const { Box, Text, Svg } = els
  if (Svg) {
    return (
      <Box width={LOGO_COLS} flexShrink={0} alignItems="center" justifyContent="center" marginRight={1}>
        <Svg source={icon('orchestrator', PHASE_COLOR.implement)} alt="dacapo" width={64} height={64} />
      </Box>
    )
  }
  // the repeat sign, framed: thick bar, thin bar, two dots
  const art = ['╭─────╮', '│ ┃│ ●│', '│ ┃│  │', '│ ┃│ ●│', '╰─────╯']
  return (
    <Box width={LOGO_COLS} flexShrink={0} flexDirection="column" alignItems="center" justifyContent="center" marginRight={1}>
      {art.map((line, i) => (
        <Text key={`logo-${i}`} color={PHASE_COLOR.implement}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

function keyLine(els: Els, key: string, value: JSX.Element | string): JSX.Element {
  const { Box, Text } = els
  return (
    <Box key={`key-${key}`} flexDirection="row">
      <Box width={KEY_COLS} flexShrink={0}>
        <Text color="claude">{key}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {typeof value === 'string' ? <Text wrap="truncate-end">{value}</Text> : value}
      </Box>
    </Box>
  )
}

/** How many of the latest entries the timeline shows until "earlier" is pressed. */
export const TIMELINE_LATEST = 5

/**
 * Six blocks, one per phase: the ones done greyed out, the current one in its own color with its name beneath,
 * the ones ahead hollow. A merged run fills every block green and reads "merged"; an aborted one stops on
 * its phase in orange and reads "aborted". One SVG on the remote surfaces so the label sits under its block
 * whatever the font; glyph rows in the terminal.
 */
function drawBar(els: Els, current: Phase, status: Run['status']): JSX.Element {
  const { Box, Text, Svg } = els
  const at = PHASES.indexOf(current)
  const grey = '#6e7681'
  const isMerged = status === 'done'
  const isAborted = status === 'aborted'
  const label = isMerged ? 'merged' : isAborted ? 'aborted' : current
  const labelColor = isMerged ? GREEN : isAborted ? ORANGE : PHASE_COLOR[current]
  const labelAt = isMerged ? PHASES.length - 1 : at
  // the fill of block i: a color, grey, or null for hollow
  const fillOf = (p: Phase, i: number): string | null => (isMerged ? GREEN : i < at ? grey : i === at ? (isAborted ? ORANGE : PHASE_COLOR[p]) : null)
  if (Svg) {
    const w = 46
    const gap = 6
    const bar = 13
    const rects = PHASES.map((p, i) => {
      const x = i * (w + gap)
      const fill = fillOf(p, i)
      return fill
        ? `<rect x="${x}" y="0" width="${w}" height="${bar}" rx="3" fill="${fill}"/>`
        : `<rect x="${x + 0.5}" y="0.5" width="${w - 1}" height="${bar - 1}" rx="3" fill="none" stroke="${grey}" stroke-width="1"/>`
    })
    const cx = labelAt * (w + gap) + w / 2
    const total = PHASES.length * (w + gap) - gap
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${bar + 18}">${rects.join('')}<text x="${cx}" y="${bar + 14}" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="12" fill="${labelColor}">${label}</text></svg>`
    return (
      <Box>
        <Svg source={source} alt={`phase ${label}`} width={total} height={bar + 18} />
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>
        {PHASES.map((p, i) => {
          const fill = fillOf(p, i)
          return (
            <Text key={`bar-${p}`}>
              {i > 0 ? ' ' : ''}
              {fill === null ? <Text dimColor>{'░'.repeat(BLOCK_COLS)}</Text> : fill === grey ? <Text dimColor>{'█'.repeat(BLOCK_COLS)}</Text> : <Text color={fill}>{'█'.repeat(BLOCK_COLS)}</Text>}
            </Text>
          )
        })}
      </Text>
      <Box paddingLeft={labelAt * (BLOCK_COLS + 1)}>
        <Text color={labelColor}>{label}</Text>
      </Box>
    </Box>
  )
}

/** A count beside an icon in one color: `◆ 3` on the terminal, the SVG icon on the others. */
function countChip(els: Els, key: string, color: string, svg: string | null, glyph: string, n: number): JSX.Element {
  const { Box, Text, Svg } = els
  return (
    <Box key={key} flexDirection="row" alignItems="center" marginRight={2}>
      {Svg && svg ? <Svg source={svg} alt={key} width={14} height={14} /> : <Text color={color}>{glyph}</Text>}
      <Text color={color}>{` ${n}`}</Text>
    </Box>
  )
}

function sectionRow(els: Els, act: Actions, name: Section, label: string, isOpen: boolean, chips: JSX.Element[], lines: JSX.Element[]): JSX.Element {
  const { Box, Text, Button } = els
  return (
    <Box key={`section-${name}`} flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        <Box width={14} flexShrink={0}>
          <Button key={`section-${name}`} plain onPress={() => act.toggleSection(name)}>
            <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
            <Text color="claude">{label}</Text>
          </Button>
        </Box>
        {chips}
      </Box>
      {isOpen && lines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {lines}
        </Box>
      )}
    </Box>
  )
}

/** One line of an expanded section: the entry's icon and its header text in the entry's color, plus a dim tail. */
function sectionLine(els: Els, key: string, kind: Row['kind'], color: string, text: string, live: boolean, now: number, tail?: JSX.Element): JSX.Element {
  const { Box, Text, Svg } = els
  return (
    <Box key={key} flexDirection="row" alignItems="center" overflow="hidden">
      <Box width={ICON_COLS} flexShrink={0} alignItems="center">
        {Svg ? <Svg source={icon(kind, color, live)} alt={kind} width={14} height={14} isInteractive={live} /> : <Text color={color}>{live ? spinner(now) : GLYPH[kind]}</Text>}
      </Box>
      <Text color={color} wrap="truncate-end">
        {text}
      </Text>
      {tail ?? ''}
    </Box>
  )
}

export function drawPane(els: Els, snap: Snapshot, act: Actions, columns: number, theme: Theme): JSX.Element {
  const { Box, Text } = els
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
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker')
  const qas = rows.filter((r): r is QaRow => r.kind === 'qa').sort((a, b) => a.round - b.round)
  const total = spend(agents, theme.prices, run.orchestrator)
  const prs = [...run.prs].sort((a, b) => a.createdAt - b.createdAt)
  const entries = entriesOf(rows)
  const textWidth = Math.max(16, width - LOGO_COLS - 2)

  const models = new Map<string, number>()
  for (const a of agents) models.set(a.model, (models.get(a.model) ?? 0) + 1)
  const modelsText = [...models.entries()].map(([m, n]) => `${m} ×${n}`).join(' · ') || 'none yet'
  const spendText_ = total.tokens === 0 ? 'nothing yet' : `${fmtTokens(total.tokens)} tokens${total.cost !== undefined ? ` · ~${fmtCost(total.cost)}` : ''}`
  const elapsedValue = (
    <Text wrap="truncate-end">
      {elapsed(run.startedAt, endAt)}
      {run.status === 'aborted' ? <Text color={RED}>{'  ·  aborted'}</Text> : run.status === 'done' ? <Text color={GREEN}>{'  ·  merged'}</Text> : ''}
    </Text>
  )

  // the progress rows: pull requests by state, workers by status, QA rounds by verdict; empty counts are left out
  const prCounts = (['merged', 'open', 'draft', 'closed'] as const).map(st => [st, prs.filter(p => p.state === st).length] as const).filter(([, n]) => n > 0)
  const workerBuckets: Array<[string, string, WorkerRow[]]> = [
    ['running', TEAL, workers.filter(w => workerColor(w, run) === TEAL)],
    ['done', GREEN, workers.filter(w => workerColor(w, run) === GREEN)],
    ['limited', YELLOW, workers.filter(w => workerColor(w, run) === YELLOW)],
    ['failed', ORANGE, workers.filter(w => workerColor(w, run) === ORANGE)],
  ]
  const qaBuckets: Array<[string, string, QaRow[]]> = [
    ['running', TEAL, qas.filter(q => qaColor(q) === TEAL)],
    ['pass', GREEN, qas.filter(q => qaColor(q) === GREEN)],
    ['recommendations', YELLOW, qas.filter(q => qaColor(q) === YELLOW)],
    ['fix', ORANGE, qas.filter(q => qaColor(q) === ORANGE)],
  ]
  const sections: JSX.Element[] = []
  if (prs.length > 0) {
    sections.push(
      sectionRow(
        els,
        act,
        'prs',
        `PRs (${prs.length})`,
        ui.openSections.includes('prs'),
        prCounts.map(([st, n]) => countChip(els, `prs-${st}`, PR_COLOR[st], prIcon(st), PR_GLYPH[st], n)),
        prs.map(pr => drawPr(els, pr, `top-pr-${pr.number}`)),
      ),
    )
  }
  if (workers.length > 0) {
    sections.push(
      sectionRow(
        els,
        act,
        'agents',
        `Agents (${workers.length})`,
        ui.openSections.includes('agents'),
        workerBuckets.filter(([, , list]) => list.length > 0).map(([name, color, list]) => countChip(els, `agents-${name}`, color, icon('worker', color), GLYPH.worker, list.length)),
        [...workers].sort((a, b) => a.at - b.at).map(w => sectionLine(els, `agent-${w.id}`, 'worker', workerColor(w, run), w.title, isInProgress(w), now)),
      ),
    )
  }
  if (qas.length > 0) {
    sections.push(
      sectionRow(
        els,
        act,
        'qa',
        `QA (${qas.length})`,
        ui.openSections.includes('qa'),
        qaBuckets.filter(([, , list]) => list.length > 0).map(([name, color, list]) => countChip(els, `qa-${name}`, color, icon('qa', color), GLYPH.qa, list.length)),
        qas.map(q =>
          sectionLine(
            els,
            `qa-line-${q.id}`,
            'qa',
            qaColor(q),
            `QA round ${q.round}${q.summary ? `: ${verdictWord(q)}` : ''}`,
            isInProgress(q),
            now,
            q.summary ? (
              <Text key={`qa-tail-${q.id}`} wrap="truncate-end">
                <Text dimColor> · </Text>
                {scoreNumbers(els, q.summary, `qa-score-${q.id}`)}
              </Text>
            ) : undefined,
          ),
        ),
      ),
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="stretch">
        {logo(els)}
        <Box flexDirection="column" width={textWidth} flexShrink={0}>
          {keyLine(
            els,
            'Task',
            run.task ? (
              <Text bold wrap="truncate-end">
                {run.task.replace(/\s+/g, ' ').trim()}
              </Text>
            ) : (
              <Text dimColor italic wrap="truncate-end">
                Clarifying the task…
              </Text>
            ),
          )}
          {keyLine(els, 'Elapsed', elapsedValue)}
          {keyLine(els, 'Branch', run.branch ? `${run.branch} → ${run.baseBranch}` : `not started (into ${run.baseBranch})`)}
          {keyLine(els, 'Models', modelsText)}
          {keyLine(els, 'Spend', spendText_)}
          <Box marginTop={1}>{drawBar(els, run.phase, run.status)}</Box>
        </Box>
      </Box>
      {run.gh && !run.gh.ok && (
        <Box marginTop={1}>
          <Text color="warning" wrap="wrap">
            {`gh: ${run.gh.detail}`}
          </Text>
        </Box>
      )}
      {run.pushProblem && (
        <Box marginTop={1}>
          <Text color="warning" wrap="wrap">
            {run.pushProblem}
          </Text>
        </Box>
      )}
      {run.overview && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {run.overview}
          </Text>
        </Box>
      )}
      {sections.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {sections}
        </Box>
      )}
      {drawTimeline(els, entries, ui, act, width, theme, now, run)}
    </Box>
  )
}

/**
 * The timeline as its own panel under the header: a solid title band (name, counts, the earlier/latest switch and
 * the hide/show toggle) over a framed tree of the latest entries.
 */
function drawTimeline(els: Els, entries: Entry[], ui: Ui, act: Actions, width: number, theme: Theme, now: number, run: Run): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.openSections.includes('timeline')
  const running = entries.filter(e => e.kind === 'agent' && isInProgress(e.row)).length
  const hidden = ui.isTimelineFull ? 0 : Math.max(0, entries.length - TIMELINE_LATEST)
  const shown = hidden > 0 ? entries.slice(hidden) : entries
  const bits = [`${entries.length} ${entries.length === 1 ? 'event' : 'events'}`, ...(running > 0 ? [`${running} running`] : [])]
  // the band wears the phase bar's current color: the phase's own, green once merged, orange when aborted
  const band = run.status === 'done' ? GREEN : run.status === 'aborted' ? ORANGE : PHASE_COLOR[run.phase]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" backgroundColor={band} paddingX={1} justifyContent="space-between">
        <Text color="white" wrap="truncate-end">
          <Text bold>Timeline</Text>
          {` · ${bits.join(' · ')}`}
        </Text>
        <Box flexDirection="row" flexShrink={0}>
          {entries.length > TIMELINE_LATEST ? (
            <Button key="timeline-earlier" plain onPress={() => act.toggleTimelineFull()}>
              <Text color="white">{ui.isTimelineFull ? `latest ${TIMELINE_LATEST}` : `earlier (${hidden})`}</Text>
            </Button>
          ) : (
            ''
          )}
          {entries.length > TIMELINE_LATEST ? <Text color="white"> · </Text> : ''}
          <Button key="section-timeline" plain onPress={() => act.toggleSection('timeline')}>
            <Text color="white">{isOpen ? 'hide' : 'show'}</Text>
          </Button>
        </Box>
      </Box>
      {isOpen && (
        <Box borderStyle="single" borderDimColor paddingX={1} flexDirection="column">
          {shown.length > 0 ? treeLead(els, hidden > 0) : <Text dimColor>Nothing yet.</Text>}
          {shown.map((entry, i) => drawEntry(els, entry, ui, act, width - 4, theme, now, run, i === shown.length - 1))}
        </Box>
      )}
    </Box>
  )
}

/**
 * One timeline entry: the header is the button that expands it; the subline is always shown, dim; the body when
 * expanded. `bodyRows` is the body's height as estimated, so the vertical line can be drawn beside it.
 */
type Card = { id: string; key: string; kind: Row['kind']; color: string; title: string; subline: JSX.Element; body: JSX.Element[]; bodyRows: number }

/** The tree column: `├─` beside an entry's header, `│` down to the next entry, `└─` for the last; three cells wide, the last one blank so the tick stops short of the icon. */
const TREE_COLS = 3
/** The icon column, right of the tree. */
const ICON_COLS = 2
/** One text row on the remote surfaces, in CSS pixels: the tree pieces are drawn this tall so they meet edge to edge. */
const ROW_PX = 20
const TREE_COLOR = '#6e7681'

type Piece = 'branch' | 'last' | 'trunk' | 'tick' | 'none'

/** A tree piece `rows` text rows tall, as one SVG: the trunk, a branch tick, or both. */
function treeSvg(piece: Piece, rows: number, dotted = false): string {
  const h = ROW_PX * rows
  const mid = ROW_PX / 2
  const x = 5
  const parts: string[] = []
  const dash = dotted ? ' stroke-dasharray="1.5 3.5"' : ''
  if (piece === 'trunk' || piece === 'branch') parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}"${dash}/>`)
  if (piece === 'last') parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${mid}"/>`)
  if (piece === 'branch' || piece === 'last' || piece === 'tick') parts.push(`<line x1="${x}" y1="${mid}" x2="14" y2="${mid}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 ${h}" fill="none" stroke="${TREE_COLOR}" stroke-width="1.5" stroke-linecap="round">${parts.join('')}</svg>`
}

const TREE_GLYPH: Record<Piece, string> = { branch: '├─ ', last: '└─ ', trunk: '│  ', tick: '─  ', none: '   ' }

/** One piece in the tree column, `rows` rows tall; the terminal draws glyphs, the other surfaces an SVG. */
function connector(els: Els, piece: Piece, rows = 1): JSX.Element {
  const { Box, Text, Svg } = els
  return (
    <Box width={TREE_COLS} flexShrink={0} flexDirection="column" alignSelf="flex-start">
      {Svg ? (
        <Svg source={treeSvg(piece, rows)} alt="tree line" width={16} height={ROW_PX * rows} />
      ) : (
        <Text dimColor>{[TREE_GLYPH[piece], ...Array.from({ length: rows - 1 }, () => TREE_GLYPH[piece === 'trunk' || piece === 'branch' ? 'trunk' : 'none'])].join('\n')}</Text>
      )}
    </Box>
  )
}

/** The trunk as tall as its parent, whatever the rows measure: an absolute box from top to bottom clipping a long SVG. */
const TRUNK_ROWS = 120

function trunk(els: Els, dotted = false): JSX.Element {
  const { Box, Svg } = els
  return (
    <Box position="absolute" top={0} bottom={0} left={0} width={TREE_COLS} overflow="hidden" flexDirection="column">
      {Svg ? <Svg source={treeSvg('trunk', TRUNK_ROWS, dotted)} alt="tree line" width={16} height={ROW_PX * TRUNK_ROWS} /> : ''}
    </Box>
  )
}

/** The lead-in above the first entry: one row of trunk, dotted when earlier entries are folded away above it. */
export function treeLead(els: Els, hasEarlier = false): JSX.Element {
  const { Box, Text } = els
  if (els.Svg) {
    return (
      <Box height={1} overflow="hidden">
        {trunk(els, hasEarlier)}
      </Box>
    )
  }
  return hasEarlier ? (
    <Box flexDirection="row">
      <Box width={TREE_COLS} flexShrink={0}>
        <Text dimColor>┆</Text>
      </Box>
    </Box>
  ) : (
    <Box flexDirection="row">{connector(els, 'trunk')}</Box>
  )
}

function drawEntry(els: Els, entry: Entry, ui: Ui, act: Actions, width: number, theme: Theme, now: number, run: Run, isLast: boolean): JSX.Element {
  const { Box, Text, Button, Svg } = els
  // the text column gets an explicit width: the desktop's column count is approximate for its font, and without a
  // bound the surface never truncates or wraps
  const textWidth = Math.max(16, width - TREE_COLS - ICON_COLS - 4)
  const card = entry.kind === 'agent' ? agentCard(els, entry.row, theme, now, run, textWidth) : messagesCard(els, entry.rows, textWidth)
  const isOpen = ui.expanded.includes(card.id)
  const live = entry.kind === 'agent' && isInProgress(entry.row)
  // on the SVG surfaces the trunk is one piece behind the rows, so the rows' heights do not matter; the terminal's
  // rows are exact, so it draws a glyph per row
  const smooth = !!Svg
  const below = (rows = 1) => (isLast ? <Box width={TREE_COLS} flexShrink={0} /> : smooth ? <Box width={TREE_COLS} flexShrink={0} /> : connector(els, 'trunk', rows))
  return (
    <Box key={`entry-${card.id}`} flexDirection="column" overflow="hidden">
      {smooth && !isLast ? trunk(els) : ''}
      <Box flexDirection="row" alignItems="center">
        {connector(els, isLast ? 'last' : smooth ? 'tick' : 'branch')}
        <Box width={ICON_COLS} flexShrink={0} alignItems="center" justifyContent="center">
          {Svg ? (
            <Svg source={icon(card.kind, card.color, live)} alt={card.kind} width={16} height={16} isInteractive={live} />
          ) : (
            <Text color={card.color}>{live ? spinner(now) : GLYPH[card.kind]}</Text>
          )}
        </Box>
        <Box width={textWidth} flexShrink={0} marginLeft={1}>
          <Button key={card.key} plain onPress={() => act.toggleRow(card.id)}>
            <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
            <Text bold color={card.color} wrap="truncate-end">
              {card.title}
            </Text>
          </Button>
        </Box>
      </Box>
      <Box flexDirection="row" alignItems="flex-start">
        {below()}
        <Box width={ICON_COLS} flexShrink={0} />
        <Box width={textWidth} flexShrink={0} marginLeft={1}>
          {card.subline}
        </Box>
      </Box>
      {isOpen && card.body.length > 0 && (
        <Box flexDirection="row" alignItems="flex-start">
          {below(card.bodyRows + 1)}
          <Box width={ICON_COLS} flexShrink={0} />
          <Box width={textWidth} flexShrink={0} marginLeft={1} flexDirection="column" marginTop={1}>
            {card.body}
          </Box>
        </Box>
      )}
      {!isLast ? <Box flexDirection="row" height={1}>{below()}</Box> : ''}
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
  const color = cardColor(row, run)
  const feed = row.stats.activity.length > 0 ? [<Box key="feed" marginTop={1} flexDirection="column">{drawActivity(els, row.stats.activity)}</Box>] : []
  const feedRows = row.stats.activity.length > 0 ? 1 + row.stats.activity.length : 0
  if (row.kind === 'worker') {
    const prs = prsOf(run, row.branch)
    const latest = prs[0]
    const lead = [span, row.model, ...(row.outcome === 'limited' ? ['with limitations'] : []), ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · ')
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
      <Text wrap="truncate-end">
        <Text dimColor>{`${[span, row.model, ...(row.restarts ? [`restarted ${row.restarts}x`] : [])].join(' · ')} · `}</Text>
        {row.summary ? (
          <Text>
            {scoreNumbers(els, row.summary, `score-${row.id}`)}
            <Text dimColor>{` → ${verdictWord(row)}`}</Text>
          </Text>
        ) : (
          <Text dimColor>{statusWord[row.status]}</Text>
        )}
      </Text>
    ),
    body: [
      <Text key="stats" dimColor wrap="truncate-end">
        {statsLine(row.stats, row.model, theme.prices)}
      </Text>,
      row.summary ? (
        <Text key="score" wrap="wrap">
          {scoreNumbers(els, row.summary, `score-body-${row.id}`)}
          <Text dimColor>{` → ${verdictWord(row)}`}</Text>
        </Text>
      ) : (
        <Text key="score" dimColor>
          {scoreLine(row)}
        </Text>
      ),
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
                  <Text color={i.score === 'unacceptable' ? ORANGE : YELLOW}>{i.score}</Text>
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
  if (run.status === 'merging' && run.final) second.push(`final PR #${run.final.number} waiting on checks`)
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
