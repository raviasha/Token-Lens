# Code Buddy Individual Developer Workflow Design

## Scope

This release evolves Code Buddy from retrospective advice into an individual developer workflow that remains entirely inside VS Code. It preserves the current local hook capture, JSONL session log, Python analytics reports, prompt scoring, worktree deltas, and context instrumentation.

Included:

- Deterministic task preflight before a developer starts coding-agent work.
- Developer-initiated prompt enhancement through VS Code's supported Copilot Language Model API.
- Review, edit, approval, and lineage for original, enhanced, and final prompts.
- Context-strategy recommendations: Start Clean, Smart Context Handoff, and Continue Here.
- Local candidate filtering and developer-approved Copilot curation for Smart Context Handoff.
- Recommendation lifecycle, verification, versioned Estimated Context Load snapshots, and conservative individual value measurement.
- Local dashboard, data view/export, and privacy disclosure.

Explicitly deferred:

- Code Buddy Cloud, authentication, server-controlled paid entitlements, cloud policy/ranking intelligence, telemetry sync, organization pricing, tenant isolation, Teams, and Enterprise features.

## Architecture

`src/extension.ts` remains the VS Code composition root. Focused TypeScript modules provide deterministic preflight analysis, context-load reading, strategy selection, candidate filtering, supported language-model calls, recommendation lifecycle tracking, verification, a hash-chained local ledger, value calculations, and Markdown-based developer views.

The existing `hook.cjs` and `code_buddy.py` continue to collect and report retrospective analytics. The analytics path gains versioned per-turn Estimated Context Load snapshots while retaining schema-v2 records and current report behavior.

The local ledger records event metadata, hashes, scores, context estimates, verification evidence, and value calculations. It does not duplicate raw source, raw prompt, handoff, or model-response content by default. Existing local JSONL capture remains unchanged for compatibility and is only used for local analysis and a developer-authorized Copilot curation request.

## VS Code Experience

All interaction stays in VS Code using documented extension APIs:

1. `Code Buddy: Preflight Task` obtains a draft and presents deterministic findings.
2. The developer can improve the prompt, review context, edit it personally, or continue without blocking.
3. An explicit `Improve with Copilot` action selects a Copilot language model and requests a concise intent-preserving rewrite. The original and generated prompt are visible in a VS Code editor review tab, and the developer chooses/edit the final wording.
4. Context strategy recommends Start Clean, Smart Context Handoff, or Continue Here. Smart Handoff sends only locally selected candidates plus the next task to Copilot after explicit developer action, then opens the generated capsule for review/edit/approval.
5. The extension composes the approved handoff capsule and final task prompt, displays it in an editor tab, and uses VS Code's clipboard API. The developer starts a fresh Copilot chat and pastes/submits the payload. Code Buddy never injects into, scrapes, manipulates, or submits native Copilot chat UI.

The developer dashboard, data view, export, and privacy disclosure are local Markdown/JSON artifacts opened in VS Code editor tabs.

## Recommendation, Verification, and Value

Every actionable recommendation has an immutable ID and lifecycle events: generated, shown, accepted, applied, verification pending, verified/partially verified/not verified/not observable, and measured. A later observable Copilot prompt can verify a prepared final payload by its hash; unavailable evidence remains pending or not observable rather than being assumed.

Estimated Context Load snapshots use `estimated_tokens` when the existing visible-text estimator applies and persist `code_buddy_context_estimator_v1`. Context recommendations compare the previously observed context with the next observable turn. Smart Handoff includes its curation request load.

The individual value engine calculates only immediate, defensible context benefit:

`max(0, context_before - context_after - measurable_curation_overhead)`.

The ledger retains zero-value outcomes, provenance, estimator/pricing versions, and calculation method. A monetary amount is reported only when the developer has supplied applicable versioned local pricing; otherwise the dashboard reports verified estimated context avoided with monetary value unavailable. Prompt and task-quality interventions remain separate, non-monetary quality value.

## Failure and Privacy Behavior

Language-model selection and requests occur only from explicit developer actions, allowing VS Code/Copilot consent. If no model is available, access is denied, a request fails, or quota is exhausted, Code Buddy preserves the draft/capsule and offers manual editing. Incomplete hook data is labeled estimated, pending, or not observable. No individual core workflow depends on a cloud service.

The individual release is local-only: it sends no telemetry, source code, raw prompts, handoffs, repository files, or model responses to Code Buddy Cloud. Passing selected local candidates to the developer's chosen Copilot model happens only to fulfill the explicit enhancement/curation request.

## Test Strategy

New deterministic Node tests will cover prompt analysis, strategy choice, candidate filtering, recommendation transitions, prompt/context verification, value calculations, pricing selection, zero and negative outcomes, and ledger hash-chain integrity. Existing hook and Python analytics tests remain regression coverage and will be extended for the versioned context snapshot.
