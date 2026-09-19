# Token Lens Capture Deltas

This document lists only the information that is missing from the current JSONL capture and should be added to make it a reliable raw observability layer.

## 1. Raw assistant response

The current `agent_response` event contains counts and timing, but no response content.

Add:

```json
"raw_response": "complete assistant response text"
```

Also capture:

- Response status: `completed`, `failed`, `cancelled`, or `interrupted`.
- Finish reason.
- Model name when available.
- Source response or message ID.
- Token usage when available.
- References to generated files or artifacts.

## 2. Exact tool-call details

The current `tool_activity` records only broad categories such as `terminal` or `code_buddy`.

Add:

```json
"tool_name": "terminal.exec",
"tool_call_id": "source-call-id",
"arguments": {},
"started_at": "...",
"ended_at": "..."
```

For terminal activity, preserve the exact command text. For other tools, preserve the original arguments.

## 3. Exact tool results

The current records say whether a tool succeeded, but do not contain its output.

Add a corresponding result payload containing:

```json
{
  "tool_call_id": "source-call-id",
  "result": "...",
  "error": null,
  "exit_code": 0,
  "truncated": false
}
```

If the output is large, store it separately and record a durable `result_ref`.

This is necessary to determine what the agent actually observed and whether a tool result caused a later change.

## 4. File paths and actual changes

The current `file_activity` contains only a hash, extension, and nullable line counts.

Add:

- Workspace-relative file path.
- Operation: created, modified, deleted, or renamed.
- Before-content hash.
- After-content hash.
- Diff or snapshot reference.
- Source tool-call ID.

Example:

```json
{
  "path": "src/config.json",
  "before_hash": "...",
  "after_hash": "...",
  "diff_ref": "...",
  "operation": "modified"
}
```

## 5. Message-level source identifiers

`interaction_id` groups a turn, but there is no identifier for the individual source message or response.

Add:

- `source_message_id` for user messages.
- `source_response_id` for assistant responses.
- `source_event_id` for tool and lifecycle events, when supplied by the source.

These identifiers allow downstream consumers to deduplicate events and join raw records to the original Copilot trace.

## 6. Separate event time from capture time

The current `timestamp` appears to be the source event timestamp. Add:

```json
"recorded_at": "time Token Lens received and wrote the event"
```

This allows downstream analysis to identify buffering, delays, reordering, or late-arriving events.

## 7. Explicit missingness and truncation

When a field is absent, the current log does not say why.

Add either an event-level field:

```json
"capture_status": "captured"
```

or field-level status metadata distinguishing:

- Captured.
- Unavailable from source.
- Intentionally redacted.
- Truncated.
- Recorder failure.

This is especially needed for response text, tool output, context measurements, and file diffs.

## 8. Actual context values when available

The current context snapshots store estimates, while `actual_context_tokens` is null.

When the source exposes the actual value, capture:

- Actual context token count.
- Measurement method.
- Measurement timestamp.
- Compaction or truncation details.
- Identifiers for the included conversation messages or files.

Keep the existing estimate, but preserve the actual value separately.

## 9. Session and task lifecycle completion

The sample has `created -> active`, but no explicit completion or termination evidence.

Capture source-observed events for:

- Response completed.
- Interaction failed.
- Interaction cancelled.
- Session ended.
- Session resumed.
- Task or conversation closed, if the source exposes it.

Do not infer task completion from the absence of another event.

## 10. Recorder health and dropped-event evidence

There is currently no way to tell whether an event was never emitted or was lost by Token Lens.

Add recorder events or counters for:

- Source connection failure.
- Dropped event.
- Parse or serialization failure.
- Write failure.
- Unavailable hook.
- Recorder start and stop.
- Schema or recorder-version change.

## 11. Stop treating heuristic task assignment as raw evidence

The current `task_id` is applied across all records, including records assigned through semantic similarity and same-repository heuristics.

Change the raw layer so that:

- A heuristic task ID is either omitted or explicitly marked as derived.
- Source-native task, session, and conversation IDs are preserved separately.
- Task assignment records reference the underlying event IDs.
- Confidence and matching reasons remain in a downstream derived stream.

The raw log should preserve the events needed to reconstruct grouping later; it should not make the grouping decision authoritative.
