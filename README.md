# task-loop

A Claude Code mod that turns a handed-over task into an orchestrated loop: the session model clarifies, researches and plans; parallel worker subagents implement in git worktrees; the branches are squash-merged into `dev`; a QA subagent uses the deliverable as the end user and scores a rubric; the loop repeats until QA passes, then `dev` is released into `main`. A pane shows the whole run as a timeline, and a band above the prompt shows where the current iteration stands.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## Install

In a terminal session of Claude Code:

```
/plugin install task-loop --marketplace nunomota/claude-task-loop
```

Answer `y` to add the marketplace, then pick the user scope. The mod is active in that session at once and in every later one, including sessions the desktop app starts.

To run it from a clone instead:

```
claude --plugin-dir ~/claude-task-loop
```

## Use

```
/task-loop <what you want built>
```

The skill then runs in phases:

1. **Clarify.** It restates the task and asks about anything material, until nothing is open.
2. **Research.** It picks a stack if none is fixed, reads the docs for the versions in use, and notes the build and test commands.
3. **Plan.** It calls `start`, splits the work into independent tasks (each with a brief, a model, a build command and the Conventional Commit title of its squash commit), and writes the QA rubric and harness.
4. **Loop.** `dispatch` starts one worker per task in `.workspaces/task/<iteration>-<id>`; the orchestrator ends its turn and is woken by a `[task-loop]` prompt when every worker has ended or one goes stale. `merge` squash-merges the finished branches into `dev`. `qa` starts the QA subagent in a fresh worktree of `dev`; its report wakes the orchestrator with the verdict and overview. On `fix` the next `dispatch` starts a new iteration.
5. **Finish.** `finish` fast-forwards `main` to `dev` (or makes one merge commit when the histories diverged) and removes the run's worktrees.

You can type while workers run; your prompts become rows in the timeline and are folded into the next iteration.

## What the mod enforces

- **Only workers change code.** While a run is active, Edit, Write and history-changing git commands from the orchestrator are refused. A worker can only write inside its own worktree.
- **Clean commits.** Workers commit in Conventional Commit units with title-only messages; the squash commit on `dev` takes the title from the plan.
- **QA never reads source.** The QA subagent may read and search only the `.context/` folder of its worktree, and the only file it may write is its report. It is given the harness (how to run and use the deliverable) and the rubric, and scores every item `strong`, `acceptable` or `unacceptable`. The mod validates the report (every rubric id scored once, every score one of the three words, a non-empty overview), derives the verdict, and keeps a copy under `.workspaces/.task-loop/<run>/`.
- **Stale and timed out are not failed.** A worker or QA agent with no tool call or model step for 30 minutes is marked stale and the orchestrator is told; it keeps running. After two idle hours it is stopped and marked timed out. Both are distinct from a failure, so the cause stays readable.
- **Repository hygiene.** `.workspaces/` and `.context/` are added to `.git/info/exclude` (never to a tracked `.gitignore`). Worktrees are named after their branches and pruned once merged.

## Tools

The orchestrator calls these; the skill says when.

| Tool | What it does |
| --- | --- |
| `mcp__task-loop__start` | Records the repository, creates `dev` and its worktree if missing, opens the pane. |
| `mcp__task-loop__dispatch` | Starts one worker per task in its own worktree and branch. A second dispatch after QA starts the next iteration. |
| `mcp__task-loop__merge` | Squash-merges every finished branch of the iteration into `dev`, one titled commit each; reports conflicts instead of resolving them. |
| `mcp__task-loop__qa` | Starts the QA subagent with a rubric and harness; the report is collected when the agent ends. |
| `mcp__task-loop__status` | The timeline as text. |
| `mcp__task-loop__cancel` | Stops a running agent by id. |
| `mcp__task-loop__finish` | Releases `dev` into `main` and closes the run (`abort: true` closes without releasing). |

`/task-loop-pane` reopens the timeline pane.

## The timeline

Each iteration is a collapsible section; the previous one folds when a new iteration starts. Rows:

- **Worker:** start time, a spinner while running or a glyph for finished, merged, failed, stale, timed out or cancelled, the task title, the model and the elapsed time.
- **QA:** start time, the round, the counts of strong, acceptable and unacceptable items and the verdict, the elapsed time. Click to expand the overview and the items below strong; while QA runs it says the report is not ready.
- **You:** every prompt you typed during the run, expandable to its full text.

## Layout

```
.claude-plugin/plugin.json       manifest
.claude-plugin/marketplace.json  lets /plugin install find the mod here
hooks/hooks.json                 points at the hooks module
hooks/register.tsx               hooks, tools, guards, the ticker
hooks/git.ts                     worktrees, squash merges, release
hooks/report.ts                  QA rubric and report validation
hooks/prompts.ts                 worker and QA system prompts, briefs
hooks/pane.tsx                   the timeline pane and the band
hooks/io.ts                      the engine calls the helpers use
types/index.d.ts                 the $.state contract
skills/task-loop/SKILL.md        the /task-loop skill
tests/task-loop.test.ts          claude plugin test
```

## Development

```
claude plugin validate .
claude plugin test .
```

Mods are built on function hooks (`hooks/register.tsx`), an early-access Claude Code API tested on Claude Code 2.1.296; it may change between releases.

## Known limits

- The QA agent keeps Bash so it can run the deliverable, so reading source through a shell command is forbidden by its prompt rather than by the tooling. Read, Glob, Grep and writes are hard-denied outside `.context/`.
- Merge conflicts between worker branches are reported, not resolved: the skill dispatches a worker to redo the branch on top of `dev`.
- The timeline lives for the session; it is not kept across restarts.

## License

MIT
