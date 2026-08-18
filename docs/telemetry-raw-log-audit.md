# Raw Log Audit Against the Telemetry Foundation PRD

Audit date: 2026-08-18

## Before this implementation

| PRD capability | Previous status | Existing source |
| --- | --- | --- |
| Session ID, timestamps, workspace, hook type | Already captured | Schema-2 Copilot/Codex session logs. |
| Prompt, tool, transcript, and worktree observations | Already captured | Hook records, transcript snapshots, and Python turn outcomes. |
| Prompt/decomposition/context/session evaluations | Partially captured | Independent intervention events; thresholds and checks were not consolidated into one replayable preflight event. |
| Context estimates and provider usage | Partially captured | Session snapshots and hook payload normalization; not attributed to a persistent task. |
| Compaction | Partially captured | `PreCompact` observation existed; before/after task context was not reconstructable. |
| Recommendation choices | Partially captured | Selection fields existed across different intervention records without a common recommendation linkage. |
| Persistent task ID spanning sessions | Missing | `turnId` and session ID were not coherent task identity. |
| Interaction ID | Missing | A user-request → agent-work cycle was not represented independently. |
| Versioned common event envelope and session sequence | Missing | Legacy formats used camel-case schema versions and record-specific shapes. |
| Task lifecycle, follow-up classification, retries, scope changes | Missing | Required manual conversation inspection. |
| Per-run test/build/Git outcomes linked to a task | Missing | Worktree summaries existed, but a task lifecycle could not retain each run. |
| Replay and rebuildable task record | Missing | Reports were session/turn summaries. |

## Implemented mapping

| PRD requirement | Implementation |
| --- | --- |
| Common envelope | Schema `1.1` with event, time, sequence, developer, session, task, interaction, platform, environment, and payload fields; `1.0` remains readable. |
| Persistent IDs | Workspace-local attribution state creates persistent `task_*` IDs and one `interaction_*` ID per submitted prompt. Session IDs remain platform-owned and separate. |
| Task attribution | Explicit task IDs win; otherwise continuation cues, follow-up classification, hashed semantic terms, session continuity, branch, and repository identity are used. Confidence and reasons are stored. A controlled action/target summary describes the objective without storing prompt text; raw prompt terms are never stored in telemetry state. |
| Task lifecycle | Created, active, paused, completed, abandoned, and superseded transitions are emitted. Completion can be developer-confirmed or commit-detected. |
| Preflight | All four normalized scores, the contemporaneous thresholds, and decisions are emitted in one `preflight_completed` event. |
| Recommendation learning chain | `recommendation_shown` and `recommendation_decision` share a stable recommendation ID and remain attributed to task and interaction. |
| Follow-ups and retries | Metadata-only classification emits broad `retry_detected` candidates plus exact `implementation_attempt_observed` and `human_retry_detected` events. Clarifications, extensions, scope changes, new tasks, and agent-internal retrying are excluded from the exact count. |
| Context lifecycle | Checkpoint snapshots, before/after compaction observations, session changes, and curated handoff metadata are task-attributed. |
| AI usage | Exposed provider token and credit values are copied without guessing; unavailable values are null. |
| Engineering activity | Metadata-only tool, hashed file, Git, test, and build events are captured where hook payloads expose them. Every test/build execution remains distinct. |
| Local source of truth | Daily JSONL files under `.code-buddy/telemetry/raw/`; no cloud dependency. |
| Privacy and verbosity | Minimal, standard, and diagnostic levels; standard is default; raw prompt capture is a second explicit opt-in available only in diagnostic mode. |
| Fail-open behavior | Capture and validation errors return a failure result to the caller but never throw through the hook. Legacy operation continues. |
| Replay, aggregation, and evidence | `telemetry.cjs replay` prints a task timeline; `aggregate` rebuilds task features/outcomes; `dataset`, `analyze`, `recommendation`, and `report` create the versioned local human-retry evidence views. |
| Cold start and quality guardrails | Every prompt gets a feedback line. Recommendations remain suppressed until configurable sample, completeness, reliability, effect-size, and model checks pass. Completion and final observed test/build outcomes guard interpretation. |

## Deliberately unavailable values

Platforms do not always expose exact active-context size, reasoning tokens, AI Credits, file line deltas, test counts, or durations. Those fields remain null. Code Buddy does not infer cost from a mutable pricing table and does not label character-based context estimates as actual provider usage.

## Compatibility

The existing `.code-buddy/copilot-session.jsonl` and `.code-buddy/interventions.jsonl` formats remain unchanged. Schema `1.1` adds event types without rewriting schema-`1.0` JSONL. Mixed streams validate and replay; legacy broad retry candidates are conservatively reprocessed only when metadata proves a prior and subsequent attempt.

The PRD's illustrative path used `.codebuddy/`. This implementation keeps the
product's established `.code-buddy/` root so installation does not create a
second hidden state directory; the `telemetry/raw`, future `tasks`, `models`,
and `profiles` tiers retain the proposed internal structure.
