# dacapo

*Da capo*: from the top, again. A Claude Code mod that turns a handed-over task into an orchestrated loop: the session model clarifies, researches and plans; parallel worker subagents implement in git worktrees; the branches are squash-merged into `dev`; a QA subagent uses the deliverable as the end user and scores a rubric; the loop repeats until QA passes, then `dev` is released into `main`. A pane shows the whole run as a timeline, and a band above the prompt shows where the current iteration stands.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## Install

In a terminal session of Claude Code:

```
/plugin install dacapo --marketplace nunomota/dacapo
```

Answer `y` to add the marketplace, then pick the user scope. The mod is active in that session at once and in every later one, including sessions the desktop app starts.

To run it from a clone instead:

```
claude --plugin-dir ~/dacapo
```

## Use

```
/dacapo <what you want built>
```

The skill then runs in phases:

1. **Clarify.** It restates the task and asks about anything material, until nothing is open.
2. **Research.** It picks a stack if none is fixed, reads the docs for the versions in use, and notes the build and test commands.
3. **Plan.** It calls `start` with the task heading and a short overview, splits the work into independent tasks (each with a brief, a model, a build command and the Conventional Commit title of its squash commit), and writes the QA rubric and harness.
4. **Loop.** `dispatch` prepares one worktree and brief per task under `.workspaces/task/<iteration>-<id>` and spells out the `Agent` call that starts each worker; the orchestrator makes those calls itself, so the session's permission mode (auto mode included) judges them as its own actions, and the mod fills in the brief, model, worktree and background mode. The orchestrator then ends its turn and is woken by a `[dacapo]` prompt when every worker has ended or one goes stale. `merge` squash-merges the finished branches into `dev`. `qa` prepares the QA subagent's worktree of `dev` the same way; its report wakes the orchestrator with the verdict and overview. On `fix` the next `dispatch` starts a new iteration.
5. **Finish.** `finish` fast-forwards `main` to `dev` (or makes one merge commit when the histories diverged) and removes the run's worktrees.

You can type while workers run; your prompts become rows in the timeline and are folded into the next iteration.

## What the mod enforces

- **Only workers change code.** While a run is active, Edit, Write and history-changing git commands from the orchestrator are refused. A worker can only write inside its own worktree.
- **Clean commits.** Workers follow the bundled `clean-commits` skill: Conventional Commit units with title-only messages; the squash commit on `dev` takes the title from the plan. The skill is also available on its own as `/clean-commits`.
- **QA never reads source.** The QA subagent may read and search only the `.context/` folder of its worktree, and the only file it may write is its report. It is given the harness (how to run and use the deliverable) and the rubric, and scores every item `strong`, `acceptable` or `unacceptable`. The mod validates the report (every rubric id scored once, every score one of the three words, a non-empty overview), derives the verdict, and keeps a copy under `.workspaces/.dacapo/<run>/`.
- **Merges reach the remote.** After every squash merge the mod pushes `dev` to `origin`, and after the release it pushes `main`. A push that fails, or a repository without an `origin`, is reported in the tool's answer, in `status` and in the pane, and the loop goes on; push by hand when you can.
- **Wake-ups are delivered, not fired and forgotten.** Collection of a QA report and every `[dacapo]` prompt run on the mod's own timer, outside the finishing agent's dispatch. A wake-up whose turn has not started within 30 seconds is sent again, up to three times, and `status` lists any still undelivered.
- **Stale and timed out are not failed.** A worker or QA agent with no tool call or model step for 30 minutes is marked stale and the orchestrator is told; it keeps running. After two idle hours it is stopped and marked timed out. Both are distinct from a failure, so the cause stays readable.
- **Repository hygiene.** `.workspaces/` and `.context/` are added to `.git/info/exclude` (never to a tracked `.gitignore`). Worktrees are named after their branches and pruned once merged.

## Tools

The orchestrator calls these; the skill says when.

| Tool | What it does |
| --- | --- |
| `mcp__dacapo__start` | Records the repository (the session's, or `root`), creates `dev` and its worktree if missing, opens the pane. |
| `mcp__dacapo__dispatch` | Prepares one worktree, branch and brief per task and returns the `Agent` calls that start the workers. A second dispatch after QA starts the next round. |
| `mcp__dacapo__merge` | Squash-merges every finished branch of the iteration into `dev`, one titled commit each; reports conflicts instead of resolving them. |
| `mcp__dacapo__qa` | Prepares the QA worktree with a rubric and harness and returns the `Agent` call that starts it; the report is collected when the agent ends. |
| `mcp__dacapo__status` | The timeline as text, with tokens and cost. |
| `mcp__dacapo__phase` | Marks the orchestrator's phase (clarify, research, plan, implement, qa, release); the other tools set the later phases themselves. |
| `mcp__dacapo__cancel` | Stops a running agent by id. |
| `mcp__dacapo__finish` | Releases `dev` into `main` and closes the run (`abort: true` closes without releasing). |

`/dacapo-pane` reopens the timeline pane.

## The timeline

The pane opens with a card: the task heading, a status strip (elapsed, agents, tokens, estimated cost) and the phase strip `clarify › research › plan › implement › qa › release`, which steps back to `implement` when a fix round starts. The task overview sits under the card in dim text, then a rule.

Below it, one card per entry, in order: an icon on the left (a vector icon on the desktop, VS Code and mobile surfaces, a glyph in the terminal), a header line that expands or collapses the card, and a dim subline. Consecutive messages from you, or consecutive answers from the orchestrator, fold into one card that counts them and shows the latest on its subline and all of them when expanded. The border and icon take the entry's color: white for a message you typed, purple for what the orchestrator answered, cyan for QA, and for a sub-agent yellow while waiting, running or stale, green when finished or merged, red when failed, timed out or cancelled.

- A sub-agent card reads `count command` over `18s · sonnet · merged`; expanded it adds tool calls, tokens and cost, a feed of its tool calls and assistant text (the last 40 entries, captured from the engine's model steps), and its closing summary.
- A QA card reads `QA round 1: pass` over the score counts; expanded it adds the overview, every item below strong and its own feed.
- Your messages and the orchestrator's answers show their first words on the subline and the full text when expanded.

The band above the prompt is a two-line box: the phase and task, then agent counts, QA state and spend, with buttons for the timeline and to hide the band.

Token counts include cache reads and writes, as the API bills them. The cost estimate uses Anthropic list prices per model (see `hooks/cost.ts`); override or extend the table with the plugin's `prices` option, a JSON object of `{"<model id prefix>": [input, output, cacheRead, cacheWrite]}` in dollars per million tokens.

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
hooks/cost.ts                    price table, token and cost formatting
hooks/io.ts                      the engine calls the helpers use
types/index.d.ts                 the $.state contract
skills/dacapo/SKILL.md        the /dacapo skill
skills/clean-commits/SKILL.md    the commit rules workers and the squash merges follow
tests/dacapo.test.ts          claude plugin test
```

## Development

```
claude plugin validate .
claude plugin test .
```

Mods are built on function hooks (`hooks/register.tsx`), an early-access Claude Code API tested on Claude Code 2.1.296; it may change between releases.

The tools in `hooks/register.tsx` answer with text only: the engine holds a registered tool's `result` to a string or content blocks. Subagents are never started from inside the mod (`$.agent.spawn`): in auto mode the permission classifier refuses an action the model's own request did not ask for, so the tools hand the orchestrator the `Agent` calls to make and a `tool.call` hook on `Agent` fills them in and records the agent id from the result.

## Known limits

- The QA agent keeps Bash so it can run the deliverable, so reading source through a shell command is forbidden by its prompt rather than by the tooling. Read, Glob, Grep and writes are hard-denied outside `.context/`.
- Merge conflicts between worker branches are reported, not resolved: the skill dispatches a worker to redo the branch on top of `dev`.
- The timeline lives for the session; it is not kept across restarts.

## License

MIT
