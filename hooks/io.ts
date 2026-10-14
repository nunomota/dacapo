import type { AgentSpawnArgs, AgentSpawnResult, ProcessRunInit, ProcessRunResult } from 'claude-code'

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
  now: () => Promise<number>
  cwd: () => Promise<string>
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  stop: (agentId: string) => Promise<unknown>
  submit: (text: string) => Promise<unknown>
  openPane: (focus?: boolean) => Promise<unknown>
  getRun: () => Promise<Run | null>
  setRun: (fn: (run: Run | null) => Run | null) => Promise<unknown>
  getRows: () => Promise<Row[]>
  setRows: (fn: (rows: Row[]) => Row[]) => Promise<unknown>
  getUi: () => Promise<Ui>
  setUi: (fn: (ui: Ui) => Ui) => Promise<unknown>
}
