# Code Buddy for Codex

This is the development copy. For public installation, use the [Code Buddy
distribution repository](https://github.com/raviasha/Code_Buddy).

## Persistent setting

In Codex, open **Plugins**, select **Code Buddy**, and use its Enable/Disable
switch. Codex saves this choice for tasks created after the change.

- **Enabled:** every meaningful coding request automatically receives Code
  Buddy prompt quality, task scope, context-utilization, and session-fit
  checks. Substantive work starts with a compact health line; only the affected
  status changes when a recommendation is available. With native capacity, the
  context status always contains current tokens, model-window tokens, and the
  actual percentage.
- **Disabled:** new tasks receive no Code Buddy skill, MCP tools, hooks, local
  logs, or interventions.

The first time its hooks run, review and trust Codex's hook permission. Codex
owns that confirmation; Code Buddy never bypasses it.

## Install or update

```bash
codex plugin marketplace add raviasha/Code_Buddy --ref main
codex plugin add code-buddy@code-buddy
```

For an existing installation, run `codex plugin marketplace upgrade
code-buddy`, run the `codex plugin add` command again, fully restart Codex, and
create a new task.

## v0.9.0 update notes

- Uses the latest local Codex `token_count` event to show actual input tokens
  as a percentage of the reported model context window. Reading it is a local
  operation and consumes no model tokens.
- Never uses cumulative token usage for current context. When the window is
  absent, Code Buddy shows actual input tokens without a percentage; when no
  native event matches, it falls back to explicitly labeled **Estimated Context Pressure**.
- Adds exact human-retry measurement and replayable schema-1.1 task telemetry.
- Shows an explicit personalized-feedback status after every prompt without
  making claims before comparable evidence is sufficient.
- Adds interpretable Poisson/negative-binomial evidence, configurable cold-start
  gates, and test/build outcome guardrails.
- Keeps prompts, responses, source, terminal output, and tool arguments out of
  standard telemetry.

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
measurement:
  humanRetries:
    minimumComparableTasks: 8
    minimumTasksPerFactor: 5
    reliabilityThreshold: 0.60
    minimumEffectSize: 0.15
    overdispersionThreshold: 1.50
```

Raise `enhanceBelow` for more prompt-enhancement advice; lower the other
thresholds for stricter controls. Empty local context evidence is **checked —
limited evidence**, not an actual-context claim. When session fit recommends a
fresh task, the developer can choose a curated handoff or **Continue unchanged**; Code Buddy never creates a task automatically. Every prompt also receives a model-presented personalized-feedback line; it says that data is insufficient until the local evidence gate passes.

## Local task telemetry

Code Buddy emits schema-`1.1` task telemetry to
`.code-buddy/telemetry/raw/events-YYYY-MM-DD.jsonl`. Persistent task IDs remain
separate from Codex session IDs, and each developer request receives an
interaction ID. The default `standard` level stores derived behavioral and
engineering metadata without prompts, responses, source, terminal output, or
tool arguments. Configure `CODE_BUDDY_TELEMETRY_LEVEL` with `minimal`,
`standard`, or `diagnostic`; diagnostic raw prompts require the additional
`CODE_BUDDY_TELEMETRY_CAPTURE_RAW_CONTENT=true` opt-in and remain
secret-redacted.

Replay or rebuild a task from the raw source of truth:

```bash
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" list /absolute/workspace
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" replay /absolute/workspace task_...
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" aggregate /absolute/workspace task_...
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" validate /absolute/workspace
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" dataset /absolute/workspace
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" report /absolute/workspace task_...
node "${PLUGIN_ROOT}/scripts/telemetry.cjs" native-context /absolute/workspace [session_id]
```

The native reader stores only token metadata, timestamps, and utilization—not
raw Codex rollout content. Telemetry capture is local and fail-open.

## Fresh-task curated handoffs

After you choose fresh-task curation, Code Buddy returns a handoff marker and
stores a local pending record. Keep the marker unchanged when you paste the
bundle into the new task. That task waits before using any tool until you
either paste the marked handoff or submit exactly:

`Code Buddy: continue without curated context`

Surrounding whitespace added during submission is ignored; changed wording or
punctuation is not accepted as the explicit bypass.
The source task remains usable. Curation for the current task never creates a
waiting state.
