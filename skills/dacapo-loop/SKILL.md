---
name: dacapo-loop
description: The dacapo loop as a specification for any orchestrator that runs agents and lands their work its own way. It covers three roles (orchestrator, workers, QA) and their boundaries, what a host must guarantee, and the inputs written before any code exists. It also gives the worker and QA report contracts and the decision rules of each phase (clarify, research, plan, implement, qa, merge).
---

# dacapo-loop

dacapo builds a request in rounds until its end user would accept it. Three roles run the loop: the **orchestrator**, the **workers** and **QA**. A host runs the agents and integrates what lands. This file says what each role does and what the host must guarantee, never how a host does it.

If a person invoked this skill directly rather than a host loading it, tell them two things. This file is the loop's specification, and the `/dacapo` command is what runs it.

## Roles

**Orchestrator.** You turn the request into a plan, start each round through the host and decide what follows from the reports. You produce the plan, the decisions and the final report.

**Workers.** Each builds one task in a sandbox of its own and lands it. A worker produces landed work and a report.

**QA.** It uses the integrated product as its end user and scores it against the rubric. It produces a report; the host derives the verdict from it.

## Boundaries

### Orchestrator

Responsible for:
- Clarifying the request with the user, the only role in conversation with the user.
- Researching the stack, its versions and its build and test commands.
- Splitting the work into independent tasks with explicit contracts.
- Writing every input before code exists: briefs, landing titles, build and test commands, rubric, harness.
- Reading outcomes and reports, and deciding each next round.
- Asking the host to integrate the run, and writing the final report.

Never:
- Edit files, write code or integrate landed work itself.
- Write the system instructions of workers or QA (the host provides them).
- Copy the standing worker instructions into briefs when the host already hands them over.
- Ask the host for news over and over (the host reports outcomes unasked).
- Re-score, argue with or override a QA verdict.
- Reshape the rubric after seeing what was built.

Cannot see:
- A worker's work before it lands (only its report and the host's landed or not landed fact).
- QA's method (only its report).

### Workers

Responsible for:
- Building exactly one task, inside the sandbox the host prepared.
- Building and testing before landing; fixing the errors and warnings it introduced, and leaving alone those the brief marks as expected.
- Leaving the work in clean, reviewable units under the planned landing title.
- Reconciling its own work when landing is refused because the base moved, and fixing failing checks, within a bounded number of fix rounds.
- Landing before reporting, and naming what it deliberately left out.

Never:
- Spawn agents.
- Leave its sandbox or change where it works.
- Touch another task's work.
- Change the integration target other than through the landing path.
- Talk to the user.
- Report done before its work has landed.

Cannot see:
- Other workers' work mid-flight (the contracts in its brief are all it knows of them).
- The orchestrator's conversation with the user.
- The rubric and the harness.

### QA

Responsible for:
- Setting the product up as the harness says and using it as its end user.
- Exercising every rubric item; for ui-ux items, attending to clarity, feedback, errors and flow.
- Scoring each item with a concrete note: what it did, what it saw, what it expected.
- Writing one overview: what works, what does not, what to fix first, and feedback the items do not capture.
- Stopping every process it started.

Never:
- Read, search or open source by any means, including the shell it keeps to run the product.
- Edit anything but its report.
- Spawn agents.
- Talk to the user.
- Decide the verdict.

Cannot see:
- The source, the workers' reports and the orchestrator's conversation.
- Anything beyond what the host hands it.

## What a host must guarantee

- **Isolation.** Each worker works in a sandbox it cannot leave; the host refuses its writes outside it.
- **Deterministic integration.** Landed work enters the run under its planned landing title by the host's own mechanism, never by the orchestrator. Work counts as landed only when the host says so. At the end the host integrates the run into the base line when asked, and says why when it refuses (the base moved, checks fail).
- **A clean QA environment.** QA gets a clean copy of the integrated state and a way to run the product. Source is unreachable to it, or at least forbidden by its instructions.
- **Validated QA reports.** The host checks that every rubric id is scored exactly once, every score is `strong`, `acceptable` or `unacceptable`, and the overview is not empty. It derives the verdict from the scores and never asks QA for one. An invalid report goes to the orchestrator with the reasons.
- **Reported outcomes.** Without being asked, the host tells the orchestrator each worker's report and whether its work landed. It also tells it about a worker that is stalled: still running, with no activity for a long time. A report is never lost on the way.
- **Resume and stop.** The work of a worker that did not land stays in place, so its task can be resumed from where it stopped. The orchestrator can stop a worker, which discards what it has not landed.
- **A guard on the orchestrator.** While a run is active the host stops the orchestrator from editing files, integrating work or rewriting history.
- **Standing worker instructions.** The host hands every worker its standing instructions with the brief. They say to build and test before landing, fix what you introduced, leave clean reviewable units and stay within the task. They also say to land before reporting, name what you left out and end with the report below. A host that does not leaves the orchestrator to write them into every brief.
- **Model tiers.** Two at least: `strong` for complex, cross-cutting or design-heavy work, `fast` for contained, well-specified work.

## Phase 1: clarify

1. Restate the request in your own words: the deliverable, who uses it, what done looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Offer options when they are enumerable, prose otherwise. Ask everything you need in one message.
3. Fold the answer in and repeat until nothing material is open. Do not start research with an open question that changes the design.

## Phase 2: research

- If the stack is not fixed by the user or the codebase, compare the two or three most suitable stacks or libraries. Pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses. Note whether the host runs automated checks before work lands: a worker lands only when they pass, and no checks count as passing.

Keep the findings short: a stack decision, the versions, the commands, and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: plan

Produce everything below before any code exists.

1. **The run.** The request in one line, written by you after clarification and never the prompt verbatim. Then one short paragraph on the deliverable, who it is for and what done looks like. The host opens the run with them.
2. **The tasks.** Split the work into components built independently and in parallel, one task each:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `brief`: the complete prompt for a worker that knows nothing else: what to build, which files or modules, the research facts that matter, constraints, and what finished looks like. Workers cannot see each other, so name every contract between components explicitly: routes, types, function signatures, file names.
   - `model`: `strong` or `fast`.
   - `landing title`: the one line the work lands under.
   - `build`: the command that must pass before landing. `test`: the test command, if any.
   - `context`: optional extra files (API notes, fixtures, a design sketch).

   Tasks within a round are independent. When one task needs another's result, put it in a later round or combine the two into one task.
3. **The standing worker instructions** (see the host guarantees). Write them into each brief only when the host does not hand them over.
4. **The rubric.** Items with `id` (kebab-case), `title` and `category` (`core` or `ui-ux`). Each item is one user-visible outcome that can be tested through the harness alone. Cover the core function first, then clarity, feedback, error handling and flow; failure paths get items too. No item mentions code or files. Six to twelve items is usual. Writing it now keeps it from being shaped by what the workers produce.
5. **The harness.** How QA starts, reaches and uses the deliverable: install and run commands, a URL or binary, accounts or fixtures, the flows a user walks. QA sees nothing else, so it must be enough for someone who has never seen the codebase.

Show the plan (tasks, tiers, landing titles; rubric and harness) in a compact form. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

## Phase 4: implement

1. Start every task of the round in parallel through the host. Say in one line that the workers are running, then let the host report back.
2. The host reports each worker's outcome: the worker's own report and whether its work landed. The report carries short sections (what was done, where the work landed, build and tests, open issues) and ends with exactly one of:
   - **done**: landed, nothing left out.
   - **done with limitations**: landed, but something was deliberately left out, does not work, or needs a follow-up.
   - **failed**: not landed.

   The host fixes the exact form of the line that carries the outcome, so it can be parsed.
   A worker that reports done but whose work has not landed has not landed: resume it. A limitation feeds the next round's tasks, the QA note and the final report.
3. A worker the host reports as stalled may be building or waiting on checks. Decide: let it continue, or stop it and plan its task again.
4. A failed worker leaves its work in place. Options, in order of preference:
   1. **Resume it**: the same task with a brief that says what to fix or complete; it continues the earlier work.
   2. **Repair first** when the failure is not the task's fault (a broken check, a flaky test, a missing dependency). A repair task of its own lands first, then resume the original.
   3. **Drop it**: stop the task; the run continues with the others.
   4. **Ask the user** when a human is needed: missing secrets, a required approval, an outage.
5. The user may talk to you during a round. Answer, and fold any new direction into the next round rather than the running one.

## Phase 5: qa

1. When the round's work has landed, hand the host the rubric, the harness and a note on what this round built or changed. QA is handed these, the run's one-line request and where to write its report. Write the note in user-visible terms (what a user can now do or will see differently), never in implementation terms.
2. QA's report has `items`, one per rubric id, each with `id`, `score` and a `note` of one to three sentences, and an `overview`. Scores: `strong` (clearly met), `acceptable` (technically passes, improvements recommended), `unacceptable` (fails, must be fixed). The host derives the verdict: `fix` if any item is unacceptable; `pass-with-recommendations` if any is acceptable and none unacceptable; `pass` otherwise. You receive the verdict, the counts, every item below strong and the overview.
3. If the host says the report is invalid, run QA again with a clearer harness. A second invalid report in a row counts as the loop being stuck, and the stuck rule applies. An invalid report is never a pass.
4. Decide:
   - On `fix` or `pass-with-recommendations`, every item below `strong`, acceptable ones included, becomes a fix task in the next round, with the QA note as its brief's starting point. Recommendations are fixed, not weighed. Go back to phase 4, unless the loop is stuck (step 5).
     A fix round is a new set of tasks. Resuming a task whose landed work is at fault counts as a fix task.
   - On `pass`, go to phase 6.
5. The loop is stuck when the same items stay below `strong` after two consecutive rounds aimed at them, or when QA's report is invalid twice in a row. Then ask the user how to proceed: another round with a different approach, merging with the limitation stated, or stopping. Merging goes to phase 6, with the limitation in the final report. The user's answer decides.

## Phase 6: merge

1. Ask the host to integrate the run into the base line, with a one-line title summing up the run and one paragraph on what changed and why.
2. If the host refuses because the base line moved or its checks fail, start a worker to reconcile or fix it. Either resume the task at fault or start a repair task. Then run QA once more, since a reconciliation can break things, and ask again once it passes.
3. When the run is integrated, report in a few lines: what shipped, the last QA verdict, and anything deliberately left out, including every limitation a worker reported.

## Rules

- Only workers change the codebase; the host integrates what they land.
- Workers never see each other mid-flight: contracts go in the briefs.
- QA never reads source: judge its report, not its method.
- The verdict is derived from the scores, never negotiated.
- The orchestrator is the only role that talks to the user.
- The run merges only when QA passes, with one exception: a user who decides to merge after the loop is stuck. Then the final report states the limitation.
- Once work is dispatched, the loop asks the user only when stuck (defined in phase 5 step 5) or when a human is needed: secrets, approvals, outages.
