---
name: loop
description: The dacapo loop as a specification for any orchestrator that runs agents and lands their work its own way. It covers three roles (orchestrator, workers, QA) and their boundaries, what a host must guarantee, and the inputs written before any code exists. It also gives the worker and QA report contracts, the decision rules of each phase (clarify, research, plan, implement, qa, merge), and what keeps rounds repeatable: the hazards research must find, the evidence briefs ask for, and the decision record a run leaves behind.
---

# loop

dacapo builds a request in rounds until its end user would accept it. Three roles run the loop: the **orchestrator**, the **workers** and **QA**. A host runs the agents and integrates what lands. This file says what each role does and what the host must guarantee, never how a host does it.

If a person invoked this skill directly rather than a host loading it, tell them two things. This file is the loop's specification, and the `/dacapo:core` command is what runs it.

## Roles

**Orchestrator.** The orchestrator produces the plan, the rubric, the harness, the briefs, the decisions and the final report.

**Workers.** A worker produces one landed task and its report.

**QA.** QA produces one scored report.

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
- Reporting every deviation from its brief and every judgment call it made alone (a number it tuned, a rule it read two ways, a contract it had to extend), so the orchestrator can surface them.

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
- **Standing worker instructions.** The host hands every worker its standing instructions with the brief. They say to build and test before landing, fix what you introduced, leave clean reviewable units and stay within the task. They also say to land before reporting, name what you left out and end with the report below, and to retry, not fail, a step refused only because a shared resource was busy (a port, a display, a device another task holds). A host that does not leaves the orchestrator to write them into every brief.
- **Model tiers.** Two at least: the strong tier for complex, cross-cutting or design-heavy work, and the fast tier for contained, well-specified work.

## Phase 1: clarify

1. Restate the request in your own words: the deliverable, who uses it, what done looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Offer options when they are enumerable, prose otherwise. Ask everything you need in one message.
3. Fold the answer in and repeat until nothing material is open. Do not start research with an open question that changes the design.

## Phase 2: research

- If the stack is not fixed by the user or the codebase, compare the two or three most suitable stacks or libraries. Pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses. Note whether the host runs automated checks before work lands: a worker lands only when they pass, and no checks count as passing.
- Read the project's own instructions to agents and contributors (an agent instructions file, a contributing guide) and the documents they point to. What they already fix, the briefs do not restate; what they lack, the briefs must carry.
- Find the hazards of the project and the machine: commands that can hang and the project's way to bound them (a timeout wrapper, a runner limit); resources parallel workers cannot share (a port, a display, a device, a shared log or cache); outputs that grow without bound (logs, screenshots, build folders) and where to check their size. A command that can hang runs under a time limit in every brief: one hung test run can fill a disk.
- Find how behaviour is proven in this project beyond the tests: a scripted client, screenshots, a replay, a measurement, a benchmark. The briefs will ask for it as evidence, and the harness will use it.

Keep the findings short: a stack decision, the versions, the commands, the hazards, the evidence recipe, and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: plan

Produce everything below before any code exists.

1. **The run.** The request in one line, written by you after clarification and never the prompt verbatim. Then one short paragraph on the deliverable, who it is for and what done looks like. The host opens the run with them.

   The decisions the user confirmed in phase 1 get stable ids (`D1`, `D2`, ...) and go into a context file every brief can cite. One task of the first round records them in the repository as a decision record: the ids, each decision as the user confirmed it, the rationale, and what it supersedes. Later rounds and later runs then find why things are the way they are. The orchestrator never writes it into the codebase itself.
2. **The tasks.** Split the work into components built independently and in parallel, one task each:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `brief`: the complete prompt for a worker that knows nothing else: what to build, which files or modules, the research facts that matter, constraints, and what done looks like. Workers cannot see each other, so name every contract between components explicitly: routes, types, function signatures, file names. Name the evidence the report must carry for anything the tests do not prove (a command's output, a screenshot the worker has looked at, a measurement), and say what the worker may decide alone and what it must report as a deviation.
   - `model`: the strong tier or the fast tier.
   - `landing title`: the one line the work lands under.
   - `build`: the command that must pass before landing. `test`: the test command, if any. Both run under a time limit when they can hang. A test that needs a resource parallel tasks cannot share (a port, a display, a device) is not a per-task test: it runs once, in the harness or in a single task.
   - `context`: optional extra files (API notes, fixtures, a design sketch, the decisions, a contract).

   Tasks within a round are independent. When one task needs another's result, put it in a later round or combine the two into one task. One exception saves a round: a task may build against another task's contract in the same round when all three hold. The contract is written in full in a context file both briefs share (names, signatures, payloads, file names). The dependent brief says to code against it tolerantly and to reconcile with the landed dependency before landing. And the dependency is expected to land first. Without all three, use a later round.
3. **The standing worker instructions** (see the host guarantees). Write them into each brief only when the host does not hand them over.
4. **The rubric.** Items with `id` (kebab-case), `title` and `category` (`core` or `ui-ux`). Each item is one user-visible outcome that can be tested through the harness alone. Cover the core function first, then clarity, feedback, error handling and flow; failure paths get items too. No item mentions code or files. Six to twelve items is usual. Writing it now keeps it from being shaped by what the workers produce.

   Three items belong in every rubric of a run on an existing product: regression (the flows that worked before the run still work, named one by one), stability (no crash and no error in the product's own log during every flow QA walks), and the failure paths the deliverable adds (a bad input, a lost connection, an unreachable peer). They are scored like the rest.
5. **The harness.** How QA starts, reaches and uses the deliverable: install and run commands, a URL or binary, accounts or fixtures, the flows a user walks. QA sees nothing else, so it must be enough for someone who has never seen the codebase.

   It also names: the hooks that shorten long waits (flags for timers, seeds, fixtures), so a flow is walked in minutes; how to run a second instance when the deliverable needs a peer; the environment's own limits and how to tell them from product failures (a window the OS stops drawing, a port another process holds, a stalled instance to restart), so QA attributes them to the environment; and the known non-issues of this run (behaviour that looks wrong but is by design), so they are not reported.

Show the plan (tasks, tiers, landing titles; rubric and harness) in a compact form. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

## Phase 4: implement

1. Start every task of the round in parallel through the host. Say in one line that the workers are running, then let the host report back.
2. The host reports each worker's outcome: the worker's own report and whether its work landed. The report carries short sections (what was done, where the work landed, build and tests, open issues) and ends with exactly one of:
   - **done**: landed, nothing left out.
   - **done with limitations**: landed, but something was deliberately left out, does not work, or needs a follow-up.
   - **failed**: not landed.

   The host fixes the exact form of the line that carries the outcome, so it can be parsed.
   A worker that reports done before its work has landed is not done: resume it. A limitation feeds the next round's tasks, the QA note and the final report.
3. A worker the host reports as stalled may be building or waiting on checks. Decide: let it continue, or stop it and plan its task again.
4. A failed worker leaves its work in place. A worker that ended without a report (the host, the network or the machine failed under it, not its work) is resumed before anything else. Otherwise the options, in order of preference:
   1. **Resume it**: the same task with a brief that says what to fix or complete; it continues the earlier work.
   2. **Repair first** when the failure is not the task's fault (a broken check, a flaky test, a missing dependency). A repair task of its own lands first, then resume the original.
   3. **Drop it**: stop the task; the run continues with the others.
   4. **Ask the user** when a human is needed: missing secrets, a required approval, an outage.
5. The user may talk to you during a round. Answer, and fold any new direction into the next round rather than the running one.

## Phase 5: qa

1. When the round's work has landed, hand the host the rubric, the harness and a note on what this round built or changed. QA is handed these, the run's one-line request and where to write its report. Write the note in user-visible terms (what a user can now do or will see differently), never in implementation terms. In a fix round, list the items the round aimed at, so QA re-verifies them first; it still scores every item.
2. QA's report has `items`, one per rubric id, each with `id`, `score` and a `note` of one to three sentences, and an `overview`. Scores: `strong` (clearly met), `acceptable` (technically passes, improvements recommended), `unacceptable` (fails, must be fixed). The host derives the verdict: `fix` if any item is unacceptable; `pass-with-recommendations` if any is acceptable and none unacceptable; `pass` otherwise. You receive the verdict, the counts, every item below `strong` and the overview.
3. If the host says the report is invalid, run QA again. Clarify the harness or the round note only if that caused the failure. An invalid report is never a pass. Step 5 says when invalid reports make the loop stuck.
4. Decide as follows after every valid report, wherever QA ran: after a round, after a re-run following an invalid report, or after a reconciliation or fix in phase 6. Take the first case that applies.
   - **Stuck** (step 5): ask the user as step 5 says.
   - **After the user's merge decision** (step 5): the items the user accepted no longer count. An item is new only if it was `strong` in the last valid report before that decision and is below `strong` now. New items become fix tasks as in the next case, and you go back to phase 4. With no new items, go to phase 6.
   - **`fix` or `pass-with-recommendations`**: every item below `strong`, acceptable ones included, becomes a fix task in the next round. Its brief starts from the QA note: what QA did, saw and expected, and the evidence it cited. Recommendations are fixed, not weighed. Go back to phase 4.
     A fix round is a new set of tasks. Group them by the part of the codebase they touch, one task per part, so parallel fix workers do not collide; a task that holds an `unacceptable` core item gets the strong tier. Resuming a task whose landed work is at fault counts as a fix task.
   - **`pass`**: go to phase 6.
5. The loop is stuck when the same items stay below `strong` after two consecutive rounds aimed at them, or when QA's report is invalid twice in a row. A reconciliation or fix round from phase 6 counts toward this test only if it was aimed at those items. Items accepted in the user's merge decision never count toward it. When the loop is stuck, ask the user how to proceed: another round with a different approach, merging with the limitation stated, or stopping. The user's answer decides. Another round with a different approach goes back to phase 4. Choosing to merge is the user's merge decision: go to phase 6, and state the limitation in the final report. The stuck count restarts after the user's choice: rounds before it no longer count toward the test.

## Phase 6: merge

1. Ask the host to integrate the run into the base line, with a one-line title summing up the run and one paragraph on what changed and why.
2. If the host refuses because the base line moved or its checks fail, start a worker to reconcile or fix it. Either resume the task at fault or start a repair task, and handle its outcome as in phase 4. A reconciliation can break things, so once it has landed, run QA and decide as in phase 5.
3. When the run is integrated, report in a few lines: what shipped, the last QA verdict, and anything deliberately left out. Include every limitation a worker reported, any limitation the user accepted, and every decision a worker took alone that the user should review (a tuned number, a rule read two ways), with where it lives.

## Rules

- Only workers change the codebase; the host integrates what they land.
- Workers never see each other mid-flight: contracts go in the briefs.
- QA never reads source: judge its report, not its method.
- The verdict is derived from the scores, never negotiated.
- The orchestrator is the only role that talks to the user.
- The run merges only on `pass` or after the user's merge decision (phase 5 step 5).
- Once work is dispatched, the orchestrator asks the user only when the loop is stuck (phase 5 step 5) or a human is needed (phase 4 step 4).
- A command that can hang runs under a time limit; a resource parallel tasks cannot share is used by one task at a time, never by a per-task test.
- Decisions the user confirmed live in the repository, written by a worker; a worker's own judgment calls are reported, never silent.
