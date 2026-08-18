# Code Buddy Telemetry Data Dictionary

This dictionary describes raw telemetry schema `1.1`. The JSONL event stream is the source of truth; task records and human-retry analyses are rebuildable derived data. Readers accept both `1.0` and `1.1`, so existing append-only files require no destructive migration.

## Common envelope

| Field | Type | Availability | Meaning |
| --- | --- | --- | --- |
| `schema_version` | string | Always | Telemetry contract version. Version `1.1` is emitted; version `1.0` remains readable. |
| `event_id` | string | Always | Random unique event identifier with `evt_` prefix. |
| `event_type` | enum | Always | Event taxonomy member documented below. |
| `timestamp` | ISO-8601 string | Always | Platform timestamp when supplied, otherwise local observation time. |
| `session_sequence` | positive integer | Always | Monotonic counter within a session where local hook ordering permits it. |
| `developer_id` | string | Always | Explicit configured ID or stable local hash. No username or hostname is stored. |
| `session_id` | string or null | When observable | Coding-agent conversation identifier. It is intentionally separate from `task_id`. |
| `task_id` | string or null | When attributable | Coherent development objective. It can span sessions and interactions. |
| `interaction_id` | string or null | When attributable | One developer request and its associated agent work cycle. |
| `platform` | string | Always | `github-copilot`, `codex`, or another capture integration. |
| `environment.editor` | string or null | When observable | Editor or agent surface. |
| `environment.repository_id` | string or null | When observable | Workspace-salted hash of the local repository root; the path itself is not stored. |
| `environment.branch` | string or null | When observable | Current Git branch. |
| `payload` | object | Always | Event-specific, derived metadata. |

An unavailable measurement is `null`. Zero is written only when the observed value was actually zero.

## Task and interaction events

| Event | Important payload fields | Purpose |
| --- | --- | --- |
| `task_created` | `task_type`, `initial_complexity`, derived `objective`, `task_detection.method`, `confidence`, `reason` | Starts a task and records how attribution was decided. The objective contains a controlled action/target category, file extensions, hashed ticket references, and a fingerprint—not prompt text. |
| `task_continued` | `task_match_confidence`, `match_reason` | Links a new request to an existing task. |
| `task_state_changed` | `from`, `to`, `reason` | Preserves task lifecycle transitions. |
| `task_completed` | `completion_method`, `completion_confidence` | Marks completion based on a developer declaration, commit, or other observable signal. |
| `task_abandoned` | `reason` | Marks explicit abandonment. |
| `prompt_submitted` | lengths, prompt characteristic booleans, `referenced_file_count` | Stores prompt features without raw prompt content at standard level. |
| `developer_followup` | `classification`, `classification_confidence`, `objective_relation`, `material_change_requested`, task-match confidence, metadata-only `signals` | Classifies clarification, correction, extension, scope change, retry, validation, requirement, approval, question, or unknown. Signal booleans and hashed-term overlap permit later reclassification without storing the message. |
| `retry_detected` | `retry_type`, `confidence`, `trigger` | Backward-compatible broad retry candidate. It is not the analytical `human_retry_count`. |
| `implementation_attempt_observed` | attempt ID/number/kind, evidence, confidence, detector version | Records at most one material implementation attempt per interaction after the agent response. Evidence is a successful file change, repaired test/build, successful commit, observed worktree delta, or a response to a material implementation request. Multiple agent tool calls do not create multiple attempts. |
| `human_retry_detected` | retry/attempt/prior-attempt IDs, correction classification, task/material confidence, trigger, detector version | Confirms a human-requested implementation retry only when a same-objective correction or explicit retry follows a prior material attempt and the agent then makes another material attempt. |
| `scope_changed` | `direction`, prior/new scope estimates | Records an observed scope transition. |
| `agent_response` | model, response tokens, tool/file counts, duration | Stores only metadata exposed by the platform. |

## Preflight and recommendation events

| Event | Important payload fields | Purpose |
| --- | --- | --- |
| `preflight_completed` | Four objects with `score`, `threshold`, `decision` | Captures prompt quality, decomposition, context pressure, and session fit using the threshold active at that time. Scores are normalized to ratios. |
| `recommendation_shown` | `recommendation_id`, type, reason, source check/score, action | Makes a recommendation linkable to a later choice and outcome. |
| `recommendation_decision` | `recommendation_id`, `decision` | Records `accepted`, `rejected`, `dismissed`, `modified`, or `unknown`. |
| `recommendation_applied` | recommendation ID/type, application status, evidence | Separates accepting a recommendation from evidence that it was actually applied. |

Recommendation types are `enhance_prompt`, `decompose_task`, `reduce_context`, `start_fresh_session`, and `create_handoff`. The schema can add types in a later version without changing older raw records.

## Context and session events

| Event | Important payload fields | Purpose |
| --- | --- | --- |
| `context_snapshot` | checkpoint, estimated or actual tokens, measurement method/terminology, turns, compaction count, fresh-session and handoff flags | Captures context at task start, preflight measurement, before work, around compaction, and after an agent response. Actual provider measurements remain separate from estimates. |
| `conversation_compacted` | before/after token estimates, compaction number | Records one compaction. Missing platform measurements remain null. |
| `session_changed` | previous/new IDs, transition type, handoff flag | Preserves a task moving across sessions. |
| `handoff_created` | source/handoff estimates and compression ratio | Records curated context creation without storing the handoff text. |

Context token values based on character counts are estimates, never actual provider billing usage.

## Engineering and usage events

| Event | Important payload fields | Purpose |
| --- | --- | --- |
| `ai_usage` | model, input/cached/output/reasoning tokens, AI credits, estimated cost | Stores raw exposed values. Missing fields are null; cost is intentionally not calculated at capture time. |
| `tool_activity` | tool type, operation category, success, duration | Stores no tool arguments or output. |
| `file_activity` | operation, workspace-salted file identity, extension, line deltas | Stores no source content or raw path. Line deltas are null when the hook cannot observe them. |
| `git_event` | Git event type, commit hash, change counts | Captures commit, amend, revert, branch, and merge signals where observable. |
| `test_run` | framework, run/pass/fail/skip counts, duration | Preserves every run instead of only the final result. |
| `build_run` | result, duration, error count | Captures each observable build result. |

The rebuild utility sums exact observed worktree line deltas when available and
derives `code_churn` as removed lines divided by total added-plus-removed lines.
It remains null when the hook cannot observe complete line deltas.

The exported `TaskAggregator` provides `ingest(event)`, `getTask(taskId)`,
`finalizeTask(taskId)`, and `rebuildTask(taskId, events)` over the same raw
schema. `rebuildTask` deliberately has no dependence on a prior derived record.

Derived task records use dataset schema `human-retry-task-v1`. They include
prompt clarity, initial complexity, actual decomposition, session/context fit,
acceptance-criteria presence, recommendation exposure/acceptance/application,
sessions/interactions, broad retry candidates, exact `human_retry_count`,
material implementation attempts, compactions, maximum actual/estimated context,
token/credit totals, first/final test outcomes, worktree lines and churn,
agent/developer turns, elapsed time, commit/completion state, first-pass
success, completed-without-retry, and completed-in-original-session. Null is
preserved whenever a source signal was unavailable.

`human_retry_count` does not count clarification, extension, scope change, a
new task, validation-only requests, questions, approvals, or autonomous agent
retries within one interaction. For schema `1.0` input only, reprocessing can
confirm a legacy retry candidate when metadata shows attempt evidence both
before and after it; otherwise it remains unconfirmed. The task record exposes
the derivation source.
`human_retry_observation_confidence` is 1 for tasks captured wholly with the
exact schema-1.1 detector and 0.75 for mixed-version tasks. Legacy-only tasks
use confirmed/candidate coverage, or 0.5 when no candidate is available to
audit.

## Evidence model and feedback

`human-retry-analysis-v1` compares only completed tasks with the same task type
and initial complexity as the current task. Univariate count models report
incident-rate ratios and 95% confidence intervals. Poisson is the default;
negative binomial is selected when Pearson dispersion exceeds the configured
threshold. Results are associations, never causal claims.

Every submitted prompt receives one model-facing feedback line. Before the
cold-start and reliability gates pass it says `Personalized recommendation —
Not enough data ...` or `Not enough reliable data ...`. A recommendation also
requires the configured minimum effect, expected direction, and no observed
test/build quality regression. Missing test/build outcomes remain unknown and
their coverage is disclosed.

Defaults are 8 comparable completed tasks, 5 observations per factor, 60%
reliability, 0.15 minimum absolute log-rate effect, and 1.5 overdispersion.
They can be changed in `code-buddy.yaml` under `measurement.humanRetries` or in
the corresponding `tokenLens.humanRetry.*` VS Code settings.

## Storage and privacy

Raw records are written to `.code-buddy/telemetry/raw/events-YYYY-MM-DD.jsonl` with local-user file permissions. State needed for attribution and monotonic sequences lives under `.code-buddy/telemetry/.state/`.

Platform event/tool IDs—or a local payload fingerprint when no ID is
available—are retained only as bounded hashes in state so replayed hook
deliveries do not duplicate raw events.

The default `standard` level stores behavioral metadata, not prompts, responses, source code, terminal output, or tool arguments. Raw prompts require both `diagnostic` level and an explicit raw-content opt-in, and are still passed through the secret redactor. Analysis is local and reads only these metadata-derived events. Secret redaction in the legacy logs remains independent; the standard task stream avoids sensitive content by construction.
