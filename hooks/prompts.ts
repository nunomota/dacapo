/**
 * What the host adds to the role of every `lands` node: how the work lands through a pull request, and the report
 * whose last line says how it went.
 */
export const LANDS_SUFFIX = `Landing the work, in this order:
1. After your first commit, push the branch (\`git push -u origin <branch>\`) and open a draft pull request against the base branch: \`gh pr create --draft --base <base> --head <branch> --title "<title>" --body "<body>"\`, the body written to the pull request rules skill. Keep pushing as you commit.
2. When the build and tests pass and nothing is uncommitted, bring the body up to date if the work changed (\`gh pr edit --body\`) and mark the pull request ready: \`gh pr ready\`.
3. Conflicts: if GitHub reports the pull request as conflicting, or a merge is refused because the branch is behind, run \`git fetch origin\` then \`git rebase origin/<base>\`, resolve the conflicts, rebuild, and \`git push --force-with-lease\`. Rebasing and force-pushing your own branch is allowed for this and nothing else.
4. Checks: run \`gh pr checks --watch\` until they finish. "no checks reported" counts as passing. For a failing check read its log (\`gh run view <run id> --log-failed\`), fix the cause in a clean commit, push, and watch again. At most three fix rounds: after the third failure stop, leave the pull request open, and finish with status failed, naming the failing check and the last error.
5. Merge: \`gh pr merge <number> --squash --subject "<title>" --body ""\` (with \`--merge\` instead of \`--squash\` when the brief says the merge method is merge). Never use \`--admin\`. Confirm with \`gh pr view <number> --json state\` that the state is MERGED; if the merge was refused, say exactly why.
6. Only then report finished.

Your final message is read by the orchestrator. Give it these headings with short content under each: "Done", "Pull request" (number, URL, merged or not), "Build and tests", "Open issues". Its very last line is one of exactly these three, alone on the line: \`dacapo: done\` (merged, nothing left out), \`dacapo: done with limitations\` (merged, but something was deliberately left out, does not work, or needs a follow-up), or \`dacapo: failed\` (not merged).`

/**
 * What the host adds to the role of every `scores` node: the score words, the report's JSON shape and path, and
 * stopping what it started. `categories` are the rubric categories the node accepts.
 */
export function SCORES_SUFFIX(categories: readonly string[]): string {
  return `Your report:
1. Read the brief and \`.context/rubric.json\` your prompt names. The brief says what to judge and where your report goes; the rubric lists every item you must score, each in one of the categories ${categories.join(', ')}.
2. Score every rubric item with exactly one of: "strong" (clearly met), "acceptable" (technically passes, improvements recommended), "unacceptable" (fails, must be fixed). Keep notes concrete: what you did, what you saw and where (a file and line when you read code), what you expected.
3. Write the report to the exact path the brief names, as JSON:
   {"items": [{"id": "<rubric id>", "score": "strong|acceptable|unacceptable", "note": "<one to three sentences>"}, ...], "overview": "<free text>"}
   Every rubric id appears once. The "overview" is read by the orchestrator: say what works, what does not and what to fix first, then, apart, what you would recommend beyond it. Be specific and objective.
4. Stop any process you started, and any a helper of yours left behind.

Only the report file is read. Your final message can be one line.`
}

/** What the host adds to the role of every `collects` node: the headings of its report to the judge and its last line. */
export const COLLECTS_SUFFIX = `Your final message is read by QA. Give it these headings: one section per rubric id in your slice, each with what you did, what you saw, what you expected and the evidence paths; "Not covered" (what in your slice you could not exercise and why, or "nothing"); "Outside the slice" (what QA should look at beyond your items, briefly). Its very last line is one of exactly these three, alone on the line: \`dacapo: collected\` (every item of the slice exercised), \`dacapo: collected with gaps\` (something under "Not covered"), or \`dacapo: failed\` (nothing usable was gathered).`

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
  /** The skills the worker loads for its commits and its pull request, as the Skill tool names them. */
  rules: { commits: string; prs: string }
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
    `- Commit rules: the \`${args.rules.commits}\` skill. Load it with the Skill tool before your first commit and follow it.`,
    `- Pull request rules: the \`${args.rules.prs}\` skill. Load it with the Skill tool before opening the pull request and follow it for the title and body.`,
  ]
  if (args.extras.length > 0) {
    lines.push('', '## Extra material in .context/', '', ...args.extras.map(name => `- \`.context/${name}\``))
  }
  return `${lines.join('\n')}\n`
}

/**
 * The brief of a judge that uses the product as its end user: `node` names the judge, `collector` the agent type of the
 * collects node it may start (absent when it hands over to none), `collectors` how many may run at once.
 */
export function qaBrief(args: { node: string; task: string; harness: string; brief: string; reportPath: string; worktree: string; collector?: string; collectors: number }): string {
  const helper = args.collector ?? 'collector'
  return [
    `# Brief for ${args.node}, the judge`,
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
    '## Collecting evidence in parallel',
    '',
    ...(args.collector && args.collectors > 0
      ? [
          `- Up to ${args.collectors} \`${helper}\` agent${args.collectors === 1 ? '' : 's'} may run at once. Start one with the Agent tool: \`subagent_type: "${helper}"\`, a short \`description\` of its slice, and a \`prompt\` naming the rubric ids of the slice, the instance, pages, accounts, windows or ports that are its own, and what is shared. The run adds the worktree and the standing instructions; a collector sees this brief and the rubric, never the source, writes only under \`${args.worktree}/.context/evidence/\`, and never scores.`,
          '- The harness above says how several testers share the product with the least setup (one running instance through separate pages, accounts or windows; or a second instance) and what cannot be shared. Give each collector its own share; walk yourself what cannot be split.',
          "- Every score and the report are yours. Read each collector's final message, verify what surprises you, then score.",
          '- Collectors run in the foreground: start a batch in one message and each Agent call answers with its collector\'s report. A batch takes as long as its slowest collector.',
          '- A collector\'s report ends with `dacapo: collected`, `dacapo: collected with gaps` or `dacapo: failed`. A collector that failed, ended in error or never reported: start one again on the same slice, once. Gaps it names under "Not covered", and anything still untested after a second failure: walk yourself, and say so in the note. No item is scored on evidence nobody gathered; no id is left unscored.',
        ]
      : [args.collector ? '- Collectors are off for this judge (its cap is 0): collect every piece of evidence yourself.' : '- No collector works for you in this loop: collect every piece of evidence yourself.']),
    '',
    '## Scores',
    '',
    '- strong: the item was clearly met.',
    '- acceptable: the item technically passed, but improvements are recommended.',
    '- unacceptable: the item failed and needs to be fixed.',
    '',
  ].join('\n')
}

/** The brief of a judge that reads the run's change: `node` names the judge. */
export function reviewBrief(args: { node: string; task: string; base: string; brief: string; reportPath: string; worktree: string }): string {
  return [
    `# Brief for ${args.node}, the judge`,
    '',
    '## What the run set out to build',
    '',
    args.task.trim(),
    '',
    args.brief.trim() ? `${args.brief.trim()}\n` : '',
    '## The change to review',
    '',
    `- Working directory (a clean checkout of the run branch): \`${args.worktree}\``,
    `- Base branch the run merges into: \`${args.base}\``,
    `- The run's change: \`git diff origin/${args.base}...HEAD\` (or \`git diff ${args.base}...HEAD\` when origin/${args.base} is absent); \`git log origin/${args.base}..HEAD\` lists its commits.`,
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

/**
 * What the host adds to the role of every `interviews` node: it holds the floor, asks one thing at a time, confirms the
 * conversation is complete, writes its report in the format its role defines, and ends on a line that says how it went.
 */
export const INTERVIEWS_SUFFIX = `Talking to the user:
1. You talk to the user directly: the program hands you the floor, and what the user types reaches you as your next user message.
2. Read \`.context/consult-brief.md\` first and the earlier reports under \`.context/reports/\`; that is all you know of the run.
3. Ask one thing at a time and end your turn after each question. The program may tell you to hand back while you wait; hand back a one-line note (for example \`waiting for the user\`), never your working text or a partial report. The user's answer resumes you.
4. When nothing is open, confirm with the user that the conversation is complete, then write your report to the path the brief names, in the format your role defines (the program dictates no headings).
5. Never edit the repository, never start agents.

Your final message ends with exactly one of these two lines, alone on the line: \`dacapo: reported\` (the report is written and nothing is left open) or \`dacapo: reported with open questions\` (the report is written and names what is still open).`

/** The brief of one interview: the run's task, the orchestrator's scope note, where earlier reports sit, where the report goes and how to end. */
export function consultBrief(args: { node: string; task: string; scope?: string; reportPath: string; reportsDir: string; n: number }): string {
  return [
    `# Interview ${args.n}: ${args.node}`,
    '',
    `- Task of the run: ${args.task.trim()}`,
    `- Scope from the orchestrator: ${args.scope?.trim() || 'none given'}`,
    `- Earlier reports of the run: \`${args.reportsDir}\` (read every file there first; it may be empty)`,
    `- Your report: \`${args.reportPath}\`, in the format your role defines`,
    '',
    "What reaches you as 'The user says:' is the person's own words, not the orchestrator's.",
    '',
    'When the user has confirmed the conversation is complete and the report is written, end your final message with exactly one of these lines, alone on the line: `dacapo: reported` or `dacapo: reported with open questions`.',
  ].join('\n')
}
