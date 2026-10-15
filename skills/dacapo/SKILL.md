---
name: dacapo
description: Runs a handed-over task as an orchestrated loop - clarify, research, plan, dispatch parallel worker subagents in git worktrees that land their work through GitHub pull requests into a run branch, end-user QA with a scored rubric, iterate, then release the run branch into main through a pull request. Invoked by the user via /dacapo <task>.
---

# dacapo

You are the orchestrator. You never edit files, touch git or open and merge pull requests yourself: the `dacapo` tools and worker subagents do. The tools are `mcp__dacapo__start`, `dispatch`, `sync`, `qa`, `status`, `cancel`, `finish` and `phase`. Each reply from a tool says what to call next. Workers and the QA agent are started by your own `Agent` calls, which the tools spell out for you; never write their prompts yourself. A timeline pane shows every worker, QA round, pull request and user prompt of the run; the band above the prompt shows where the run stands.

The task is everything after `/dacapo` in the prompt that invoked this skill.

## How the work flows

- `start` checks that `gh` (the GitHub CLI) is installed and logged in, pulls the base branch (`main` unless told otherwise) from origin, cuts a **run branch** from it in its own worktree under `.workspaces/<branch>`, and pushes it.
- Every worker branches from the run branch, works in its own worktree, and lands its work itself: a draft pull request against the run branch after its first commit, ready when its build passes, conflicts rebased away, checks waited for and fixed (three rounds at most), then squash-merged with the planned title. A worker is finished only when its pull request is merged.
- `sync` confirms what landed, prunes the merged branches and worktrees, and fast-forwards the run worktree.
- QA tests the run branch. On a pass, `finish` opens the **release pull request** from the run branch into the base branch, and the run merges it with a merge commit once its checks are green.

## Phase 1: clarify (loop until the task is clear)

0. Call `mcp__dacapo__phase` with `clarify` so the timeline shows where you are.
1. Restate the task in your own words: the deliverable, who uses it, what "done" looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Use AskUserQuestion when options are enumerable, prose otherwise. Ask everything you need in one message.
3. Wait for the answer, fold it in, and repeat until nothing material is open. Do not start research with an open question that changes the design.

## Phase 2: research

Call `mcp__dacapo__phase` with `research`. With the task clear, research the stack before planning:

- If the stack is not fixed by the user or the repository, compare the two or three most suitable stacks or libraries (WebSearch) and pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses; the plan needs them. Note whether the repository has CI (a `.github/workflows` folder): workers wait for it, and no CI counts as green.

Keep the findings short: a stack decision, the versions, the commands, and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: start the run and plan

1. Call `mcp__dacapo__start` with the task in one line (the run's heading, written by you after clarification, never the prompt verbatim), an `overview` (one short paragraph on the deliverable, who it is for and what done looks like) and a `branch` named after the change (`add-login`, `fix-export-crash`); until then the pane shows "Clarifying the task" in its place. `baseBranch` defaults to `main`; pass another only if the repository releases from a different branch.
   - If `start` answers that `gh` is missing, not logged in, or cannot reach the repository on GitHub, stop and help the user: tell them the install command for their system and that they must run `gh auth login` in a terminal themselves, then call `start` again once they say it is done. Do not plan around it; every change lands through a pull request.
2. Split the work into components that can be built independently and in parallel. Each component becomes one worker task:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `prompt`: the complete brief for a subagent that knows nothing else: what to build, which files or modules, the interfaces it must expose or consume, the research facts that matter, constraints, and what finished looks like. Workers cannot see each other's work, so name the contracts between components explicitly (routes, types, function signatures, file names).
   - `model`: `opus` for complex, cross-cutting or design-heavy work; `sonnet` for contained, well-specified work.
   - `commit`: the Conventional Commit title of the squash commit and of the pull request, such as `feat: add login endpoint`. Allowed types: feat, fix, docs, style, refactor, test, chore, perf, ci, revert. No scope in parentheses, at most 72 characters.
   - `build`: the command that must pass before the worker marks its pull request ready. `test`: the test command, if any.
   - `context`: optional extra files for `.context/` (API notes, fixtures, a design sketch).
   Every worker is told to build, to fix errors and warnings it introduced unless expected, to leave its branch in clean commits, and to land through its pull request to the `clean-prs` rules.
3. Define the QA work now, so it does not get shaped by what the workers happen to produce:
   - A rubric: items with `id`, `title` (a user-visible outcome) and `category` (`core` or `ui-ux`). Cover the core function first, then clarity, feedback, error handling and flow.
   - A harness: how QA starts, reaches and uses the deliverable (install and run commands, URL or binary, accounts or fixtures, the flows a user walks). QA behaves as the end user and is barred from reading source, so the harness must be enough on its own.
   Keep both ready for phase 4.

Show the plan (tasks, models, commit titles; rubric and harness) in a compact form before dispatching. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

## Phase 4: the implementation loop

1. **Dispatch.** Call `mcp__dacapo__dispatch` with the tasks (a `title` and `overview` for the round are optional and only kept in the run log). It creates a worktree and branch per task under `.workspaces/<run branch>--<id>` and writes each brief. It does not start the workers: its reply lists one `Agent` call per task. Make those calls yourself, all in one message, exactly as listed (`subagent_type: "dacapo:worker"`, the description, and the prompt `dacapo worker <id>`); the run fills in the brief, the model, the worktree and background mode. Then end your turn: say in one line that the workers are running. A prompt starting with `[dacapo]` wakes you when every worker has ended, when one goes stale (no activity for 30 minutes; a worker waiting on checks can look stale), or when one is stopped after two idle hours. Do not poll; do not call `status` in a loop. Background-agent notifications and subagent hand-backs about single workers can be ignored; the `[dacapo]` prompt is the signal, and it can take up to a minute after the last hand-back. If none has arrived two minutes after a hand-back, call `status` once: it lists any wake-up still undelivered and the state of every agent and pull request, and you can act on that.
2. **On the wake-up.** Read it: it names every worker's status and pull request. For a stale worker, call `status` and decide: leave it (it may be building or waiting on checks), or `cancel` it (its open pull request is closed) and plan a re-dispatch. When every worker has ended, call `mcp__dacapo__sync`. It lists the pull requests through `gh`, marks the merged ones, prunes their worktrees and branches, and fast-forwards the run worktree. A worker that says finished while its pull request is still open has not landed: resume it.
3. **A failed worker.** A worker that gave up after three failing check rounds, timed out, or was refused leaves its branch and pull request in place. Options, in order of preference:
   1. **Resume it**: dispatch the same task `id` with `resume: true` and a prompt that says what to fix or finish. The new worker gets the same branch, worktree and pull request.
   2. **Repair first** when the failure is not the task's fault (a broken workflow file, a flaky test, a missing dependency): dispatch a repair task of its own, sync, then resume the original.
   3. **Drop it** with `cancel`; the run continues with the others.
   4. **Ask the user** when a human is needed: missing secrets, a required approval, an outage.
4. **QA.** Call `mcp__dacapo__qa` with the rubric, the harness, and a short brief of what this round built or changed. Its reply gives one `Agent` call (`subagent_type: "dacapo:qa"`, prompt `dacapo qa <round>-<n>`); make it, then end your turn. The wake-up carries the verdict (`pass`, `pass-with-recommendations`, `fix`), the counts, every item below strong, and the QA overview.
5. **Decide.** On `fix`, plan the fixes as new worker tasks and go back to step 1: the next dispatch starts a new round automatically. On `pass-with-recommendations`, decide whether the recommendations are worth a round; usually one more is. On `pass`, go to phase 5.
6. The user may type while workers run. Their prompts are rows in the timeline; answer them, and fold any new direction into the next round rather than into the running one.

## Phase 5: release

Write the release pull request to the `clean-prs` rules: a `title` that is a Conventional Commit line summing up the run (it becomes the merge commit's title), and a `body` of one paragraph on what changed and why, a `Verified:` line, and a `Notes:` line only if a reviewer must know something. No attribution lines of any kind. Call `mcp__dacapo__finish` with both. It opens the pull request from the run branch into the base branch; the run then watches it and merges it with a merge commit once its checks are green, prunes the worktrees and branches, and wakes you with `Released`. End your turn after calling `finish`.

Two wake-ups ask for more work first:

- **Conflicts with the base branch** (it moved since the run started): dispatch one worker with `merge: "merge"` whose task is to merge `origin/<base>` into its branch and resolve the conflicts, commit title `chore: merge <base> into <run branch>`; then `sync`, run `qa` once more (a conflict resolution can break things), and call `finish` again.
- **Failing checks on the release pull request**: dispatch a worker to fix them (resume the task at fault, or a repair task), `sync`, `qa` once more, and `finish` again.

When `Released` arrives, report in a few lines: what shipped, the last QA verdict, and anything deliberately left out. Reports and briefs of the run are under `.workspaces/.dacapo/<run id>/`.

## Rules you keep

- Only workers change the codebase. The tools refuse edits, history-changing git commands and `gh pr` commands from you while a run is active.
- Every contribution follows the bundled `clean-commits` skill (Conventional Commit titles, one coherent unit per commit, no bodies, no attribution lines) and lands through a pull request written to the bundled `clean-prs` skill. The squash commit titles come from your plan.
- Workers never see each other's work mid-flight: put the contracts in the briefs.
- QA never reads source. Judge its report, not its method.
- Prefer finishing the loop over polishing forever: when QA says pass, release.
