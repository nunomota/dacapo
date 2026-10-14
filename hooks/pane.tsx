import type { Elements } from 'claude-code'

import type { QaRow, Row, Run, Ui, UserRow, WorkerRow } from '../types'

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

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function hhmm(ms: number): string {
  const d = new Date(ms)
  const h = `${d.getHours()}`.padStart(2, '0')
  const m = `${d.getMinutes()}`.padStart(2, '0')
  return `${h}:${m}`
}

export function elapsed(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.floor((toMs - fromMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${`${s % 60}`.padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${`${m % 60}`.padStart(2, '0')}m`
}

export function cut(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (width <= 1) return one.slice(0, 1)
  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}

export const isActive = (row: Row): boolean => row.kind !== 'user' && (row.status === 'running' || row.status === 'stale')

export function glyph(row: WorkerRow | QaRow, tick: number): { text: string; color?: string; dim?: boolean } {
  switch (row.status) {
    case 'pending':
      return { text: '○', dim: true }
    case 'running':
      return { text: FRAMES[Math.floor(tick / 100) % FRAMES.length]! }
    case 'finished':
      return { text: '✓', color: 'green' }
    case 'merged':
      return { text: '✓', color: 'green', dim: true }
    case 'failed':
    case 'invalid':
      return { text: '✗', color: 'red' }
    case 'stale':
      return { text: '…', color: 'yellow' }
    case 'timeout':
      return { text: '⏱', color: 'red' }
    case 'cancelled':
      return { text: '∅', dim: true }
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

export function scoreLine(row: QaRow): string {
  if (!row.summary) return row.status === 'running' || row.status === 'stale' ? 'report not ready' : 'no report'
  const s = row.summary
  const verdict = s.verdict === 'pass' ? 'pass' : s.verdict === 'fix' ? 'fix needed' : 'pass, with recommendations'
  return `${s.strong} strong · ${s.acceptable} acceptable · ${s.unacceptable} unacceptable → ${verdict}`
}

function iterationSummary(rows: Row[], n: number): string {
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === n)
  const qas = rows.filter((r): r is QaRow => r.kind === 'qa' && r.iteration === n)
  const parts: string[] = []
  if (workers.length > 0) {
    const done = workers.filter(w => w.status === 'finished' || w.status === 'merged').length
    parts.push(`${done}/${workers.length} workers done`)
  }
  const last = qas[qas.length - 1]
  if (last) parts.push(last.summary ? `QA ${last.summary.verdict === 'fix' ? 'fix needed' : 'pass'}` : `QA ${statusWord[last.status]}`)
  return parts.join(' · ')
}

export function drawPane(els: Els, snap: Snapshot, act: Actions, columns: number): JSX.Element {
  const { Box, Text, Button } = els
  const { run, rows, ui } = snap
  if (!run) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No task-loop run in this session. Start one with /task-loop.</Text>
      </Box>
    )
  }
  const width = Math.max(20, columns)
  const now = ui.tick
  const iterations = Array.from({ length: run.iteration }, (_, i) => i + 1)
  const header = `${run.status === 'done' ? 'Finished' : run.status === 'aborted' ? 'Aborted' : run.status === 'planning' ? 'Planning' : 'Running'} · ${elapsed(run.startedAt, run.status === 'done' || run.status === 'aborted' ? (rows[rows.length - 1]?.at ?? now) : now)}`

  return (
    <Box flexDirection="column">
      <Text bold>{cut(run.task, width - header.length - 3)}</Text>
      <Text dimColor>{header}</Text>
      {iterations.map(n => {
        const isCollapsed = ui.collapsed.includes(n)
        const summary = iterationSummary(rows, n)
        const mine = rows.filter(r => r.iteration === n).sort((a, b) => a.at - b.at)
        return (
          <Box key={`iteration-${n}`} flexDirection="column" marginTop={1}>
            <Button key={`iter-${n}`} plain onPress={() => act.toggleIteration(n)}>
              {isCollapsed ? '▸' : '▾'} Iteration {`${n}`}
              {summary ? <Text dimColor>{`  ${summary}`}</Text> : ''}
            </Button>
            {!isCollapsed && mine.map(row => drawRow(els, row, ui, act, width, now))}
          </Box>
        )
      })}
    </Box>
  )
}

function drawRow(els: Els, row: Row, ui: Ui, act: Actions, width: number, now: number): JSX.Element {
  const { Box, Text, Button } = els
  const time = hhmm(row.at)
  if (row.kind === 'user') return drawUser(els, row, ui, act, width, time)
  const g = glyph(row, ui.tick)
  const end = row.endedAt ?? now
  const span = elapsed(row.at, isActive(row) ? now : end)
  if (row.kind === 'worker') {
    const tail = ` · ${row.model} · ${span}`
    const label = row.status === 'running' ? row.title : `${row.title} (${statusWord[row.status]})`
    return (
      <Box key={`row-${row.id}`} flexDirection="row">
        <Text dimColor>{time} </Text>
        <Text color={g.color} dimColor={g.dim}>{g.text} </Text>
        <Text wrap="truncate-end">{cut(label, width - 10 - tail.length)}</Text>
        <Text dimColor>{tail}</Text>
      </Box>
    )
  }
  return drawQa(els, row, ui, act, width, time, span, g)
}

function drawUser(els: Els, row: UserRow, ui: Ui, act: Actions, width: number, time: string): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  return (
    <Box key={`row-${row.id}`} flexDirection="column">
      <Button key={`user-${row.id}`} plain onPress={() => act.toggleRow(row.id)}>
        <Text dimColor>{time} </Text>
        {isOpen ? '▾' : '▸'} you{' '}
        <Text dimColor>{cut(row.text, width - 14)}</Text>
      </Button>
      {isOpen && (
        <Box paddingLeft={8}>
          <Text wrap="wrap">{row.text}</Text>
        </Box>
      )}
    </Box>
  )
}

function drawQa(
  els: Els,
  row: QaRow,
  ui: Ui,
  act: Actions,
  width: number,
  time: string,
  span: string,
  g: { text: string; color?: string; dim?: boolean },
): JSX.Element {
  const { Box, Text, Button } = els
  const isOpen = ui.expanded.includes(row.id)
  const head = `QA round ${row.round}${row.attempt > 1 ? ` (attempt ${row.attempt})` : ''}`
  const score = scoreLine(row)
  const tail = ` · ${span}`
  return (
    <Box key={`row-${row.id}`} flexDirection="column">
      <Button key={`qa-${row.id}`} plain onPress={() => act.toggleRow(row.id)}>
        <Text dimColor>{time} </Text>
        <Text color={g.color} dimColor={g.dim}>{g.text} </Text>
        {isOpen ? '▾' : '▸'} {head}{' '}
        <Text dimColor>{cut(score, Math.max(8, width - 12 - head.length - tail.length))}</Text>
        <Text dimColor>{tail}</Text>
      </Button>
      {isOpen && (
        <Box paddingLeft={8} flexDirection="column">
          {row.overview ? (
            <Text wrap="wrap">{row.overview}</Text>
          ) : (
            <Text dimColor>
              {row.status === 'running' || row.status === 'stale'
                ? 'The QA agent is still working; the overview appears when its report is collected.'
                : row.note ?? 'No overview was collected.'}
            </Text>
          )}
          {row.items && row.items.some(i => i.score !== 'strong') && (
            <Box flexDirection="column" marginTop={1}>
              {row.items
                .filter(i => i.score !== 'strong')
                .map(i => (
                  <Text key={`item-${row.id}-${i.id}`} wrap="wrap">
                    <Text color={i.score === 'unacceptable' ? 'red' : 'yellow'}>{i.score}</Text>
                    {` ${i.title}${i.note ? `: ${i.note}` : ''}`}
                  </Text>
                ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

export function drawBand(els: Els, snap: Snapshot, act: Actions, columns: number): JSX.Element | null {
  const { Box, Text, Button } = els
  const { run, rows, ui } = snap
  if (!run || ui.isBandHidden || run.status === 'done' || run.status === 'aborted') return null
  const workers = rows.filter((r): r is WorkerRow => r.kind === 'worker' && r.iteration === run.iteration)
  const running = workers.filter(w => w.status === 'running').length
  const stale = workers.filter(w => w.status === 'stale').length
  const done = workers.filter(w => w.status === 'finished' || w.status === 'merged').length
  const trouble = workers.length - running - stale - done
  const qa = rows.filter((r): r is QaRow => r.kind === 'qa' && r.iteration === run.iteration).pop()
  const parts = [`task-loop`, `iteration ${run.iteration}`]
  if (workers.length > 0) {
    const bits = [`${running} running`, `${done} done`]
    if (stale > 0) bits.push(`${stale} stale`)
    if (trouble > 0) bits.push(`${trouble} failed`)
    parts.push(`workers ${bits.join(', ')}`)
  } else if (run.status === 'planning') parts.push('planning')
  if (qa) parts.push(qa.summary ? `QA ${qa.summary.verdict === 'fix' ? 'fix needed' : 'pass'}` : `QA ${statusWord[qa.status]}`)
  const text = parts.join(' · ')
  return (
    <Box flexDirection="row">
      <Text dimColor>{cut(text, Math.max(10, columns - 20))} </Text>
      <Button key="open-pane" plain onPress={() => act.openPane()}>
        timeline
      </Button>
      <Text dimColor> </Text>
      <Button key="hide-band" plain dimColor onPress={() => act.hideBand()}>
        hide
      </Button>
    </Box>
  )
}
