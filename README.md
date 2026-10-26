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
  <a href="#loops">Loops</a> •
  <a href="#configure">Configure</a> •
  <a href="#going-further">Going further</a> •
  <a href="#docs">Docs</a>
</div>

---

**dacapo** is an orchestration plugin for [Claude Code](https://claude.com/claude-code). You hand it a task. The session clarifies it with you, researches the stack and splits the work. Worker subagents build the pieces in parallel, each in its own git worktree, and land them through GitHub pull requests into a run branch. A QA subagent then uses the result the way a user would, splitting the rubric among evidence collectors where the product can be shared, scores it, and the loop runs again until it passes. A final pull request merges the run branch into the base branch, `main` unless you configure another. The stages a run walks and the agents it starts are a [loop](#loops): plain files you can copy and redesign by talking to an architect.

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

<img src="docs/pane.png" alt="The dacapo pane: task header, stage bar, progress rows and the timeline">

</td>
</tr>
</table>

## Use

```
/dacapo:core [--loop <name>] <what you want built>
```

The flag names the loop the run walks: its stages, its agents and how far the work is judged before it merges. The plugin ships three, and the pane names the one in force:

- **core-fast** lands the work: the run merges once every task has landed. No judges.
- **core** adds QA as the end user, until it passes. The default.
- **core-deep** adds an engineering review of the run's whole change after QA passes, so the codebase stays maintainable past this run.

Without a flag the run takes the loop your configuration names, `core` unless you changed it. A loop of your own runs the same way, by its name. The old run-depth flags (`--fast`, `--balanced`, `--deep`) are gone: one after `/dacapo:core` is refused with a message naming the loops to choose from.

The `core` loop walks these stages in order. A verdict below pass from QA sends the run back to implement, and it merges only on pass. A final merge refused because the base branch moved or its checks fail goes back too, to reconcile, and QA runs again. `core-deep` adds a review stage between qa and merge, judged the same way; `core-fast` has no qa stage.

```
clarify ──▶ research ──▶ plan ──▶ implement ──▶ qa ──▶ merge
                                      ▲          │       │
                                      ├── fix ───┘       │
                                      └─── reconcile ────┘
```

[The stages](docs/how-it-works.md#the-stages) describes each one.

## Loops

A loop is a folder of plain files. Nothing about it lives only inside the plugin:

| File | What it holds |
| --- | --- |
| `loop.json` | The graph: steps of stages, the nodes each stage runs, the transitions between stages and the handovers between nodes. |
| `nodes/<id>.md` | One agent: a frontmatter (type, summary, contract, models, skills, denied tools) and its role as the body. |
| `loop.d2` | The diagram, as valid [D2](https://d2lang.com) that other D2 tools render. dacapo reads it back too, so a hand edit can be folded in. |
| `LOOP.md` | The loop as prose, generated on every save: each node's models and skills, and the stages the orchestrator works alone. |

Loops live at three levels. A level is where a loop lives: plugin, user or project. It has nothing to do with the `level` key or the `--level` flag that older versions had, which are gone. A name resolves project over user over plugin, so a loop of your own can hide a shipped one:

| Level | Folder | Seen by |
| --- | --- | --- |
| Project | `.claude/dacapo/loops/<name>/` at a repository's root | That repository. dacapo keeps it out of git. |
| User | `$DACAPO_HOME/loops/<name>/`, default `~/.claude/dacapo/loops/<name>/` | You, in every repository. |
| Plugin | `loops/<name>/` inside the installed plugin | Everyone. The three shipped loops, read-only and replaced on every update. |

**Design a loop.** `/dacapo:design` makes the session the loop's architect and opens the loop viewer beside it. The viewer shows the library of loops at the three levels, then one loop: its canvas of stages, nodes, transitions and handovers, and a focus panel for whatever you press, with phrases to try. It only shows. You change a loop by saying what you want: "new loop docs-only at project level from core", "add a stage security alongside qa", "let workers use fable", "move qa after review", "delete the qa stage", "make docs-only the default". The architect reads each request into fixed operations on a draft, shows the change in the viewer and asks before anything destructive. An operation that would break the loop is refused with the rule it breaks. Moving a stage alongside another rewires the transitions between them, and a refusal names the fix. The architect's tools take an optional `name` and `level` to say which loop; left out, they act on the loop the viewer has open, which it remembers per home and repository. A shipped loop is read-only: copy it into a new loop and change the copy.

Nothing reaches a loop's files until you press Save in the viewer or say "save"; Discard drops the draft. A draft lives under `$DACAPO_HOME/drafts/`, default `~/.claude/dacapo/drafts/`, and survives sessions: open the loop again tomorrow and the draft is still there. `/dacapo-loops` reopens the viewer.

**Making a loop the default.** "Make docs-only the default" writes `loop = docs-only` to your user conf for a plugin or user loop, and to the repository's `.dacapo.conf` for a project loop. Deleting the loop the conf names rewrites that line to `loop = core`.

**Editing the diagram by hand.** dacapo tells a hand edit by comparing `loop.d2` with the loop's other files, not by file time. Opening a loop whose diagram differs says `loop.d2 was edited by hand since the last save; say “import the diagram” to fold it in`.

**Run a loop of your own** with `/dacapo:core --loop <name> <task>`, or set `loop = <name>` in your configuration to make it the default. The agents of every loop at the three levels register when a session starts, so `--loop <name>` works for any loop that existed then. A loop saved or changed mid-session runs in the next session, and `start` says so when its agents are missing. If two loops define the same node id with a different role, the loop that wins resolution for that name registers its version. `--loop` on the other refuses and asks for a new session with `loop = <name>` in the conf.

**Other orchestrators** read `LOOP.md`: the roles, the order of the stages, the transitions with their conditions and the handovers with their specs, in prose. Edit a loop through the architect, never `LOOP.md` itself: the next save writes it again.

## Configure

The plugin ships [`dacapo.conf`](dacapo.conf) with its defaults. It is replaced on every update, so do not edit it there: copy it and edit the copy. A later file overrides an earlier one, key by key.

| File | Scope |
| --- | --- |
| `dacapo.conf` inside the installed plugin | The defaults. |
| `$DACAPO_HOME/dacapo.conf`, default `~/.claude/dacapo.conf` | You, in every repository. |
| `.dacapo.conf` at a repository's root | That repository. dacapo keeps it out of git. |

The keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `loop` | `core` | The loop a run walks when its prompt carries no `--loop` flag: `core-fast`, `core`, `core-deep` or one of your own. |
| `workers` | `opus, sonnet` | The models for workers, strongest first. With `qa` and `review` they make the models a loop's nodes may name: each node lists its own, and one naming a model outside the three lists is refused when the run starts. |
| `qa` | `opus, sonnet` | The models for QA, likewise. |
| `review` | `opus, sonnet` | The models for the reviewer, likewise. |
| `qa-collectors` | `3` | How many evidence collectors a judge may run at once when its node sets no `collectors` of its own; `0` keeps it on its own. The shipped QA node sets 3, so this applies to a judge of your own. |
| `commits-skill` | `dacapo:rules-commits` | The skill workers load for how to commit: titles, staging, what never to run. |
| `prs-skill` | `dacapo:rules-prs` | The skill workers and the final pull request follow for the title and body. |
| `base-branch` | `main` | The branch a run is cut from and merged into, when you do not name another at hand-over. |

Point `commits-skill` or `prs-skill` at a skill of your own, `my-rules` or `other-plugin:rules`, to have workers follow your conventions; the leading slash is optional. With the shipped skills dacapo also checks commit titles and refuses attribution lines in the final pull request; with any other skill it trusts the skill. Fable is listed in the shipped file, commented out; uncomment the lines in your copy to allow it. Lines starting with `#` are comments and lists are comma-separated. Agents never read these files: the orchestrator asks a tool for the values in force, so comments and commented-out lines never reach a model. `/dacapo-config` shows you the same values, the file each came from and the loop a run walks.

Model prices for the pane's cost estimate are a plugin option, not a conf key: `claude plugin configure dacapo`.

## Going further

**Both judges in one step.** In `core-deep` the review runs after QA passes. To run them side by side, ask the architect for a loop that puts both stages in one step: `/dacapo:design`, then "new loop deep-parallel at user level from core-deep" and "run review alongside qa". Judges whose stages share a step run at once. It is faster and spends more tokens: a review of a state QA then fails is wasted, since a QA verdict of `fix` stops the review running beside it, which runs again after the fixes. Run it with `/dacapo:core --loop deep-parallel <task>`.

**The loop outside this plugin.** The loop is specified apart from the mod that runs it, in the `dacapo:loop` skill (`/dacapo:loop` shows it): the roles, their boundaries, the variants, what a host must guarantee, the report contracts and the decision rules from clarify to merge. Each loop's `LOOP.md` adds its own roles, order, transitions and handovers in prose. Any orchestrator that can run agents and land their work its own way can follow them, [Conductor](https://www.conductor.build/) among them. The `dacapo:core` skill is this plugin's binding of the loop to its tools.

**The commit and pull request rules** workers follow are skills of their own, `/dacapo:rules-commits` and `/dacapo:rules-prs`, usable outside a run and replaceable through the `commits-skill` and `prs-skill` keys.

## Docs

- [How it works](docs/how-it-works.md): the stages, what the mod enforces, outcomes, the pane, loops, the tools.
- [Developing dacapo](docs/development.md): validating, testing, layout, known limits.
- [The loops design](docs/decisions/2026-10-26-loops.md): the decisions behind loops, the viewer and the architect, with their reasons and what each replaced.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit).

## License

MIT
