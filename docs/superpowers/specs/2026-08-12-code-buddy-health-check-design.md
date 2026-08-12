# Code Buddy Always-Visible Health Check Design

## Goal

For every meaningful coding request, Code Buddy must visibly identify its
participation even when it recommends no intervention. The VS Code extension
and Codex plugin must apply the same project policy and present four checks:

1. prompt quality;
2. task scope and decomposition suitability;
3. Estimated Context Pressure; and
4. session fit (whether a fresh task would be clearer).

The check remains advisory: Code Buddy must preserve the original request,
never create a task automatically, and offer curation only after the developer
chooses it.

## User-visible behavior

After the four checks finish, the agent begins its coding response with one
compact Code Buddy line. The line names every check even when it is
satisfactory. For example:

```text
Code Buddy: prompt quality satisfactory · task scope satisfactory · estimated context pressure satisfactory · session fit satisfactory
```

Each non-satisfactory result replaces only its segment with a concise,
actionable status:

- `prompt quality: enhancement available`;
- `task scope: decomposition recommended`;
- `estimated context pressure: warning — curation available`; or
- `session fit: fresh task recommended — curated handoff available`.

The assistant shows the existing original-preserving choices only when prompt
enhancement, decomposition, or curation is recommended. A status line alone
does not interrupt the task.

Small control replies (`yes`, `continue`, `retry`, and similar) retain the
existing no-preflight behavior and do not receive a health line.

## Shared project policy

`code-buddy.yaml` at the workspace root is the single, optional, committed
policy file used by both clients. It is deliberately separate from the
generated `.code-buddy/` logs and state, which remain local and normally
ignored by Git.

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
```

Defaults preserve the current extension policy. A project can become stricter
by raising `enhanceBelow`, or lowering the task-scope, context-pressure, or
session-fit thresholds.

Configuration precedence is:

1. a valid value in `code-buddy.yaml`;
2. existing `tokenLens.*` VS Code settings for the extension only, to preserve
   upgrade compatibility; then
3. the built-in defaults.

The Codex plugin has no VS Code settings fallback and uses YAML values or its
built-in defaults. Invalid, unknown, out-of-range, or internally inconsistent
values (for example, `criticalAt < warningAt`) must not disable governance.
Code Buddy records a local configuration diagnostic, reports a concise warning,
and falls back only for the invalid field.

The YAML reader supports the documented mapping/scalar schema and comments.
It rejects advanced YAML constructs rather than interpreting them differently
between the Node and Python runtimes. The parser and policy validation must be
covered by shared-value fixtures so the two clients resolve the same policy.

## Calibrated scoring

Prompt quality, task scope, and ambiguous session fit use a versioned Code
Buddy rubric with short calibration examples. The rubric supplies score bands,
not hard-coded answers: the semantic evaluator must still assess the actual
request and return its reasons.

### Prompt quality

The semantic evaluator returns a 0–100 quality score and the existing prompt
dimensions. Calibration examples establish these bands:

| Example shape | Expected range | Default action |
| --- | ---: | --- |
| Focused task with outcome, scope, constraints, and validation | 85–100 | satisfactory |
| Clear outcome but missing context or acceptance details | 65–84 | satisfactory unless the evaluator identifies a material issue |
| Vague request such as “make it better” | 0–64 | enhancement available |

The semantic result can recommend an intervention regardless of score; the
project threshold also recommends one when `score < enhanceBelow`.

### Task scope

The evaluator returns a 0–100 complexity score and must include a usable
strategy whenever it recommends decomposition. Calibration examples establish:

| Example shape | Expected range | Default action |
| --- | ---: | --- |
| One localized change with a test | 0–44 | satisfactory |
| Several related changes in one feature | 45–64 | satisfactory |
| Cross-cutting feature, migration, or independent deliverables | 65–100 | decomposition recommended |

An explicit model recommendation still takes precedence over the numeric
threshold. If semantic evaluation is unavailable, the current deterministic
action/segment/cross-cutting heuristic supplies the result.

### Estimated Context Pressure

Context is never semantically scored. Code Buddy measures a complete provider
value only when available; otherwise it estimates pressure from observable
local records. The result is always labelled **Estimated Context Pressure** for
the latter case. The configured capacity denominator and warning/critical
ratios classify the measurement as satisfactory, warning, or critical.

The four-check preflight always invokes context measurement for a meaningful
coding request. An unavailable or empty local record set becomes a
low-confidence estimate, not a claim that the actual active context is zero.
The health line says `estimated context pressure checked — limited evidence`
for that state.

### Session fit

Session fit returns a `newTaskLikelihood` score from 0–100, a confidence, and
a reason. Calibration examples establish:

| Prior/current relationship | Expected range | Default action |
| --- | ---: | --- |
| “Add tests” after implementing the same component | 0–24 | satisfactory |
| Follow-up sharing a subsystem but adding a related concern | 25–74 | satisfactory, retain current task |
| Unrelated feature after prior task is complete | 75–100 | fresh task recommended |

Clear continuation language (`continue`, `also`, `following up`, and the
existing equivalents) resolves to satisfactory without semantic escalation.
For ambiguous cases, Codex supplies a semantic assessment that considers the
current request and relevant recent task summary. If it is unavailable, the
existing lexical-overlap rule is the conservative fallback. A new Codex session
with prior local context remains a separate, explicit carry-forward decision.

## Implementation architecture

### Codex plugin

1. Add a policy loader shared by the hook and Python MCP server.
2. Extend the MCP surface with session-fit assessment and ensure all four
   check results are persisted to `.code-buddy/interventions.jsonl`.
3. Extend the preflight state from two requirements to four: prompt review,
   task decomposition, context measurement, and session fit.
4. Update the `UserPromptSubmit` hook context to require those tools and to
   require the visible health line before substantive work.
5. Build health-line text from structured results, preserving accurate labels
   for measurements, fallback evidence, and recommendations.
6. Keep current handoff gating, developer choices, and controlled fail-open
   behavior unchanged.

### VS Code extension

1. Add the same policy loader and use YAML values ahead of existing settings.
2. Add a session-fit service/tool and include context measurement in the
   meaningful-request workflow.
3. Persist a four-check health summary that the managed Copilot instructions
   require the agent to present at the start of its response.
4. Retain the existing extension notifications only for recommendations;
   satisfactory checks add no toast noise.
5. Keep existing commands and `tokenLens.*` settings as compatible fallbacks.

### Rubric and release consistency

The calibration rubric is a versioned source asset with shared fixtures. Both
clients consume the same score-band language and examples. The release flow
copies the resulting Codex plugin assets into both the personal-plugin source
and the repository's downloadable `codex-plugin/` marketplace bundle before
cache-busting and reinstalling the plugin.

## Failure handling

- Missing `code-buddy.yaml`: use defaults with no warning.
- Invalid YAML or policy value: record the diagnostic, retain valid fields,
  fall back per invalid field, and continue normal work.
- Semantic tool failure: keep the original request and use the existing safe
  fallback; the status line identifies limited/failed assessment rather than
  falsely saying satisfactory.
- Context measurement with insufficient local records: show limited evidence,
  never `0 tokens` as an actual-context claim.
- No prior meaningful task: session fit is satisfactory with `no prior task to
  compare`, and never recommends a handoff solely because evidence is absent.

## Verification

Tests will cover:

1. YAML defaults, overrides, invalid fields, and precedence in both clients;
2. calibrated semantic request payloads and deterministic fallback score bands;
3. four-check preflight completion, no-action health line, and each
   recommendation variant;
4. low-evidence context wording and accurate estimate terminology;
5. explicit continuation, semantic fresh-task recommendation, and lexical
   fallback session-fit decisions;
6. preservation of original prompt/task options, curation choices, controlled
   fallback, and fresh-handoff gating; and
7. synchronization/validation of the downloadable Codex plugin bundle.
