# Code Buddy for Codex

## Persistent setting

In Codex, open **Plugins**, select **Code Buddy**, and use its Enable/Disable
switch. Codex saves this choice for tasks created after the change.

- **Enabled:** every meaningful coding request automatically receives Code
  Buddy prompt review and task decomposition. Routine checks stay silent unless
  a result recommends developer choices.
- **Disabled:** new tasks receive no Code Buddy skill, MCP tools, hooks, local
  logs, or interventions.

The first time its hooks run, review and trust Codex's hook permission. Codex
owns that confirmation; Code Buddy never bypasses it.

## Fresh-task curated handoffs

After you choose fresh-task curation, Code Buddy returns a handoff marker and
stores a local pending record. Keep the marker unchanged when you paste the
bundle into the new task. That task waits before using any tool until you
either paste the marked handoff or submit exactly:

`Code Buddy: continue without curated context`

The source task remains usable. Curation for the current task never creates a
waiting state.
