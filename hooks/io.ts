import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Row, Run, Ui } from '../types'

/**
 * What the helpers need from the engine, as closures the `session.start` hook
 * makes over its `$`: `$` itself is never handed around, each call is spelled
 * `$.noun.method(...)` once, in `register.tsx`.
 */
export type Io = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** The names directly in a folder; [] when it is missing. */
  list: (dir: string) => Promise<string[]>
  now: () => Promise<number>
  cwd: () => Promise<string>
  home: () => Promise<string | undefined>
  stop: (agentId: string) => Promise<unknown>
  submit: (text: string) => Promise<unknown>
  openPane: (focus?: boolean) => Promise<unknown>
  /** Shows an agent's transcript in the main view, or the main conversation without an id; `deny` says why it did not. */
  view: (agentId?: string) => Promise<{ deny?: string }>
  toast: (text: string) => void
  getRun: () => Promise<Run | null>
  setRun: (fn: (run: Run | null) => Run | null) => Promise<unknown>
  getRows: () => Promise<Row[]>
  setRows: (fn: (rows: Row[]) => Row[]) => Promise<unknown>
  getUi: () => Promise<Ui>
  setUi: (fn: (ui: Ui) => Ui) => Promise<unknown>
}
