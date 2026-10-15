---
name: dacapo-loop
description: The dacapo loop - clarify, research, plan, parallel isolated workers, end-user QA with a scored rubric, iterate, merge. Any orchestrator host can follow it with its own way to dispatch agents and merge their work. Invoked by the user via /dacapo-loop <task>.
---

# dacapo-loop

dacapo runs a request as a loop with three roles. The **orchestrator** (you) clarifies the request, researches the stack, plans the work, starts the workers, reads their outcomes and decides what happens next. **Workers**, one per task, each build one component in isolation and land it into the run. The **QA agent** uses the deliverable as an end user and scores it against a rubric you wrote before any work began. You never edit files or integrate work yourself: workers change the codebase and the host integrates what they land.

The request is everything after `/dacapo-loop` in the prompt that invoked this skill, or the task handed to you by the host.

## What the host provides

- `start`: open a run for the clarified request.
- `dispatch`: start one isolated worker per task, all in parallel.
- `wait`: be woken when every worker has ended or one stalls; never poll.
- `collect`: learn each worker's outcome and bring landed work into the run.
- `cancel`: stop a worker and discard what it has not landed.
- `qa`: start the QA agent on the current state of the run with the rubric and harness; receive the scored report.
- `merge`: integrate the run into the base line.
- `phase`: mark where the loop stands (clarify, research, plan, implement, qa, merge). Mark each later phase (plan, implement, qa, merge) as you enter it, unless the host marks it itself.

The host you run in says how each operation is done: its own tools, agents and integration. A worker's outcome is one of `landed`, `failed`, `stale`, `timed out` or `cancelled`.

## Phase 1: clarify (loop until the request is clear)

0. Call `phase` with `clarify`.
1. Restate the request in your own words: the deliverable, who uses it, what "done" looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Offer options when they are enumerable, prose otherwise. Ask everything you need in one message.
3. Wait for the answer, fold it in, and repeat until nothing material is open. Do not start research with an open question that changes the design.

## Phase 2: research

Call `phase` with `research`. With the request clear, research the stack before planning:

- If the stack is not fixed by the user or the repository, compare the two or three most suitable stacks or libraries and pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses; the plan needs them. Note whether the project runs automated checks on landed work: workers wait for them, and no checks count as passing.

Keep the findings short: a stack decision, the versions, the commands, and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: start the run and plan

1. Mark `plan`. Call `start` with the request in one line (written by you after clarification, never the prompt verbatim) and one short paragraph on the deliverable, who it is for and what done looks like.
2. Split the work into components that can be built independently and in parallel. Each component becomes one task, with the fields:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `brief`: the complete prompt for a worker that knows nothing else: what to build, which files or modules, the interfaces it must expose or consume, the research facts that matter, constraints, and what finished looks like. Workers cannot see each other's work, so name the contracts between components explicitly (routes, types, function signatures, file names).
   - `model`: `strong` for complex, cross-cutting or design-heavy work; `fast` for contained, well-specified work.
   - `landing title`: the one-line title the work lands under, in the form the host requires.
   - `build`: the command that must pass before the worker lands. `test`: the test command, if any.
   - `context`: optional extra files (API notes, fixtures, a design sketch).
   Standing instructions for every worker: build, fix the errors and warnings you introduced unless expected, leave the work in clean commits, stay within the task, and land it before reporting finished. The host hands them to every worker with its brief; if your host does not, write them into each brief.
3. Define the QA work now, so it does not get shaped by what the workers happen to produce:
   - A rubric: items with `id`, `title` (a user-visible outcome) and `category` (`core` or `ui-ux`). Cover the core function first, then clarity, feedback, error handling and flow.
   - A harness: how QA starts, reaches and uses the deliverable (install and run commands, URL or binary, accounts or fixtures, the flows a user walks). QA behaves as the end user and never reads source, so the harness must be enough on its own.
   Keep both ready for phase 4.

Show the plan (tasks, models, landing titles; rubric and harness) in a compact form before dispatching. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

## Phase 4: the implementation loop

1. **Dispatch.** Mark `implement`. Call `dispatch` with the tasks; all workers start in parallel. Say in one line that the workers are running, then `wait` to be woken. Do not poll.
2. **On the wake-up.** Read every worker's outcome. For a `stale` worker, decide: leave it (it may be building or waiting on checks), or `cancel` it and plan a re-dispatch. When every worker has ended, call `collect`. A worker that says finished but has not `landed` has not finished: resume it.
3. **A failed worker** (`failed` or `timed out`) leaves its work in place. Options, in order of preference:
   1. **Resume it**: dispatch the same `id` with `resume` and a brief that says what to fix or finish. The new worker continues the earlier one's work.
   2. **Repair first** when the failure is not the task's fault (a broken check, a flaky test, a missing dependency): dispatch a repair task of its own, `collect`, then resume the original.
   3. **Drop it** with `cancel`; the run continues with the others.
   4. **Ask the user** when a human is needed: missing secrets, a required approval, an outage.
4. **QA.** Mark `qa`. Call `qa` with the rubric, the harness, and a short note of what this round built or changed, then `wait`. The report scores every rubric item `strong`, `acceptable` or `unacceptable` with a short note, and carries an overview and a verdict: `fix` if any item is unacceptable; `pass-with-recommendations` if any item is acceptable and none unacceptable; `pass` otherwise.
5. **Decide.** On `fix`, plan the fixes as new tasks and go back to step 1: the next dispatch starts a new round. On `pass-with-recommendations`, decide whether the recommendations are worth a round; usually one more is. On `pass`, go to phase 5.
6. The user may type while workers run. Answer them, and fold any new direction into the next round rather than into the running one.

## Phase 5: merge

1. Mark `merge`. Call `merge` with a one-line title summing up the run and one paragraph on what changed and why, then `wait`.
2. If the integration is refused because the base line moved or its checks fail, dispatch a worker to reconcile or fix it (resume the task at fault, or a repair task), `collect`, run `qa` once more (a reconciliation can break things), and call `merge` again.
3. When the run is merged, report in a few lines: what shipped, the last QA verdict, and anything deliberately left out.

## Rules

- Only workers change the codebase.
- Workers never see each other's work mid-flight: contracts go in each task's `brief`.
- QA never reads source: judge its report, not its method.
- Prefer finishing the loop over polishing forever: when QA says pass, merge.
