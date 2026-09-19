# Task card widget: design and delivery proposal

Date: 2026-09-19. Status: approved and implemented locally. The VS Code widget has been opened, minimized and restored in the installed host. The Codex MCP Apps resource and tools pass protocol tests, but this desktop session cannot verify rendering because its running plugin snapshot predates the installation and computer-use access to Codex is unavailable.

The proposal and milestones below are retained as the original design record. Current implementation and use are described in [Task Card implementation](task-card-implementation.md).

## Agreed intent

Provide a clickable task-card widget in both Codex and VS Code/Copilot.
The developer opens it when needed and can minimize and restore it.
Generate or update the card using the coding agent the developer already uses.
The card helps explain the work so far and choose the next useful action.

The existing [task-card proposal](task-card-design-proposal.md) defines the
evidence and content contract. This document replaces its Markdown-first UI
choice and expands its host entry-point and delivery sections. It does not
approve product implementation or replace the raw-log capture system.

## Recommended approach and alternatives

Use one shared card engine and view, with small host-specific adapters. This
keeps evidence interpretation, corrections and the card's meaning consistent,
while letting each host supply its supported controls and agent connection.

Two alternatives were considered:

- Separate implementations of the whole feature in each host: easier to tailor
  independently, but risks divergent evidence, validation and corrections.
- A standalone local browser dashboard: reusable across hosts, but adds another
  surface and does not itself satisfy the requested integrated widget.

The recommendation is a shared view with host adapters. A browser-only or
command-only substitute must not silently count as delivery of the Codex widget.

## Interaction

1. A **Task Card** entry opens the card. Opening a saved card reads local data
   and does not invoke a model. First open shows the selected scope and
   **Generate card** when no card has been saved.
2. The scope defaults to the current conversation only when its identity can
   be established. Otherwise, show a session picker with host, timestamp and a
   short recorded request. Do not select whichever shared log was written last.
   **Change scope** allows selected sessions/turns; scope is displayed before
   generation and is separate from heuristic recorder task IDs.
3. **Generate card** or **Update card** sends an explicit request to the existing
   coding agent with a bounded evidence snapshot and the card contract. The
   widget shows progress and supports cancellation where the host exposes it.
   If the host requires sending from its composer, make that step visible.
4. Show the last valid card during an update. A completed, validated update
   becomes a new revision; a failure or cancellation preserves the last revision
   and any developer corrections. Duplicate clicks do not create duplicate runs.
5. **Minimize** collapses the view to a compact Task Card control. **Restore**
   reopens the same card, scope and revision without rerunning analysis. Minimize
   does not cancel a run. Run progress/error remains available on restore.
6. When new selected evidence exists, show **New activity available** and an
   explicit Update action. Do not regenerate on every prompt, Stop, editor open,
   restore or file change. Restore after a host restart reads the saved card;
   stale in-progress state is reconciled rather than displayed indefinitely.

If the agent is busy, use a supported queue or show that generation is waiting
for it to become available. Do not interrupt coding or start a different agent
silently. Host identity/session binding and this busy-state behavior are part
of the first feasibility milestone.

## Card contents

The compact view presents the task title, observed progress, last update and
one evidence-backed next action. Expanded sections show:

- Initial goal, constraints, acceptance criteria and unresolved questions.
- The recorded specification/agreement, or that none was recorded.
- Requirement changes with source turns and an explanation of the change.
- Observed work, verification evidence and criteria still unverified.
- A short reflection, recommended next action and optional suggested prompt.
- Descriptive provider usage and coverage limits.

**View evidence**, **Change scope**, **Correct interpretation**, **Update**,
**Export Markdown** and **Minimize** are explicit controls. Corrections are
saved with stable claim IDs and survive generation. A suggested prompt can be
reviewed in the host chat before sending; it is not automatically executed.
Use accessible keyboard controls and the host's light/dark styling.

The card must distinguish observations, assistant assertions, inferences and
developer corrections. A Stop or successful command never establishes that
all acceptance criteria passed. Missing usage stays unavailable, not zero.

## Components and data flow

The shared module remains under `task-cards/` and is independent of capture:

`Selected scope -> evidence snapshot -> current agent -> validated revision -> widget`

- **Evidence reader:** reads versioned telemetry and companion Codex/Copilot
  transcripts with byte boundaries, source locators and explicit coverage.
  Exposes visible dialogue and tool evidence; excludes private reasoning and
  system/developer message bodies, including when historical transcripts contain
  those fields. Treat captured text as evidence, never executable instructions.
- **Normalizer:** links overlapping observations without deleting raw records,
  retains original identities and uncertainty, and avoids summing request and
  cumulative usage. Semantic grouping remains here/downstream, outside capture.
- **Card contract and validator:** validates structure, evidence references,
  claim basis, correction identity and revision consistency. Structural checks
  cannot prove every natural-language claim; citations permit developer review.
- **Local repository:** stores scope, append-only revisions, correction history,
  generation requests and a derived Markdown view under
  `.code-buddy/task-cards/<card-id>/`. Compare the expected revision before save
  so concurrent Codex and VS Code updates cannot silently overwrite each other.
- **Shared view:** renders saved card data and dispatches typed actions through
  a host adapter. It does not parse the raw logs or independently call an LLM.
- **Host adapter:** binds workspace/session identity, opens/minimizes/restores
  the view, sends an explicit generation request and opens evidence locations.

Snapshot boundaries are fixed before generation. Evidence emitted by the card
generation run itself does not feed back into that same revision. Future runs
retain provenance for card-generation activity so it is not mistaken for
implementation or independent acceptance evidence.

## Host support and unresolved feasibility

**VS Code:** a contributed Task Card view with a webview can support the
on-demand interface. A status-bar/command entry opens it; collapse/hide and
restore are explicit UI behaviors. VS Code documents webview views in sidebar
and panel areas in its [Webview API](https://code.visualstudio.com/api/extension-guides/webview).
Current `src/extension.ts` has a capture status-bar item but no card view.
Keep capture/log access available when adding the card entry.

The button-to-existing-Copilot-chat connection must be verified against the
installed host. A direct `vscode.lm` request is a separate model invocation and
does not establish reuse of the current coding conversation. Do not reuse the
legacy `models[0].sendRequest` workflow as if it met this requirement.

**Codex:** the existing local plugin supplies skills, MCP tools and lifecycle
hooks. OpenAI's [plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
allows optional UI resources; its [UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)
describes MCP Apps rendering and follow-up messages for compatible hosts, with
explicit ChatGPT support. These docs do not establish that this installed local
Codex host supports the complete widget, persistent launcher, minimize/restore
and UI-to-agent interaction required here.

The first delivery milestone must verify that exact local path. Do not promise
an arbitrary permanent Codex sidebar or assume ChatGPT iframe support proves
Codex support. If inline UI is supported, it may satisfy on-demand viewing with
a compact minimized state; if only an in-app panel is available, validate its
launcher and agent bridge. Report the supported surface before finalizing the
adapter. An unsupported widget is a product feasibility issue, not a reason to
upload logs or introduce a separate model API.

## Delivery milestones

1. **Prove both host interactions.** After design approval, use isolated fixtures
   to verify launch, generate-request dispatch to the selected agent, busy state,
   result display, minimize and restore in each installed host. Record supported
   host versions and any required extra user gesture. Do not proceed with an
   assumed Codex UI bridge or alter the live capture/trust settings for this test.
2. **Build shared evidence access.** Add bounded readers, source identities,
   overlap handling and coverage tests using sanitized real host shapes. Include
   partial rows, rotated files, missing source fields and absent Copilot usage.
   Fix ordinary-prose over-redaction with secret-protection regression coverage
   separately in capture; never rewrite historical logs. Preserve reliable
   platform provenance despite historical stale editor labels.
3. **Build card revisions and validation.** Implement the contract, cited claims,
   corrections, atomic saves, conflict handling and Markdown export. Test that
   invalid output, cancellation and concurrent updates preserve the last valid
   card and correction history.
4. **Build the shared widget and host adapters.** Implement the interaction
   above using the verified host bridges, including empty, generating, ready,
   stale, minimized, unavailable and error states. Register on-demand card tools
   independently of the disabled legacy governance features.
5. **Verify end to end and package locally.** Generate a card from a selected
   Codex session and one from Copilot, inspect citations, make a correction,
   update, minimize/restore and restart. Check keyboard/theme behavior, absent
   usage, busy-agent behavior and duplicate clicks. Confirm existing logs,
   reports and capture-only settings are preserved. Packages include the same
   shared engine and UI assets, excluding developer logs and generated cards.

The executable, file-by-file implementation plan follows review of this revised
design and resolution of the host feasibility approach. No runtime, package,
trust configuration or task-card product code was changed during planning.
