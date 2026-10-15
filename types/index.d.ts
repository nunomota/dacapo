export type RunStatus = 'planning' | 'active' | 'done' | 'aborted'

export type Phase = 'clarify' | 'research' | 'plan' | 'implement' | 'qa' | 'release'

/** Token counts as the API reports them, summed over model steps. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One thing an agent did, kept for the timeline: a tool call with a short argument, or a piece of assistant text. */
export type Activity = { at: number; kind: 'tool' | 'text'; text: string }

export type IterationInfo = { n: number; title: string; overview?: string; startedAt: number }

export type Run = {
  id: string
  task: string
  /** A short paragraph on the whole task, written by the orchestrator at start. */
  overview?: string
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
  phase: Phase
  iterations: IterationInfo[]
  /** The orchestrator's own model steps during the run. */
  orchestrator: Usage & { steps: number; modelId?: string }
  /** Wake-up prompts sent to the orchestrator, with their delivery. */
  wakes: Wake[]
  /** The last push to origin that did not happen, shown until the next push succeeds. */
  pushProblem?: string
}

/** A prompt the run queued for the orchestrator; `deliveredAt` is set when its turn starts, else the ticker resends it. */
export type Wake = { key: string; text: string; sentAt: number; tries: number; deliveredAt?: number }

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

/** What the orchestrator answered at the end of one of its turns during the run. */
export type OrchestratorRow = {
  kind: 'orchestrator'
  id: string
  iteration: number
  at: number
  text: string
}

export type AgentStats = {
  usage: Usage
  steps: number
  toolCalls: number
  /** The resolved model id of the agent's steps (`claude-sonnet-5-5`, ...). */
  modelId?: string
  /** The last entries, oldest first. */
  activity: Activity[]
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
  /** The worker's closing answer, or the failure reason. */
  note?: string
  stats: AgentStats
  /** How many times the agent was resumed after it had ended. */
  restarts?: number
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
  stats: AgentStats
  /** Set when the agent ended: the ticker collects the report outside the agent's own dispatch. */
  collect?: { failure: string | null }
  /** How many times the agent was resumed after it had ended. */
  restarts?: number
}

export type Row = UserRow | OrchestratorRow | WorkerRow | QaRow

export type Ui = {
  /** Iteration numbers whose rows are folded away. */
  collapsed: number[]
  /** Ids of rows whose body is shown. */
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
