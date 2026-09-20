# Task Card implementation, 2026-09-19

The developer approved an on-demand, minimizable Task Card for Codex and VS Code.
VS Code extension 0.10.6 and Codex plugin
`0.10.6+codex.20260919210904` implement a shared local evidence reader, card validation and
revision store, plus host entry points. Semantic task interpretation is downstream
of capture. Card generation is explicit and uses the active coding agent; opening,
minimizing, restoring and correcting a saved card do not invoke a model.

## Use

In VS Code, Code Buddy automatically opens its own Task Card beside the editor
for the latest captured GitHub Copilot session. That automatic action does not
inspect, open, or submit Copilot Chat. **Minimize** closes the panel for that VS
Code process and session; a new Copilot session opens its own card, and
restarting VS Code opens the latest captured session again. The status-bar **Task Card** control and
**Code Buddy: Open Task Card** command remain available to restore or manually
select a card. Choose a captured session, then click **Generate card**. The
extension prepares a bounded evidence snapshot and opens a request in Copilot
Chat for the developer to review and send. The agent reads evidence pages and
saves a cited revision through the local CLI. **Refresh** displays it;
corrections are appended without rewriting source logs. The panel can open each
cited JSONL row and export Markdown.

In a Codex task that has loaded the new plugin, ask Code Buddy to open the Task
Card. `task_card_open` supplies the MCP Apps UI resource and lets the developer
choose a saved card or captured session. The view's **Generate card / Update**
button prepares a snapshot and sends a follow-up request to the same conversation
using the MCP Apps bridge. The view includes **Minimize** and **Restore** controls.
If the Codex host does not render MCP Apps resources, the corresponding MCP tools
and local CLI still support the same card data, but the clickable Codex widget
has not been confirmed in this desktop runtime.

## Data and guarantees

- Selected Codex and Copilot transcript JSONL and versioned raw telemetry are
  read-only inputs. The reader emits stable source locators, visible dialogue,
  tool observations, usage scope and coverage warnings. It does not use recorder
  task IDs as grouping truth or read private reasoning.
- Card state lives under `.code-buddy/task-cards/<card-id>/`, separate from raw
  logs. Revisions are append-only; developer corrections remain in a separate
  history. Saving requires an expected revision, valid selected citations and
  the required task narrative sections. A completed status requires an observed
  acceptance claim.
- Each generation freezes the selected source byte boundaries first, so the
  generation run cannot cite its own later telemetry. Missing usage remains
  unavailable; request and cumulative counters are kept distinct.
- Legacy governance remains disabled by default. The new Task Card tools are
  available independently of those retired actions. No uploads or separate
  model API are involved.

## Verification and limits

The VS Code 0.10.6 VSIX was installed locally. Its status control, opening,
minimizing and restoring were observed in the live VS Code window. The shared
reader found the selected live Codex and Copilot sessions without coverage
warnings. Unit/protocol tests cover evidence isolation, revisions, corrections,
snapshot boundaries, disabled legacy tools and the Codex UI resource.

Codex UI rendering and the button-to-conversation bridge still need one check
in a newly started Codex task: the current task predates the plugin installation,
and Codex desktop computer-use access was denied. This is an explicit host
verification gap, not proof that the Codex widget renders. The VS Code request
is inserted into Copilot's composer for review; sending it and generation of a
live card were not performed during installation, so existing conversations and
capture logs were preserved.
