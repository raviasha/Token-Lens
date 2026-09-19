# Live Task Card for Codex

## Purpose

Make the Task Card a useful companion during a Codex task. Every new task should
attempt to open an expanded card for its current Codex session; historical cards
remain available only when the developer deliberately opens History.

## Confirmed requirements

- The live card is scoped to the active Codex session, not inferred recorder task
  identifiers and not a collection of older sessions.
- The card opens expanded when a new task begins, when the task is reopened, and
  after Codex restarts.
- Minimize is temporary UI state for the current rendered panel only. It is not
  persisted locally and does not affect another task.
- Refresh reloads the saved card and current evidence availability. It must not
  silently ask a model to rewrite the card.
- Generate/Update remains a developer action. It freezes the selected current
  session's evidence and requests a cited revision from the current agent.
- Older cards/sessions are visible only through a History affordance and never
  replace the live card's current-session scope.
- Raw telemetry remains immutable and local. A card revision retains citations
  to captured evidence and corrections remain separately stored.

## Architecture

### Task-start bridge

Codex currently exposes an MCP Apps resource only after an agent calls
`task_card_open`; its hook API cannot force a native panel to open. On the first
meaningful user prompt for a session, the Code Buddy hook will therefore inject a
small, idempotent instruction directing the active agent to open the live card
for that exact session and workspace. The instruction carries no telemetry
contents and does not trigger card generation.

The hook stores an ephemeral per-session "open requested" marker under the
existing local state directory. The marker prevents repeated open instructions
within the same running task. A `SessionStart` event for that session deletes
its prior marker before the next meaningful prompt, so reopening a task or
restarting Codex requests an expanded card again. Failure to surface the panel
must never block work; the instruction is the supported best-effort bridge
until Codex provides an explicit auto-open UI lifecycle API.

### MCP card API

Add a live-card entry point that accepts an explicit Codex `sessionId` and
workspace. It resolves or creates one card whose scope is exactly that session.
It returns the card plus live-session metadata needed by the UI (current scope,
whether captured evidence has changed since the saved revision, and the history
list). It must not alter a developer-created multi-session historical card.

`task_card_open` remains backwards compatible for opening a supplied card or
creating a developer-selected historical scope. A live-session call is distinct
from generic session selection.

### UI resource

The card resource has two modes:

1. **Live:** default after the task-start bridge. Shows a clear Current task
   label, current-session identity, Refresh, Generate/Update, Minimize, and a
   History control.
2. **History:** a developer-entered list of saved cards and captured sessions.
   Opening history is read-only with respect to the live card. A return control
   restores the current live card.

Minimize and restore use in-memory DOM state only. A new resource instance
starts expanded. Refresh calls the card-open/read path again, reports evidence
changes, and leaves the saved revision unchanged. Generate/Update preserves the
current cited-draft workflow and asks the agent to save a new optimistic
revision.

## Data flow

1. Codex receives the first meaningful user prompt in session S.
2. Code Buddy captures the prompt and injects the single live-card-open request
   for S.
3. The agent calls the live-card MCP operation with S and the absolute workspace.
4. The MCP server resolves/creates the S-only card and returns UI data.
5. The UI displays the expanded live card. New capture continues independently.
6. Refresh re-reads the card/evidence metadata. Generate/Update freezes evidence
   and prompts the same active agent for a cited revision.

## Error handling and privacy

- Missing/unknown session IDs return a clear local error and leave existing
  cards unchanged.
- If the hook, agent, or UI host does not complete auto-open, coding continues;
  the developer can invoke the card manually.
- Concurrent saves retain the current expected-revision guard.
- UI state is never written as task-card evidence or persistent preference.
- The feature neither enables diagnostic/raw-content collection nor changes
  capture policy.

## Tests

- Hook tests: one open instruction on the first meaningful prompt, no duplicate
  within the active session, no instruction on irrelevant lifecycle events.
- MCP tests: live scope creates/reuses only the named session card; historical
  behavior remains compatible; missing session is rejected safely.
- UI tests: live layout contains Current task and History; minimize does not
  persist; Refresh does not invoke generation; Generate/Update retains its
  existing prompt bridge.
- Regression tests: capture-only mode, immutable raw evidence, corrections, and
  optimistic revision validation continue to work.

## Out of scope

- Automatic semantic grouping across tasks or sessions.
- Automatic narrative generation or background model calls.
- Persisted minimized state or a global hide preference.
- A truly host-native auto-open panel; this needs future Codex lifecycle support.
