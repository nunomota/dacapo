# Developing dacapo

```
claude plugin validate .
claude plugin test .
```

Mods are built on function hooks (`hooks/register.tsx`), an early-access Claude Code API; it may change between releases. Pull request state comes from one `gh pr list` call every 20 seconds on the mod's timer. Cost estimates use Anthropic list prices per model; override them with the plugin's `prices` option (`claude plugin configure dacapo`).

## Layout

| Path | What it holds |
| --- | --- |
| `skills/loop/SKILL.md` | The loop's specification: roles, levels, boundaries, host guarantees, report contracts, decision rules. Host-agnostic. |
| `skills/core/SKILL.md` | How this plugin runs the loop: its tools, subagents, worktrees, pull requests and wake-ups. |
| `skills/rules-commits`, `skills/rules-prs` | The commit and pull request rules workers follow by default; `commits-skill` and `prs-skill` in the configuration can name others. |
| `hooks/register.tsx` | The mod: tools, agents, guards, the ticker, the run's state. |
| `hooks/pane.tsx` | The pane and the band above the prompt. |
| `hooks/prompts.ts` | The system prompts of the worker, QA, QA collector and reviewer subagents, and the brief builders. |
| `hooks/conf.ts` | Reading and merging `dacapo.conf` files. |
| `hooks/report.ts` | Rubric and report validation, verdicts. |
| `dacapo.conf` | The shipped defaults; the keys users copy and edit. |
| `types/index.d.ts` | The run's state types. |
| `tests/dacapo.test.ts` | The test suite, run with `claude plugin test .`. |

## Known limits

- The QA agent and its collectors keep a shell so they can run the deliverable, so reading source through a shell command is forbidden by their prompts rather than by the tooling.
- QA must stay on its turn while its collectors run: a collector is a background subagent of QA's, and a QA turn that ends is the round ending, collected without a report. The prompts say so; the tooling cannot hold the turn open.
- Branch protection that requires reviews stops a worker's merge and the final merge; the orchestrator is told, and merging on GitHub by hand finishes the run.
- The timeline lives for the session; it is not kept across restarts.
- The configuration is read when a session starts, when a `/dacapo:core` prompt opens a run and when `/dacapo-config` runs; a file edited mid-run applies to the next run.
