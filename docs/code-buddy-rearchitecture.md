# Code Buddy rearchitecture

## Migration map

| Area | Decision | Result |
|---|---|---|
| Schema-v2 hook capture and redaction | Retain | Existing local records, transcript deduplication, and failure-tolerant hook behavior remain compatible. |
| Worktree snapshots and Markdown reports | Retain and extend | Existing metrics remain; reports prefer native Codex context utilization and retain versioned Estimated Context Pressure snapshots as fallback. |
| Prompt-quality and task-size heuristics | Retain only as retrospective labels | They no longer represent semantic live evaluation. Structured AI tools own prompt review and decomposition. |
| Thresholds and triggers | Refactor | Policy lives in typed configuration and is passed to the hook through environment settings. |
| Agent orchestration | Add | A managed workspace instruction requests evaluation, and a deterministic preflight gate enforces completion before implementation while skipping tiny control replies. |
| Semantic evaluation | Add | Prompt Reviewer, Task Decomposer, Context Measurement, and Context Curator expose structured contracts. |
| Provider support | Add | Capability and measurement-provider interfaces preserve API → vision → estimate ordering. |
| Developer interaction | Add | Quick Picks, pin/remove/add controls, previews, original options, cancel/close behavior, and manual fresh-chat copy preserve user control. |
| Intervention analytics | Add | `.code-buddy/interventions.jsonl` records evaluations, options, choices, warnings, curation metadata, and failures locally. |

## Runtime boundaries

Deterministic governance owns event capture, observable counters, worktree metrics, thresholds, session/task-boundary cues, trigger generation, analytics, and fallback estimation. It does not rewrite prompts or infer semantic decompositions.

Session and task boundaries are deliberately separate. A different known session ID plus prior meaningful prompt context produces a `new_session` carry-forward offer on the new chat's first meaningful prompt. Low task-term overlap produces a `new_task` assessment only when both meaningful prompts have the same known session ID. Control replies trigger neither path.

The agent instruction requests orchestration. A per-prompt hook gate owns enforcement: it permits observation, denies non-observational implementation tools until required semantic evaluations finish, and offers an explicit controlled fallback rather than permanently blocking coding.

The four language-model tools own semantic judgment. Their outputs are normalized and validated before the extension renders choices. Invalid output never changes the user's task.

For every meaningful prompt, `UserPromptSubmit` creates per-prompt governance state. `PostToolUse` and `PostToolUseFailure` write independent completion markers for the Prompt Reviewer and Task Decomposer. This marker design remains correct if semantic tool calls complete concurrently. The session and intervention logs distinguish `language_model_tool` invocations from manual command/governance invocations.

## Capability-aware limitations

The GitHub Copilot/VS Code adapter has hook-based event access, language-model
tool support, and Quick Pick support. It does not claim native complete
active-context measurement, visual screen inspection from the extension, or
automatic fresh-chat seeding. The Codex adapter additionally reads local
`token_count` rollout events.

Consequently:

- Codex native measurements use `last_token_usage.input_tokens` divided by
  `model_context_window`; cumulative usage is not a context-pressure value.
- Other complete native measurements are accepted only from a provider that
  explicitly supplies them.
- An invoking agent may supply a visual measurement only after actually reading a visible indicator and when vision verification is enabled.
- Otherwise the result is `estimate` and is labeled **Estimated Context Pressure**.
- Fresh-task curation produces an approved clipboard payload; the developer opens and submits the new chat.
- When a new chat is already open, Code Buddy can detect its first meaningful prompt and copy curated prior context for the developer to paste there; merely opening an empty chat is not observable through the supported surface.

## Failure invariants

- Prompt Reviewer failure retains the original prompt.
- Task Decomposer failure retains the original task.
- Measurement failure uses the Code Buddy estimate when available.
- Curator failure preserves the current session.
- Invalid structured output is rejected.
- No optional AI failure blocks the hook or normal coding.

## Acceptance coverage

| Requirement | Implementation evidence |
|---|---|
| Deterministic measurement is separate from semantic judgment | `src/observability`, `src/core/policyEngine.ts`, and `code_buddy.py` contain observable metrics; `src/ai` owns semantic contracts and model requests. |
| Meaningful prompts are evaluated automatically | The managed section requests the tools, and a stateful `PreToolUse` gate prevents implementation until Prompt Reviewer and Task Decomposer completion/failure markers exist or the developer approves a controlled fallback. |
| Good prompts/tasks avoid interruption | Presenters open only when structured results recommend intervention. |
| Weak prompts and large tasks receive selectable alternatives | Tool results contain dynamic prompt options/decomposition strategies and Quick Pick selections. |
| Original prompt/task is always available | Normalizers add deterministic `original` options; all failure paths select or retain them. |
| Context values are labeled honestly | Schema-v2 `context.load_snapshot` records use `tokens` and `Actual Context Utilization` for matching native Codex events; fallbacks keep `estimated_tokens`, `measurementMethod: estimate`, and `Estimated Context Pressure`. Missing native capacity never produces an invented percentage. |
| Measurement uses the best provider | `ContextMeasurementService` orders API, vision, and estimate providers and preserves method/confidence. |
| High context can produce a curated handoff | Governance verifies the measurement, offers three user choices, and starts the previewable curation workflow. |
| New sessions can trigger curation | A different known session ID on the first meaningful prompt emits `session.boundary_detected`, offers carry-forward or a clean start, and copies an accepted handoff for the already-open chat. |
| New tasks can trigger curation | Within the same known session, deterministic task-term overlap emits a boundary evaluation and optional fresh-task flow. |
| Curation is minimum-sufficient and editable | Curator instructions exclude irrelevant history; UI supports remove, pin, add, preview, accept, and cancel. |
| Decisions and selections are logged locally | `.code-buddy/interventions.jsonl` records structured options, choices, measurements, warnings, metadata, and failures. |
| Providers remain extensible | Provider capability and measurement-provider interfaces isolate GitHub Copilot/VS Code-specific availability. |
| Existing behavior remains compatible | Schema-v2 hooks, legacy log migration, worktree deltas, reports, and regression tests remain in place. |
