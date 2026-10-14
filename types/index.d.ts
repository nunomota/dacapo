export type RunStatus = 'planning' | 'active' | 'done' | 'aborted'

export type Run = {
  id: string
  task: string
  startedAt: number
  status: RunStatus
  /** The current implementation iteration, 1-based. */
  iteration: number
  /** Absolute path of the repository root. */
  root: string
  devBranch: string
  mainBranch: string
  /** Absolute path of the run log folder, `.workspaces/.task-loop/<id>`. */
  runDir: string
  /** Absolute path of the worktree that has `devBranch` checked out. */
  devWorktree: string
}

export type WorkerStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'merged'
  | 'failed'
  | 'stale'
  | 'timeout'
  | 'cancelled'

export type QaStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'invalid'
  | 'failed'
  | 'stale'
  | 'timeout'
  | 'cancelled'

export type Score = 'strong' | 'acceptable' | 'unacceptable'

export type QaItem = { id: string; title: string; category: 'core' | 'ui-ux'; score: Score; note: string }

export type QaSummary = {
  strong: number
  acceptable: number
  unacceptable: number
  verdict: 'pass' | 'pass-with-recommendations' | 'fix'
}

export type UserRow = {
  kind: 'user'
  id: string
  iteration: number
  at: number
  text: string
}

export type WorkerRow = {
  kind: 'worker'
  /** The subagent's agent id; `pending-...` until the orchestrator's Agent call started it. */
  id: string
  iteration: number
  at: number
  endedAt?: number
  lastActivityAt: number
  taskId: string
  title: string
  branch: string
  worktree: string
  model: string
  commit: string
  status: WorkerStatus
  /** The worker's closing answer, cut short, or the failure reason. */
  note?: string
}

export type QaRow = {
  kind: 'qa'
  /** The QA subagent's agent id. */
  id: string
  iteration: number
  round: number
  attempt: number
  at: number
  endedAt?: number
  lastActivityAt: number
  worktree: string
  reportPath: string
  model: string
  status: QaStatus
  summary?: QaSummary
  items?: QaItem[]
  overview?: string
  note?: string
}

export type Row = UserRow | WorkerRow | QaRow

export type Ui = {
  /** Iteration numbers whose rows are folded away. */
  collapsed: number[]
  /** Ids of user and QA rows whose body is shown. */
  expanded: string[]
  /** The clock as of the last tick, for spinners and elapsed times. */
  tick: number
  /** The pane is hidden from the band's point of view. */
  isBandHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'task-loop': { run: Run | null; rows: Row[]; ui: Ui }
  }
}
