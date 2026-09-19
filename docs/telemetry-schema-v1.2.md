# Telemetry Schema 1.2

Schema 1.2 extends the local raw task event stream without changing the meaning of existing 1.0 or 1.1 records.

Every event may include:

- `recorded_at`: when Token Lens wrote the record, distinct from source `timestamp`.
- `source_message_id`, `source_response_id`, and `source_event_id`: source-native identifiers when supplied.
- `capture_status`: `captured`, `unavailable_from_source`, `intentionally_redacted`, `truncated`, or `recorder_failure`.
- `task_id_source`: `source` for source-native attribution or `derived` for heuristic grouping.

Diagnostic prompt events can include redacted `raw_prompt`. Diagnostic response events can include redacted `raw_response`, response status, finish reason, source response ID, token usage, and generated-file references.

Diagnostic `tool_activity` events include the tool name, call ID, redacted arguments, terminal command, source timing, redacted result or durable `result_ref`, error, exit code, and truncation state. File activity includes workspace-relative `path`, before/after hashes when available, a diff reference, and the source tool call ID.

Context snapshots preserve existing estimates and include actual measurements separately when the source supplies them. Lifecycle and recorder-health events are source-observed; task completion is never inferred from silence.

Large tool results are stored beneath `.code-buddy/telemetry/results/` with a durable relative reference. Raw diagnostic content remains local and should be reviewed before sharing.
