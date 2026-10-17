<div align="center">
  <img src="docs/banner.svg" alt="dacapo: from the top, again" width="720">
  <br /><br />
  <p><em>A Claude Code mod that turns a handed-over task into a build loop: clarify, research, plan, build in parallel, QA as the end user, repeat until it passes, merge.</em></p>
  <a href="https://github.com/nunomota/dacapo/blob/main/.claude-plugin/plugin.json"><img alt="version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnunomota%2Fdacapo%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue" /></a>
  <a href="https://claude.com/claude-code"><img alt="platform" src="https://img.shields.io/badge/platform-Claude%20Code%20plugin-D85A30" /></a>
  <a href="https://cli.github.com"><img alt="requires" src="https://img.shields.io/badge/requires-GitHub%20CLI-brightgreen" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green" /></a>
  <br /><br />
  <a href="#install">Install</a> •
  <a href="#use">Use</a> •
  <a href="#configure">Configure</a> •
  <a href="#going-further">Going further</a> •
  <a href="#docs">Docs</a>
</div>

---

**dacapo** is an orchestration plugin for [Claude Code](https://claude.com/claude-code). You hand it a task. The session clarifies it with you, researches the stack and splits the work. Worker subagents build the pieces in parallel, each in its own git worktree, and land them through GitHub pull requests into a run branch. A QA subagent then uses the result the way a user would, scores a rubric, and the loop runs again until it passes. A final pull request merges the run branch into `main`.

Everything in the mod is deterministic: it manages worktrees, branches and pull requests, validates reports, wakes the orchestrator, and draws the pane. No model is asked anything inside it. [How it works](docs/how-it-works.md) has the details.

<table>
<tr>
<td width="66%" valign="top">

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

</td>
<td width="34%" valign="top">

<img src="docs/pane.png" alt="The dacapo pane: task header, phase bar, progress rows and the timeline">

</td>
</tr>
</table>

## Use

```
/dacapo:core [--fast | --balanced | --deep] <what you want built>
```

The flag is the run's level, how far the work is judged before it merges. The levels nest, and the pane names the one in force:

- **fast** lands the work: the run merges once every task has landed. No QA.
- **balanced** adds QA as the end user, until it passes. The default.
- **deep** adds an engineering review of the run's whole change after QA passes, so the codebase stays maintainable past this run.

Without a flag the run takes the level your configuration names, `balanced` unless you changed it.

A run then walks these phases in order, as far as its level goes. A verdict below pass from QA or the review sends it back to implement, and it merges only on pass:

```
clarify ──▶ research ──▶ plan ──▶ implement ──▶ qa ──▶ review ──▶ merge
                                      ▲          │         │
                                      └── fix ───┴─────────┘
```

[The phases](docs/how-it-works.md#the-phases) describes each one.

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
| `level` | `balanced` | The level of a run whose prompt carries no flag. |
| `judges` | `sequential` | At `deep`: `sequential` runs the review after QA passes; `parallel` runs both side by side. |
| `workers` | `opus, sonnet` | The models a worker may be given, strongest first. The first is the strong tier and the default, the last the fast tier. |
| `qa` | `opus, sonnet` | The models QA may be given, likewise. |
| `review` | `opus, sonnet` | The models the reviewer may be given, likewise. |
| `commits-skill` | `dacapo:rules-commits` | The skill workers load for how to commit: titles, staging, what never to run. |
| `prs-skill` | `dacapo:rules-prs` | The skill workers and the final pull request follow for the title and body. |

Point `commits-skill` or `prs-skill` at a skill of your own, `my-rules` or `other-plugin:rules`, to have workers follow your conventions; the leading slash is optional. With the shipped skills dacapo also checks commit titles and refuses attribution lines in the final pull request; with any other skill it trusts the skill. Fable is listed in the shipped file, commented out; uncomment the lines in your copy to allow it. Lines starting with `#` are comments and lists are comma-separated. Agents never read these files: the orchestrator asks a tool for the values in force, so comments and commented-out lines never reach a model. `/dacapo-config` shows you the same values and the file each came from.

Model prices for the pane's cost estimate are a plugin option, not a conf key: `claude plugin configure dacapo`.

## Going further

**Judges in parallel.** At `deep`, set `judges = parallel` in your conf, or ask for it when you hand over the task, and QA and the engineering review run side by side. It is faster and spends more tokens: a review of a state QA then fails is wasted, since a QA verdict of `fix` always preempts the review, which runs again after the fixes.

**The loop outside this plugin.** The loop is specified apart from the mod that runs it, in the `dacapo:loop` skill (`/dacapo:loop` shows it): the roles, their boundaries, the levels, what a host must guarantee, the report contracts and the decision rules of each phase. Any orchestrator that can run agents and land their work its own way can follow it, [Conductor](https://www.conductor.build/) among them. The `dacapo:core` skill is this plugin's binding of the loop to its tools.

**The commit and pull request rules** workers follow are skills of their own, `/dacapo:rules-commits` and `/dacapo:rules-prs`, usable outside a run and replaceable through the `commits-skill` and `prs-skill` keys.

## Docs

- [How it works](docs/how-it-works.md): the phases, what the mod enforces, outcomes, the pane, the tools.
- [Developing dacapo](docs/development.md): validating, testing, layout, known limits.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## License

MIT
