# Code Buddy for Codex

This directory is a self-contained local Codex marketplace. It includes the
Code Buddy plugin, its lifecycle hooks, MCP server, tests, and marketplace
metadata.

## Install from a download or clone

1. Download or clone this repository.
2. In a terminal, add this directory as a local marketplace:

   ```bash
   codex plugin marketplace add /absolute/path/to/Token_Lens/codex-plugin
   ```

3. Install and enable Code Buddy:

   ```bash
   codex plugin add code-buddy@token-lens
   ```

4. Fully restart Codex, then create a new task. Review and trust the Code
   Buddy hook when Codex requests it.

The native **Plugins → Code Buddy → Enable/Disable** switch is persistent for
new tasks. When enabled and trusted, Code Buddy automatically performs its
four-check preflight and starts substantive work with a compact prompt quality,
task scope, estimated context pressure, and session-fit health line. A fresh task created from accepted
curated context waits until the marked handoff is pasted or the developer
submits exactly `Code Buddy: continue without curated context`.

## Shared project policy

Place this optional `code-buddy.yaml` in the project root to configure both
the Codex plugin and VS Code extension:

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

Raise `enhanceBelow` for stricter prompt enhancement; lower the other
thresholds for earlier decomposition, pressure, or fresh-task advice. Context
without sufficient local evidence is shown as **checked — limited evidence**.
A session-fit recommendation offers a curated fresh task or **Continue unchanged**; it never acts automatically.

To update, download a newer repository version and run the two installation
commands again from the new local path.
