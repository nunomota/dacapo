export type RunStatus = 'planning' | 'active' | 'merging' | 'done' | 'aborted'

export type Phase = 'clarify' | 'research' | 'plan' | 'implement' | 'qa' | 'review' | 'merge'

/**
 * How far a run is judged before it merges: `fast` lands the work and merges; `balanced` adds QA as the end user
 * (the default); `deep` adds an engineering review of the run's accumulated change after QA passes.
 */
export type Level = 'fast' | 'balanced' | 'deep'

/** Token counts as the API reports them, summed over model steps. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One thing an agent did, kept for the timeline: a tool call with a short argument, or a piece of assistant text. */
export type Activity = { at: number; kind: 'tool' | 'text'; text: string }

export type IterationInfo = { n: number; title: string; overview?: string; startedAt: number }

export type PrState = 'draft' | 'open' | 'merged' | 'closed'

export type PrChecks = 'none' | 'pending' | 'passing' | 'failing'

/** A pull request of the repository whose head is one of the run's branches, as last polled through gh. */
export type Pr = {
  number: number
  url: string
  title: string
  state: PrState
  checks: PrChecks
  /** GitHub's answer on conflicts: unknown while it is still computing. */
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** Head and base branch names. */
  head: string
  base: string
  createdAt: number
}

/** Whether gh can be used, as checked at start. */
export type Gh =
  | { ok: true; repo: string; url: string }
  | { ok: false; problem: 'missing' | 'unauthenticated' | 'not-github'; detail: string }

export type Run = {
  id: string
  task: string
  /** A short paragraph on the whole task, written by the orchestrator at start. */
  overview?: string
  startedAt: number
  status: RunStatus
  /** The current dispatch round, 1-based. */
  iteration: number
  /** Absolute path of the repository root. */
  root: string
  /** The run branch, cut from the base branch at start; every worker pull request targets it. Empty until start. */
  branch: string
  /** Absolute path of the worktree that has `branch` checked out, `.workspaces/<branch>`. Empty until start. */
  worktree: string
  /** The branch the run was cut from and is merged into through the final pull request. */
  baseBranch: string
  /** Chosen at start and fixed for the run; a run saved before levels existed reads as `review`. */
  level?: Level
  /** At deep: whether QA and the review run one after the other (the rule) or side by side; absent means sequential. */
  judges?: 'sequential' | 'parallel'
  /** Absolute path of the run log folder, `.workspaces/.dacapo/<id>`. */
  runDir: string
  phase: Phase
  /**
   * The loop the run walks, as it was read at start: its name, where it was found, and its steps in order, each
   * holding one stage or several that run side by side. Absent on a run saved before loops, which walks the
   * phases of its `level`.
   */
  loop?: { name: string; level: 'plugin' | 'user' | 'project'; steps: { stages: { id: string; summary: string }[] }[] }
  /** The current stage's id when `loop` is set; `phase` stands in for it on a run without a loop. */
  stage?: string
  /** The stages of the current step that have a live agent, when that step runs several side by side; empty or absent otherwise. */
  activeStages?: string[]
  iterations: IterationInfo[]
  /** The orchestrator's own model steps during the run. */
  orchestrator: Usage & { steps: number; modelId?: string }
  /** Wake-up prompts sent to the orchestrator, with their delivery. */
  wakes: Wake[]
  /** The last push to origin that did not happen, shown until the next push succeeds. */
  pushProblem?: string
  /** gh as checked at start. */
  gh?: Gh
  /** The pull requests of the run's branches, newest first, as last polled. */
  prs: Pr[]
  /** When `prs` was last refreshed. */
  prsAt?: number
  /** The final pull request from the run branch into the base branch, once finish opened it. */
  final?: { number: number; url: string; title: string; openedAt: number; attempt: number }
  /**
   * The interviewing node that holds the floor, set when the Agent call of a `consult` started it: what the person
   * types goes to it until it reports or `/dacapo-back` returns the floor. `n` is the consult's count for the node.
   */
  floor?: { node: string; agentId: string; n: number; since: number }
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

/** QA scores user-visible outcomes (`core`, `ui-ux`); the reviewer scores properties of the code (`quality`, `consistency`, `cleanup`). */
export type QaCategory = 'core' | 'ui-ux'
export type ReviewCategory = 'quality' | 'consistency' | 'cleanup'

export type QaItem = { id: string; title: string; category: QaCategory | ReviewCategory; score: Score; note: string }

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
  /** The worker's branch, `<run branch>--<task id>`; its pull requests are the run's `prs` with this head. */
  branch: string
  worktree: string
  model: string
  /** The planned title: the squash commit's, and the pull request's. */
  commit: string
  /** How the worker merges its pull request: squash (the rule) or a merge commit (for a branch that merges the base branch in). */
  mergeMethod: 'squash' | 'merge'
  status: WorkerStatus
  /** What the worker said of its own work on its last line: done, done with limitations, or failed. */
  outcome?: 'done' | 'limited' | 'failed'
  /** The worker's closing answer, or the failure reason. */
  note?: string
  stats: AgentStats
  /** How many times the agent was resumed after it had ended. */
  restarts?: number
  /** True when the row reuses the branch and worktree of an earlier worker of the same task. */
  isResumed?: boolean
  /** The loop node the agent runs as (`worker`, or an on-call node asked with `ask`); absent on rows saved before loops. */
  node?: string
  /**
   * What the host holds the row to: `lands` for a worker that lands through a pull request (absent means `lands`),
   * `none` for a node asked with `ask`, whose answer is its Agent result and which has no branch of its own,
   * `interviews` for a node started with `consult`, which talks to the person and writes a report; its `outcome`
   * is `done` when it reported, `limited` when it reported with open questions.
   */
  contract?: 'lands' | 'none' | 'interviews'
}

/**
 * A scored report on the integrated state: QA's, as the end user, or the reviewer's, as an engineer reading the
 * run's diff. Both share this row; `role` tells them apart (absent means QA, for rows saved before reviews existed).
 */
/** An evidence collector QA started: a subagent bound like QA that uses the product on a slice of the rubric. */
export type Collector = {
  /** The collector's agent id. */
  id: string
  /** The Agent call's short description of its slice. */
  description: string
  at: number
  endedAt?: number
  /** What the collector said of its slice on its last line: collected, collected with gaps, or failed; the agent ending in error is failed too. */
  outcome?: 'collected' | 'gaps' | 'failed'
  /** The first words of its answer, or the failure reason. */
  note?: string
}

export type QaRow = {
  kind: 'qa'
  /** `qa` for a judge that uses the product (categories core or ui-ux), `review` for one that reads the change. */
  role?: 'qa' | 'review'
  /** The loop's scores node the judge runs as; absent on rows saved before loops, which `role` names. */
  node?: string
  /** The QA or reviewer subagent's agent id. */
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
  /** The evidence collectors QA started, live ones and ended ones alike. */
  collectors?: Collector[]
}

export type Row = UserRow | OrchestratorRow | WorkerRow | QaRow

export type Ui = {
  /** Ids of rows whose body is shown. */
  expanded: string[]
  /** The header's progress rows that are unfolded ('prs', 'agents', 'qa') and the timeline panel ('timeline'). */
  openSections: string[]
  /** The timeline shows every entry, not only the latest few. */
  isTimelineFull: boolean
  /** The clock as of the last tick, for spinners and elapsed times. */
  tick: number
  /** The pane is hidden from the band's point of view. */
  isBandHidden: boolean
}

// The loop viewer's state, as types/loops.d.ts has it (ViewerState and the loop types under it). A contract cannot
// import, so the shape is repeated here: keep the two in step.

export type ViewerLevel = 'plugin' | 'user' | 'project'
export type ViewerNode = {
  id: string
  type: 'entry' | 'agent' | 'swarm' | 'exit'
  summary: string
  contract: 'lands' | 'scores' | 'collects' | 'none'
  models: string[]
  skills: string[]
  tools: { deny: string[] }
  categories?: string[]
  collectors?: number
  role: string
}
export type ViewerLoop = {
  name: string
  description: string
  entry: string
  exit: string
  steps: Array<{ stages: Array<{ id: string; summary: string; nodes: string[] }> }>
  onCall: Record<string, string[]>
  transitions: Array<{ from: string; to: string[]; back?: boolean; label: string; when?: string; then?: string }>
  handovers: Array<{ from: string; to: string; label: string; spec: string }>
  nodes: Record<string, ViewerNode>
}
export type ViewerDraft = { dir: string; base: string | null; since: number; changes: string[] }
export type ViewerRef = {
  name: string
  level: ViewerLevel
  dir: string
  description: string
  shadowedBy?: ViewerLevel
  draft?: ViewerDraft
  counts: { stages: number; steps: number; nodes: number; edges: number }
}

/** What the loop viewer draws: the library, the loop open with its draft, the view, a notice. */
export type Viewer = {
  screen: 'library' | 'loop'
  library: ViewerRef[]
  defaultLoop: string
  open?: {
    ref: ViewerRef
    loop: ViewerLoop
    draft?: ViewerDraft
    d2Newer: boolean
    problems: Array<{ path: string; message: string }>
    files: string[]
    opaque?: string[]
  }
  view: { folded: boolean; focus?: { kind: 'stage' | 'node' | 'transition' | 'handover'; id: string }; tab: 'canvas' | 'files' }
  notice?: string
  shapes?: Record<string, string[][]>
}

declare module 'claude-code' {
  interface PluginState {
    'dacapo': { run: Run | null; rows: Row[]; ui: Ui; viewer: Viewer }
  }
}
