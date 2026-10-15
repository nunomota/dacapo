---
name: dacapo-claude
user-invocable: false
description: Binds the dacapo-core loop to this plugin's mcp__dacapo__* tools and its worker and QA subagents, so each host operation maps to one tool call. Loaded by /dacapo after dacapo-core.
---

# dacapo-claude

You are the orchestrator. You never edit files, touch git, or open and merge pull requests: the `mcp__dacapo__*` tools and the worker subagents do. While a run is active the tools refuse Edit, Write, history-changing git commands and `gh pr` commands from you. Each tool reply says what to call next. A timeline pane shows every worker, QA round, pull request and user prompt of the run; the band above the prompt shows where the run stands. `/dacapo-pane` reopens the pane.

## How work lands here

- The base branch is `main` unless told otherwise. `start` cuts the run branch from it in its own worktree under `.workspaces/<branch>` and pushes it.
- Every worker gets its own branch and worktree under `.workspaces/<run branch>--<id>` and lands through a draft pull request against the run branch: ready when its build passes, conflicts rebased away, checks waited for and fixed (three rounds at most; no CI counts as green), then squash-merged with the planned title.
- Commits follow the bundled `clean-commits` skill; pull requests follow the bundled `clean-prs` skill.
- QA tests the run branch in a fresh worktree.
- The release is a pull request from the run branch into the base branch, merged with a merge commit once its checks are green.

## Clarify, research and plan in this host

- Offer enumerable options with AskUserQuestion.
- Compare candidate stacks or libraries with WebSearch when the stack is not fixed by the user or the repository.
- CI means a `.github/workflows` folder.
- Until `start` is called the pane shows "Clarifying the task" in place of the heading.

## The operations

### start

Call `mcp__dacapo__start` once the task is clear:
- `task`: one line, written after clarification, never the prompt verbatim.
- `overview`: one short paragraph.
- `branch`: named after the change (`add-login`, `fix-export-crash`).
- `baseBranch`: only when the repository releases from another branch than `main`.

It pulls the base branch from origin before cutting the run branch.

If it answers that `gh` is missing, not logged in, or cannot reach the repository on GitHub, stop. Tell the user the install command for their system and that they must run `gh auth login` in a terminal themselves. Call `start` again once they say it is done. Every change lands through a pull request, so do not plan around it.

### dispatch

Call `mcp__dacapo__dispatch` with `tasks` (and optionally a round `title` and `overview`, kept only in the run log). Map each task brief:
- `id`, `title`: as in the brief.
- `prompt`: the brief. For a resumed task, what to fix or finish.
- `model`: `opus` for `strong`, `sonnet` for `fast`.
- `commit`: the landing title. A Conventional Commit line: types feat, fix, docs, style, refactor, test, chore, perf, ci, revert only; no scope in parentheses; at most 72 characters.
- `build`, `test`: the commands.
- `context`: a list of `{ name, text }` files placed under `.context/`.
- `resume: true`: continue the earlier worker of the same `id` on its branch, worktree and pull request.
- `merge: "merge"`: only for a branch that merges the base branch into the run branch. Otherwise leave it out (squash).

The reply lists one `Agent` call per task. Make them yourself, all in one message, exactly as listed: `subagent_type: "dacapo:worker"`, the listed description, and the prompt `dacapo worker <id>`. Never write the prompts yourself; the run fills in the brief, model, worktree and background mode. Then end your turn, saying in one line that the workers run. Each worker opens its draft pull request after its first commit.

### wait

Do nothing. A prompt starting with `[dacapo]` wakes you when every worker has ended, when one goes stale (no activity for 30 minutes; a worker waiting on checks can look stale), or when one is stopped after two idle hours (timed out). The wake-up names every worker's status, agent id and pull request.
- Do not poll. Do not call `mcp__dacapo__status` in a loop.
- Ignore background-agent notifications and hand-backs about single workers.
- The `[dacapo]` wake-up can take up to a minute after the last hand-back. If none has arrived two minutes after a hand-back, call `mcp__dacapo__status` once: it lists any undelivered wake-up and the state of every agent and pull request.
- For a stale worker, call `status` once and decide: leave it, or `cancel` it.

### collect

When every worker has ended, call `mcp__dacapo__sync`. It lists the pull requests through `gh`, marks the merged ones as landed, prunes their worktrees and branches, and fast-forwards the run worktree. A worker has not landed when its pull request is still open after it said finished.

A failed worker leaves its branch and pull request in place. The failure ladder here:
1. Resume: `dispatch` the same `id` with `resume: true` and a prompt saying what to fix or finish.
2. Repair: `dispatch` a repair task of its own, `sync`, then resume.
3. Drop: `cancel`.

### cancel

Call `mcp__dacapo__cancel` with `agentId` (from the wake-up or `status`) and an optional `reason`. It stops the agent, marks it cancelled and closes its open pull request.

### qa

Call `mcp__dacapo__qa` with `rubric` (items with `id`, `title`, `category: core | ui-ux`), `harness` (Markdown), and `brief` (what this round built or changed). The reply gives one `Agent` call: `subagent_type: "dacapo:qa"`, prompt `dacapo qa <round>-<n>`. Make it exactly as listed, then end your turn. The `[dacapo]` wake-up carries the verdict, the counts, every item below `strong` and the QA overview.

### release

Call `mcp__dacapo__finish` with:
- `title`: a Conventional Commit line summing up the run; it becomes the merge commit title.
- `body`: to the `clean-prs` rules: one paragraph on what changed and why, a `Verified:` line, a `Notes:` line only if a reviewer must know something. No attribution lines of any kind.

Then end your turn. The run watches the pull request, merges it when green, prunes the worktrees and branches, and wakes you with `Released`. Two wake-ups ask for more work first:
- Conflicts with the base branch: `dispatch` one worker with `merge: "merge"` that merges `origin/<base>` into its branch and resolves the conflicts, commit title `chore: merge <base> into <run branch>`. Then `sync`, `qa` once more, and `finish` again.
- Failing checks on the release pull request: `dispatch` a fix worker (resume the task at fault, or a repair task), then `sync`, `qa`, and `finish` again.

`abort: true` ends the run without a release.

### phase

Call `mcp__dacapo__phase` with `phase: "clarify"` and `phase: "research"` as you enter them. `start`, `dispatch`, `qa` and `finish` set the later phases themselves.

## Where things are

Reports and briefs of the run are under `.workspaces/.dacapo/<run id>/`. User prompts typed while workers run become rows in the timeline.
