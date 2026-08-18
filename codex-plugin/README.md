# Code Buddy for Codex

This directory contains the development source for the Code Buddy Codex
plugin, including its lifecycle hooks, MCP server, tests, and marketplace
metadata. Users should install the runtime plugin from the public [Code Buddy
distribution repository](https://github.com/raviasha/Code_Buddy), not from
this Token Lens source checkout.

## Public installation

1. In a terminal, add the public marketplace:

   ```bash
   codex plugin marketplace add raviasha/Code_Buddy --ref main
   ```

2. Install and enable Code Buddy:

   ```bash
   codex plugin add code-buddy@code-buddy
   ```

3. Fully restart Codex, then create a new task. Review and trust the Code
   Buddy hook when Codex requests it.

The native **Plugins → Code Buddy → Enable/Disable** switch is persistent for
new tasks. When enabled and trusted, Code Buddy automatically performs its
four-check preflight and starts substantive work with a compact prompt quality,
task scope, context utilization, and session-fit health line. A fresh task created from accepted
curated context waits until the marked handoff is pasted or the developer
submits exactly `Code Buddy: continue without curated context`.

When native capacity is available, the context-utilization status includes
current tokens, model-window tokens, and the actual percentage. If capacity is
absent, it explicitly says that the percentage is unavailable.

To update an existing installation, refresh the marketplace snapshot, reinstall
the plugin, and restart Codex:

```bash
codex plugin marketplace upgrade code-buddy
codex plugin add code-buddy@code-buddy
```

## v0.9.0 update notes

- Reads Codex's latest local `token_count` event and reports current input
  tokens as a percentage of the reported model context window. This local file
  read does not invoke a model or consume tokens.
- Uses actual `last_token_usage.input_tokens`, never cumulative
  `total_token_usage`, for context pressure. If model capacity is absent, it
  shows actual input tokens without inventing a percentage; the existing
  **Estimated Context Pressure** remains a clearly labeled fallback.
- Adds schema-1.1 task telemetry and exact human-requested retry measurement.
- Shows a model-presented personalized-feedback status after every prompt,
  including explicit cold-start and low-reliability states.
- Adds descriptive comparable-task evidence, Poisson/negative-binomial count
  analysis, and completion/test/build quality guardrails.
- Adds read-only human-retry analysis through MCP while preserving local-only,
  metadata-derived capture and fail-open hooks.

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
measurement:
  humanRetries:
    minimumComparableTasks: 8
    minimumTasksPerFactor: 5
    reliabilityThreshold: 0.60
    minimumEffectSize: 0.15
    overdispersionThreshold: 1.50
```

Raise `enhanceBelow` for stricter prompt enhancement; lower the other
thresholds for earlier decomposition, pressure, or fresh-task advice. Context
without a matching native event or sufficient fallback evidence is shown as
**checked — limited evidence**.
A session-fit recommendation offers a curated fresh task or **Continue unchanged**; it never acts automatically.

Every submitted prompt also receives a model-presented `Personalized
recommendation —` line based on local metadata. It explicitly reports cold
start until comparable-task and reliability thresholds are met.

## Local task telemetry

The plugin writes privacy-first schema-`1.1` task events to
`.code-buddy/telemetry/raw/events-YYYY-MM-DD.jsonl`. Task, session, and
interaction IDs remain separate, so a task can be reconstructed across
follow-ups, compactions, and fresh sessions. Standard capture stores derived
prompt characteristics and engineering metadata—not source, prompts,
responses, terminal output, or tool arguments. Set
`CODE_BUDDY_TELEMETRY_LEVEL=minimal|standard|diagnostic` to change verbosity;
raw prompts additionally require
`CODE_BUDDY_TELEMETRY_CAPTURE_RAW_CONTENT=true` and diagnostic mode, and are
still secret-redacted.

From a plugin development checkout:

```bash
node plugins/code-buddy/scripts/telemetry.cjs list /absolute/workspace
node plugins/code-buddy/scripts/telemetry.cjs replay /absolute/workspace task_...
node plugins/code-buddy/scripts/telemetry.cjs aggregate /absolute/workspace task_...
node plugins/code-buddy/scripts/telemetry.cjs validate /absolute/workspace
node plugins/code-buddy/scripts/telemetry.cjs dataset /absolute/workspace
node plugins/code-buddy/scripts/telemetry.cjs report /absolute/workspace task_...
node plugins/code-buddy/scripts/telemetry.cjs native-context /absolute/workspace [session_id]
```

The native reader returns only token metadata, timestamp, and utilization; it
does not copy prompts, responses, or source from Codex rollout files into Code
Buddy telemetry. Telemetry failures never gate or stop Codex.

To update, download a newer repository version and run the two installation
commands again from the new local path.
