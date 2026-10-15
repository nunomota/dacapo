---
name: dacapo
description: Runs a handed-over task as an orchestrated loop - clarify, research, plan, dispatch parallel worker subagents in git worktrees that land their work through GitHub pull requests into a run branch, end-user QA with a scored rubric, iterate, then release the run branch into main through a pull request. Invoked by the user via /dacapo <task>.
---

# dacapo

Before doing anything else, load the two parts of this skill with the Skill tool, in this order: first `dacapo:dacapo-core`, then `dacapo:dacapo-claude`.

The task is everything after `/dacapo` in the prompt that invoked this skill.

With both loaded, begin phase 1 of the core, with the binding at hand.
