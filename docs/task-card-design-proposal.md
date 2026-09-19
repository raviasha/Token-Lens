# Local task cards — design proposal

Status: approved and implemented locally on 2026-09-19; the text below is the original proposal. See [Task Card implementation](task-card-implementation.md) for the delivered behavior and remaining Codex host verification.

## Widget revision, 2026-09-19

The developer now requests a clickable widget in both Codex and VS Code.
The card opens on demand, and the developer can minimize it. This replaces
Markdown as the primary viewing experience in the original proposal below.
Markdown remains an export and accessible evidence view. The existing evidence,
card-content, correction and local-storage requirements still apply.

The [widget design and delivery proposal](task-card-widget-proposal.md) records
the revised interaction, host feasibility requirements and delivery milestones.
Planning is authorized; the complete implementation design is still proposed.

## Intended result

A developer asks their existing Codex or Copilot agent to create or update a
local task card during work or after it. The card explains the goal, recorded
agreement, changing requirements, observed progress and one useful next action.
It cites evidence and states what is missing. No separate model API, scoring,
automatic task grouping, uploads or team dashboard.

## Smallest approach

Recommend a shared evidence reader plus an agent-authored JSON card rendered as
Markdown. Both hosts use the same reader, schema, validation and renderer.
This is smaller than two custom UI panels and makes evidence review possible in
the editors already in use. A prompt-only template would be smaller still, but
would not reliably preserve citations, corrections or stable card identity.

Keep implementation under `task-cards/`, independent of capture hooks. The
recorder never imports it and never creates or updates cards automatically.
The module reads versioned telemetry and companion Copilot/Codex session JSONL
files. It never modifies them or treats recorder-derived task IDs as truth.

## Evidence and scope

The MVP requires developer-selected session(s), source turn(s) or a time range.
Every card has an independent UUID. Scope membership is an editable list of
evidence IDs, so one turn can support multiple cards and a card can span sessions.

Each evidence item includes platform, source file, source line/record hash,
session/turn/message/call/parent IDs when exposed, timestamp, kind, visible
content, capture status and provenance. A source locator is not a fabricated
provider ID. Preserve both patch and worktree observations; reconcile them only
in this reader. Legacy and normalized observations can reference the same
underlying source without counting it twice.

Read snapshots of the selected files and record byte limits/hash information.
Invalid or partial trailing rows produce coverage warnings, never silent
completion. Large selected histories use a manifest and paged evidence access;
record which pages the agent actually read. Do not scan unrelated sessions or
silently omit earlier context. Missing, disabled, redacted, truncated and partial
history remain distinct.

## Card contract

- Goal, constraints, acceptance criteria and unresolved questions as evidenced
  at the beginning of the selected scope.
- Pre-implementation agreed specification with citations, or “not recorded.”
- Requirement changes with supporting turns: addition, clarification,
  replacement or withdrawal. Explain causes separately: omitted requirement,
  ambiguity, failure to follow an existing requirement, discovery, deliberate
  scope change or unclear reason. Later discoveries never become retrospective
  initial requirements.
- Evolving summary and status. A completion snapshot requires acceptance
  evidence; an assistant assertion, successful tool invocation and verified
  criterion are separate evidence kinds. Stop/commit alone is insufficient.
- Observed outcomes, a brief reflection, one evidence-backed next action and
  an optional suggested prompt.
- Descriptive provider usage only when attributable without overlap. Preserve
  missing values; never substitute context estimates or infer efficiency/cost.

Every substantive claim has evidence references and an evidence basis
(`observed`, `assistant_assertion`, `inferred`, or `developer_correction`).
An unresolved criterion stays unverified rather than being silently omitted.

## Storage and host entry points

Use `.code-buddy/task-cards/<card-id>/` for `scope.json`, append-only revision
JSON, `corrections.jsonl` and a rendered `card.md`. Raw logs stay separate.
Corrections reference stable claim IDs and retain developer wording; updates
apply them without overwriting their history. Derived cards can be regenerated.

Codex: extend the capture skill with an explicit on-demand card workflow and
small evidence-read/card-save tools. Copilot: a matching command or explicitly
invoked language-model tool offers the same workflow to the existing chat agent.
The active agent authors the analysis through its current conversation; neither
adapter calls an external LLM API or reinstates legacy preflight services.

Validate the agent's JSON and evidence references before atomic save. Invalid
output leaves the last valid revision intact and reports concrete errors back
to the invoking agent. The Markdown view links to cited local source locations.

## Proposed implementation order

1. Shared read-only evidence adapters and coverage manifest. Test actual
   observed host shapes, overlap, missing history and source reference stability.
2. Card/revision/correction schema, validator and Markdown renderer. Test
   unresolved citations, unsupported completion, correction survival and atomic
   replacement of the derived view.
3. On-demand Codex entry point using the existing agent; validate a manually
   scoped card against source turns.
4. Copilot entry point using the same module and contract; verify identical
   evidence/validation behavior in a freshly reloaded host.

Before implementation, approve this design and resolve the live hook-readiness
steps in `task-card-session-audit-2026-09-19.md`. No task-card code was added in
the capture correction pass.
