# handover-spike

A throwaway mod (decision D5 of the interviews contract) that tries three ways to hand the chat to a subagent and get it back:

1. **The agent view.** `$.ui.view({ agentId })` shows the agent's transcript in the main view, so the next Enter goes to that agent. The types say it works only while the call answers the person's own input. Otherwise its result carries `deny`.
2. **Routing in the mod.** A `prompt.submit` hook forwards what you type to the agent with `$.session.send({ to: { agentId } })` and drops the prompt. A `turn.complete` hook appends the agent's answer as an `[interviewer]` row.
3. **Teams.** Start the interviewer as a teammate.

Delete the folder once the interviews runtime lands.

## What the types and the tests settle already

- `$.agent.spawn` runs in the background on its own. The tests show the call reaching the engine as an Agent call with `run_in_background: true`. Its arguments are `prompt`, `description`, `subagentType`, `model`, `name` and `cwd`: there is no `background` and no team field.
- **A mod cannot ask for a teammate.** `isTeammate` is pinned by the engine, and a mod's `$.tool.call({ tool: 'Agent' })` is refused with `runs the Agent tool: that is $.agent.spawn (host check)`. The one thing left to try is `name`: `/spike-team` spawns a named interviewer and reports whether the session made it a teammate (the spawn's `teammateId`, or `isTeammate` in `$.agent.list()`). If it says "not a teammate", that is the answer for mechanism 3.
- Under the test kit, `$.agent.spawn` returns no `agentId`, because only the engine sets it. `/spike-start` then takes the id from `$.agent.list()` by the spawn's description and logs `(id from $.agent.list)`. In a real session, check whether that suffix shows up.
- `prompt.submit` forwards only text typed in the composer (`origin.kind === 'composer'`) that does not start with `/`.

## Loading it

Terminal (confirmed in the plugin-authoring reference):

```sh
claude --plugin-dir spike/handover
```

Desktop app:
- Confirmed in the reference: set `CLAUDE_CODE_PLUGIN_DIRS` to the absolute path of `spike/handover` in the `env` block of `~/.claude/settings.json`, then start a new session. It loads the folder the same way `--plugin-dir` does.
- To try: the app's own plugin-dir setting, if it has one.
- To try: copy the folder to `~/.claude/dev-mods/<session>/handover-spike/`. The repository docs and the types do not confirm this path.

Check that it loaded: `/spike-status` should answer `floor: none`.

## Script: desktop app

1. Run `/spike-start`. Read the toast and the command's text (`spike-start: view <id> → shown`, or `→ deny: <reason>`). That is mechanism 1, called from inside a command handler.
2. Note whether the main view switched to the interviewer's transcript and whether its greeting shows. The band above the prompt should read `handover spike · floor: <id> · last: …`.
3. Run `/spike-view`. Read the toast.
4. If the agent view is showing, type an answer to the first question. Did it reach the agent? Its reply would show in the agent view, or as an `[interviewer]` row plus a toast.
5. Run `/spike-main` to return to the main view.
6. Type an answer to the next question (mechanism 2). The prompt should be dropped with `→ interviewer (<id>)`. Watch for an `[interviewer]` row and a toast with its first line.
7. Answer with `/spike-send <your answer>` and compare it with step 6.
8. When the agent finishes (its last line is `spike: reported`), watch for the `floor returned` toast, the band going away, and `spike-report.md` in the working directory.
9. Run `/spike-team`, then answer the teammate's questions the same way (steps 4 to 7). Use `/spike-back` to clear the floor early.
10. Run `/spike-status` and copy the log (each view, each send, each `turn.complete` reason) and the agent's status into the table.

## Script: terminal

Same steps as the desktop app, starting with `claude --plugin-dir spike/handover`. In step 2, look for the agent's transcript in place of the main conversation (the same switch the tasks list makes). In step 4, check whether Enter goes to the agent or to the main conversation.

## Findings to paste back

| Surface | Mechanism | Typing reached the agent? | Where its reply showed | How its end was observed | Deny texts seen |
|---|---|---|---|---|---|
| desktop | 1 view from /spike-start | | | | |
| desktop | 1 view from /spike-view | | | | |
| desktop | 2 prompt hook + send | | | | |
| desktop | 2 /spike-send | | | | |
| desktop | 3 /spike-team | | | | |
| terminal | 1 view from /spike-start | | | | |
| terminal | 1 view from /spike-view | | | | |
| terminal | 2 prompt hook + send | | | | |
| terminal | 2 /spike-send | | | | |
| terminal | 3 /spike-team | | | | |

Also note: did `spike-start` log `(id from $.agent.list)`? What `$.agent.list()` status did the agent have between its turns (`/spike-status`)? Did a `send` to the finished agent resume it?
