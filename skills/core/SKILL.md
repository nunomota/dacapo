---
name: core
description: Runs a handed-over task as an orchestrated loop: clarify, research, plan, dispatch parallel worker subagents in git worktrees, end-user QA with a scored rubric, iterate, merge. Workers land their work through GitHub pull requests into a run branch, and the run branch merges into main through a final pull request. Invoked by the user via /dacapo:core <task>.
---

# core

Before anything else, load `dacapo:loop` with the Skill tool: it is the loop you follow, with its roles, boundaries, levels, contracts and decision rules. This file says how this plugin runs it: its tools, subagents, worktrees, pull requests and wake-ups. The task is everything after `/dacapo:core` in the prompt that invoked this skill, less the level flag: `--build`, `--review` or `--consolidate` right after the command names the loop's level, and without one the level is the configured default. With the loop loaded, call `mcp__dacapo__config` once for the configuration in force (the default level, whether the judges run in parallel, the models each kind of subagent may be given, and the skills commits and pull requests follow), then begin phase 1. Never read a `dacapo.conf` file yourself: the tool is the configuration.

The loop's boundaries are enforced here. While a run is active the tools refuse Edit, Write, history-changing git commands and `gh pr` commands from you. Workers write only inside their worktree. QA can read and search only its `.context` folder and write only its report; its shell is bound by its prompt alone. The reviewer reads anything and writes only its report. You never edit files, touch git, or open and merge pull requests: the `mcp__dacapo__*` tools and the worker subagents do. Each tool reply says what to call next. A timeline pane shows every worker, QA round, pull request and user prompt of the run; the band above the prompt shows where the run stands. `/dacapo-pane` reopens the pane.

## The loop on these tools

- Opening the run: `start`, as you begin planning.
- Starting a round: `dispatch`, then the Agent calls its reply lists.
- Learning outcomes: `wait` for the `[dacapo]` wake-up, then `sync`.
- Resuming a worker: `dispatch` with the same `id` and `resume: true`. Repair first: a `dispatch` of its own, then `sync`, then the resume.
- Stopping a worker, or dropping its task: `cancel`.
- QA: `qa`, then its Agent call.
- Engineering review (level `consolidate`, after QA): `review`, then its Agent call.
- Integrating into the base line: `finish`.
- The state of everything as text: `status`.

## How work lands here

- The base branch is `main` unless told otherwise. `start` pulls it from origin, then cuts the run branch from it in its own worktree under `.workspaces/<branch>` and pushes it.
- Every worker gets its own branch and worktree under `.workspaces/<run branch>--<id>` and lands through a draft pull request against the run branch. It marks the pull request ready when its build passes, rebases conflicts away, and waits for and fixes the checks (three rounds at most; no CI counts as green). Then it squash-merges the pull request with the planned title.
- Commits follow the skill the `commits-skill` configuration key names and pull requests the one `prs-skill` names: the shipped `dacapo:rules-commits` and `dacapo:rules-prs` unless configured otherwise. Workers load them from their brief; the mod checks commit titles and attribution lines itself only while the shipped skills are in force.
- QA tests the run branch in a fresh worktree; the reviewer reads it in another, diffed against the base branch.
- The run ends with a final pull request from the run branch into the base branch, merged with a merge commit.

## Outcomes here

`status` and the pane also name the run's level. A worker's status in the wake-up, `status` and the pane is one of:
- `finished`: the worker ended with a report whose last line is `dacapo: done` or `dacapo: done with limitations`. This is its claim, not yet a fact.
- `merged` (landed): what `sync` confirms from the pull request's merged state. Only then has the work landed.
- `failed`: the worker's own `dacapo: failed` line, or the agent ending in error. Its branch and pull request stay in place. `sync` also marks a `finished` worker `failed` when its pull request did not merge.
- `stale`: no tool call or model step for 30 minutes; it still runs. This is the loop's stalled worker. A worker waiting on checks can look stale.
- `timed out`: stopped by the run after two idle hours. Treat it as failed.
- `cancelled`: stopped by you; its open pull request is closed.

The worker's report ends with `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`: the loop's three outcomes. A worker whose last line is `dacapo: done` but whose pull request is still open has not landed (what `sync` reports); the loop says what follows.

## Clarify, research and plan in this host

- Offer enumerable options with AskUserQuestion.
- The level comes from the flag after `/dacapo:core`; an absent flag means the configured default, which you confirm in your restatement rather than ask about. Pass it to `start` as `level`.
- At `consolidate`, the judges run one after the other unless the configuration says `parallel` or the user asks for it; pass `judges` to `start` only when the user asked.
- Compare candidate stacks or libraries with WebSearch when the stack is not fixed by the user or the repository.
- CI means a `.github/workflows` folder.
- Until `start` is called the pane shows "Clarifying the task" in place of the heading.

## The operations

### start

Call `mcp__dacapo__start` once the request is clear, as you enter the loop's phase 3:
- `task`: the run's one line.
- `overview`: one short paragraph.
- `branch`: named after the change (`add-login`, `fix-export-crash`).
- `baseBranch`: only when the run should merge into another branch than `main`.
- `level`: `build`, `review` or `consolidate`, from the flag. Fixed once set up: a later `start` with another level is refused.
- `judges`: `sequential` or `parallel`, only when the user asked for one; otherwise the configuration decides. Fixed once set up.

If it answers that `gh` is missing, not logged in, or cannot reach the repository on GitHub, stop. Tell the user the install command for their system and that they must run `gh auth login` in a terminal themselves. Call `start` again once they say it is done. Every change lands through a pull request, so do not plan around it.

### dispatch

Call `mcp__dacapo__dispatch` with `tasks` (and optionally a round `title` and `overview`, kept only in the run log). Map each task:
- `id`, `title`: as given.
- `prompt`: its brief. For a resumed task, the resume brief the loop's phase 4 describes.
- `model`: one of the configured worker models (`config`); the first listed is the strong tier, the last the fast tier.
- `commit`: the landing title. A Conventional Commit line: types feat, fix, docs, style, refactor, test, chore, perf, ci, revert only; no scope in parentheses; at most 72 characters.
- `build`, `test`: the commands.
- `context`: a list of `{ name, text }` files placed under `.context/`.
- `resume: true`: continue the earlier worker of the same `id` on its branch, worktree and pull request.
- `merge: "merge"`: only for a branch that merges the base branch into the run branch. Otherwise leave it out (squash).

This host already gives every worker its standing instructions with the brief it writes. They cover building and testing, fixing what it introduced, clean commits, landing through the pull request, and the report and its last line. Put only the task itself and its contracts in the task `prompt`.

The reply lists one `Agent` call per task. Make them yourself, all in one message, exactly as listed: `subagent_type: "dacapo:worker"`, the listed description, and the prompt `dacapo worker <id>`. Never write the prompts yourself; the run fills in the brief, model, worktree and background mode. Then end your turn. Each worker opens its draft pull request after its first commit.

### wait

`wait` is not a tool: it means doing nothing. A prompt starting with `[dacapo]` wakes you when every worker has ended, when one goes stale, or when one times out. The wake-up names every worker's status, agent id and pull request.
- Do not poll; see `status` for when to call it.
- Ignore background-agent notifications and hand-backs about single workers.
- The `[dacapo]` wake-up can take up to a minute after the last hand-back, and one that does not start a turn is sent again.

### sync

`sync` is how the loop learns each worker's outcome and brings landed work into the run. When every worker has ended, call `mcp__dacapo__sync`. It lists the pull requests through `gh`, marks the merged ones as landed, prunes their worktrees and branches, and fast-forwards the run worktree. Call it before `qa`.

### cancel

Call `mcp__dacapo__cancel` with `agentId` (from the wake-up or `status`) and an optional `reason`. It stops the agent, marks it cancelled and closes its open pull request.

### qa

Call `mcp__dacapo__qa` with `rubric` (items with `id`, `title`, `category: core | ui-ux`), `harness` (Markdown), `brief` (the round note of the loop's phase 5 step 1) and optionally `model` (one of the configured QA models; the first is the default). The reply gives one `Agent` call: `subagent_type: "dacapo:qa"`, prompt `dacapo qa <round>-<n>`. Make it exactly as listed, then end your turn. With judges in parallel at `consolidate`, the reply says to call `review` as well before starting: make both Agent calls in one message, then end your turn; each verdict wakes you on its own. The `[dacapo]` wake-up carries the verdict, the counts, every item below `strong` and the QA overview, or says the report was invalid and why.

### review (the loop's phase 5b)

At level `consolidate`, once QA has reported on the round (or, with judges in parallel, once QA has started): call `mcp__dacapo__review` with `rubric` (items with `id`, `title`, `category: quality | consistency | cleanup`), `brief` (what the run built, the conventions and references the briefs pointed at, what to look at first) and optionally `model` (one of the configured review models). The tool refuses to run before QA, and at any other level. In parallel, a QA verdict of `fix` stops the running review and its wake-up says so: run `review` again once the fixes have landed and QA passes. The reply gives one `Agent` call: `subagent_type: "dacapo:reviewer"`, prompt `dacapo review <round>-<n>`. Make it exactly as listed, then end your turn. The `[dacapo]` wake-up carries the verdict, the counts, every item below `strong` and the overview, or says the report was invalid and why.

### finish (the loop's merge)

At `build`, call it once the round's work has landed and is synced; at `review`, after QA passes; at `consolidate`, after QA and then the review pass. Call `mcp__dacapo__finish` with:
- `title`: the title of the loop's phase 6 step 1, as a Conventional Commit line; it becomes the merge commit title.
- `body`: the paragraph of the loop's phase 6 step 1, to the configured pull request rules skill, which you load with the Skill tool before writing it. With the shipped `dacapo:rules-prs`, that means a `Verified:` line, an optional `Notes:` line and no attribution lines of any kind.

Then end your turn. The run watches the pull request and merges it when green. It then prunes the worktrees and branches, and wakes you with `Merged into <base>`. Two wake-ups ask for more work first:
- Conflicts with the base branch: `dispatch` one worker with `merge: "merge"`. It merges `origin/<base>` into its branch and resolves the conflicts, under the commit title `chore: merge <base> into <run branch>`.
- Failing checks on the final pull request: `dispatch` a fix worker.

From there follow the loop's phase 6 step 2, where `sync` collects the worker's outcome and the judges of the level run again (`qa`, then `review` at `consolidate`). Call `finish` again only when that decision sends you there.

`abort: true` ends the run without a final pull request.

### config

Call `mcp__dacapo__config` for the configuration in force: default level, judges, the models for workers, QA and the reviewer, and the skills commits (`commits-skill`) and pull requests (`prs-skill`) follow, each with the file it came from. It reads nothing you need to open yourself; the person edits `~/.claude/dacapo.conf` or the repository's `.dacapo.conf` and sees the result with `/dacapo-config`.

### status

Call `mcp__dacapo__status` once, never in a loop. It returns the timeline as text: every worker and QA row with status, pull request and elapsed time, any undelivered wake-up, and the run state. Call it in two cases:
- No `[dacapo]` wake-up has arrived two minutes after a hand-back.
- A worker is stale: `status` shows it as `stale` and still running, and `cancel` stops it. Whether to let it run or stop it is the loop's phase 4 step 3.

### phase

Call `mcp__dacapo__phase` with `phase: "clarify"` and `phase: "research"` as you enter them. The later phases are marked by the tools: `start` marks `plan`, `dispatch` marks `implement`, `qa` marks `qa`, `review` marks `review`, and `finish` marks `merge`.

## Where things are

Reports and briefs of the run are under `.workspaces/.dacapo/<run id>/`. User prompts typed while workers run become rows in the timeline.
