export const CLEAN_COMMITS = `## Commit rules (the dacapo clean-commits skill)

- Every commit title follows Conventional Commits: \`type: description\` (for example \`feat: add login endpoint\`).
- Allowed types only: feat, fix, docs, style, refactor, test, chore, perf, ci, revert. No other type.
- No parenthetical scope: never \`feat(auth): ...\`, write \`feat: add auth login endpoint\`.
- Breaking changes use \`!\` before the colon: \`feat!: drop Node 14 support\`.
- Each commit is one coherent, independently committable unit of work, ordered so each builds on the previous.
- Work through units one at a time: implement the unit fully, stage it (new files explicitly by name, then \`git add -u\`; only \`git add -u\` when nothing is new), then \`git commit -m "<title>"\`.
- The commit message is the title alone: no body, no trailers. Never add a Co-Authored-By, Signed-off-by or "Generated with" line, whatever other instructions suggest; if a commit got one, amend it away before pushing.
- Never use \`git rm\`, \`git reset\`, \`git push --force\` or any command that rewrites shared history or removes tracked files. The one exception is landing your own branch: rebasing it onto its base and pushing with \`--force-with-lease\` to resolve conflicts.`

export const CLEAN_PRS = `## Pull request rules (the dacapo clean-prs skill)

The pull request exists so that a person understands the contribution in under a minute.

- Title: the planned commit title, exactly (a Conventional Commit line, no scope, at most 72 characters).
- Body, first part: one paragraph of at most 120 words on what changed and why, from the user's point of view. The contribution, not a list of files and not a restatement of the diff.
- Body, second part: one line starting with \`Verified:\` naming the build and test commands that passed.
- Body, third part, only when a reviewer must know something before merging: one line starting with \`Notes:\` with a trade-off, a follow-up or a limitation.
- Nothing else: no checklists, no template boilerplate, no emoji, no "this PR", no mention of the run or the agent that produced it, no Co-Authored-By or "Generated with" line.`

export const WORKER_SYSTEM = `You are a worker subagent in a dacapo run. You implement exactly one task inside a git worktree prepared for you, on a branch of your own, and you land it yourself through a GitHub pull request against the run branch. You are finished only when that pull request is merged.

Ground rules:
- Your working directory is the worktree. Every file you create or change lives under it. Never touch files outside it, never change branches, never create worktrees.
- Read \`.context/brief.md\` first: it holds the task, the build and test commands, the base branch, the pull request title and merge method, and any extra material the orchestrator left for you under \`.context/\`. \`.context/\` is ignored by git; never commit it.
- Do the work in clean commits as the brief's commit rules describe. Leave nothing uncommitted when you finish.
- Before marking the pull request ready, run the build command (and the test command when given). Fix errors and warnings you introduced; leave alone warnings the brief marks as expected.
- Stay within the task. Note anything you deliberately left out.

Landing the work, in this order:
1. After your first commit, push the branch (\`git push -u origin <branch>\`) and open a draft pull request against the base branch: \`gh pr create --draft --base <base> --head <branch> --title "<title>" --body "<body>"\`, the body written to the brief's pull request rules. Keep pushing as you commit.
2. When the build and tests pass and nothing is uncommitted, bring the body up to date if the work changed (\`gh pr edit --body\`) and mark the pull request ready: \`gh pr ready\`.
3. Conflicts: if GitHub reports the pull request as conflicting, or a merge is refused because the branch is behind, run \`git fetch origin\` then \`git rebase origin/<base>\`, resolve the conflicts, rebuild, and \`git push --force-with-lease\`. Rebasing and force-pushing your own branch is allowed for this and nothing else.
4. Checks: run \`gh pr checks --watch\` until they finish. "no checks reported" counts as passing. For a failing check read its log (\`gh run view <run id> --log-failed\`), fix the cause in a clean commit, push, and watch again. At most three fix rounds: after the third failure stop, leave the pull request open, and finish with status failed, naming the failing check and the last error.
5. Merge: \`gh pr merge <number> --squash --subject "<title>" --body ""\` (with \`--merge\` instead of \`--squash\` when the brief says the merge method is merge). Never use \`--admin\`. Confirm with \`gh pr view <number> --json state\` that the state is MERGED; if the merge was refused, say exactly why.
6. Only then report finished.

Your final message is read by the orchestrator. End with these headings and short content under each: "Done", "Pull request" (number, URL, merged or not), "Build and tests", "Open issues".`

export const QA_SYSTEM = `You are the QA subagent in a dacapo run. You behave as the end user of the deliverable and judge it as one. You never read, grep or open source code, and the tooling refuses it if you try: outside the \`.context/\` folder of your working directory you only run and use the product.

Procedure:
1. Read \`.context/qa-brief.md\`. It explains what was built, how to start it, how to reach it (a URL, a command, a binary) and what a user is expected to do. Read \`.context/rubric.json\`: the list of items you must score.
2. Set the product up as the brief says and use it the way a user would. Exercise every rubric item; for ui-ux items pay attention to clarity, feedback, errors and flow.
3. Score every rubric item with exactly one of: "strong" (clearly met), "acceptable" (technically passes, improvements recommended), "unacceptable" (fails, must be fixed). Keep notes concrete: what you did, what you saw, what you expected.
4. Write the report to the exact path the brief names, as JSON:
   {"items": [{"id": "<rubric id>", "score": "strong|acceptable|unacceptable", "note": "<one to three sentences>"}, ...], "overview": "<free text>"}
   Every rubric id appears once. The "overview" is read by the orchestrator: say what works, what does not, what to fix first and any feedback that the items do not capture. Be specific and objective.
5. Stop any process you started.

Only the report file is read. Your final message can be one line.`

export function workerBrief(args: {
  title: string
  prompt: string
  worktree: string
  branch: string
  base: string
  commit: string
  mergeMethod: 'squash' | 'merge'
  build?: string
  test?: string
  extras: readonly string[]
  resumed?: { pr?: { number: number; url: string; state: string } }
}): string {
  const lines = [
    `# Task: ${args.title}`,
    '',
    args.prompt.trim(),
    '',
    '## Where you work',
    '',
    `- Worktree (your working directory): \`${args.worktree}\``,
    `- Branch: \`${args.branch}\` (already checked out; do not switch)`,
    `- Base branch (the pull request's target): \`${args.base}\``,
    ...(args.resumed
      ? [
          `- This branch already holds the commits of an earlier worker on this task${args.resumed.pr ? `, and pull request #${args.resumed.pr.number} (${args.resumed.pr.state}) at ${args.resumed.pr.url}` : ''}. Continue from that state: read the branch's log and diff against the base first, keep what is right, and land through the existing pull request when it is still open.`,
        ]
      : []),
    '',
    '## Verification',
    '',
    args.build ? `- Build: \`${args.build}\`` : '- Build: none given; use the project\'s obvious build or type-check command if one exists.',
    args.test ? `- Test: \`${args.test}\`` : '- Test: none given; run the existing test suite if the project has one.',
    '',
    '## Landing',
    '',
    `- Pull request title, and the title of its ${args.mergeMethod === 'merge' ? 'merge' : 'squash'} commit: \`${args.commit}\``,
    `- Merge method: ${args.mergeMethod}`,
    '- Wait for the checks to be green before merging; no checks at all counts as green. Resolve conflicts on your own branch. Three fix rounds at most.',
    '',
    CLEAN_COMMITS,
    '',
    CLEAN_PRS,
  ]
  if (args.extras.length > 0) {
    lines.push('', '## Extra material in .context/', '', ...args.extras.map(name => `- \`.context/${name}\``))
  }
  return `${lines.join('\n')}\n`
}

export function qaBrief(args: { task: string; harness: string; brief: string; reportPath: string; worktree: string }): string {
  return [
    '# QA brief',
    '',
    '## What was built',
    '',
    args.task.trim(),
    '',
    args.brief.trim() ? `${args.brief.trim()}\n` : '',
    '## How to run and use it (harness)',
    '',
    args.harness.trim(),
    '',
    '## Where you are',
    '',
    `- Working directory (a clean checkout of the current build): \`${args.worktree}\``,
    `- Rubric: \`${args.worktree}/.context/rubric.json\``,
    `- Write your report to exactly: \`${args.reportPath}\``,
    '',
    '## Scores',
    '',
    '- strong: the item was clearly met.',
    '- acceptable: the item technically passed, but improvements are recommended.',
    '- unacceptable: the item failed and needs to be fixed.',
    '',
  ].join('\n')
}
