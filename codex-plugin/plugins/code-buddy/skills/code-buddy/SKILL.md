---
name: code-buddy
description: Use for meaningful coding prompts in Codex when Code Buddy is installed. Run the developer-controlled prompt review and task decomposition before substantial implementation; use its context measurement, curation, local reports, and controlled fallback workflow.
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
4. Read both results. They always preserve an explicit original option.

Small control replies such as `yes`, `continue`, `run it`, `retry`, or `cancel`
do not require preflight.

The lifecycle hook enforces the same rule for local tools. If it denies an
implementation call, do not retry it. Use `tool_search` if the Code Buddy MCP
tools are deferred, invoke the missing tool or tools, and then retry.

## Developer control

An evaluation is required; an intervention is conditional.

- If both results do not recommend an intervention, continue normally.
- If prompt review recommends an improved prompt, show concise options including
  the original. Do not silently select or submit an alternative.
- If decomposition is recommended, show the original-task option and the
  available strategy. Do not begin a subset or phase unless the developer picks
  it.
- Record an explicit selection with `record_intervention` using
  `prompt.review_choice` or `task.decomposition_choice`.
- If Code Buddy's optional MCP tool fails, preserve the original request and
  continue once the hook's safe-fallback condition has been met.

Codex cannot display a PreToolUse approval dialog from a hook. After the hook
has denied the configured number of implementation attempts, only the developer
can enable the controlled fail-open path by submitting exactly:

`Code Buddy: continue without preflight`

That approval is recorded locally. Do not suggest or submit that phrase on the
developer's behalf.

## Context measurement and handoffs

When Code Buddy reports warning or critical context pressure, call
`measure_context` before discussing the value.

- Values from a supplied provider API are **Actual Context Utilization** only
  when the provider says they are complete active-context usage.
- Values from the local event log are **Estimated Context Pressure**. They are
  not billing data or an exact context-window measurement.
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
- `Code Buddy.md` — concise next-prompt feedback
- `Code Buddy Analytics.md` — detailed session analytics

Use `session_status` when the developer asks where the files are or asks for
the current Code Buddy status. Do not treat a missing report as a failure while
the current turn is still running.
