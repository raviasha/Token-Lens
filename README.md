# Code Buddy

Code Buddy is a VS Code extension and Codex plugin that add transparent, developer-controlled governance and local analytics to coding-agent sessions.

It has four deliberately separate responsibilities:

1. **Hook capture:** deterministically records the Copilot events that VS Code supplies.
2. **Preflight enforcement:** allows investigation but prevents implementation until prompt quality, task scope, context-utilization, and session-fit checks complete, fail safely, or the developer approves a controlled fallback.
3. **Structured AI tools:** uses the selected VS Code language-model provider for prompt review, task decomposition, context measurement, session fit, and context curation.
4. **Local governance:** detects high actual context utilization when Codex exposes it (or high explicitly labeled Estimated Context Pressure otherwise), a likely new task within a chat, or the first meaningful prompt in a new chat and offers an appropriate handoff.

Code Buddy never silently replaces a prompt, automatically discards a conversation, or submits a new Copilot chat for the developer.

For the complete runtime sequence, component boundaries, state transitions,
local data model, policy resolution, and security boundaries, see the
[Code Buddy technical architecture](docs/code-buddy-technical-architecture.md).

## Shared project policy

Add an optional, trackable `code-buddy.yaml` at the project root to apply the
same policy to the VS Code extension and Codex plugin:

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

Code Buddy starts every meaningful coding task with one compact health line:
`prompt quality`, `task scope`, `context utilization`, and `session fit`.
Empty local context evidence is labeled **checked — limited evidence**;
it is never presented as actual context use. Raise `enhanceBelow` for more
prompt-enhancement suggestions; lower the other thresholds for stricter
decomposition, pressure, or fresh-task recommendations. A fresh-task
recommendation always offers **Curate for a fresh chat** or **Continue unchanged**—it never switches tasks automatically. Invalid YAML fields fall
back independently, and VS Code’s existing `tokenLens.*` settings remain the
fallback when YAML omits a value.

After every submitted prompt, Code Buddy also asks the coding model to show an
exact local evidence line beginning `Personalized recommendation —`. During
cold start this explicitly says that there is not enough data. Advice appears
only after the configurable comparable-task and reliability gates pass, and is
worded as an observed association rather than a causal or personalized claim.

## What's new in v0.9.0

- Codex context measurement now reads the latest local `token_count` event,
  displays `last_token_usage.input_tokens` as a percentage of
  `model_context_window` (the reported model context window), and retains the
  existing estimate only as fallback.
- Actual input tokens remain visible when Codex omits model capacity, but Code
  Buddy does not invent a percentage. Reading these local events consumes no
  model tokens and persists no raw rollout content.
- Every prompt now receives an explicit model-presented personalized-feedback
  status, including a clear **Not enough data yet** message during cold start.
- Schema-1.1 local telemetry distinguishes human-requested corrective retries
  from clarifications, extensions, new tasks, and agent-internal attempts.
- Comparable-task evidence uses descriptive comparisons and interpretable
  Poisson analysis, with negative-binomial fallback for overdispersion and
  test/build quality guardrails.
- VS Code adds raw telemetry, task replay, and human-retry evidence commands;
  Codex adds the read-only `analyze_human_retries` tool.
- Recommendation exposure, acceptance, and observed application remain
  separately linkable, local, metadata-derived, and fail-open.

## Download

Download the latest release from the [Code Buddy v0.9.0 release page](https://github.com/raviasha/Token-Lens/releases/tag/v0.9.0):

- `code-buddy-0.9.0.vsix` — VS Code extension installer.
- `code-buddy-0.9.0-SHA256SUMS.txt` — integrity checksum.

The v0.9.0 SHA-256 value published in the checksum file must match the downloaded VSIX.

### Codex plugin

Install the public Codex plugin from the [Code Buddy distribution
repository](https://github.com/raviasha/Code_Buddy). It contains only the
runtime plugin package; this Token Lens repository remains the development
source for the VS Code extension and Codex integration.

```bash
codex plugin marketplace add raviasha/Code_Buddy --ref main
codex plugin add code-buddy@code-buddy
```

Restart Codex, create a new task, and trust the Code Buddy hook when prompted.
The persistent **Plugins → Code Buddy → Enable/Disable** setting controls
whether Code Buddy runs in future tasks.

## Requirements

- VS Code 1.95 or newer.
- GitHub Copilot on a coding-agent surface that supplies the configured hook events and supports VS Code language-model tools.
- Python 3 as `python3` or `python` for Markdown reports and worktree analysis. Structured JSONL hook logging continues if Python is unavailable.

Hook and transcript availability can vary by Copilot surface and rollout.

## Task telemetry and lifecycle replay

Code Buddy writes an additive, versioned task event stream under:

```text
.code-buddy/
  telemetry/
    raw/
      events-YYYY-MM-DD.jsonl
    .state/
```

Schema `1.1` keeps `task_id`, `session_id`, and `interaction_id` separate. It
records task attribution and state, all four preflight scores and their active
thresholds, recommendation choices, follow-up and retry signals, context and
compaction checkpoints, exposed AI usage, and metadata-only tool, file, Git,
test, and build outcomes. Existing session and intervention logs remain
unchanged.

The default `standard` level stores behavioral metadata rather than source
code, prompt/response text, terminal output, or tool arguments. File identities
and repository roots are hashed. Raw prompts require both `diagnostic` level
and the separate `tokenLens.telemetry.captureRawContent` opt-in, and are still
passed through secret redaction. Telemetry is
local, validated before append, and fail-open: capture errors never stop the
coding agent.

Use **Code Buddy: Open Raw Task Telemetry** to reveal the daily JSONL files and
**Code Buddy: Replay Task Telemetry** to reconstruct a task by ID. From this
source checkout, the same replay and rebuild operations are available as:

```bash
node telemetry.cjs list "$PWD"
node telemetry.cjs replay "$PWD" task_...
node telemetry.cjs aggregate "$PWD" task_...
node telemetry.cjs validate "$PWD"
node telemetry.cjs dataset "$PWD"
node telemetry.cjs analyze "$PWD" task_...
node telemetry.cjs recommendation "$PWD" task_...
node telemetry.cjs report "$PWD" task_...
```

Use **Code Buddy: Open Human Retry Evidence** for the same Markdown evidence
report in VS Code. The `analyze_human_retries` MCP tool exposes the structured
read-only result to Codex.

See the [schema 1.1 specification](docs/telemetry-schema-v1.1.json), [legacy
schema 1.0 specification](docs/telemetry-schema-v1.json), [data
dictionary](docs/telemetry-data-dictionary.md), [raw-log
audit](docs/telemetry-raw-log-audit.md), and [synthetic acceptance
dataset](docs/examples/telemetry-events-v1.jsonl). The [Phase 1 human-retry
measurement guide](docs/human-retry-measurement.md) documents exact boundaries,
evidence gates, reprocessing, rollout, and non-goals.

## Install, upgrade, and remove

### Install

1. Download `code-buddy-0.9.0.vsix` and its checksum.
2. In VS Code, open **Extensions → Install from VSIX**.
3. Select `code-buddy-0.9.0.vsix`.
4. Reload the VS Code window.
5. Open the workspace where Code Buddy should operate.
6. Run **Code Buddy: Install Copilot Hooks** from the Command Palette.
7. Submit a meaningful prompt in a supported Copilot agent chat.

The extension is installed once in VS Code. The hook installation command must be run once in every workspace where Code Buddy should operate.

### What workspace installation changes

The installer:

- Creates or updates `.github/hooks/token-lens.json` with the supported hook registrations and the active Code Buddy settings.
- Adds or replaces only the marked Code Buddy section in `.github/copilot-instructions.md`.
- Preserves all unrelated workspace instructions.
- Removes the older managed `.github/instructions/code-buddy.instructions.md` file during migration.
- Migrates the default legacy `.token-lens/copilot-session.jsonl` path to `.code-buddy/copilot-session.jsonl` when possible.

`Code Buddy.md` and `Code Buddy Analytics.md` are generated reports. They are not agent instruction files.

### Upgrade

After installing a newer VSIX:

1. Reload the VS Code window.
2. Run **Code Buddy: Install Copilot Hooks** again in each active workspace so the hook path, settings, and managed instructions reference the new extension version.

### Remove

Run **Code Buddy: Remove Copilot Hooks**. Code Buddy removes its hook configuration and managed instruction section while preserving existing logs and reports.

## End-to-end operating lifecycle

For a normal meaningful coding prompt, the expected sequence is:

1. Copilot emits `UserPromptSubmit`.
2. Code Buddy writes `user.prompt`, captures the initial worktree baseline, and starts prompt-specific preflight with `preflight.started`.
3. The extension evaluates new-session and same-session task-boundary triggers from the latest meaningful prompt history and displays a choice only when warranted.
4. Managed instructions ask the coding agent to invoke `code-buddy_reviewPrompt`, `code-buddy_decomposeTask`, `code-buddy_measureContext`, and `code-buddy_assessSessionFit` with the unchanged original request, then display the compact health line.
5. Read, search, open, list, fetch, screenshot, question, and `tool_search` operations remain available during preflight.
6. If the agent attempts an edit, terminal command, file creation, or another non-observational action too early, `PreToolUse` denies it and records `preflight.gate_denied`.
7. Successful or safely failed Code Buddy evaluations write independent completion markers. Once all four required markers exist, Code Buddy records `preflight.completed` and a factual `health.check_completed` or `health.check_limited` event.
8. Copilot implementation continues normally.
9. Every hook observation also contributes metadata to the schema-1.1 task event stream, where it can be replayed or re-aggregated independently of the original conversation; existing schema-1.0 events remain readable.
10. When Copilot emits `Stop`, Code Buddy captures available transcript events, compares the worktree, records `turn.outcome` and `context.load_snapshot`, and refreshes both Markdown reports.
11. When live observation or the completed-turn snapshot crosses a context threshold, the extension verifies the measurement and offers context action only if the state remains warning or critical.

Small control replies such as `yes`, `continue`, `run it`, `retry`, or `cancel` record `preflight.skipped` and do not require semantic evaluation.

## Copilot hook events and Code Buddy responses

The workspace hook configuration subscribes to all events below. Every supplied event is written to `.code-buddy/copilot-session.jsonl`, even when Code Buddy intentionally takes no additional action.

| Copilot hook event | Session-log record | Code Buddy response |
| --- | --- | --- |
| `SessionStart` | `session.started` | Records the new session ID, source, model/version metadata, initial prompt when supplied, transcript path, timestamps, and workspace. This event alone does not open curation because an empty chat has no reliable target task. |
| `SessionEnd` | `session.ended` | Records the supplied end reason. It does not delete state, logs, or reports. |
| `UserPromptSubmit` | `user.prompt` | Records the prompt, starts or skips preflight, captures/extends the worktree baseline, and gives the extension a meaningful prompt to evaluate for new-session/new-task governance. |
| `UserPromptTransformed` | `prompt.transformed` | Records the original and transformed model-facing prompt when Copilot supplies both. It contributes to observed context estimates but does not silently change the developer's request. |
| `PreToolUse` | `tool.started` | Records the requested tool and input, then applies the deterministic preflight gate. Observational and Code Buddy tools pass; premature implementation tools are denied or moved to controlled fallback. |
| `PostToolUse` | `tool.completed` | Records the tool result. Prompt Reviewer and Task Decomposer completion updates independent preflight markers and may complete preflight. An approved controlled-fallback tool completion records `preflight.bypassed`. |
| `PostToolUseFailure` | `tool.failed` | Records the error. A failed Prompt Reviewer or Task Decomposer satisfies that preflight requirement through the safe-fallback contract, allowing the unchanged task to continue. |
| `Stop` | `agent.stopped` | Records the stop reason, captures and deduplicates an available transcript, computes observed worktree changes, writes the context snapshot, and refreshes feedback and analytics. |
| `SubagentStart` | `subagent.started` | Records subagent identity, type, parent/session information, and transcript path when supplied. No automatic intervention is forced. |
| `SubagentStop` | `subagent.completed` | Records the subagent response and stop reason and includes observed response text in context estimates. |
| `ErrorOccurred` | `error.occurred` | Records the redacted error, context, and recoverability signal. Hook logging remains fail-open. |
| `PreCompact` | `context.compacted` | Records that Copilot is about to compact context and any supplied trigger/custom instructions. It does not claim access to hidden compaction behavior. |
| `PostCompact` | `context.compaction_completed` | Records supplied after-compaction metadata and closes the task telemetry compaction checkpoint. Unavailable before/after values remain null. |

Unknown hook events are retained as `hook.event` rather than discarded.

## Deterministic preflight behavior

Preflight applies per meaningful prompt and per session.

### Required evaluations

By default, all four requirements must reach `completed` or safe `failed` status:

- Prompt Reviewer: `code-buddy_reviewPrompt`
- Task Decomposer: `code-buddy_decomposeTask`
- Context Measurement: `code-buddy_measureContext`
- Session Fit: `code-buddy_assessSessionFit`

Independent marker files under `.code-buddy/.state/preflight/` prevent concurrent tool completion from overwriting the other requirement.

### What can run while preflight is pending

Code Buddy allows tools whose names indicate observation or discovery, including common read, search, find, list, open, fetch, hover, screenshot, question, and `tool_search` operations. Code Buddy's own semantic tools are also allowed.

Edits, file creation, terminal execution, and other non-observational tools are implementation actions and must wait.

### Denial and controlled fallback

If an implementation tool arrives before preflight finishes:

1. Code Buddy denies it and records `preflight.gate_denied`.
2. The denial directs the agent to load missing deferred tools with `tool_search`, invoke them, and only then retry implementation.
3. After the configured number of denials, the next attempt records `preflight.fallback_requested` and asks the developer whether to continue with the original task under the controlled fail-open path.
4. If the developer approves and that implementation tool completes or fails, Code Buddy records `preflight.bypassed`.

Optional AI failure never permanently blocks coding. Invalid output, model unavailability, cancellation, or provider failure retains the original prompt/task and records `tool.failed` or `preflight.tool_failed` before preflight completes with fallback.

## Structured AI tools

Semantic tools use the active VS Code language-model provider. Their inputs and normalized results are validated against Code Buddy contracts before any recommendation is shown.

### Prompt Reviewer

Tool: `code-buddy_reviewPrompt`

Command: **Code Buddy: Review Prompt**

Triggered automatically for every meaningful prompt when enabled, or manually from the Command Palette.

It returns:

- A 0–100 score.
- Assessments for goal clarity, scope, relevant context, constraints, acceptance criteria, validation, ambiguity, and breadth where applicable.
- Issues, reasons, and improvement suggestions.
- Intent-preserving enhanced prompt options.
- An explicit **Continue with the original prompt** option.

When intervention is recommended, a Quick Pick lets the developer retain the original or choose an enhanced prompt. A chosen enhancement is copied to the clipboard for review; Code Buddy does not submit it automatically. Results record `prompt.reviewed`; failures record `tool.failed`.

### Task Decomposer

Tool: `code-buddy_decomposeTask`

Command: **Code Buddy: Decompose Task**

Triggered automatically for every meaningful task when enabled, or manually from the Command Palette.

It returns:

- A 0–100 complexity score.
- Reasons for the assessment.
- Dynamic decomposition strategies when decomposition would help.
- Ordered steps, objectives, dependencies, and optional validation suggestions.
- An explicit **Continue with the original task** option.

When decomposition is recommended, the developer can retain the original task, choose a strategy, use the complete plan, or choose a dependency-ready starting step. Results record `task.decomposition_evaluated`; failures record `tool.failed`.

### Context Measurement

Tool: `code-buddy_measureContext`

Command: **Code Buddy: Measure Context**

Measurement follows this strict order:

1. The latest native Codex `token_count` event associated with the current
   session or workspace.
2. A visually verified context indicator supplied only after an invoking agent actually reads one and vision verification is enabled.
3. Code Buddy's deterministic estimate from observed events.

For Codex, Code Buddy uses `last_token_usage.input_tokens` as the current
context numerator and `model_context_window` as the denominator. It never uses
cumulative `total_token_usage` for this percentage. Native values are labeled
**Actual Context Utilization**. If the window is absent, the actual input-token
count is shown and the percentage is unavailable. Fallback values are labeled
**Estimated Context Pressure**, use `estimated_tokens`, and do not represent
billing or exact context-window use. Results record `context.measured`;
failures fall back to the best honest estimate available.

### Context Curator

Tool: `code-buddy_curateContext`

Command: **Code Buddy: Curate Context**

The manual command is an explicit fallback. The primary curation entry points are automatic context-pressure, new-session, and same-session new-task triggers.

The curator produces minimum-sufficient task context and allows the developer to:

1. Keep or remove proposed items.
2. Preserve automatically pinned items.
3. Choose additional items to pin.
4. Add one missing fact.
5. Preview the complete Markdown handoff.
6. Accept and copy it or cancel without changing the chat.

The bundle can contain background, decisions, constraints, relevant files, implementation state, completed/remaining work, issues, validation, open questions, and explicitly excluded history. Accepted curation records `context.curation_completed` with item counts and destination metadata.

Code Buddy cannot insert or submit content into native Copilot Chat through a supported API. It copies the approved handoff; the developer pastes and submits it.

### Fresh-task handoff gate

An accepted **fresh-task** handoff starts with a Code Buddy marker and creates
local pending-handoff state. In a different chat, Code Buddy waits before any
file inspection, command, or implementation until the developer either pastes
the marked bundle or submits exactly:

`Code Buddy: continue without curated context`

Pasting the bundle records `context.handoff_pasted`; the explicit continuation
records `context.handoff_bypassed`. The source chat that created the handoff
continues normally, and **Curate current task** never creates a waiting state.

## Automatic governance and curation triggers

### 1. New Copilot session

Trigger conditions:

- `tokenLens.context.offerCurationOnNewSession` is enabled.
- A prior meaningful prompt exists in the workspace session log.
- The current meaningful prompt has a different known session ID.
- The current prompt has not already been processed for a boundary offer.

Opening an empty chat is not enough because the supported surface does not provide a reliable target-task event. The trigger runs on the new chat's first meaningful submitted prompt. Control replies are ignored.

Response:

- Records `session.boundary_detected`.
- Offers **Carry forward curated context** or **Start without prior context**.
- Records `session.boundary_choice`.
- If accepted, opens the editable curation flow and copies the approved handoff for pasting into the already-open new chat. The target chat waits for that marked bundle or the explicit no-context continuation before it advances.

The processed prompt ID is kept in VS Code workspace state to avoid repeating the same offer after a reload.

### 2. Likely new task in the existing session

Trigger conditions:

- `tokenLens.context.offerCurationOnNewTask` is enabled.
- Both prompts are meaningful and have the same known session ID.
- The current prompt is not an explicit continuation beginning with terms such as `continue`, `next`, `now`, `also`, `then`, `build on`, `following up`, or `same task`.
- Both prompts contain at least two task-specific terms.
- Task-term overlap is below 0.20.

Response:

- Records `task.boundary_evaluated` with overlap, confidence, and reason.
- If it is likely a new task, offers **Curate for a fresh chat** or **Continue unchanged**.
- Records `task.boundary_choice`.
- If accepted, opens the editable curation flow and copies a marked handoff for a fresh chat. That fresh chat waits for the bundle or the explicit no-context continuation before it advances.

This is a deterministic lexical task-boundary cue, not a claim of perfect semantic classification. The developer always chooses what happens next.

### 3. Warning or critical context pressure

Trigger conditions:

- The current session snapshot crosses the configured warning or critical threshold.
- A follow-up measurement still reports a non-normal threshold state.
- A session/task boundary offer is not already being shown for the same update.

Response:

- Records `context.measured` and `context.warning`.
- Offers **Start fresh with curated context**, **Curate current task**, or **Continue unchanged**.
- Records `context.warning_choice`.
- Starts curation only when the developer chooses it.

Warning and critical defaults are 70% and 85%. For a native Codex measurement,
they apply to the actual input-token/model-window ratio. The 40,000-token
setting is used only by the fallback estimate and is not a claim about the
selected model's actual context window.

## Workspace files and local state

| Path | Purpose |
| --- | --- |
| `.github/hooks/token-lens.json` | Copilot hook registrations and extension-version-specific command/environment configuration. |
| `.github/copilot-instructions.md` | Existing workspace instructions plus the marked Code Buddy governance section. |
| `.code-buddy/copilot-session.jsonl` | Schema-v2 hook, transcript, preflight, worktree, and context records. |
| `.code-buddy/interventions.jsonl` | Schema-v1 semantic evaluations, governance triggers, choices, fallbacks, and failures. |
| `.code-buddy/.state/` | Local transcript deduplication, worktree baseline, and per-prompt preflight markers. |
| `.code-buddy/telemetry/raw/` | Immutable daily schema-1.1 task event stream used for replay and derived datasets; schema 1.0 remains readable. |
| `.code-buddy/telemetry/.state/` | Privacy-safe task attribution, interaction, sequence, recommendation, and compaction state. |
| `Code Buddy.md` | Concise next-prompt feedback refreshed after a completed main-agent turn. |
| `Code Buddy Analytics.md` | Detailed session, context, intervention, event, and observed worktree report. |

Add `.code-buddy/` to the target repository's `.gitignore`. Reports may also contain prompt or file information and should be committed only intentionally.

## Session-log record reference

Every session record includes a stable `eventId`, `recordType`, `sessionId`, timestamps, workspace, normalized `data`, and a redacted `rawPayload` when supplied.

### Direct hook records

`session.started`, `session.ended`, `user.prompt`, `prompt.transformed`, `tool.started`, `tool.completed`, `tool.failed`, `agent.stopped`, `subagent.started`, `subagent.completed`, `error.occurred`, `context.compacted`, `context.compaction_completed`, and fallback `hook.event`.

### Preflight records

`preflight.started`, `preflight.skipped`, `preflight.gate_denied`, `preflight.tool_completed`, `preflight.tool_failed`, `preflight.completed`, `preflight.fallback_requested`, and `preflight.bypassed`.

### Transcript-derived records

When a readable absolute transcript path is supplied and capture is enabled:

- `assistant.turn_start` becomes `turn.started`.
- `assistant.message` remains `assistant.message`.
- `assistant.turn_end` becomes `turn.ended`.
- Other transcript types become `transcript.event` with their original type in `sourceEventType`.
- Malformed lines become `transcript.parse_error`.
- Each capture produces `transcript.snapshot`; unreadable transcripts produce `transcript.snapshot_error`.

Source event IDs are persisted so repeated transcript reads do not duplicate normalized events.

### Analytics records

- `turn.outcome` — observed added, modified, and deleted files plus exact line counts when available.
- `context.load_snapshot` — latest native Codex input-token utilization and
  token components when available; otherwise deterministic Estimated Context
  Pressure and its observable signals.

## Intervention-log event reference

The intervention log records why Code Buddy acted and what the developer selected:

- Semantic tools: `prompt.reviewed`, `task.decomposition_evaluated`, `context.measured`, `context.curation_completed`, and `tool.failed`.
- Session/task governance: `session.boundary_detected`, `session.boundary_choice`, `task.boundary_evaluated`, and `task.boundary_choice`.
- Context governance: `context.warning` and `context.warning_choice`.
- Preflight governance: every `preflight.*` record listed above.

Semantic events include `invocationSource`:

- `language_model_tool` — invoked by the coding agent through a Code Buddy tool.
- `command_or_governance` — invoked manually from the Command Palette or by deterministic governance after a developer choice.

VS Code **Chat Debug** may show internal provider calls as `copilotLanguageModelWrapper`. The JSONL records contain the exact Code Buddy tool names and invocation source.

## Commands

| Command | Result |
| --- | --- |
| **Code Buddy: Install Copilot Hooks** | Installs or refreshes workspace hooks and managed agent instructions. |
| **Code Buddy: Remove Copilot Hooks** | Removes Code Buddy's hook configuration and managed instruction section; keeps logs/reports. |
| **Code Buddy: Open Session Log** | Opens `.code-buddy/copilot-session.jsonl`. The Code Buddy status-bar item runs this command. |
| **Code Buddy: Open Feedback** | Opens `Code Buddy.md`. |
| **Code Buddy: Open Analytics** | Opens `Code Buddy Analytics.md`. |
| **Code Buddy: Open Hook Configuration** | Opens `.github/hooks/token-lens.json`. |
| **Code Buddy: Open Agent Instructions** | Opens `.github/copilot-instructions.md`. |
| **Code Buddy: Open Intervention Log** | Opens `.code-buddy/interventions.jsonl`. |
| **Code Buddy: Open Raw Task Telemetry** | Reveals `.code-buddy/telemetry/raw/`. |
| **Code Buddy: Replay Task Telemetry** | Reconstructs one task lifecycle from raw events in a Markdown editor. |
| **Code Buddy: Open Human Retry Evidence** | Opens the local task-cohort reliability and association report. |
| **Code Buddy: Review Prompt** | Runs Prompt Reviewer manually and copies a selected enhancement. |
| **Code Buddy: Decompose Task** | Runs Task Decomposer manually and displays strategies/steps. |
| **Code Buddy: Measure Context** | Displays the best available actual or estimated context measurement. |
| **Code Buddy: Curate Context** | Starts developer-requested fresh-task curation manually. |

## Configuration

Settings remain under the `tokenLens` namespace for upgrade compatibility.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `tokenLens.logFile` | `.code-buddy/copilot-session.jsonl` | Session JSONL path, relative to the active workspace unless absolute. |
| `tokenLens.redactSensitiveData` | `true` | Redacts common secret-looking keys and token formats before local persistence. |
| `tokenLens.captureTranscripts` | `true` | Captures readable transcript content supplied by Copilot and deduplicates its events. |
| `tokenLens.hookTimeoutSeconds` | `10` | Hook command timeout, constrained to 1–30 seconds. |
| `tokenLens.feedbackFile` | `Code Buddy.md` | Concise feedback report path. |
| `tokenLens.analyticsFile` | `Code Buddy Analytics.md` | Detailed analytics report path. |
| `tokenLens.trackWorktreeChanges` | `true` | Enables before/after worktree comparison around a turn. |
| `tokenLens.snapshotMaxFileSizeBytes` | `1000000` | Largest text file retained temporarily for exact line comparison; constrained to 10,000–10,000,000. |
| `tokenLens.pythonCommand` | empty | Explicit Python executable; empty tries `python3`, then `python` (`python`/`py -3` on Windows). |
| `tokenLens.interventionLogFile` | `.code-buddy/interventions.jsonl` | Structured intervention/choice log path. |
| `tokenLens.promptReview.enabled` | `true` | Requires automatic Prompt Reviewer evaluation for meaningful prompts. |
| `tokenLens.promptReview.interventionThreshold` | `75` | Scores below this value recommend prompt intervention. |
| `tokenLens.taskDecomposition.enabled` | `true` | Requires automatic task-complexity evaluation for meaningful prompts. |
| `tokenLens.taskDecomposition.interventionThreshold` | `65` | Complexity scores at or above this value recommend decomposition. |
| `tokenLens.preflight.enforceBeforeImplementation` | `true` | Enables deterministic preflight enforcement. |
| `tokenLens.preflight.denialsBeforeFallback` | `1` | Denials before an explicit controlled-fallback approval is offered; constrained to 1–5. |
| `tokenLens.telemetry.enabled` | `true` | Enables the local schema-1.1 task event stream. Capture remains fail-open. |
| `tokenLens.telemetry.level` | `standard` | Selects `minimal`, `standard`, or `diagnostic` event detail. |
| `tokenLens.telemetry.captureRawContent` | `false` | Allows raw prompts only when level is also `diagnostic`. |
| `tokenLens.telemetry.directory` | `.code-buddy/telemetry` | Raw event, derived-data, and attribution-state root. |
| `tokenLens.humanRetry.minimumComparableTasks` | `8` | Completed same-type/same-complexity tasks required before advice can be considered. |
| `tokenLens.humanRetry.minimumTasksPerFactor` | `5` | Complete observations required to fit one factor. |
| `tokenLens.humanRetry.reliabilityThreshold` | `0.60` | Minimum combined local evidence score before advice is shown. |
| `tokenLens.humanRetry.minimumEffectSize` | `0.15` | Minimum absolute count-model coefficient for advice. |
| `tokenLens.humanRetry.overdispersionThreshold` | `1.50` | Pearson dispersion above which analysis falls back from Poisson to negative binomial. |
| `tokenLens.context.estimatedContextCapacityTokens` | `40000` | Denominator used only for Estimated Context Pressure; minimum 1,000. |
| `tokenLens.context.warningThreshold` | `0.70` | Actual context-utilization ratio, or fallback estimated-pressure ratio, that triggers warning behavior. |
| `tokenLens.context.criticalThreshold` | `0.85` | Actual context-utilization ratio, or fallback estimated-pressure ratio, that triggers critical behavior; never lower than warning. |
| `tokenLens.context.allowVisionVerification` | `true` | Accepts a visually verified indicator only when an invoking visual agent actually supplies one. |
| `tokenLens.context.offerCurationOnNewSession` | `true` | Offers prior-context carry-forward on the first meaningful prompt with a different known session ID. |
| `tokenLens.context.offerCurationOnNewTask` | `true` | Offers a task-specific fresh-chat handoff for a deterministic same-session task boundary. |

Reload VS Code after changing runtime policies. Run **Code Buddy: Install Copilot Hooks** again after changing settings used by the hook so its environment is refreshed.

## What Code Buddy measures

- Prompt quality and selectable semantic improvements.
- Task complexity and dependency-aware decomposition strategies.
- Submitted and transformed prompt text that the supported surface exposes.
- Tool requests, results, failures, errors, subagent responses, and transcript events that are supplied.
- Observed textual characters and approximate tokens using four characters per token.
- Native Codex input, cached-input, output, reasoning, total, cumulative usage,
  and model-window fields when present. Current context percentage uses only
  last-input usage divided by the model window.
- Files referenced in captured records.
- Net files and lines added, modified, or deleted between the initial prompt baseline and main-agent stop.
- Per-turn actual Codex context utilization where available, plus fallback
  Estimated Context Pressure, model-interaction estimates, and repeated
  prior-context estimates.
- Semantic recommendations, developer choices, safe fallbacks, and accepted curation metadata.

## Privacy, attribution, and limitations

- Code Buddy has no cloud telemetry service. Session logs, the task telemetry pipeline, state, and reports stay local to the workspace.
- Semantic tools use the active VS Code language-model provider. Prompts and relevant context supplied to those tools are therefore processed under that provider's terms.
- Redaction is conservative but cannot guarantee removal of every sensitive value. Review logs before sharing them.
- Transcript capture can contain conversation content. Disable `tokenLens.captureTranscripts` for sensitive or large transcripts.
- Worktree metrics are observed before/after deltas, not proof that Copilot authored every change. Concurrent manual or external edits can be included.
- A file created and deleted before `Stop` has no lasting worktree delta and cannot be reported as changed.
- Exact line counts can be unavailable for binary, oversized, unreadable, or truncated files.
- Code Buddy cannot access hidden system prompts, model-internal reasoning, undocumented provider state, or data Copilot never supplies.
- Native Codex token-count events are local runtime measurements, not billing
  statements. The fallback Estimated Context Pressure is not exact
  active-context utilization or the model's advertised context window.
- Opening an empty native Copilot chat is not a reliable trigger. New-session curation begins with the first meaningful submitted prompt.
- Code Buddy cannot create, seed, paste into, or submit a native Copilot chat automatically. It produces an approved clipboard handoff.
- Cloud-agent files can be ephemeral; local reports are useful only when hooks and the extension can access the same workspace/log paths.

## Troubleshooting and verification

### Code Buddy tools do not appear

1. Confirm **Code Buddy 0.9.0** is installed.
2. Reload VS Code.
3. Run **Code Buddy: Install Copilot Hooks** in the active workspace.
4. Open **Code Buddy: Open Agent Instructions** and confirm the marked governance section exists.
5. Open **Code Buddy: Open Hook Configuration** and confirm its command points to the installed 0.9.0 extension directory.
6. Use a supported Copilot agent mode and submit a meaningful prompt rather than a control reply.

### New-session curation does not appear

The workspace must already contain a prior meaningful prompt in its Code Buddy session log. The new chat must then submit a meaningful prompt with a different known session ID, and `tokenLens.context.offerCurationOnNewSession` must be enabled. Merely opening an empty chat does not trigger it.

### Tool calls are visible only as `copilotLanguageModelWrapper`

That is the provider-facing label shown by Chat Debug. Open the session and intervention logs and search for:

- `code-buddy_reviewPrompt`
- `code-buddy_decomposeTask`
- `invocationSource: "language_model_tool"`
- `preflight.completed`

### Prompt review or decomposition reports invalid output

Code Buddy rejects malformed structured output, records `tool.failed`, retains the original prompt/task, marks the requirement as safely failed, and lets preflight finish with fallback.

### Markdown reports do not update

Confirm Python 3 is available or configure `tokenLens.pythonCommand`. JSONL hook logging continues even when Python analytics cannot run.

### Useful proof sequence

A complete governed implementation normally produces:

1. `preflight.started`
2. `tool.started` / `tool.completed` for `code-buddy_reviewPrompt`
3. `preflight.tool_completed` or `preflight.tool_failed`
4. `tool.started` / `tool.completed` for `code-buddy_decomposeTask`
5. `preflight.tool_completed` or `preflight.tool_failed`
6. `preflight.completed`
7. Implementation `tool.started` / `tool.completed`
8. `agent.stopped`
9. `turn.outcome`
10. `context.load_snapshot`

## Development and validation

```sh
npm install
npm test
```

The v0.9.0 suite covers hook/report regression behavior, worktree deltas,
redaction, transcript deduplication, structured contracts, developer-controlled
preflight and handoffs, schema-1.0/1.1 compatibility, exact human-retry
boundaries, recommendation linkage, cold-start feedback, Poisson and
negative-binomial analysis, quality guardrails, and VS Code/Codex runtime
parity.
