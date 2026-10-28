/** Where a loop lives: shipped with the plugin (read-only), in the user's dacapo home, or in a repository. */
export type LoopLevel = 'plugin' | 'user' | 'project'

/**
 * What a node is on the canvas: `entry` talks to the user and runs the loop, `exit` is where a run ends,
 * `agent` is one subagent at a time, `swarm` is as many as the round has tasks or slices.
 */
export type NodeType = 'entry' | 'agent' | 'swarm' | 'exit'

/**
 * What the host holds a node to: `lands` lands its own work and reports how it went, `scores` scores a rubric,
 * `collects` gathers evidence for a `scores` node and never scores, `none` asks nothing of the host, `interviews` talks to
 * the user and writes a report.
 */
export type Contract = 'lands' | 'scores' | 'collects' | 'none' | 'interviews'

/** One node: the frontmatter of nodes/<id>.md plus its body. */
export type LoopNode = {
  id: string
  type: NodeType
  /** Two to four words drawn under the icon. */
  summary: string
  contract: Contract
  /** Strongest first; the first is the default, the last the fast tier. Empty for entry and exit. */
  models: string[]
  /** The skills the node preloads, as the Skill tool names them. */
  skills: string[]
  /** The tools the node may not use. */
  tools: { deny: string[] }
  /** scores only: the rubric categories this judge accepts. */
  categories?: string[]
  /** scores only: how many collects helpers it may run at once. */
  collectors?: number
  /** The markdown body: the role. */
  role: string
}

/** One stage of the loop: a name the run pane tracks, its summary, and the nodes that work in it (none for an orchestrator-only stage). */
export type Stage = { id: string; summary: string; nodes: string[] }

/** One point in time; two stages in a step run side by side. */
export type Step = { stages: Stage[] }

/**
 * A move of the orchestrator from one stage to the next. `to` lists every stage of one step, or names one stage of an
 * earlier step when `back` is set; `when` says when it is taken and `then` what the orchestrator does on the way.
 */
export type Transition = { from: string; to: string[]; back?: boolean; label: string; when?: string; then?: string }

/** What one node hands another, by node id; `spec` says what the handover holds. */
export type Handover = { from: string; to: string; label: string; spec: string }

/** loop.json as stored. `from`/`to` of a transition name stage ids, or the words `entry` and `exit`. */
export type LoopGraph = {
  name: string
  description: string
  /** The id of the entry node. */
  entry: string
  /** The id of the exit node. */
  exit: string
  steps: Step[]
  /** On-call node id to its helper node ids. */
  onCall: Record<string, string[]>
  transitions: Transition[]
  handovers: Handover[]
}

/** A whole loop: the graph of loop.json and every node file, by id. */
export type Loop = LoopGraph & { nodes: Record<string, LoopNode> }

/**
 * A draft in progress: its folder, the hash of the loop it was copied from (null for a new loop), when it was opened,
 * and the changes made to it so far, one line each.
 */
export type DraftInfo = { dir: string; base: string | null; since: number; changes: string[] }

/**
 * A loop as the library lists it. `shadowedBy` names the higher level whose loop of the same name wins, `hides` the
 * lower levels whose loop of the same name this one hides; `draft` is set when a draft of this loop is open, and
 * `unsaved` when the loop is that draft alone so far (a new loop not saved yet: `dir` is where the save puts it).
 */
export type LoopRef = {
  name: string
  level: LoopLevel
  dir: string
  description: string
  shadowedBy?: LoopLevel
  hides?: LoopLevel[]
  draft?: DraftInfo
  unsaved?: true
  counts: { stages: number; steps: number; nodes: number; edges: number }
}

/** A validation problem at a path like `nodes.worker.models`, `steps[4].stages[0]`, `transitions[2]`. */
export type Problem = { path: string; message: string }

/** What the viewer points at: a stage, a node, or an edge by its id (`from>to` for a handover, `from>a+b` for a transition). */
export type ViewerFocus = { kind: 'stage' | 'node' | 'transition' | 'handover'; id: string }

/** The loop viewer's whole state: what the pane draws. The mod keeps it in plugin state; the tools of the next round change it. */
export type ViewerState = {
  screen: 'library' | 'loop'
  /** Every loop as last listed. */
  library: LoopRef[]
  /** The name the `loop` conf key gives. */
  defaultLoop: string
  /** The loops folder of each level and the drafts folder, for the library's section headings; absent before the first listing. */
  roots?: { plugin: string | null; user: string | null; project: string | null; drafts: string }
  /** The loop on screen: its draft when one exists. `problems` are the saved folder's, `d2Newer` says loop.d2 is newer than loop.json, `opaque` holds the diagram's blocks the loop model does not know, kept for the save. */
  open?: { ref: LoopRef; loop: Loop; draft?: DraftInfo; d2Newer: boolean; problems: Problem[]; files: string[]; opaque?: string[] }
  view: { folded: boolean; focus?: ViewerFocus; tab: 'canvas' | 'files' }
  /** One line under the draft bar: a refusal, a confirmation, a warning. */
  notice?: string
  /**
   * Each listed loop's stage ids, one list per step, by `<level>/<name>`: the library card's colour strip. A loop left
   * out here draws a grey block per step from its counts.
   */
  shapes?: Record<string, string[][]>
}
