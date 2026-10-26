# How dacapo works

The [README](../README.md) covers installing, updating, configuring and using dacapo. This page is the rest: the stages of a run, what the mod enforces, how it reads a worker's outcome, the pane, loops, and the tools the orchestrator and the architect call.

## The stages

A loop defines its own stages. The run pane draws them as a bar, one block per step, and a step of several stages, which run side by side, is split into one thin block per stage. The `core` loop walks these, in order:

1. **Clarify.** It restates the task and asks about anything material until nothing is open.
2. **Research.** It picks a stack if none is fixed, reads the docs for the versions in use, notes the build and test commands, and finds the existing conventions each task must match.
3. **Plan.** It names the run, cuts a run branch from the base branch, splits the work into independent tasks, and writes each judge's rubric and the QA harness before any code exists.
4. **Implement.** One worker per task, in parallel. Each opens a draft pull request against the run branch, marks it ready when its build passes, waits for checks, and squash-merges with the planned title. A worker's task is done only when its pull request is merged.
5. **QA.** A fresh subagent uses the deliverable as the end user, attending to consistency across it, and scores every rubric item `strong`, `acceptable` or `unacceptable`. On any verdict below pass the loop goes back to step 4, with every item below `strong` becoming a task. The run merges only on pass. The one exception is a stuck loop, where the user may decide to merge with the limitation stated.
6. **Merge.** The orchestrator opens the final pull request into the base branch, written to the pull request rules skill, and the mod merges it once its checks are green. When the base branch moved or the final checks fail, the run goes back to step 4 to reconcile, and the judges run again.

`core-deep` adds a **review** stage between QA and merge: another subagent reads the run's change against the base branch as an engineer and scores an engineering rubric: quality, consistency with the codebase, cleanup. Findings inside the run's change become fix tasks; findings beyond it are recommendations in the final report. `core-fast` has no QA stage: the run merges once every task has landed.

Clarify, research, plan and merge are stages with no nodes: the orchestrator works through them alone, and the pane still marks them.

## What the mod enforces

- **Only workers change code.** While a run is active, the orchestrator cannot edit files, rewrite git history or touch pull requests by hand. Workers write inside their own worktree only.
- **Everything lands through pull requests.** Workers merge their own after green checks; the final merge into the base branch is a pull request too. The mod never merges a branch locally.
- **Clean history.** Commits follow the configured commit rules skill, the bundled `rules-commits` by default: Conventional Commit titles, one unit of work each, no bodies, no attribution lines. Pull requests follow the configured pull request rules skill, `rules-prs` by default: the planned title, one paragraph on the contribution, a `Verified:` line. Workers load the skills from their brief. While the bundled skills are the configured ones, the mod also checks commit titles and refuses attribution lines itself; a skill of your own is trusted as it is.
- **A judge of the product never reads source; a judge of the change never changes it.** QA, and the collectors it starts, can only read the brief and rubric they were given and only write their report or evidence; the reviewer reads anything and writes only its report. A judge may start only the collector its loop hands slices to. The mod validates every report and derives the verdicts.
- **Agents never read the configuration or loop files.** The orchestrator asks the `config` tool for the values in force and the loop; comments and commented-out lines in `dacapo.conf` never reach a model.
- **Nothing is fired and forgotten.** Report collection, pull request polling, the final merge and every wake-up run on the mod's own timer. A wake-up that does not arrive is sent again.
- **Stale is not failed.** An agent silent for 30 minutes is marked stale and the orchestrator is told; it keeps running. After two idle hours it is timed out: stopped and handled as a failure (resume, repair, drop or ask).
- **The loop is fixed.** A run's loop is chosen before any work is dispatched and never changes mid-run.
- **Loops are edited through the architect only.** This one is the `design` skill's rule, not the mod's: no tool refuses an edit to a loop file, and a loop folder is plain files anyone can change by hand. The skill tells the architect never to write a loop file itself, and the viewer has no control that edits. What the mod does check is the architect's own path: every operation is checked before anything is written, and Save validates the whole draft again.

## Outcomes

A worker's report ends with `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`. `done` is a claim: the mod marks the work landed only when `sync` sees its pull request merged. A worker whose last line says done while its pull request is still open is marked failed, with its branch and pull request kept, so the orchestrator can resume it.

Each judge writes a JSON report. The mod checks that every rubric id is scored exactly once with `strong`, `acceptable` or `unacceptable` and that the overview is not empty, then derives the verdict: `fix` if any item is unacceptable, `pass-with-recommendations` if any is acceptable, `pass` otherwise. An invalid report is reported as such and never counts as a pass. When two judges run side by side, a `fix` from QA stops the reviewer running beside it, which runs again after the fixes.

## The pane

The header reads like fastfetch: the task, elapsed time, branch, the loop (its name, the level it was found at, and its stages in steps), models and spend, then a stage bar. Done steps are grey, the current one is colored with its stages named, steps ahead are hollow. Up to four rows count pull requests by state, agents by outcome, QA rounds by verdict and review rounds by verdict, each expanding to its items. Below them the timeline is a tree of everything that happened: your messages, the orchestrator's answers, every worker with a link to its pull request, every judge's round with its scores. It shows the latest five events and folds the rest behind `earlier`.

One color code throughout: teal in progress, green done, yellow done with limitations or recommendations, orange failed. Each stage has a color of its own, the same in the bar, the band above the prompt and the loop viewer; a stage of your own takes one from the same palette by its position.

You can type while workers run. Your prompts become events in the timeline and are folded into the next round. `/dacapo-pane` reopens the pane; `/dacapo-config` prints the configuration in force and the loop a run walks.

## Loops

A loop is a folder named after it, holding four kinds of file:

- `loop.json`, the graph: `name`, `description`, the `entry` and `exit` node ids, `steps` (each a list of stages, each stage with an `id`, a `summary` and the `nodes` it runs), `onCall` (nodes outside any stage, each with its helpers), `transitions` (stage to stage, with a `label` and optional `back`, `when` and `then`) and `handovers` (node to node, with a `label` and a `spec`). A forward transition left out goes to the next step.
- `nodes/<id>.md`, one per node: frontmatter lines for `type` (`entry`, `agent`, `swarm` or `exit`), `summary`, `contract` (`lands`, `scores`, `collects` or `none`), `models`, `skills`, `tools: { deny: [...] }`, and for a `scores` node `categories` and an optional `collectors`. The body is the role, the agent's system prompt; the mod appends the landing steps or the report format its contract needs.
- `loop.d2`, the diagram: a D2 subset dacapo writes and reads itself, so no d2 binary is needed. It carries structure, labels and summaries only. A top-level block the subset does not know is kept as it is and written back after the generated part.
- `LOOP.md`, the loop as prose for people and other orchestrators, generated from the others on every save.

Loops live at three levels: the plugin's `loops/<name>/`, read-only; the user's `$DACAPO_HOME/loops/<name>/`; and a repository's `.claude/dacapo/loops/<name>/`, which dacapo keeps out of git through `.git/info/exclude`. `DACAPO_HOME` defaults to `~/.claude/dacapo`; tests and QA point it at a temporary folder so the real one is never touched. A name resolves project over user over plugin, and the library marks a loop hidden by one of the same name above it.

A draft is a full loop folder under `$DACAPO_HOME/drafts/`, named `user--<name>`, `plugin--<name>` or `project--<hash of the repository>--<name>`, with a `draft.json` beside the files: the hash of the loop it was copied from, when it began and the list of changes. Drafts never live in a repository and survive sessions. Save refuses a draft whose loop changed on disk since the draft began, unless told to overwrite.

`/dacapo:design` opens the loop viewer, the `dacapo-loops` pane, and `/dacapo-loops` reopens it. Its library has one section per level with its folder and a card per loop with its counts and chips: `default`, `draft`, `read-only`, `hidden by`. A loop's screen has a Canvas and a Files tab, a draft bar with the change count, Save and Discard, and a focus panel. The canvas draws the entry tile with its on-call nodes (a section that folds), the steps with their stages and nodes, and the exit `done`; dashed transitions run forward down the left and back up the right, and handovers join nodes, as a stub on the agent when the other end is the orchestrator. Press a stage or a node and the focus panel shows the rest: summary, models, skills, contract, denied tools, the first lines of the role, its transitions or handovers, and phrases to try saying. Desktop, VS Code and mobile draw the canvas as SVG; the terminal draws it in glyphs.

The architect edits a draft through fixed operations: add, remove, move, split, rename and summarize a stage; add, remove, move, set, rename a node and rewrite its role; set and remove a transition or a handover; describe or rename the loop; fold in a hand-edited `loop.d2`; and create, move, delete or make default a whole loop. Operations apply in order, and the first that cannot apply stops the batch with the rule it broke and nothing written. Removing a stage puts its nodes on call; it never deletes them. The [`design` skill](../skills/design/SKILL.md) lists every operation and the rules they enforce.

## Tools

The orchestrator calls these; the `core` skill says when.

| Tool | What it does |
| --- | --- |
| `config` | The configuration in force, each value with the file it came from, and the loop a run walks: its level and folder, its steps and stages, every node with its contract, models, skills and categories, its transitions and handovers, and the orchestrator's role as its entry node. |
| `start` | Checks the loop and registers its agents, checks `gh`, pulls the base branch, cuts the run branch in its worktree and pushes it. Takes the loop, by default the one the prompt's `--loop` or the configuration named. |
| `stage` | Marks the stage the run is in, for a stage the orchestrator works through alone (clarify and research in the shipped loops). |
| `dispatch` | Prepares one worktree, branch and brief per task of a `lands` node; `resume: true` continues an earlier worker. |
| `sync` | Confirms which pull requests merged, prunes their branches, fast-forwards the run worktree. |
| `judge` | Prepares a `scores` node, QA or a reviewer, on a fresh worktree of the run branch with its rubric, and the harness for a judge that uses the product. Judges whose stages share a step run side by side. |
| `ask` | Prepares a node with contract `none`, on call or in a stage, for one question or task, and returns the Agent call that asks it. |
| `finish` | Opens the final pull request; the mod merges it when green. |
| `status`, `cancel` | The timeline as text, with the loop and its current stages; stopping a worker, judge or asked node. |

The architect calls these; the `design` skill says when.

| Tool | What it does |
| --- | --- |
| `loops` | `list` the loops at the three levels, `open` one (its draft when one exists), `focus` the viewer on a stage, a node or an edge, `fold` the on-call section. |
| `loop_edit` | Applies a batch of operations in order to the open loop's draft, opening a draft when none exists. Also creates, moves, deletes and sets the default loop. |
| `loop_save` | Validates the draft, writes the loop folder (`loop.json`, `nodes/`, `loop.d2`, `LOOP.md`) and clears the draft. Refused for a plugin loop. |
| `loop_discard` | Deletes the draft; the viewer shows the saved loop again. |

## Where things are

Reports, briefs and rubrics of a run are under `.workspaces/.dacapo/<run id>/` in the repository. Worker worktrees are `.workspaces/<run branch>--<task id>`, each judge's `.workspaces/<node>/<round>-<n>` (QA's `.workspaces/qa/<round>-<n>`). Loops are in the three folders above and drafts under `$DACAPO_HOME/drafts/`. dacapo keeps `.workspaces/`, `.context/`, `.dacapo.conf` and `.claude/dacapo/` out of git through `.git/info/exclude`.
