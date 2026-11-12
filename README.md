# subagent-monitor

A Claude Code mod that adds a live **Subagents** pane and a one-line band above the prompt.

![Subagents pane in the Claude desktop app](docs/pane.png)

- Session total at API prices, total tokens, main thread vs subagent cost split, and an input / output / cache read / cache write breakdown
- One row per subagent: task, type, status, elapsed time, model, effort, tokens, estimated cost and context fill
- Click a task title to open a detail view with the prompt, a live activity timeline and the final result
- Click the band, or run `/subagents`, to open or close the pane

## Map

While any subagent runs, the **Map** section above the agent list draws the main loop at the centre and every running subagent around it, one ring per spawn depth. A finished agent leaves the map.
- Solid lines: who spawned whom. Dashed curves: delivered `SendMessage` traffic, thicker the more often used, with one pulse when a message arrives.
- A node's ring is its model's colour. A running node beats, and a waiting one has a dashed ring.
- Up to 24 agents are shown; any more are counted as `+N more`. Only who messaged whom and how often is kept, never the message text.
- Under the map, a feed shows what each agent is doing: its running tool calls and its last finished one, as a short label (a file, a host, a command's first word), never the call's input or output.
- Click its head to fold it. The terminal shows the same map as an indented tree followed by `from → to ×count` lines.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install subagent-monitor --marketplace enginahmetbodur/subagent-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, including the desktop app's local sessions).

To run from a local folder instead, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder in the `env` block of `~/.claude/settings.json`.

## Notes

- Per-subagent cost is estimated from list prices. The session total comes from Claude Code itself.
- A subagent's context window is estimated unless it runs on the session's own model; estimates are shown with `~`.
- Session token totals count from the moment the mod loads.

## Develop

```
claude plugin validate .
claude plugin test .
```
