# dacapo

*Da capo*: from the top, again. A Claude Code mod that turns a handed-over task into an orchestrated loop: the session model clarifies, researches and plans; parallel worker subagents implement in git worktrees and land their work through GitHub pull requests into a run branch; a QA subagent uses the deliverable as the end user and scores a rubric; the loop repeats until QA passes, then the run branch is merged into `main` through a final pull request of its own. A pane shows the whole run as a timeline, and a band above the prompt shows where the run stands.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## Install

In a terminal session of Claude Code:

```
/plugin install dacapo --marketplace nunomota/dacapo
```

Answer `y` to add the marketplace, then pick the user scope. The mod is active in that session at once and in every later one, including sessions the desktop app starts.

dacapo needs [`gh`](https://cli.github.com), the GitHub CLI, installed and logged in (`gh auth login`), and a repository whose `origin` is on GitHub. If either is missing, `start` says so and the orchestrator helps you set it up before anything else happens.

To run it from a clone instead:

```
claude --plugin-dir ~/dacapo
```

## Use

```
/dacapo <what you want built>
```

The skill comes in two parts. `dacapo-loop` is the loop itself, host-agnostic and callable on its own as `/dacapo-loop <task>`, so another orchestrator host with its own dispatch and merge can use it; the `/dacapo` entry loads it and carries the binding to this mod's tools and subagents.

The skill then runs in phases:

1. **Clarify.** It restates the task and asks about anything material, until nothing is open.
2. **Research.** It picks a stack if none is fixed, reads the docs for the versions in use, and notes the build and test commands.
3. **Plan.** It calls `start` with the task heading, a short overview and a branch name for the change. `start` checks `gh`, pulls `main` from origin, cuts the run branch from it in a worktree under `.workspaces/<branch>` and pushes it. It then splits the work into independent tasks (each with a brief, a model, a build command and the Conventional Commit title of its squash commit and pull request), and writes the QA rubric and harness.
4. **Loop.** `dispatch` prepares one worktree and brief per task under `.workspaces/<branch>--<id>` and spells out the `Agent` call that starts each worker; the orchestrator makes those calls itself, so the session's permission mode (auto mode included) judges them as its own actions, and the mod fills in the brief, model, worktree and background mode. Each worker opens a draft pull request against the run branch after its first commit, marks it ready when its build passes, rebases conflicts away, waits for the checks (three fix rounds at most; no CI counts as green), squash-merges it with the planned title, and only then finishes. The orchestrator is woken by a `[dacapo]` prompt when every worker has ended or one goes stale. `sync` confirms through `gh` what landed, prunes the merged branches and worktrees, and fast-forwards the run worktree. `qa` prepares the QA subagent's worktree of the run branch the same way; its report wakes the orchestrator with the verdict and overview. On `fix` the next `dispatch` starts a new round; a task dispatched with `resume: true` continues an earlier worker on its branch and pull request.
5. **Merge.** `finish` opens the final pull request from the run branch into `main` with a title and body the orchestrator writes to the `clean-prs` rules. The mod watches it, merges it with a merge commit titled as planned once its checks are green, deletes the run branch, prunes the worktrees and wakes the orchestrator. Failing checks or a conflict with `main` wake the orchestrator instead, which dispatches a fix, runs QA once more, and calls `finish` again.

You can type while workers run; your prompts become rows in the timeline and are folded into the next round.

## What the mod enforces

- **Only workers change code.** While a run is active, Edit, Write, history-changing git commands and `gh pr` commands from the orchestrator are refused. A worker can only write inside its own worktree.
- **Everything lands through pull requests.** Workers merge their own pull requests after green checks; the final merge into `main` is a pull request too. The mod never merges a branch locally.
- **Clean commits and clean pull requests.** Workers follow the bundled `clean-commits` skill (Conventional Commit units with title-only messages and no attribution lines) and the bundled `clean-prs` skill (the planned title, one paragraph on the contribution, a `Verified:` line, an optional `Notes:` line). `finish` refuses a final pull request body with an attribution line. Both skills are also available on their own as `/clean-commits` and `/clean-prs`.
- **QA never reads source.** The QA subagent may read and search only the `.context/` folder of its worktree, and the only file it may write is its report. It is given the harness (how to run and use the deliverable) and the rubric, and scores every item `strong`, `acceptable` or `unacceptable`. The mod validates the report (every rubric id scored once, every score one of the three words, a non-empty overview), derives the verdict, and keeps a copy under `.workspaces/.dacapo/<run>/`.
- **Wake-ups are delivered, not fired and forgotten.** Collection of a QA report, the pull request polling, the final merge and every `[dacapo]` prompt run on the mod's own timer, outside the finishing agent's dispatch. A wake-up whose turn has not started within 30 seconds is sent again, up to three times, and `status` lists any still undelivered.
- **Stale and timed out are not failed.** A worker or QA agent with no tool call or model step for 30 minutes is marked stale and the orchestrator is told; it keeps running. After two idle hours it is stopped and marked timed out. Both are distinct from a failure, so the cause stays readable.
- **Repository hygiene.** `.workspaces/` and `.context/` are added to `.git/info/exclude` (never to a tracked `.gitignore`). Worktrees are named after their branches and pruned once their pull request is merged, on origin too.

## Tools

The orchestrator calls these; the skill says when.

| Tool | What it does |
| --- | --- |
| `mcp__dacapo__start` | Checks `gh`, pulls the base branch, cuts the run branch in its worktree and pushes it, opens the pane. |
| `mcp__dacapo__dispatch` | Prepares one worktree, branch and brief per task and returns the `Agent` calls that start the workers. `resume: true` continues an earlier worker of the same task. |
| `mcp__dacapo__sync` | Lists the pull requests through `gh`, marks the merged ones, prunes their worktrees and branches, fast-forwards the run worktree. |
| `mcp__dacapo__qa` | Prepares the QA worktree with a rubric and harness and returns the `Agent` call that starts it; the report is collected when the agent ends. |
| `mcp__dacapo__status` | The timeline as text, with pull requests, tokens and cost. |
| `mcp__dacapo__phase` | Marks the orchestrator's phase (clarify, research, plan, implement, qa, merge); the other tools set the later phases themselves. |
| `mcp__dacapo__cancel` | Stops a running agent by id and closes its open pull request. |
| `mcp__dacapo__finish` | Opens the final pull request with a title and body; the run merges it when green (`abort: true` closes the run without one). |

`/dacapo-pane` reopens the timeline pane.

## The timeline

The pane opens with a header in the manner of fastfetch: the dacapo mark on the left (a vector icon on the desktop, VS Code and mobile surfaces, a small glyph drawing in the terminal) and key lines on the right: `Task` (the heading, or "Clarifying the task" until `start` names it), `Elapsed`, `Branch` (run branch and base), `Models` (agents per model) and `Spend` (tokens and estimated cost). Under them a phase bar of six blocks: the phases done greyed out, the current one in its own color with its name under its block, the ones ahead hollow. A merged run fills the bar green and reads `merged`; an aborted one stops on its phase in orange and reads `aborted`. The task overview follows in dim text, then three collapsible progress rows: `PRs (n)` with a count per state beside GitHub's icon in GitHub's color, `Agents (n)` with counts running, done and failed, and `QA (n)` with counts of rounds that passed, passed with recommendations, or need a fix. Empty counts are left out. Expanded, each row lists its items one per line, colored and phrased like the timeline. The timeline follows as a panel of its own: a title band in the phase bar's current color (`Timeline · 14 events · 1 running`) with an `earlier (n)` switch that reveals entries beyond the latest five; the lead-in line is dotted while earlier entries are folded away and a `hide` toggle, over a framed tree.

The timeline is a tree: one entry per event on a trunk down the left (smooth vector lines on the desktop, VS Code and mobile surfaces, `├─ │ └─` glyphs in the terminal), each with its icon beside the branch, a header line that expands or collapses the entry, and a dim subline under the header. A blank row separates entries. Consecutive messages from you, or consecutive answers from the orchestrator, fold into one entry that counts them and shows the latest on its subline and all of them when expanded. The icon and header take the entry's color, one code for workers and QA alike: teal while in progress (the icon pulses on the desktop and spins in the terminal), green when done, yellow when done with limitations or with recommendations, orange when failed. A worker ends its answer with a status line, `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`, which the mod reads; without one its pull request decides, merged or not, and `sync` marks a worker that finished without landing as failed.

- A sub-agent entry reads the task title over `18s · sonnet` and, once its pull request exists, GitHub's icon for the pull request's state (draft gray, open green, merged purple, closed red) and its title as a link; an orange cross follows when its checks fail. Expanded it adds tool calls, tokens and cost, every pull request of the branch when there is more than one, a feed of its tool calls and assistant text (the last 40 entries), and its closing summary.
- A QA entry reads `QA round 1: pass` over `2m14s · opus · 7 · 2 · 0 → pass`, the counts in green, yellow and orange for strong, acceptable and unacceptable items, zero counts left out; expanded it adds the overview, every item below strong and its own feed.
- Your messages and the orchestrator's answers show their first words on the subline and the full text when expanded.

The band above the prompt is a two-line box: the phase and task, then agent counts, open pull requests, the final pull request while it waits on checks, QA state and spend, with buttons for the timeline and to hide the band.

Token counts include cache reads and writes, as the API bills them. The cost estimate uses Anthropic list prices per model (see `hooks/cost.ts`); override or extend the table with the plugin's `prices` option, a JSON object of `{"<model id prefix>": [input, output, cacheRead, cacheWrite]}` in dollars per million tokens.

## Layout

```
.claude-plugin/plugin.json       manifest
.claude-plugin/marketplace.json  lets /plugin install find the mod here
hooks/hooks.json                 points at the hooks module
hooks/register.tsx               hooks, tools, guards, the ticker, the final merge watch
hooks/git.ts                     worktrees, branches, fetch and push
hooks/gh.ts                      gh: availability, pull request listing, create, edit, merge, close
hooks/report.ts                  QA rubric and report validation
hooks/prompts.ts                 worker and QA system prompts, briefs, the commit and pull request rules
hooks/pane.tsx                   the timeline pane and the band
hooks/cost.ts                    price table, token and cost formatting
hooks/io.ts                      the engine calls the helpers use
types/index.d.ts                 the $.state contract
skills/dacapo/SKILL.md           the /dacapo skill: loads dacapo-loop and binds it to the mod
skills/dacapo-loop/SKILL.md      the loop, host-agnostic, also /dacapo-loop
skills/clean-commits/SKILL.md    the commit rules workers and squash merges follow
skills/clean-prs/SKILL.md        the pull request rules workers and the final pull request follow
tests/dacapo.test.ts             claude plugin test
```

## Development

```
claude plugin validate .
claude plugin test .
```

Mods are built on function hooks (`hooks/register.tsx`), an early-access Claude Code API tested on Claude Code 2.1.296; it may change between releases.

The tools in `hooks/register.tsx` answer with text only: the engine holds a registered tool's `result` to a string or content blocks. Subagents are never started from inside the mod (`$.agent.spawn`): in auto mode the permission classifier refuses an action the model's own request did not ask for, so the tools hand the orchestrator the `Agent` calls to make and a `tool.call` hook on `Agent` fills them in and records the agent id from the result. Pull request state comes from one `gh pr list` call every 20 seconds on the mod's timer, matched to the run's branches; nothing in the mod asks a model anything.

## Known limits

- The QA agent keeps Bash so it can run the deliverable, so reading source through a shell command is forbidden by its prompt rather than by the tooling. Read, Glob, Grep and writes are hard-denied outside `.context/`.
- Branch protection that requires reviews stops a worker's merge (it reports why) and the final merge (the orchestrator is told; merging on GitHub by hand finishes the run).
- The timeline lives for the session; it is not kept across restarts.

## License

MIT
