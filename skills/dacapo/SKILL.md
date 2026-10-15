---
name: dacapo
description: Runs a handed-over task as an orchestrated loop: clarify, research, plan, dispatch parallel worker subagents in git worktrees, end-user QA with a scored rubric, iterate, merge. Workers land their work through GitHub pull requests into a run branch, and the run branch merges into main through a final pull request. Invoked by the user via /dacapo <task>.
---

# dacapo

Before anything else, load `dacapo:dacapo-loop` with the Skill tool: it is the loop you follow, with its roles, boundaries, contracts and decision rules. This file says how this plugin runs it: its tools, subagents, worktrees, pull requests and wake-ups. The task is everything after `/dacapo` in the prompt that invoked this skill. With the loop loaded, begin its phase 1.

The loop's boundaries are enforced here. While a run is active the tools refuse Edit, Write, history-changing git commands and `gh pr` commands from you. Workers write only inside their worktree. QA can read and search only its `.context` folder and write only its report; its shell is bound by its prompt alone. You never edit files, touch git, or open and merge pull requests: the `mcp__dacapo__*` tools and the worker subagents do. Each tool reply says what to call next. A timeline pane shows every worker, QA round, pull request and user prompt of the run; the band above the prompt shows where the run stands. `/dacapo-pane` reopens the pane.

## The loop on these tools

- Opening the run: `start`, as you begin planning.
- Starting a round: `dispatch`, then the Agent calls its reply lists.
- Learning outcomes: `wait` for the `[dacapo]` wake-up, then `sync`.
- Resuming a worker: `dispatch` with the same `id` and `resume: true`. Repair first: a `dispatch` of its own, then `sync`, then the resume.
- Stopping a worker, or dropping its task: `cancel`.
- QA: `qa`, then its Agent call.
- Integrating into the base line: `finish`.
- The state of everything as text: `status`.

## How work lands here

- The base branch is `main` unless told otherwise. `start` pulls it from origin, then cuts the run branch from it in its own worktree under `.workspaces/<branch>` and pushes it.
- Every worker gets its own branch and worktree under `.workspaces/<run branch>--<id>` and lands through a draft pull request against the run branch. It marks the pull request ready when its build passes, rebases conflicts away, and waits for and fixes the checks (three rounds at most; no CI counts as green). Then it squash-merges the pull request with the planned title.
- Commits follow the bundled `clean-commits` skill; pull requests follow the bundled `clean-prs` skill.
- QA tests the run branch in a fresh worktree.
- The run ends with a final pull request from the run branch into the base branch, merged with a merge commit.

## Outcomes here

A worker's status in the wake-up, `status` and the pane is one of:
- `finished`: the worker ended with a report whose last line is `dacapo: done` or `dacapo: done with limitations`. This is its claim, not yet a fact.
- `merged` (landed): what `sync` confirms from the pull request's merged state. Only then has the work landed.
- `failed`: the worker's own `dacapo: failed` line, or the agent ending in error. Its branch and pull request stay in place. `sync` also marks a `finished` worker `failed` when its pull request did not merge.
- `stale`: no tool call or model step for 30 minutes; it still runs. This is the loop's stalled worker. A worker waiting on checks can look stale.
- `timed out`: stopped by the run after two idle hours. Treat it as failed.
- `cancelled`: stopped by you; its open pull request is closed.

The worker's report ends with `dacapo: done`, `dacapo: done with limitations` or `dacapo: failed`: the loop's three outcomes. A worker whose last line is `dacapo: done` but whose pull request is still open has not landed (what `sync` reports); the loop says what follows.

## Clarify, research and plan in this host

- Offer enumerable options with AskUserQuestion.
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

If it answers that `gh` is missing, not logged in, or cannot reach the repository on GitHub, stop. Tell the user the install command for their system and that they must run `gh auth login` in a terminal themselves. Call `start` again once they say it is done. Every change lands through a pull request, so do not plan around it.

### dispatch

Call `mcp__dacapo__dispatch` with `tasks` (and optionally a round `title` and `overview`, kept only in the run log). Map each task:
- `id`, `title`: as given.
- `prompt`: its brief. For a resumed task, the resume brief the loop's phase 4 describes.
- `model`: `opus` for the strong tier, `sonnet` for the fast tier.
- `commit`: the landing title. A Conventional Commit line: types feat, fix, docs, style, refactor, test, chore, perf, ci, revert only; no scope in parentheses; at most 72 characters.
- `build`, `test`: the commands.
- `context`: a list of `{ name, text }` files placed under `.context/`.
- `resume: true`: continue the earlier worker of the same `id` on its branch, worktree and pull request.
- `merge: "merge"`: only for a branch that merges the base branch into the run branch. Otherwise leave it out (squash).

This host already gives every worker its standing instructions with the brief it writes. They cover building and testing, fixing what it introduced, clean commits, landing through the pull request, and the report and its last line. Put only the task itself and its contracts in the task `prompt`.

The reply lists one `Agent` call per task. Make them yourself, all in one message, exactly as listed: `subagent_type: "dacapo:worker"`, the listed description, and the prompt `dacapo worker <id>`. Never write the prompts yourself; the run fills in the brief, model, worktree and background mode. Then end your turn, saying in one line that the workers run. Each worker opens its draft pull request after its first commit.

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

Call `mcp__dacapo__qa` with `rubric` (items with `id`, `title`, `category: core | ui-ux`), `harness` (Markdown), and `brief` (the round note of the loop's phase 5 step 1). The reply gives one `Agent` call: `subagent_type: "dacapo:qa"`, prompt `dacapo qa <round>-<n>`. Make it exactly as listed, then end your turn. The `[dacapo]` wake-up carries the verdict, the counts, every item below `strong` and the QA overview, or says the report was invalid and why.

### finish (the loop's merge)

Call `mcp__dacapo__finish` with:
- `title`: the title of the loop's phase 6 step 1, as a Conventional Commit line; it becomes the merge commit title.
- `body`: the paragraph of the loop's phase 6 step 1, to the `clean-prs` rules, with a `Verified:` line and an optional `Notes:` line. No attribution lines of any kind.

Then end your turn. The run watches the pull request and merges it when green. It then prunes the worktrees and branches, and wakes you with `Merged into <base>`. Two wake-ups ask for more work first:
- Conflicts with the base branch: `dispatch` one worker with `merge: "merge"`. It merges `origin/<base>` into its branch and resolves the conflicts, under the commit title `chore: merge <base> into <run branch>`. Then `sync`, then `qa`, then decide as the loop's phase 6 step 2 says. Call `finish` again only when that decision sends you there.
- Failing checks on the final pull request: `dispatch` the fix, then `sync`, then `qa`, then decide as the loop's phase 6 step 2 says. Call `finish` again only when that decision sends you there.

`abort: true` ends the run without a final pull request.

### status

Call `mcp__dacapo__status` once, never in a loop. It returns the timeline as text: every worker and QA row with status, pull request and elapsed time, any undelivered wake-up, and the run state. Call it in two cases:
- No `[dacapo]` wake-up has arrived two minutes after a hand-back.
- A worker is stale: decide to leave it, or `cancel` it and plan a re-dispatch.

### phase

Call `mcp__dacapo__phase` with `phase: "clarify"` and `phase: "research"` as you enter them. The later phases are marked by the tools: `start` marks `plan`, `dispatch` marks `implement`, `qa` marks `qa`, and `finish` marks `merge`.

## Where things are

Reports and briefs of the run are under `.workspaces/.dacapo/<run id>/`. User prompts typed while workers run become rows in the timeline.
