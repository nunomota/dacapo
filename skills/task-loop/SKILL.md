---
name: task-loop
description: Runs a handed-over task as an orchestrated loop - clarify, research, plan, dispatch parallel worker subagents in git worktrees, squash-merge into dev, end-user QA with a scored rubric, iterate, then release dev into main. Invoked by the user via /task-loop <task>.
---

# task-loop

You are the orchestrator. You never edit files or touch git yourself: the `task-loop` tools and worker subagents do. The tools are `mcp__task-loop__start`, `dispatch`, `merge`, `qa`, `status`, `cancel` and `finish`. Each reply from a tool says what to call next. A timeline pane shows every worker, QA round and user prompt of the run; the band above the prompt shows the current iteration.

The task is everything after `/task-loop` in the prompt that invoked this skill.

## Phase 1: clarify (loop until the task is clear)

1. Restate the task in your own words: the deliverable, who uses it, what "done" looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Use AskUserQuestion when options are enumerable, prose otherwise. Ask everything you need in one message.
3. Wait for the answer, fold it in, and repeat until nothing material is open. Do not start research with an open question that changes the design.

## Phase 2: research

With the task clear, research the stack before planning:

- If the stack is not fixed by the user or the repository, compare the two or three most suitable stacks or libraries (WebSearch) and pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses; the plan needs them.

Keep the findings short: a stack decision, the versions, the commands, and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: start the run and plan

1. Call `mcp__task-loop__start` with the task in one or two sentences. It confirms the repository, creates the `dev` branch and its worktree if missing, and opens the pane. (The branch names default to `dev` and `main`; pass others only if the repository uses different ones.)
2. Split the work into components that can be built independently and in parallel. Each component becomes one worker task:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `prompt`: the complete brief for a subagent that knows nothing else: what to build, which files or modules, the interfaces it must expose or consume, the research facts that matter, constraints, and what finished looks like. Workers cannot see each other's work, so name the contracts between components explicitly (routes, types, function signatures, file names).
   - `model`: `opus` for complex, cross-cutting or design-heavy work; `sonnet` for contained, well-specified work.
   - `commit`: the Conventional Commit title of the squash commit, such as `feat: add login endpoint`. Allowed types: feat, fix, docs, style, refactor, test, chore, perf, ci, revert. No scope in parentheses.
   - `build`: the command that must pass before the worker finishes. `test`: the test command, if any.
   - `context`: optional extra files for `.context/` (API notes, fixtures, a design sketch).
   Every worker is told to build, to fix errors and warnings it introduced unless expected, and to leave its branch in clean commits.
3. Define the QA work now, so it does not get shaped by what the workers happen to produce:
   - A rubric: items with `id`, `title` (a user-visible outcome) and `category` (`core` or `ui-ux`). Cover the core function first, then clarity, feedback, error handling and flow.
   - A harness: how QA starts, reaches and uses the deliverable (install and run commands, URL or binary, accounts or fixtures, the flows a user walks). QA behaves as the end user and is barred from reading source, so the harness must be enough on its own.
   Keep both ready for phase 4.

Show the plan (tasks, models, commit titles; rubric and harness) in a compact form before dispatching. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

## Phase 4: the implementation loop

1. **Dispatch.** Call `mcp__task-loop__dispatch` with the tasks. It creates a worktree and branch per task under `.workspaces/` and starts the workers. Then end your turn: say in one line that the workers are running. A prompt starting with `[task-loop]` wakes you when every worker has ended, when one goes stale (no activity for 30 minutes), or when one is stopped after two idle hours. Do not poll; do not call `status` in a loop.
2. **On the wake-up.** Read it. For a stale worker, call `status` and decide: leave it (it may be building), or `cancel` it and plan a re-dispatch. When every worker has ended, call `mcp__task-loop__merge`. It squash-merges each finished branch into `dev` with the planned commit title and prunes the worktrees. Conflicts are reported, not resolved: dispatch a worker whose task is to redo that branch on top of `dev`, then merge again.
3. **QA.** Call `mcp__task-loop__qa` with the rubric, the harness, and a short brief of what this iteration built or changed. End your turn. The wake-up carries the verdict (`pass`, `pass-with-recommendations`, `fix`), the counts, every item below strong, and the QA overview.
4. **Decide.** On `fix`, plan the fixes as new worker tasks and go back to step 1: the next dispatch starts a new iteration automatically. On `pass-with-recommendations`, decide whether the recommendations are worth an iteration; usually one more is. On `pass`, go to phase 5.
5. The user may type while workers run. Their prompts are rows in the timeline; answer them, and fold any new direction into the next iteration rather than into the running one.

## Phase 5: finish

Call `mcp__task-loop__finish`. It merges `dev` into `main` (fast-forward, else one merge commit), removes leftover run worktrees and closes the run. Report in a few lines: what shipped, the last QA verdict, and anything deliberately left out. Reports and briefs of the run are under `.workspaces/.task-loop/<run id>/`.

## Rules you keep

- Only workers change the codebase. The tools refuse edits and history-changing git commands from you while a run is active.
- Every contribution follows clean-commits: Conventional Commit titles, one coherent unit per commit, no bodies. The squash commit titles come from your plan.
- Workers never see each other's work mid-flight: put the contracts in the briefs.
- QA never reads source. Judge its report, not its method.
- Prefer finishing the loop over polishing forever: when QA says pass, finish.
