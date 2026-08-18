---
name: code-buddy
description: Use for meaningful coding prompts in Codex when Code Buddy is installed. Run the developer-controlled prompt quality, task scope, actual-or-estimated context utilization, and session-fit checks before substantial implementation.
---

# Code Buddy for Codex

Code Buddy is a local governance and analytics workflow. Its Codex hooks record
prompt, tool, compaction, subagent, and turn-completion events under the active
workspace. Its MCP tools return structured evaluations and write local
intervention records. Never present an estimate as actual model usage.

## Mandatory preflight

For every meaningful coding request, before an edit, file creation, or command
that changes project state:

1. Identify the absolute workspace path.
2. Prepare a concise, intent-preserving semantic prompt assessment, then use
   the Code Buddy `review_prompt` tool with the unchanged user prompt and that
   assessment in `modelAssessment`.
3. Prepare a semantic task-complexity assessment, then use the Code Buddy
   `decompose_task` tool with the unchanged user task and that assessment in
   `modelAssessment`.
4. Call `measure_context` to obtain the best available measurement. It reads
   the latest native Codex `token_count` event automatically when available.
   Treat empty or fallback evidence as **Estimated Context Pressure — limited
   evidence**, never as an actual-context zero.
5. Prepare a semantic session-fit assessment, then call
   `assess_session_fit` with the unchanged prompt, prior meaningful prompt
   when available, and `modelAssessment`.
6. Read all four results. Before substantive work, begin with:

   `Code Buddy: prompt quality <status> · task scope <status> · context utilization <status> · session fit <status>`

   Replace only the affected status with an action such as “enhancement
   available”, “decomposition available”, “checked — limited evidence”, or
   “fresh task recommended”. Copy `measure_context.healthLineStatus` verbatim
   into the context-utilization slot. With native capacity, it includes current
   tokens, model-window tokens, and the actual percentage; a token count alone
   is incomplete.

Small control replies such as `yes`, `continue`, `run it`, `retry`, or `cancel`
do not require preflight.

## Human-retry feedback

For every submitted prompt, show the exact `Personalized recommendation — ...`
line supplied by the lifecycle hook. For a meaningful coding request, put it
immediately after the health line; for a control prompt, put it at the beginning
of the response. Do not omit, paraphrase, or upgrade a cold-start or
low-reliability message into advice.

The line comes from a local count model over comparable completed tasks. Treat
all reported effects as associations, never causation. Do not make a
developer-specific recommendation until the supplied evidence status passes
its configured sample and reliability thresholds. Missing test/build outcomes
are unknown, not passing or failing.

The lifecycle hook enforces the same rule for local tools. If it denies an
implementation call, do not retry it. Use `tool_search` if the Code Buddy MCP
tools are deferred, invoke the missing tool or tools, and then retry.

## Developer control

An evaluation is required; an intervention is conditional.

- If the prompt, scope, context, and session-fit checks are satisfactory,
  continue normally after the health line.
- If prompt review recommends an improved prompt, show concise options including
  the original. Do not silently select or submit an alternative.
- If decomposition is recommended, show the original-task option and the
  available strategy. Do not begin a subset or phase unless the developer picks
  it.
- Put every actionable choice in the normal user-visible response, including
  each option's label and prompt or task. Never leave choices only in tool
  output, hidden reasoning, or a collapsed Thinking section, and never ask the
  developer to choose unless that same visible response contains the choices.
- Record an explicit selection with `record_intervention` using
  `prompt.review_choice` or `task.decomposition_choice`.
- If Code Buddy's optional MCP tool fails, preserve the original request and
  continue once the hook's safe-fallback condition has been met.
- A session-fit recommendation offers **Curate for a fresh chat** or
  **Continue unchanged**. Never create, switch, or curate a task automatically.

## Project policy

An optional trackable root `code-buddy.yaml` applies to this plugin and the VS
Code extension. It supports only documented two-space mappings, booleans,
numbers, and comments; invalid fields fall back individually.

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

Raise `enhanceBelow` to request more prompt enhancement; lower the other
thresholds for stricter decomposition, pressure, or fresh-task recommendations.

Codex cannot display a PreToolUse approval dialog from a hook. After the hook
has denied the configured number of implementation attempts, only the developer
can enable the controlled fail-open path by submitting exactly:

`Code Buddy: continue without preflight`

That approval is recorded locally. Do not suggest or submit that phrase on the
developer's behalf.

## Context measurement and handoffs

When Code Buddy reports warning or critical context pressure, call
`measure_context` before discussing the value.

- A native Codex `token_count` event is **Actual Context Utilization**. Use
  `last_token_usage.input_tokens` as the current-context numerator and
  `model_context_window` as the denominator. Never use cumulative
  `total_token_usage` for the percentage.
- If Codex exposes actual input tokens without the model window, show the
  actual token count and state that the percentage is unavailable.
- Values from Code Buddy's observable-text fallback are **Estimated Context
  Pressure**. They are not billing data or an exact context-window
  measurement.
- Offer a fresh-task handoff or current-task curation only after the developer
  chooses it. Prepare a minimum-sufficient semantic bundle in `modelBundle`
  before calling `curate_context`; preserve pinned items and state which
  history is excluded.
- For a fresh-task handoff, call `curate_context` with
  `developerConfirmed: true` only after the developer explicitly selected that
  option. Preserve the returned `handoffMarker` unchanged at the beginning of
  the bundle the developer copies.
- A fresh task with a pending Code Buddy handoff must not advance, inspect the
  workspace, or invoke tools until the developer pastes that marked bundle or
  submits exactly `Code Buddy: continue without curated context`. Current-task
  curation never creates this wait state.
- Never create a fresh task, discard conversation history, or paste a handoff
  automatically. The developer decides whether to use it.

## Local files

All generated data is local to the selected workspace:

- `.code-buddy/codex-session.jsonl` — redacted lifecycle and transcript records
- `.code-buddy/interventions.jsonl` — reviews, choices, measurements, and fallbacks
- `.code-buddy/.state/` — preflight, transcript, and worktree-baseline state
- `.code-buddy/telemetry/raw/` — versioned local task events for replay and human-retry evidence
- `.code-buddy/telemetry/.state/` — task attribution, interaction, sequence, and deduplication state
- `Code Buddy.md` — concise next-prompt feedback
- `Code Buddy Analytics.md` — detailed session analytics

Use `session_status` when the developer asks where the files are or asks for
the current Code Buddy status. Do not treat a missing report as a failure while
the current turn is still running.

Use the read-only `analyze_human_retries` tool when the developer asks for the
structured cohort, reliability score, Poisson/negative-binomial associations,
or recommendation evidence. This Phase 1 workflow is statistical measurement,
not ML training.
