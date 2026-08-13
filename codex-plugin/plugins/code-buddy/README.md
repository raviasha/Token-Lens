# Code Buddy for Codex

This is the development copy. For public installation, use the [Code Buddy
distribution repository](https://github.com/raviasha/Code_Buddy).

## Persistent setting

In Codex, open **Plugins**, select **Code Buddy**, and use its Enable/Disable
switch. Codex saves this choice for tasks created after the change.

- **Enabled:** every meaningful coding request automatically receives Code
  Buddy prompt quality, task scope, estimated context pressure, and session-fit
  checks. Substantive work starts with a compact health line; only the affected
  status changes when a recommendation is available.
- **Disabled:** new tasks receive no Code Buddy skill, MCP tools, hooks, local
  logs, or interventions.

The first time its hooks run, review and trust Codex's hook permission. Codex
owns that confirmation; Code Buddy never bypasses it.

## Shared project policy

Add an optional, trackable `code-buddy.yaml` to the project root:

```yaml
version: 1
healthCheck:
  showOnEveryMeaningfulCodingTask: true
thresholds:
  promptQuality:
    enhanceBelow: 75
  taskScope:
    decomposeAtOrAbove: 65
  estimatedContextPressure:
    capacityTokens: 40000
    warningAt: 0.70
    criticalAt: 0.85
  sessionFit:
    recommendFreshTaskAtOrAbove: 75
    fallbackLexicalOverlapBelow: 0.20
```

Raise `enhanceBelow` for more prompt-enhancement advice; lower the other
thresholds for stricter controls. Empty local context evidence is **checked —
limited evidence**, not an actual-context claim. When session fit recommends a
fresh task, the developer can choose a curated handoff or **Continue unchanged**; Code Buddy never creates a task automatically.

## Fresh-task curated handoffs

After you choose fresh-task curation, Code Buddy returns a handoff marker and
stores a local pending record. Keep the marker unchanged when you paste the
bundle into the new task. That task waits before using any tool until you
either paste the marked handoff or submit exactly:

`Code Buddy: continue without curated context`

The source task remains usable. Curation for the current task never creates a
waiting state.
