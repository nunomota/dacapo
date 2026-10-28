# Decision record: the interviews contract

This record holds the decisions the user confirmed for the interviews contract, with the reasons and what each one replaces. It was written by the run that set out to add a fifth node contract, `interviews`, for nodes that talk to the user and write a report. The run was held to the core loop (QA, no reviewer) and leaves dacapo at version 0.23.0. Decisions are cited by id, `D1` to `D8`.

## Decisions

### D1 A fifth node contract, `interviews`

dacapo gains a fifth node contract, `interviews`, glossed `talks to the user and writes a report`. The existing four stay: `lands` (builds and lands work), `scores` (judges a rubric), `collects` (gathers evidence) and `none` (answers a prompt).

Why: a node that holds a conversation with the user fits none of the four contracts, which all work without the user.

Supersedes: the design skill's "four contracts and no other".

### D2 The interviewing node owns its report

An interviewing node owns the shape of its report: its role defines the format, and the host dictates no headings. The host checks only that the report file exists and is non-empty, and that the node's final message ends with exactly one of `dacapo: reported` or `dacapo: reported with open questions`.

Why: what an interview produces depends on the loop's purpose, so the loop's author, not the host, knows the right shape.

Supersedes: nothing.

### D3 The orchestrator starts it with `consult`

The orchestrator starts an interviewing node with a new tool, `consult { node, scope?, model? }`. Before the node starts, the host writes a brief (the run's one line, the scope note and where to write the report) and copies every report of the run so far into a folder the node reads. The node sees nothing else of the run.

Why: a fixed, small input keeps the interview repeatable and the node independent of the run's internals.

Supersedes: nothing.

### D4 The node holds the floor

While it runs, the node holds the floor: what the user types goes to it, its replies come back to the user, and the orchestrator is out of the exchange. When it ends, the floor returns to the orchestrator, woken with the node, the outcome line, the report path and the first lines of the report. `/dacapo-back` returns the floor early: the outcome is `reported with open questions` when a report exists and `failed` otherwise.

Why: an interview only works when the user talks to the node directly, and an early exit keeps the user in control.

Supersedes: the rule that only the orchestrator talks to the user.

### D5 The handover mechanism is open

The handover mechanism is settled by a person-driven spike before the runtime is built. The candidates are the agent view (`$.ui.view({ agentId })`), routing in the mod (`prompt.submit` plus `$.session.send({ to: { agentId } })`), and teams. The spike mod is throwaway and is removed once the runtime lands.

Why: the plugin API does not say which of the three carries the floor reliably, and only a trial on the real surface can.

Supersedes: nothing.

Status: open. The spike's finding, and the mechanism it picks, is filled in by a later commit of this run.

### D6 Where an interviewing node runs

An interviewing node runs in a stage or on call, with several per stage allowed. It needs models. It has no categories and no collectors.

Why: it is a conversation, not a rubric, so it takes the placement of other nodes and none of the scoring machinery.

Supersedes: nothing.

### D7 No shipped loop uses the contract

No shipped loop uses the contract. The first user, a `program` loop at user level, is designed with the architect after the run.

Why: the contract should be proven by a real loop of a person's own before the plugin ships one.

Supersedes: nothing.

### D8 Commits and the loop spec

Commits follow `dacapo:rules-commits`. The loop spec in `skills/loop` stays host-agnostic prose.

Why: one commit style across runs, and a spec that does not depend on any host.

Supersedes: nothing.

## Superseded

The design replaces these:

- The design skill's "four contracts and no other" (D1).
- The rule that only the orchestrator talks to the user (D4).
