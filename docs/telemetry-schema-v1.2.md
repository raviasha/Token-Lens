# Telemetry Schema 1.2

Schema 1.2 extends the local raw task event stream without changing the meaning of existing 1.0 or 1.1 records.

Every event may include:

- `recorded_at`: when Token Lens wrote the record, distinct from source `timestamp`.
- `source_message_id`, `source_response_id`, and `source_event_id`: source-native identifiers when supplied.
- `source_turn_id`, `source_parent_id`, and `source_agent_id`: nullable source relationships, independent of inferred task IDs.
- `capture_status`: `captured`, `unavailable_from_source`, `intentionally_redacted`, `truncated`, or `recorder_failure`.
- `task_id_source`: `source` for source-native attribution or `derived` for heuristic grouping.

Diagnostic prompt events can include redacted `raw_prompt`. Diagnostic response events can include redacted `raw_response`, response status, finish reason, source response ID, token usage, and generated-file references.

Diagnostic `tool_activity` events include the tool name, call ID, redacted arguments, terminal command, source timing, redacted result or durable `result_ref`, error, exit code, and truncation state. File activity includes workspace-relative `path`, before/after hashes when available, a diff reference, and the source tool call ID.

Context snapshots preserve existing estimates and include actual measurements separately when the source supplies them. Lifecycle and recorder-health events are source-observed; task completion is never inferred from silence.

Large tool results are stored beneath `.code-buddy/telemetry/results/` with a durable relative reference. Raw diagnostic content remains local and should be reviewed before sharing.

## Capture evidence corrections (2026-09-19)

Prompt, response and tool payloads also expose `content_capture_status`:
`disabled`, `unavailable_from_source`, `intentionally_redacted`, `truncated`, or
`captured`. This describes retained content separately from the older envelope's
observation status. Older records without this field have unknown content coverage.

Tool `success` is nullable. A completed hook delivery does not establish command
success; missing/opaque status stays null. JSON-encoded result exit codes are
read when present. `started_at` stays null without source timing or a matching
PreToolUse observation. Correlation uses session, source turn, source agent and
call ID; `timing_source=hook_observations` denotes elapsed observations rather
than provider execution duration. Unknown build outcomes remain `unknown`.

`ai_usage` only reads explicit provider envelopes and includes request identity,
scope (possibly `unspecified`), total, cache-write and reasoning counters when
available. Do not sum observations with unspecified scope, overlapping cumulative
counters or repeated source request IDs. Context estimates are not provider usage.

Visible transcript evidence remains in the companion session JSONL files; it is
not duplicated into heuristic task events. Copilot records retain source IDs,
line positions, model, attachments and parent links. Codex native records expose
source line, message/call/response IDs, turn/model context and visible content.
Native request usage and cumulative snapshots remain separate fields and record
types. Reasoning records, system/developer message bodies and host state are
excluded from native transcript copies. A filtered snapshot contains a hash and
coverage metadata, not the original rollout body.

`historyStatus=source_snapshot` describes only the available source file, not a
complete task/session. `partial` denotes unparseable/in-progress rows; later
capture retries completed rows. Attachments remain references or host-provided
content; unavailable attachments and instruction text cannot be invented.

Codex `Interrupt` is a cancellation observation. Neither it nor `Stop` verifies
task acceptance. Existing heuristic task classifications remain unchanged.
