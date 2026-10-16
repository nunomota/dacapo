<p align="center">
  <img src="docs/banner.svg" alt="dacapo: from the top, again" width="720">
</p>

<p align="center">
  A Claude Code mod that turns a handed-over task into a build loop: clarify, research, plan, build in parallel, QA as the end user, repeat until it passes, merge.
</p>

---

**dacapo** is an orchestration plugin for [Claude Code](https://claude.com/claude-code). You hand it a task. The session clarifies it with you, researches the stack and splits the work. Worker subagents build the pieces in parallel, each in its own git worktree, and land them through GitHub pull requests into a run branch. A QA subagent then uses the result the way a user would, scores a rubric, and the loop runs again until it passes. A final pull request merges the run branch into `main`.

Everything in the mod is deterministic: it manages worktrees, branches and pull requests, validates reports, wakes the orchestrator, and draws the pane. No model is asked anything inside it. [How it works](docs/how-it-works.md) has the details.

<p align="center">
  <img src="docs/pane.png" alt="The dacapo pane: task header, phase bar, progress rows and the timeline" width="620">
</p>

## Install

You need [`gh`](https://cli.github.com), the GitHub CLI, installed and logged in (`gh auth login`), and a repository whose `origin` is on GitHub.

In a Claude Code session:

```
/plugin install dacapo --marketplace nunomota/dacapo
```

Answer `y` to add the marketplace and pick the user scope. The mod is active in that session and every later one.

## Update

```
claude plugin update dacapo
```

Then restart Claude Code. Your configuration is not touched: it lives outside the plugin (see below).

## Use

```
/dacapo:core [--build | --review | --consolidate] <what you want built>
```

The flag is the run's level, how far the work is judged before it merges. The levels nest, and the pane names the one in force:

- **build** lands the work: the run merges once every task has landed. No QA.
- **review** adds QA as the end user, until it passes. The default.
- **consolidate** adds an engineering review of the run's whole change after QA passes, so the codebase stays maintainable past this run.

Without a flag the run takes the level your configuration names, `review` unless you changed it.

The orchestrator then walks the phases of the level, and the pane shows which one it is in:

1. **Clarify.** It restates the task and asks about anything material until nothing is open.
2. **Research.** It picks a stack if none is fixed, reads the docs for the versions in use, notes the build and test commands, and finds the existing conventions each task must match.
3. **Plan.** It names the run, cuts a run branch from `main`, splits the work into independent tasks, and writes the QA rubric and harness (and, at `consolidate`, the engineering rubric) before any code exists.
4. **Implement.** One worker per task, in parallel. Each opens a draft pull request against the run branch, marks it ready when its build passes, waits for checks, and squash-merges with the planned title. A worker's task is done only when its pull request is merged.
5. **QA.** A fresh subagent uses the deliverable as the end user, attending to consistency across it, and scores every rubric item `strong`, `acceptable` or `unacceptable`. On any verdict below pass the loop goes back to step 4, with every item below `strong` becoming a task. The run merges only on pass. The one exception is a stuck loop, where the user may decide to merge with the limitation stated.
6. **Review** (at `consolidate`). Another subagent reads the run's change against `main` as an engineer and scores an engineering rubric: quality, consistency with the codebase, cleanup. Findings inside the run's change become fix tasks; findings beyond it are recommendations in the final report.
7. **Merge.** The orchestrator opens the final pull request into `main`, written to the `clean-prs` rules, and the mod merges it once its checks are green.

You can type while workers run. Your prompts become events in the timeline and are folded into the next round. `/dacapo-pane` reopens the pane.

## Configure

The plugin ships [`dacapo.conf`](dacapo.conf) with its defaults. It is replaced on every update, so do not edit it there: copy it and edit the copy. A later file overrides an earlier one, key by key.

| File | Scope |
| --- | --- |
| `dacapo.conf` inside the installed plugin | The defaults. |
| `~/.claude/dacapo.conf` | You, in every repository. |
| `.dacapo.conf` at a repository's root | That repository. dacapo keeps it out of git. |

The keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `level` | `review` | The level of a run whose prompt carries no flag. |
| `judges` | `sequential` | At `consolidate`: `sequential` runs the review after QA passes; `parallel` runs both side by side. |
| `workers` | `opus, sonnet` | The models a worker may be given, strongest first. The first is the strong tier and the default, the last the fast tier. |
| `qa` | `opus, sonnet` | The models QA may be given, likewise. |
| `review` | `opus, sonnet` | The models the reviewer may be given, likewise. |

Fable is listed in the shipped file, commented out; uncomment the lines in your copy to allow it. Lines starting with `#` are comments and lists are comma-separated. Agents never read these files: the orchestrator asks a tool for the values in force, so comments and commented-out lines never reach a model. `/dacapo-config` shows you the same values and the file each came from.

Model prices for the pane's cost estimate are a plugin option, not a conf key: `claude plugin configure dacapo`.

## Going further

**Judges in parallel.** At `consolidate`, set `judges = parallel` in your conf, or ask for it when you hand over the task, and QA and the engineering review run side by side. It is faster and spends more tokens: a review of a state QA then fails is wasted, since a QA verdict of `fix` always preempts the review, which runs again after the fixes.

**The loop outside this plugin.** The loop is specified apart from the mod that runs it, in the `dacapo:loop` skill (`/dacapo:loop` shows it): the roles, their boundaries, the levels, what a host must guarantee, the report contracts and the decision rules of each phase. Any orchestrator that can run agents and land their work its own way can follow it, [Conductor](https://www.conductor.build/) among them. The `dacapo:core` skill is this plugin's binding of the loop to its tools.

**The commit and pull request rules** workers follow are skills of their own, `/dacapo:clean-commits` and `/dacapo:clean-prs`, usable outside a run.

## Docs

- [How it works](docs/how-it-works.md): what the mod enforces, outcomes, the pane, the tools.
- [Developing dacapo](docs/development.md): validating, testing, layout, known limits.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## License

MIT
