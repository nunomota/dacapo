---
name: core
description: Runs a handed-over task as an orchestrated loop read from its files: clarify, research, plan, dispatch parallel worker subagents in git worktrees, judge the result with scored rubrics, iterate, merge. Workers land their work through GitHub pull requests into a run branch, and the run branch merges into the base branch through a final pull request. Invoked by the user via /dacapo:core [--loop <name>] <task>.
---

# core

This file says how this plugin runs a loop: its tools, subagents, worktrees, pull requests and wake-ups. The loop itself is files: a `loop.json` of steps, stages, transitions and handovers, and one file per node with its role. The task is everything after `/dacapo:core` in the prompt that invoked this skill, less the loop flag: `--loop <name>` right after the command names the loop, and without one the loop is the one the `loop` configuration key names (`core` by default). The plugin ships `core-fast` (no judges), `core` (QA as the end user) and `core-deep` (QA, then an engineering review); the user may keep loops of their own.

Call `mcp__dacapo__config` once, first. It returns the configuration in force and the loop: its steps and stages, every node with its contract, models, skills and categories, its transitions and handovers, and your role as its entry node under `Your role`. Read your role there and follow it: in the shipped loops it has you load `dacapo:loop`, the phases, boundaries and decision rules you follow. Never read a `dacapo.conf` or a loop file yourself: the tool is the configuration.

The loop's boundaries are enforced here. While a run is active the tools refuse Edit, Write, history-changing git commands and `gh pr` commands from you. Workers write only inside their worktree. A judge that uses the product can read and search only its `.context` folder and write only its report; its shell is bound by its prompt alone. The collectors it starts are bound the same way and write only under `.context/evidence`; a judge may start only the collector its loop hands slices to, and a collector none at all. A judge that reads the change reads anything and writes only its report. A node you ask writes only under `.context`, and an interviewing node writes only its report. You never edit files, touch git, or open and merge pull requests: the `mcp__dacapo__*` tools and the subagents do. Each tool reply says what to call next. A timeline pane shows every worker, judge, pull request and user prompt of the run, and a bar of the loop's stages; the band above the prompt shows where the run stands. `/dacapo-pane` reopens the pane, and `/dacapo-back` takes the floor back from an interviewing node.

## The loop on these tools

Every node of the loop other than its entry and exit is an agent type `dacapo:<node id>`. Its contract says which tool runs it:
- A stage you work through alone (no nodes, like `clarify` and `research`): `stage` as you enter it.
- Opening the run: `start`, as you begin planning.
- The `lands` node (the workers): `dispatch`, then the Agent calls its reply lists.
- Learning outcomes: `wait` for the `[dacapo]` wake-up, then `sync`.
- Resuming a worker: `dispatch` with the same `id` and `resume: true`. Repair first: a `dispatch` of its own, then `sync`, then the resume.
- Stopping an agent, or dropping its task: `cancel`.
- Each `scores` node (the judges), in step order: `judge`, then its Agent call. Two judges whose stages share a step run side by side.
- A node with contract `none`, on call or in a stage: `ask`, whenever its help is worth it.
- The `interviews` node: `consult`, then its Agent call; it holds the floor until it reports.
- Integrating into the base line: `finish`.
- The state of everything as text: `status`.

## How work lands here

- The base branch is the one the `base-branch` configuration key names, `main` by default, unless the user names another. `start` pulls it from origin, then cuts the run branch from it in its own worktree under `.workspaces/<branch>` and pushes it.
- Every worker gets its own branch and worktree under `.workspaces/<run branch>--<id>` and lands through a draft pull request against the run branch. It marks the pull request ready when its build passes, rebases conflicts away, and waits for and fixes the checks (three rounds at most; no CI counts as green). Then it squash-merges the pull request with the planned title.
- Commits follow the skill the `commits-skill` configuration key names and pull requests the one `prs-skill` names: the shipped `dacapo:rules-commits` and `dacapo:rules-prs` unless configured otherwise. Workers load them from their brief; the mod checks commit titles and attribution lines itself only while the shipped skills are in force.
- Each judge works in a fresh worktree of the run branch under `.workspaces/<node>/<round>-<n>`; a judge of the change reads it diffed against the base branch.
- The run ends with a final pull request from the run branch into the base branch, merged with a merge commit.

## Outcomes here

`status` and the pane also name the run's loop and its current stages. A worker's status in the wake-up, `status` and the pane is one of:
- `finished`: the worker ended with a report whose last line is `dacapo: done` or `dacapo: done with limitations`. This is its claim, not yet a fact.
- `merged` (landed): what `sync` confirms from the pull request's merged state. Only then has the work landed.
- `failed`: the worker's own `dacapo: failed` line, or the agent ending in error. Its branch and pull request stay in place. `sync` also marks a `finished` worker `failed` when its pull request did not merge.
- `stale`: no tool call or model step for 30 minutes; it still runs. This is the loop's stalled worker. A worker waiting on checks can look stale.
- `timed out`: stopped by the run after two idle hours. Treat it as failed.
- `cancelled`: stopped by you; its open pull request is closed.

The worker's report ends with `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`: the loop's three outcomes. A worker whose last line is `dacapo: done` but whose pull request is still open has not landed (what `sync` reports); the loop says what follows.

## Clarify, research and plan in this host

- Offer enumerable options with AskUserQuestion.
- The loop comes from the flag after `/dacapo:core`; an absent flag means the configured loop, which you confirm in your restatement rather than ask about. Pass `loop` to `start` only when the user asks for another one than the run opened with.
- Compare candidate stacks or libraries with WebSearch when the stack is not fixed by the user or the repository.
- CI means a `.github/workflows` folder.
- Until `start` is called the pane shows "Clarifying the task" in place of the heading.

## The operations

### config

Call `mcp__dacapo__config` with no arguments, once at the start of a run and again only when a reply sends you there. It lists every configuration key with the file it came from (`loop`, the model lists `workers`, `qa` and `review` that a loop's nodes draw from, `commits-skill`, `prs-skill`, `base-branch`, `qa-collectors`), then the loop: its level and folder, its steps with stage ids and summaries, every node with type, contract, models, skills and categories, its transitions with when and then, its handovers, and `Your role`. A loop that cannot be loaded is named with its problems; tell the user, since no run starts on it. The person edits the user conf ($DACAPO_HOME/dacapo.conf when DACAPO_HOME is set, else ~/.claude/dacapo.conf; `config` names the path in force) or the repository's `.dacapo.conf` and sees the result with `/dacapo-config`.

### stage

Call `mcp__dacapo__stage` with `stage` (a stage id of the loop) as you enter a stage you work through alone: `clarify` and `research` in the shipped loops. The other stages are marked by the tools: `start` marks the planning stage, `dispatch` the stage of its `lands` node, `judge` the stage of its judge, and `finish` the stage that leads to the exit. To mark the stages of one step side by side by hand, give them together, `stage: 'qa, review'` or a list. A stage the loop does not have is refused, and so are stages of two steps.

### start

Call `mcp__dacapo__start` once the request is clear, as you enter the loop's plan:
- `task`: the run's one line.
- `overview`: one short paragraph.
- `branch`: named after the change (`add-login`, `fix-export-crash`).
- `baseBranch`: only when the user wants the run merged into another branch than the configured one.
- `loop`: only when the user asks for another loop than the one the run opened with. Fixed once set up: a later `start` with another loop is refused. An unknown loop is refused with the names there are.

If it answers that `gh` is missing, not logged in, or cannot reach the repository on GitHub, stop. Tell the user the install command for their system and that they must run `gh auth login` in a terminal themselves. Call `start` again once they say it is done. Every change lands through a pull request, so do not plan around it. If it answers that an agent type is registered by another loop with a different role, tell the user to begin a new session with the loop flag.

### dispatch

Call `mcp__dacapo__dispatch` with `tasks` (and optionally `node`, a round `title` and `overview`, kept only in the run log). `node` names the `lands` node that works the tasks; leave it out when the loop has one. Map each task:
- `id`, `title`: as given.
- `prompt`: its brief. For a resumed task, the resume brief the loop's implement phase describes.
- `model`: one of the node's models (`config`); the first listed is the strong tier, the last the fast tier.
- `commit`: the landing title. A Conventional Commit line: types feat, fix, docs, style, refactor, test, chore, perf, ci, revert only; no scope in parentheses; at most 72 characters.
- `build`, `test`: the commands.
- `context`: a list of `{ name, text }` files placed under `.context/`.
- `resume: true`: continue the earlier worker of the same `id` on its branch, worktree and pull request.
- `merge: "merge"`: only for a branch that merges the base branch into the run branch. Otherwise leave it out (squash).

This host already gives every worker its standing instructions: the node's role and the landing steps, with the brief it writes. They cover building and testing, fixing what it introduced, clean commits, landing through the pull request, and the report and its last line. Put only the task itself and its contracts in the task `prompt`.

The reply lists one `Agent` call per task. Make them yourself, all in one message, exactly as listed: `subagent_type: "dacapo:<node>"`, the listed description, and the prompt `dacapo worker <id>`. Never write the prompts yourself; the run fills in the brief, model, worktree and background mode. Then end your turn. Each worker opens its draft pull request after its first commit.

### wait

`wait` is not a tool: it means doing nothing. A prompt starting with `[dacapo]` wakes you when every worker has ended, when one goes stale, or when one times out. The wake-up names every worker's status, agent id and pull request.
- Do not poll; see `status` for when to call it.
- Ignore background-agent notifications and hand-backs about single workers.
- The `[dacapo]` wake-up can take up to a minute after the last hand-back, and one that does not start a turn is sent again.

### sync

`sync` is how the loop learns each worker's outcome and brings landed work into the run. When every worker has ended, call `mcp__dacapo__sync`. It lists the pull requests through `gh`, marks the merged ones as landed, prunes their worktrees and branches, and fast-forwards the run worktree. Call it before `judge`; its reply names the loop's next move.

### judge

Call `mcp__dacapo__judge` for each `scores` node of the loop in step order, once the round's work has landed and is synced:
- `node`: the judge (`qa`, `reviewer`).
- `rubric`: items with `id`, `title` and a `category` from the node's categories (`core | ui-ux` for QA, `quality | consistency | cleanup` for the reviewer).
- `harness` (Markdown): required for a judge that uses the product (categories `core` or `ui-ux`) or runs collectors.
- `brief`: the round note of the loop's qa phase, or for a judge of the change what the run built, the conventions the briefs pointed at and what to look at first.
- `model`: optionally one of the node's models; the first is the default.

A judge that hands slices to a collects node may split the rubric among those collectors (as many at once as its node's `collectors`, else `qa-collectors`), each on its own share of the product, so the harness must say what one running instance can share between testers and what cannot be shared. A collector reports to its judge alone, ending with `dacapo: collected`, `dacapo: collected with gaps` or `dacapo: failed`; the judge reruns or walks itself a slice whose collector failed, and only its report reaches you. `status` and the pane count a round's collectors and how many failed.

The tool refuses a judge while an agent of an earlier step still runs, while a finished worker is not synced, and before each judge of an earlier step has reported on the round. The reply gives one `Agent` call: `subagent_type: "dacapo:<node>"`, prompt `dacapo judge <node> <round>-<n>`. Make it exactly as listed, then end your turn. When another judge's stage shares the step, the reply says to call `judge` for it as well first: make both Agent calls in one message, then end your turn; each verdict wakes you on its own, and a fix verdict from the judge that uses the product stops a judge of the change running beside it. The `[dacapo]` wake-up carries the verdict, the counts, every item below `strong` and the overview, or says the report was invalid and why, and names the loop's next move.

### ask

Call `mcp__dacapo__ask` with `node` (a node with contract `none`, on call or in a stage), `prompt` (the whole question or task: the node sees nothing else of the run) and optionally `model` (one of its models). The reply gives one `Agent` call: `subagent_type: "dacapo:<node>"`, prompt `dacapo ask <node> <n>`. Make it exactly as listed. It runs in the foreground in the run worktree (the repository before `start`), so the Agent result is the answer; read it and go on. The timeline shows it as a row.

### consult

Call `mcp__dacapo__consult` with `node` (a node with contract `interviews`, on call or in a stage), optionally `scope` (a note on what the interview is for) and optionally `model` (one of its models). It refuses with no run or no loop, for a node whose contract is not `interviews` (it names the interviewing nodes), and for a model the node does not list. The host writes a brief under `.context/consult-brief.md` in the run worktree (the run's one line, your scope note, where to write the report) and copies every report of the run so far to `.context/reports/`. The reply gives one `Agent` call: `subagent_type: "dacapo:<node>"`, prompt `dacapo consult <node> <n>`. Make it exactly as listed, then end your turn. The node holds the floor until it reports: what the user types goes to it, its replies come back to the user, and you are out of the exchange. It writes its report to `.workspaces/.dacapo/<run id>/interview-<node>-<n>.md`, in the format its own role defines, and ends with `dacapo: reported` or `dacapo: reported with open questions`. The `[dacapo]` wake-up carries `<node> reported` or `<node> reported with open questions`, the report path and its first ten lines, or says `failed: no report at <path>`. `/dacapo-back` gives the floor back early: the outcome is `reported with open questions` when a report exists, else `failed`. The timeline shows the interview as a row: `interview · talking`, then `reported`, `reported with open questions` or `failed` (`talking (stale)` after 30 minutes without activity). The band's line ends with `· talking to <node>` beside a Back button that returns the view only, with the hint `/dacapo-back ends it`; `status` prints `interview <node> [id] <status> (<span>, model): <note>` and, while the floor is held, `floor: <node> (/dacapo-back returns it)`.

### cancel

Call `mcp__dacapo__cancel` with `agentId` (from the wake-up or `status`) and an optional `reason`. It stops the agent, marks it cancelled and closes its open pull request.

### finish (the loop's merge)

Call it when the loop's transitions lead to the exit: once the round's work has landed and is synced in a loop without judges, after every judge passes otherwise. Call `mcp__dacapo__finish` with:
- `title`: the title of the loop's merge phase, as a Conventional Commit line; it becomes the merge commit title.
- `body`: the paragraph of the loop's merge phase, to the configured pull request rules skill, which you load with the Skill tool before writing it. With the shipped `dacapo:rules-prs`, that means a `Verified:` line, an optional `Notes:` line and no attribution lines of any kind.

Then end your turn. The run watches the pull request and merges it when green. It then prunes the worktrees and branches, and wakes you with `Merged into <base>`. Two wake-ups ask for more work first:
- Conflicts with the base branch: `dispatch` one worker with `merge: "merge"`. It merges `origin/<base>` into its branch and resolves the conflicts, under the commit title `chore: merge <base> into <run branch>`.
- Failing checks on the final pull request: `dispatch` a fix worker.

From there follow the loop's merge phase, where `sync` collects the worker's outcome and the loop's judges run again in step order. Call `finish` again only when that decision sends you there.

`abort: true` ends the run without a final pull request.

### status

Call `mcp__dacapo__status` once, never in a loop. It returns the timeline as text: the loop and its current stages, every worker, judge and asked node with status, pull request and elapsed time, any undelivered wake-up, and the run state. Call it in two cases:
- No `[dacapo]` wake-up has arrived two minutes after a hand-back.
- A worker is stale: `status` shows it as `stale` and still running, and `cancel` stops it. Whether to let it run or stop it is the loop's implement phase.

## Where things are

Reports, briefs and asked prompts of the run are under `.workspaces/.dacapo/<run id>/`. Loops live in the plugin's `loops/`, in `~/.claude/dacapo/loops/` (or `$DACAPO_HOME/loops/`) and in the repository's `.claude/dacapo/loops/`, which git ignores; a loop of the repository wins over the user's, and the user's over the plugin's. User prompts typed while workers run become rows in the timeline.
