# Phase 1 Human Retry Measurement

Phase 1 is a local, metadata-derived evidence system. It does not train an ML
model and it does not claim that any measured factor causes retries.

## Exact outcome

`human_retry_count` increments once when all of these are observed:

1. A material implementation attempt exists for the task.
2. The developer submits a same-objective correction or explicit retry with
   task-match confidence of at least 0.75.
3. The request asks for a material change rather than an explanation.
4. The agent completes a subsequent material implementation attempt.

A material attempt is emitted once per interaction at agent stop. Strong
evidence includes a successful file change, repaired test/build, successful
commit, or observed worktree delta. An agent response to a material request is
accepted at lower confidence because some hosts do not expose file changes.

| Boundary | Exact count |
| --- | ---: |
| Correction followed by another material attempt | +1 |
| Explicit human `retry` followed by another material attempt | +1 |
| Clarification or explanation request | 0 |
| Extension/new requirement/scope change | 0 |
| New task | 0 |
| Validation-only request | 0 |
| Multiple tool calls or autonomous retries in one interaction | 0 |

The broad `retry_detected` event remains for compatibility and audit. It does
not directly increment the exact outcome.

## Analytical record

`human-retry-task-v1` derives one row per task. Its initial-condition features
are prompt clarity, initial complexity, decomposition recommendation, context
pressure, session fit, acceptance-criteria presence, fresh-session state, and
initial token observations. It separately records decomposition acceptance and
observed application, recommendation exposure/acceptance/application, exact
and candidate retries, completion, and final observed test/build outcomes.

Analyses use completed tasks of the same task type and initial complexity as
the current task. Missing measurements remain null and reduce evidence
completeness; they are not imputed as zero.

## Evidence and presentation

Each factor is analyzed independently with a count model. Poisson is used by
default. When Pearson dispersion exceeds `overdispersionThreshold`, the model
is refit using a negative-binomial variance. Results expose sample size,
coefficient, incident-rate ratio, 95% confidence interval, dispersion, and
convergence. The report also shows lower/upper feature-group sample sizes and
mean retry counts before presenting the model association.

Reliability combines comparable sample sufficiency, feature completeness,
confirmed retry evidence, fitted-model coverage, and final test/build outcome
coverage. A candidate recommendation also needs the expected direction, the
minimum effect size, and no observed final test/build pass-rate regression
when that comparison is evaluable.

The reported evidence-strength state is `insufficient` before the comparable
task minimum, `emerging` below the reliability threshold, `moderate` when the
threshold passes but no stable actionable association exists, and `strong`
only when a recommendation passes every gate.

Every prompt receives exactly one model-presented line beginning
`Personalized recommendation —`. The line remains a cold-start or
low-reliability status until the gates pass. Recommendation wording says
`associated with` and ends with `This is observational, not causal.`

## Policy

```yaml
version: 1
measurement:
  humanRetries:
    minimumComparableTasks: 8
    minimumTasksPerFactor: 5
    reliabilityThreshold: 0.60
    minimumEffectSize: 0.15
    overdispersionThreshold: 1.50
```

VS Code exposes the same values under `tokenLens.humanRetry.*`. Hook installers
copy resolved values into the local hook environment so capture and feedback
use the same policy.

## Interfaces

```bash
node telemetry.cjs dataset /absolute/workspace
node telemetry.cjs analyze /absolute/workspace [task_id]
node telemetry.cjs recommendation /absolute/workspace [task_id]
node telemetry.cjs report /absolute/workspace [task_id]
```

VS Code provides **Code Buddy: Open Human Retry Evidence**. The Codex MCP server
provides read-only `analyze_human_retries`. Both consume the same local JSONL.

## Compatibility and reprocessing

Schema `1.1` is additive. Readers validate mixed `1.0`/`1.1` streams and never
rewrite append-only events. A schema-`1.0` retry candidate is confirmed during
reprocessing only when attempt evidence exists both before and after it. Task
records disclose whether retry and attempt values came from direct `1.1`
detection or conservative legacy reprocessing.

## Staged rollout

1. Ship capture, dataset, and explicit cold-start feedback with the default
   eight-task/60% gate.
2. Audit detector precision and missing-feature/test coverage locally using
   `dataset` and `report`; adjust policy, not historical raw events.
3. Enable evidence-backed advice only as individual workspaces cross their
   configured gate.
4. Revisit multivariable or hierarchical analysis only after comparable
   cohorts are large enough and separately specified.

## Non-goals

- ML training, prediction services, or cloud telemetry.
- Causal claims or claims about individual developer ability.
- Ranking developers or comparing workspaces.
- Reading prompt/response/source content at standard telemetry level.
- Counting agent-internal attempts, tool errors, or every correction phrase as
  a human retry.
- Automatic prompt changes, decomposition, task switching, or handoff use.
