---
name: loop
description: The dacapo loop as a specification for any orchestrator that runs agents and lands their work its own way. It covers four roles (orchestrator, workers, QA, reviewer) and their boundaries, the three levels a run can be held to (fast, balanced, deep), what a host must guarantee, and the inputs written before any code exists. It also gives the worker, QA and reviewer report contracts, the decision rules of each phase (clarify, research, plan, implement, qa, review, merge), and what keeps rounds repeatable: the conventions workers match, the hazards research must find, the evidence briefs ask for, and the decision record a run leaves behind.
---

# loop

dacapo builds a request in rounds until its end user would accept it. Three roles run the loop: the **orchestrator**, the **workers** and **QA**; a fourth, the **reviewer**, joins at the highest level. A host runs the agents and integrates what lands. This file says what each role does and what the host must guarantee, never how a host does it.

If a person invoked this skill directly rather than a host loading it, tell them two things. This file is the loop's specification, and the `/dacapo:core` command is what runs it.

## Roles

**Orchestrator.** The orchestrator produces the plan, the rubrics, the harness, the briefs, the decisions and the final report.

**Workers.** A worker produces one landed task and its report.

**QA.** QA produces one scored report on the product, as its end user.

**Reviewer.** The reviewer produces one scored report on the run's change, as an engineer who will maintain the codebase.

## Variants

The loop ships in three variants, `core-fast`, `core` and `core-deep`, that differ only in which judges run: none, QA, or QA then the reviewer. A host names the variant when a run opens, and it is never changed once work is dispatched. The rest of this file reads with QA and the reviewer present when the variant has them.

## Boundaries

### Orchestrator

Responsible for:
- Clarifying the request with the user, the only role in conversation with the user.
- Researching the stack, its versions, its build and test commands, and the references each task must match.
- Splitting the work into independent tasks with explicit contracts.
- Writing every input before code exists: briefs, landing titles, build and test commands, rubric, harness, and at `deep` the engineering rubric.
- Reading outcomes and reports, and deciding each next round.
- Asking the host to integrate the run, and writing the final report.

Never:
- Edit files, write code or integrate landed work itself.
- Write the system instructions of workers, QA or the reviewer (the host provides them).
- Copy the standing worker instructions into briefs when the host already hands them over.
- Ask the host for news over and over (the host reports outcomes unasked).
- Re-score, argue with or override a QA or review verdict.
- Reshape a rubric after seeing what was built.
- Widen the run to parts of the project the planned change does not touch.

Cannot see:
- A worker's work before it lands (only its report and the host's landed or not landed fact).
- QA's or the reviewer's method (only their reports).

### Workers

Responsible for:
- Building exactly one task, inside the sandbox the host prepared.
- Finding the existing pattern for each kind of thing the task adds (a screen, a menu, a form, an error, a command, an endpoint) and matching it, starting from the references its brief names. Where the codebase has none: the stack's own idioms, then the platform's guidelines, then a comparable product. A glance outward is due even when a local pattern exists: a local pattern that falls short of the stack's or platform's own way is followed for consistency and reported, never silently copied.
- Building and testing before landing; fixing the errors and warnings it introduced, and leaving alone those the brief marks as expected.
- Leaving the work in clean, reviewable units under the planned landing title.
- Reconciling its own work when landing is refused because the base moved, and fixing failing checks, within a bounded number of fix rounds.
- Landing before reporting, and naming what it deliberately left out.
- Reporting every deviation from its brief, every design decision it made alone (a number it tuned, a rule it read two ways, a contract it had to extend, a pattern it chose where nothing existed to match) and every new pattern it introduced that other work could reuse, so the orchestrator can surface them. Not every pattern it followed.

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
- The rubrics and the harness.

### QA

Responsible for:
- Setting the product up as the harness says and using it as its end user.
- Exercising every rubric item; for ui-ux items, attending to clarity, feedback, errors, flow and consistency: like things look and behave alike across the product, and when they do not, the note names the pair.
- Splitting the rubric among evidence collectors when the harness lets several testers use the product at once, each told its items, its share of the product and what is shared; walking itself what needs one continuous session or the only instance; and verifying what a collector brings back before scoring on it.
- Owning the report whatever happens to its collectors, as the orchestrator owns a round whatever happens to its workers: a collector that failed or ended without a report is run again on the same slice, once; the gaps a collector names are walked by QA itself; what is still untested after that QA walks too, and the note says so. No item is scored on evidence nobody gathered, and no item is left unscored.
- Scoring each item with a concrete note: what it did, what it saw, what it expected.
- Writing one overview: what works, what does not, what to fix first, and feedback the items do not capture.
- Stopping every process it started, and any a collector left running.

Never:
- Read, search or open source by any means, including the shell it keeps to run the product.
- Edit anything but its report.
- Spawn anything but evidence collectors, and never more at once than the host allows.
- Talk to the user.
- Decide the verdict.

Cannot see:
- The source, the workers' reports and the orchestrator's conversation.
- Anything beyond what the host hands it.

### QA collectors

An evidence collector is an agent QA starts on a slice of the rubric. It uses the product as its end user on the share QA gave it (an instance, pages, accounts, windows, ports) and brings back, in its report to QA, what it did, what it saw, what it expected and the evidence it captured. The scoring stays QA's.

Its report is to QA what a worker's is to the orchestrator: short sections (one per item of its slice; what it could not exercise and why; what it noticed outside its slice) ending with exactly one of:
- **collected**: every item of the slice was exercised.
- **collected with gaps**: something in the slice could not be exercised, and the report says what and why.
- **failed**: nothing usable was gathered.

The host fixes the exact form of the last line, so it can be parsed, and tells QA when a collector ended without a report. A step refused only because a shared resource was busy is retried, not given up on.

Never:
- Read, search or open source by any means: it is bound exactly as QA is.
- Score an item or write the report.
- Spawn agents.
- Start, stop or reconfigure anything QA said is shared.
- Talk to the user.

Cannot see:
- Anything beyond the harness, the rubric and its slice.

### Reviewer

Present at `deep` only.

Responsible for:
- Reading the change the run has accumulated against its base, the same state QA just tested, and the code it touches.
- Scoring every engineering rubric item with a concrete note: what it saw, where, what it expected.
- Judging the change, not the whole codebase: a flaw the run did not introduce is a recommendation, not a score.
- Writing one overview: what to fix first inside the run's own change, then, apart, what it recommends beyond it.

Never:
- Edit anything but its report.
- Spawn agents.
- Talk to the user.
- Decide the verdict.
- Score the product's behaviour (that is QA's).

Cannot see:
- The workers' reports, QA's report and the orchestrator's conversation.

## What a host must guarantee

- **Isolation.** Each worker works in a sandbox it cannot leave; the host refuses its writes outside it.
- **Deterministic integration.** Landed work enters the run under its planned landing title by the host's own mechanism, never by the orchestrator. Work counts as landed only when the host says so. At the end the host integrates the run into the base line when asked, and says why when it refuses (the base moved, checks fail).
- **A clean QA environment.** QA gets a clean copy of the integrated state and a way to run the product. Source is unreachable to it, or at least forbidden by its instructions. Every collector QA starts is bound by the same guard, in the same environment, writing only its evidence; the host caps how many run at once, since one machine's product can only be shared so far. Each collector's report reaches QA, and a collector that ended without one is reported to QA as failed; a collector's outcome never reaches the orchestrator, since QA's method is not its to see.
- **A read-only reviewer environment.** At `deep`, the reviewer gets a clean copy of the integrated state and the base it is compared against; it can write its report and nothing else.
- **Validated reports.** For QA and the reviewer alike, the host checks that every rubric id is scored exactly once, every score is `strong`, `acceptable` or `unacceptable`, and the overview is not empty. It derives the verdict from the scores and never asks the judge for one. An invalid report goes to the orchestrator with the reasons.
- **Reported outcomes.** Without being asked, the host tells the orchestrator each worker's report and whether its work landed. It also tells it about a worker that is stalled: still running, with no activity for a long time. A report is never lost on the way.
- **Resume and stop.** The work of a worker that did not land stays in place, so its task can be resumed from where it stopped. The orchestrator can stop a worker, which discards what it has not landed.
- **A guard on the orchestrator.** While a run is active the host stops the orchestrator from editing files, integrating work or rewriting history.
- **Standing worker instructions.** The host hands every worker its standing instructions with the brief. They say to build and test before landing, fix what you introduced, leave clean reviewable units and stay within the task. They say to find and match the existing pattern for what you add, and to report the decisions you made alone and the reusable patterns you introduced. They also say to land before reporting, name what you left out and end with the report below, and to retry, not fail, a step refused only because a shared resource was busy (a port, a display, a device another task holds). A host that does not leaves the orchestrator to write them into every brief.
- **Model tiers.** Two at least: the strong tier for complex, cross-cutting or design-heavy work, and the fast tier for contained, well-specified work.

## Phase 1: clarify

1. Restate the request in your own words: the deliverable, who uses it, what done looks like.
2. If anything material is ambiguous (scope, stack, data, integration points, acceptance), ask. Offer options when they are enumerable, prose otherwise. Ask everything you need in one message.
3. Fold the answer in and repeat until nothing material is open. Do not start research with an open question that changes the design.
4. Note the level. The user names it with the request or it is `review`; an unstated level is confirmed in the restatement, not asked about.

## Phase 2: research

- If the stack is not fixed by the user or the codebase, compare the two or three most suitable stacks or libraries. Pick one, stating why in a sentence.
- For every library the work depends on, read the high-level documentation for the version the project already uses (check the lockfile or manifest). For a new project use the latest stable version.
- Note the build and test commands of the project, or the ones the chosen stack uses. Note whether the host runs automated checks before work lands: a worker lands only when they pass, and no checks count as passing.
- Read the project's own instructions to agents and contributors (an agent instructions file, a contributing guide) and the documents they point to. What they already fix, the briefs do not restate; what they lack, the briefs must carry.
- Find the hazards of the project and the machine: commands that can hang and the project's way to bound them (a timeout wrapper, a runner limit); resources parallel workers cannot share (a port, a display, a device, a shared log or cache); outputs that grow without bound (logs, screenshots, build folders) and where to check their size. A command that can hang runs under a time limit in every brief: one hung test run can fill a disk.
- Find how behaviour is proven in this project beyond the tests: a scripted client, screenshots, a replay, a measurement, a benchmark. The briefs will ask for it as evidence, and the harness will use it.
- Find the project's existing conventions at a glance, enough to point each brief at the things its task must match: the existing menu, the existing form, the error style, the way a command reports. This is a survey, not a study; the worker reads the reference in depth. Where the codebase has none, point the brief at an outside reference instead: the stack's own component library and documentation, the platform's guidelines, a comparable product. Only when two or more tasks of the same round add the same kind of thing and nothing exists to match, decide that one convention now, so parallel workers do not invent two; everything else is the worker's to decide and report.

Keep the findings short: a stack decision, the versions, the commands, the hazards, the evidence recipe, the references each brief points at (inside or outside the codebase), and the two or three facts per library that the workers would otherwise get wrong.

## Phase 3: plan

Produce everything below before any code exists.

1. **The run.** The request in one line, written by you after clarification and never the prompt verbatim. Then one short paragraph on the deliverable, who it is for and what done looks like. The host opens the run with them.

   The decisions the user confirmed in phase 1 get stable ids (`D1`, `D2`, ...) and go into a context file every brief can cite, with the level. One task of the first round records them in the repository as a decision record: the ids, each decision as the user confirmed it, the rationale, and what it supersedes. Later rounds and later runs then find why things are the way they are. The orchestrator never writes it into the codebase itself.

   Where an existing pattern and the new work meet, three rules decide, at plan time and again whenever a report surfaces a choice: match the existing pattern when it serves the purpose; use it and extend it locally when the purpose needs more; never add work to parts of the project the planned change does not already touch. An improvement that would reach those parts is a recommendation in the final report, for the user to decide on. The few conventions decided for siblings in research go in the context file next to the decisions, and the decision-record task records them too.
2. **The tasks.** Split the work into components built independently and in parallel, one task each:
   - `id`: a kebab-case slug.
   - `title`: a few words.
   - `brief`: the complete prompt for a worker that knows nothing else: what to build, which files or modules, the research facts that matter, constraints, and what done looks like. Workers cannot see each other, so name every contract between components explicitly: routes, types, function signatures, file names. Name the existing things the task must match or extend, or the outside reference when the codebase has none. Name the evidence the report must carry for anything the tests do not prove (a command's output, a screenshot the worker has looked at, a measurement), and say what the worker may decide alone and what it must report as a deviation.
   - `model`: the strong tier or the fast tier.
   - `landing title`: the one line the work lands under.
   - `build`: the command that must pass before landing. `test`: the test command, if any. Both run under a time limit when they can hang. A test that needs a resource parallel tasks cannot share (a port, a display, a device) is not a per-task test: it runs once, in the harness or in a single task.
   - `context`: optional extra files (API notes, fixtures, a design sketch, the decisions, a contract).

   Tasks within a round are independent. When one task needs another's result, put it in a later round or combine the two into one task. Contracts cover the seams where one task's work calls another's; when two tasks add the same kind of thing without touching, their briefs point at the same reference or the same convention. One exception saves a round: a task may build against another task's contract in the same round when all three hold. The contract is written in full in a context file both briefs share (names, signatures, payloads, file names). The dependent brief says to code against it tolerantly and to reconcile with the landed dependency before landing. And the dependency is expected to land first. Without all three, use a later round.
3. **The standing worker instructions** (see the host guarantees). Write them into each brief only when the host does not hand them over.
4. **The rubric** (at `balanced` and above). Items with `id` (kebab-case), `title` and `category` (`core` or `ui-ux`). Each item is one user-visible outcome that can be tested through the harness alone. Cover the core function first, then clarity, feedback, error handling, flow and consistency; failure paths get items too. No item mentions code or files. Six to twelve items is usual. Writing it now keeps it from being shaped by what the workers produce.

   One item belongs in every rubric: consistency (like things look and behave alike across the deliverable, the kinds of surface named one by one; the note names the pair that diverged). Three more belong in every rubric of a run on an existing product: regression (the flows that worked before the run still work, named one by one), stability (no crash and no error in the product's own log during every flow QA walks), and the failure paths the deliverable adds (a bad input, a lost connection, an unreachable peer). They are scored like the rest.
5. **The engineering rubric** (at `deep`). Items with `id`, `title` and `category` (`quality`, `consistency` or `cleanup`). Each item is one property of the code a reader can check in the run's diff: an error raised the way the codebase raises them, a name that follows the project's naming, no scaffolding left behind. Consistency items name the conventions and references the briefs pointed at. Six to twelve items. Written now and never reshaped afterwards, like the rubric.
6. **The harness** (at `balanced` and above). How QA starts, reaches and uses the deliverable: install and run commands, a URL or binary, accounts or fixtures, the flows a user walks. QA sees nothing else, so it must be enough for someone who has never seen the codebase.

   It also names: the hooks that shorten long waits (flags for timers, seeds, fixtures), so a flow is walked in minutes; how to run a second instance when the deliverable needs a peer; the environment's own limits and how to tell them from product failures (a window the OS stops drawing, a port another process holds, a stalled instance to restart), so QA attributes them to the environment; and the known non-issues of this run (behaviour that looks wrong but is by design), so they are not reported.

   And, so QA can split the rubric among collectors, how several testers use the product at once with the least setup: what one running instance can share (separate pages, accounts, sessions, windows or ports; a web app needs its frontend and backend started once, and different testers visit different pages), when a second instance is needed and what it costs, and what cannot be shared at all (a single display, a stateful fixture, a flow that must run uninterrupted), so QA knows what to split and what to walk itself.

Show the plan (level; tasks, tiers, landing titles; rubrics and harness) in a compact form. If the user is present and the plan is large, give them a moment to object; otherwise proceed.

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
6. At `fast`, when every task of the round has landed, go to phase 6; a task that failed or was dropped is a limitation in the final report. At the other levels go to phase 5.

## Phase 5: qa

Skipped at `fast`.

1. When the round's work has landed, hand the host the rubric, the harness and a note on what this round built or changed. QA is handed these, the run's one-line request and where to write its report. Write the note in user-visible terms (what a user can now do or will see differently), never in implementation terms. In a fix round, list the items the round aimed at, so QA re-verifies them first; it still scores every item. QA may split the items among collectors as the harness allows; every score is still its own, and a collector that fails is QA's to absorb (run again, or walk the slice itself), never a reason for an unscored item: only an invalid report reaches you.
2. QA's report has `items`, one per rubric id, each with `id`, `score` and a `note` of one to three sentences, and an `overview`. Scores: `strong` (clearly met), `acceptable` (technically passes, improvements recommended), `unacceptable` (fails, must be fixed). The host derives the verdict: `fix` if any item is unacceptable; `pass-with-recommendations` if any is acceptable and none unacceptable; `pass` otherwise. You receive the verdict, the counts, every item below `strong` and the overview.
3. If the host says the report is invalid, run QA again. Clarify the harness or the round note only if that caused the failure. An invalid report is never a pass. Step 5 says when invalid reports make the loop stuck.
4. Decide as follows after every valid report, wherever QA ran: after a round, after a re-run following an invalid report, or after a reconciliation or fix in phase 6. Take the first case that applies.
   - **Stuck** (step 5): ask the user as step 5 says.
   - **After the user's merge decision** (step 5): the items the user accepted no longer count. An item is new only if it was `strong` in the last valid report before that decision and is below `strong` now. New items become fix tasks as in the next case, and you go back to phase 4. With no new items, go to phase 6.
   - **`fix` or `pass-with-recommendations`**: every item below `strong`, acceptable ones included, becomes a fix task in the next round. Its brief starts from the QA note: what QA did, saw and expected, and the evidence it cited. Recommendations are fixed, not weighed. Go back to phase 4.
     A fix round is a new set of tasks. Group them by the part of the codebase they touch, one task per part, so parallel fix workers do not collide; a task that holds an `unacceptable` core item gets the strong tier. A fix that changes how a kind of thing looks or behaves everywhere is one task of its own round, since parallel fixes applying it differently recreate the inconsistency. Resuming a task whose landed work is at fault counts as a fix task.
   - **`pass`**: at `balanced`, go to phase 6; at `deep`, go to phase 5b.
5. The loop is stuck when the same items stay below `strong` after two consecutive rounds aimed at them, or when QA's report is invalid twice in a row. A reconciliation or fix round from phase 6 counts toward this test only if it was aimed at those items. Items accepted in the user's merge decision never count toward it. When the loop is stuck, ask the user how to proceed: another round with a different approach, merging with the limitation stated, or stopping. The user's answer decides. Another round with a different approach goes back to phase 4. Choosing to merge is the user's merge decision: go to phase 6, and state the limitation in the final report. The stuck count restarts after the user's choice: rounds before it no longer count toward the test.

## Phase 5b: review

At `deep` only, after QA passes.

1. Hand the host the engineering rubric and a note on what the run built, the conventions and references the briefs pointed at, and what to look at first. The reviewer is handed these, the run's one-line request, the base the run is compared against, and where to write its report.
2. The reviewer's report has the shape of QA's: `items`, one per rubric id, each with `id`, `score` and a `note`, and an `overview`. The host derives the verdict the same way. You receive the verdict, the counts, every item below `strong` and the overview.
3. An invalid report is run again, as in phase 5 step 3.
4. Decide after every valid report. Every item below `strong` whose fix lies inside the run's own change becomes a fix task in the next round, grouped by part as in phase 5; go back to phase 4. When those fixes have landed, QA runs again (a fix can regress behaviour), then the review again; the run merges when both pass. An item whose fix would reach parts the run does not touch is not a task: it goes to the final report as a recommendation, by the third rule of phase 3. On `pass`, go to phase 6.
5. The stuck rule of phase 5 step 5 applies to review items too, counted apart from QA's.
6. A host may let QA and the review run side by side when the user asks for it: faster, and more tokens, since a review of a state QA then fails is wasted. QA's verdict comes first: a `fix` stops the running review, whose report for that state is discarded, and the review runs again after the fixes. A review that reported before QA did waits for QA's verdict before anything is decided on it.

## Phase 6: merge

1. Ask the host to integrate the run into the base line, with a one-line title summing up the run and one paragraph on what changed and why.
2. If the host refuses because the base line moved or its checks fail, start a worker to reconcile or fix it. Either resume the task at fault or start a repair task, and handle its outcome as in phase 4. A reconciliation can break things, so once it has landed, run the judges of the level again (QA; at `deep` then the review) and decide as in phase 5 and 5b. At `build` ask the host to integrate again once it has landed.
3. When the run is integrated, report in a few lines: what shipped, the level and the last verdicts, and anything deliberately left out. Include every limitation a worker reported, any limitation the user accepted, every design decision a worker took alone that the user should review (a tuned number, a rule read two ways, a pattern chosen where nothing existed) and every reusable pattern it introduced, with where each lives, and every recommendation deferred under the third rule of phase 3.

## Rules

- Only workers change the codebase; the host integrates what they land.
- Workers never see each other mid-flight: contracts go in the briefs.
- QA never reads source, and neither does a collector it starts; the reviewer never changes it: judge their reports, not their methods.
- The verdict is derived from the scores, never negotiated.
- A worker matches what exists before inventing; what it decided alone is reported, never silent.
- The orchestrator never widens a run beyond the parts the change touches; what it deferred is reported.
- The level is chosen before dispatch and never changed mid-run.
- The orchestrator is the only role that talks to the user.
- The run merges only on `pass` from every judge of its level, or after the user's merge decision (phase 5 step 5); at `fast`, once the work has landed.
- Once work is dispatched, the orchestrator asks the user only when the loop is stuck (phase 5 step 5) or a human is needed (phase 4 step 4).
- A command that can hang runs under a time limit; a resource parallel tasks cannot share is used by one task at a time, never by a per-task test.
- Decisions the user confirmed, and the conventions decided for siblings, live in the repository, written by a worker.
