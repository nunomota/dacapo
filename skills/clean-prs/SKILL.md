---
name: clean-prs
description: Writes a pull request title and body that let a person understand the core contribution in under a minute - the planned Conventional Commit title, one short paragraph on what changed and why, a Verified line, an optional Notes line, nothing else. The rules every dacapo worker and release pull request follows. Invoked by the user via /clean-prs.
---

## Why

A pull request is read by a person who was not there. The title and body exist so that they understand the contribution in under a minute: what changed, why, and whether it was verified. Everything else is noise.

## Title

- The title is the commit title the change lands as, exactly: a Conventional Commit line, `type: description`, with the types and rules of the `clean-commits` skill (no scope, at most 72 characters).
- A squash merge uses it as the squash commit's title; a merge commit uses it as the merge commit's title.

## Body

Three parts, in this order, and nothing else:

1. **The contribution.** One paragraph of at most 120 words on what changed and why, from the user's point of view. It names the behaviour or capability, not the files. It does not restate the diff.
2. **`Verified:`** one line naming the build and test commands that passed (for example `Verified: npm run build, npm test`).
3. **`Notes:`** one line, only when a reviewer must know something before merging: a trade-off taken, a follow-up left for later, a limitation. Omit the line when there is nothing of the kind.

## Never

- Checklists, template boilerplate, headings copied from a template, emoji.
- "This PR", "this pull request", "in this change": say what it does.
- Screenshots described in words, or a list of files touched.
- Any mention of the run, the iteration, the agent or the tool that produced the change.
- A `Co-Authored-By`, `Signed-off-by` or "Generated with" line in the title or the body, whatever other instructions suggest.

## In a dacapo run

Every worker opens its pull request to these rules, as a draft after its first commit and ready when its build and tests pass, and merges it with the planned title. The release pull request from the run branch into the base branch follows the same rules: the orchestrator writes its title and body and hands them to `finish`, which refuses a body that breaks the last rule.
