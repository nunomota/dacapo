# How dacapo works

The [README](../README.md) covers installing, updating, configuring and using dacapo. This page is the rest: what the mod enforces, how it reads a worker's outcome, the pane, and the tools the orchestrator calls.

## What the mod enforces

- **Only workers change code.** While a run is active, the orchestrator cannot edit files, rewrite git history or touch pull requests by hand. Workers write inside their own worktree only.
- **Everything lands through pull requests.** Workers merge their own after green checks; the final merge into `main` is a pull request too. The mod never merges a branch locally.
- **Clean history.** Commits follow the configured commit rules skill, the bundled `rules-commits` by default: Conventional Commit titles, one unit of work each, no bodies, no attribution lines. Pull requests follow the configured pull request rules skill, `rules-prs` by default: the planned title, one paragraph on the contribution, a `Verified:` line. Workers load the skills from their brief. While the bundled skills are the configured ones, the mod also checks commit titles and refuses attribution lines itself; a skill of your own is trusted as it is.
- **QA never reads source; the reviewer never changes it.** The QA subagent can only read the brief and rubric it was given and only write its report; the reviewer reads anything and writes only its report. The mod validates both reports and derives the verdicts.
- **Agents never read the configuration files.** The orchestrator asks the `config` tool; comments and commented-out lines in `dacapo.conf` never reach a model.
- **Nothing is fired and forgotten.** Report collection, pull request polling, the final merge and every wake-up run on the mod's own timer. A wake-up that does not arrive is sent again.
- **Stale is not failed.** An agent silent for 30 minutes is marked stale and the orchestrator is told; it keeps running. After two idle hours it is timed out: stopped and handled as a failure (resume, repair, drop or ask).
- **The level is fixed.** `build`, `review` or `consolidate` is chosen before any work is dispatched and never changes mid-run; so is whether the judges run in parallel.

## Outcomes

A worker's report ends with `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`. `done` is a claim: the mod marks the work landed only when `sync` sees its pull request merged. A worker whose last line says done while its pull request is still open is marked failed, with its branch and pull request kept, so the orchestrator can resume it.

QA and the reviewer write a JSON report. The mod checks that every rubric id is scored exactly once with `strong`, `acceptable` or `unacceptable` and that the overview is not empty, then derives the verdict: `fix` if any item is unacceptable, `pass-with-recommendations` if any is acceptable, `pass` otherwise. An invalid report is reported as such and never counts as a pass.

## The pane

The header reads like fastfetch: the task, elapsed time, branch, level, models and spend, then a phase bar whose done phases are grey, current phase colored and named, phases ahead hollow. The bar has one block per phase of the level, so its length is the level at a glance: five at `build`, six at `review`, seven at `consolidate`. Up to four rows count pull requests by state, agents by outcome, QA rounds by verdict and review rounds by verdict, each expanding to its items. Below them the timeline is a tree of everything that happened: your messages, the orchestrator's answers, every worker with a link to its pull request, every QA and review round with its scores. It shows the latest five events and folds the rest behind `earlier`.

One color code throughout: teal in progress, green done, yellow done with limitations or recommendations, orange failed. The level has a color of its own in the header and the band above the prompt: grey for `build`, amber for `review`, violet for `consolidate`.

`/dacapo-pane` reopens the pane; `/dacapo-config` prints the configuration in force.

## Tools

The orchestrator calls these; the `core` skill says when.

| Tool | What it does |
| --- | --- |
| `config` | The configuration in force: default level, judges, the models each kind of subagent may be given, and the skills commits and pull requests follow, each with the file it came from. |
| `start` | Checks `gh`, pulls the base branch, cuts the run branch in its worktree and pushes it. Takes the level and, at `consolidate`, whether the judges run in parallel. |
| `dispatch` | Prepares one worktree, branch and brief per task; `resume: true` continues an earlier worker. |
| `sync` | Confirms which pull requests merged, prunes their branches, fast-forwards the run worktree. |
| `qa` | Prepares the QA worktree with the rubric and harness. |
| `review` | At `consolidate`: prepares the reviewer's worktree with the engineering rubric; the reviewer diffs the run against the base branch. |
| `finish` | Opens the final pull request; the mod merges it when green. |
| `status`, `phase`, `cancel` | The timeline as text, the phase marker, stopping an agent. |

## Where things are

Reports, briefs and rubrics of a run are under `.workspaces/.dacapo/<run id>/` in the repository. Worker worktrees are `.workspaces/<run branch>--<task id>`, QA's `.workspaces/qa/<round>-<n>`, the reviewer's `.workspaces/review/<round>-<n>`. dacapo keeps `.workspaces/`, `.context/` and `.dacapo.conf` out of git through `.git/info/exclude`.
