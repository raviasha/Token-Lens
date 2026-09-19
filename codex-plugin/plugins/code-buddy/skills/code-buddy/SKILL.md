---
name: code-buddy
description: Use when the developer asks about Code Buddy capture, local telemetry logs, or recording readiness for task-card analysis.
---

# Code Buddy capture

Code Buddy currently runs in capture-only mode. Its hooks record local prompts,
tools, transcripts, context measurements and observed outcomes. Legacy prompt
quality checks, task decomposition, context-pressure interventions, new-task
suggestions, curated handoffs and automatic feedback reports are inactive.

Continue ordinary coding work without Code Buddy preflight calls, health lines,
quality scores or personalized-retry recommendations. A stale tool listing or
historical handoff file does not reactivate those workflows.

When asked about recording, use `session_status` with the absolute workspace.
Verify events for the requested session; loaded MCP tools do not prove hook
capture. Diagnostic conversation content requires both diagnostic telemetry
level and raw-content opt-in. Do not enable content capture implicitly.

Preserve existing Markdown reports and raw telemetry. Distinguish unavailable,
redacted and estimated data from measured observations. Context-window usage is
not total tokens consumed. Heuristic task IDs and completion flags are inferences.

Task-card analysis is separate from capture. Use its on-demand tools only when
they are callable in the current runtime; an older running host may still need
a plugin refresh.

## On-demand Task Card

When the developer asks to open a task card, call `task_card_open` with the
absolute workspace. Its UI lists saved cards and captured sessions when no
scope is supplied. If a selected current Codex session is known, the developer
may choose it in the widget or you may pass an explicit selected scope. Opening
or restoring a card does not generate or update it.

When the developer clicks Generate/Update or directly asks for generation,
use this same active Codex conversation. Follow the generation prompt returned
by `task_card_open`; page through `task_card_evidence` until `nextOffset` is
null. Compose a cited JSON draft and save through `task_card_save` with the
card ID and expected revision. Correct invalid evidence references or claims
before saving. Do not infer task identity from recorder task IDs or treat a
Stop event as acceptance. Provider usage snapshots overlap request usage.

Use `task_card_correct` only for developer-supplied claim corrections. The card
and corrections are local derived data; raw capture stays immutable.
