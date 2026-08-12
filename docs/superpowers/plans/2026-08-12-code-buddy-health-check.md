# Code Buddy Always-Visible Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Code Buddy’s prompt quality, task-scope, Estimated Context Pressure, and session-fit assessment on every meaningful coding task, using a shared project YAML policy and calibrated rubric in both VS Code and Codex.

**Architecture:** An optional root `code-buddy.yaml` supplies project thresholds. Valid YAML values override built-in defaults and, in VS Code only, legacy settings remain the fallback. Four structured checks complete before substantive work; the agent then starts with a concise Code Buddy health line. The repository bundle is the source of truth and is synchronized to the installed personal plugin only at release.

**Tech Stack:** TypeScript VS Code extension, Node.js CommonJS hooks/tests, Python standard-library MCP server, strict dependency-free YAML subset parser, local Codex plugin marketplace.

## Global Constraints

- Support only documented YAML mappings, booleans, integers, decimals, and comments. Reject tabs, sequences, anchors, aliases, multiline values, duplicate keys, and unknown shape.
- Preserve defaults: prompt enhancement below `75`, decomposition at or above `65`, capacity `40000`, warning `0.70`, critical `0.85`, and lexical session-fit fallback below `0.20` overlap.
- A project becomes stricter by raising `enhanceBelow` or lowering task-scope, context-pressure, or session-fit thresholds.
- Preserve original prompt/task options, controlled fallback, handoff marker, explicit no-context continuation, and developer-controlled curation.
- Use **Estimated Context Pressure** for estimates. Empty local evidence is low-confidence **limited evidence**, never an actual-context zero claim.
- Control replies remain silent and do not receive four-check preflight.
- Do not edit `/Users/rampetaravishankar/plugins/code-buddy` until the release task. It must receive a mechanically synchronized, tested repository bundle.

---

## File structure

- `src/core/projectPolicy.ts` parses/validates root YAML and merges it over legacy policy.
- `src/core/contracts.ts` and `src/core/policyEngine.ts` define health-check/session-fit contracts and threshold helpers.
- `src/resources/code-buddy-scoring-rubric.json` is the canonical VS Code score-band/few-shot asset.
- `src/ai/toolContracts.ts`, `src/ai/services.ts`, `src/ai/tools.ts`, and `src/agentInstructions.ts` add semantic session fit, four checks, rubric-backed instructions, and the health-line rule.
- `hook.cjs`, `src/hookInstaller.ts`, `src/runtime/governance.ts`, `src/runtime/workflow.ts`, and `code_buddy.py` recognize four completed checks and persist/report factual status.
- `codex-plugin/plugins/code-buddy/scripts/project_policy.cjs` and `project_policy.py` implement the same strict YAML contract for Codex’s hook/MCP server.
- `codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py` adds policy-aware checks and `assess_session_fit`; `hooks/code_buddy_hook.cjs` requires all four MCP tools.
- Root and plugin tests prove policy fixtures, preflight, safe failures, session-fit choices, and release parity.

### Task 1: Add strict YAML policy and calibrated-score foundations

**Files:**

- Create: `src/core/projectPolicy.ts`
- Create: `src/resources/code-buddy-scoring-rubric.json`
- Create: `test/project_policy.test.js`
- Create: `test/fixtures/code-buddy-policy-fixtures.json`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/policyEngine.ts`
- Modify: `src/config.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

**Interfaces:**

- `loadProjectPolicy(workspacePath, legacyPolicy): ProjectPolicyLoad`
- `ProjectPolicyLoad = { policy: CodeBuddyPolicy; diagnostics: ProjectPolicyDiagnostic[] }`
- `shouldRecommendFreshTask(newTaskLikelihood, policy): boolean`
- `CodeBuddyPolicy.healthCheck.showOnEveryMeaningfulCodingTask`
- `CodeBuddyPolicy.sessionFit.recommendFreshTaskAtOrAbove` and `fallbackLexicalOverlapBelow`

- [ ] **Step 1: Write failing parser and threshold tests**

Create fixture-driven tests. The valid fixture writes this exact workspace file:

```yaml
version: 1
thresholds:
  promptQuality:
    enhanceBelow: 90
  estimatedContextPressure:
    warningAt: 0.50
```

Assert that only supplied fields override defaults. Add a malformed relationship case:

```yaml
version: 1
thresholds:
  estimatedContextPressure:
    warningAt: 0.70
    criticalAt: 0.40
```

Test that the valid `warningAt` is retained, invalid `criticalAt` returns to `0.85`, and a diagnostic names `thresholds.estimatedContextPressure.criticalAt`. Add direct threshold assertions:

```js
assert.equal(shouldRecommendFreshTask(75, DEFAULT_POLICY), true);
assert.equal(shouldRecommendFreshTask(74, DEFAULT_POLICY), false);
assert.equal(classifyContext(0.70, DEFAULT_POLICY), 'warning');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build && node --test test/project_policy.test.js
```

Expected: FAIL because the loader, diagnostics, and session-fit policy fields do not exist.

- [ ] **Step 3: Implement the minimum strict parser and merge**

Implement a line-oriented parser in `src/core/projectPolicy.ts`: strip comments, accept two-space nested mappings and scalar values, reject unsupported YAML syntax, and return diagnostics rather than throw. Validate every documented field independently. Add:

```ts
healthCheck: { showOnEveryMeaningfulCodingTask: true },
sessionFit: {
  recommendFreshTaskAtOrAbove: 75,
  fallbackLexicalOverlapBelow: 0.20
}
```

to `DEFAULT_POLICY`. Map YAML values onto existing threshold fields: `enhanceBelow` → prompt-review threshold, `decomposeAtOrAbove` → task-decomposition threshold, and the three context values → existing context policy fields. Make `getCodeBuddyPolicy` produce legacy VS Code values first and merge root YAML last. Enable `resolveJsonModule` and create `src/resources/code-buddy-scoring-rubric.json` with the approved score bands for focused/vague prompts, localized/cross-cutting tasks, and continuation/unrelated tasks.

- [ ] **Step 4: Verify focused and existing policy behavior**

Run:

```bash
npm run build && node --test test/project_policy.test.js test/rearchitecture.test.js
```

Expected: PASS. Missing YAML is quiet; invalid fields fall back individually; valid shared policy overrides only specified fields.

- [ ] **Step 5: Commit the policy foundation**

```bash
git add src/core/projectPolicy.ts src/core/contracts.ts src/core/policyEngine.ts src/config.ts src/resources/code-buddy-scoring-rubric.json test/project_policy.test.js test/fixtures/code-buddy-policy-fixtures.json tsconfig.json package.json
git diff --cached --check
git commit -m "feat: add shared Code Buddy policy"
```

### Task 2: Add semantic session fit and the four-check VS Code contract

**Files:**

- Modify: `src/core/contracts.ts`
- Modify: `src/core/policyEngine.ts`
- Modify: `src/ai/toolContracts.ts`
- Modify: `src/ai/services.ts`
- Modify: `src/ai/tools.ts`
- Modify: `src/agentInstructions.ts`
- Modify: `package.json`
- Modify: `test/rearchitecture.test.js`

**Interfaces:**

- `SessionFitInput { prompt; previousPrompt?; sessionId?; taskId?; relevantContext? }`
- `SessionFitResult { kind: 'session_fit'; status; newTaskLikelihood; confidence; reason; freshTaskRecommended; assessmentSource }`
- `SessionFitService.assess(input, token)`
- `code-buddy_assessSessionFit` language-model tool, referenced as `#tool:codeBuddySessionFit`

- [ ] **Step 1: Write failing session-fit and instruction tests**

Add to `test/rearchitecture.test.js`:

```js
const result = normalizeSessionFit({
  newTaskLikelihood: 82,
  confidence: 'high',
  reason: 'CSV export is unrelated to authentication.'
}, {
  prompt: 'Build a CSV export endpoint in src/reports/exportController.ts.',
  previousPrompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts.'
}, DEFAULT_POLICY);

assert.equal(result.freshTaskRecommended, true);
assert.equal(result.assessmentSource, 'codex_model');
```

Also assert that `sessionFitFallback` returns likelihood `0` for “Continue authentication work and add expiry tests.” and that `buildCodeBuddyAgentInstructions()` contains `#tool:codeBuddyContextMeasurement`, `#tool:codeBuddySessionFit`, `Code Buddy:`, and `Estimated Context Pressure`.

- [ ] **Step 2: Run the focused test to verify it fails**

```bash
npm run build && node --test test/rearchitecture.test.js
```

Expected: FAIL because no session-fit contract/tool or four-check instruction exists.

- [ ] **Step 3: Implement calibrated session fit**

Add `buildSessionFitRequest`, `normalizeSessionFit`, and `sessionFitFallback` to `src/ai/toolContracts.ts`. The semantic JSON contract is:

```ts
{ newTaskLikelihood: number, confidence: 'high' | 'medium' | 'low', reason: string }
```

Embed compact examples from `code-buddy-scoring-rubric.json` in the request. A model recommendation is actionable only through `shouldRecommendFreshTask`; no model prose can create a task. Fallback reuses existing continuation and lexical overlap logic. With no prior meaningful prompt, return satisfactory with reason `No prior meaningful task to compare.`

Add `SessionFitService`, its language-model tool registration, its package contribution, and `session.fit_evaluated` logging. Update managed instructions to call Prompt Reviewer, Task Decomposer, Context Measurement, and Session Fit before substantive work, then begin with exactly:

```text
Code Buddy: prompt quality <status> · task scope <status> · estimated context pressure <status> · session fit <status>
```

The instruction must use `checked — limited evidence` for empty/fallback context estimates and concise action words for recommendations.

- [ ] **Step 4: Verify VS Code semantic contracts**

```bash
npm run build && node --test test/rearchitecture.test.js
npm test
```

Expected: PASS. The rubric reaches semantic requests, explicit continuation is satisfactory, and the public language-model tools stay compatible.

- [ ] **Step 5: Commit the semantic-check layer**

```bash
git add src/core/contracts.ts src/core/policyEngine.ts src/ai/toolContracts.ts src/ai/services.ts src/ai/tools.ts src/agentInstructions.ts package.json test/rearchitecture.test.js
git diff --cached --check
git commit -m "feat: add Code Buddy session fit checks"
```

### Task 3: Extend VS Code governance, hook gating, and reports to four checks

**Files:**

- Modify: `hook.cjs`
- Modify: `src/hookInstaller.ts`
- Modify: `src/runtime/governance.ts`
- Modify: `src/runtime/workflow.ts`
- Modify: `code_buddy.py`
- Modify: `test/hook.test.js`
- Modify: `test/governance.test.js`
- Modify: `test/code_buddy.test.js`

**Interfaces:**

- Meaningful preflight requirements: `promptReviewer`, `taskDecomposer`, `contextMeasurement`, `sessionFit`.
- Hook tool names: `code-buddy_reviewPrompt`, `code-buddy_decomposeTask`, `code-buddy_measureContext`, `code-buddy_assessSessionFit`.
- Final records: `health.check_completed` or `health.check_limited`, holding categories rather than raw prompts.

- [ ] **Step 1: Write failing four-check hook tests**

Modify the current preflight test so implementation stays denied after the first two tool completions and succeeds only after:

```js
runHook({ hook_event_name: 'PostToolUse', session_id, tool_name: 'code-buddy_measureContext', tool_use_id: 'context-1', tool_result: { status: 'fallback' } }, environment, directory);
runHook({ hook_event_name: 'PostToolUse', session_id, tool_name: 'code-buddy_assessSessionFit', tool_use_id: 'fit-1', tool_result: { status: 'ok', freshTaskRecommended: false } }, environment, directory);
```

Assert the final event contains every terminal requirement and `health.check_limited` when context was fallback. Add a governance test where `session.fit_evaluated` is over the configured threshold: the UI offers **Curate for a fresh chat** and **Continue unchanged**, and calls `workflow.curate` only for the former choice. Add report assertions for factual session-fit/limited-evidence output.

- [ ] **Step 2: Run focused tests to verify they fail**

```bash
npm run build && node --test test/hook.test.js test/governance.test.js test/code_buddy.test.js
```

Expected: FAIL because the current hook has only two requirements and no health-summary events.

- [ ] **Step 3: Implement four-requirement lifecycle behavior**

Add context/session-fit recognizers and labels in `hook.cjs`. Replace fixed two-name loops with iteration over the state requirement keys. A failed semantic tool remains a terminal safe fallback and never blocks the original request forever.

In `src/hookInstaller.ts`, resolve YAML-first policy before writing hook environment values; export context thresholds, `TOKEN_LENS_SESSION_FIT_THRESHOLD`, and `TOKEN_LENS_HEALTH_CHECK_VISIBLE`, never raw YAML. In `src/runtime/governance.ts`, prefer completed `session.fit_evaluated` results over recomputing a conflicting lexical boundary. Retain lexical detection only as a fallback. `ContextMeasurementTool` records each model-invoked estimate; `CodeBuddyWorkflow.measureContext(false)` remains the manual/governance helper and shows no normal-result notification.

Update `code_buddy.py` to summarize four actual recorded statuses. It must never claim `satisfactory` after a failed semantic check or actual context utilization from an estimate.

- [ ] **Step 4: Verify VS Code lifecycle behavior**

```bash
npm run build && node --test test/hook.test.js test/governance.test.js test/code_buddy.test.js
npm test
```

Expected: PASS. Four checks are required, safe failures are allowed through, and fresh-task curation remains a developer choice.

- [ ] **Step 5: Commit lifecycle/reporting changes**

```bash
git add hook.cjs src/hookInstaller.ts src/runtime/governance.ts src/runtime/workflow.ts code_buddy.py test/hook.test.js test/governance.test.js test/code_buddy.test.js
git diff --cached --check
git commit -m "feat: show Code Buddy health checks"
```

### Task 4: Implement identical policy and four-check preflight in the Codex bundle

**Files:**

- Create: `codex-plugin/plugins/code-buddy/scripts/project_policy.cjs`
- Create: `codex-plugin/plugins/code-buddy/scripts/project_policy.py`
- Create: `codex-plugin/plugins/code-buddy/resources/code-buddy-scoring-rubric.json`
- Create: `codex-plugin/plugins/code-buddy/tests/fixtures/code-buddy-policy-fixtures.json`
- Modify: `codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py`
- Modify: `codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs`
- Modify: `codex-plugin/plugins/code-buddy/skills/code-buddy/SKILL.md`
- Modify: `codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs`
- Modify: `codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs`

**Interfaces:**

- Node and Python policy parsers return the same normalized `{ policy, diagnostics }` for each shared fixture.
- `assess_session_fit(workspace, prompt, previousPrompt?, modelAssessment?)` returns `newTaskLikelihood`, confidence, reason, recommendation, and source.
- Codex preflight requires review, decomposition, context measurement, and session fit before substantive tools.

- [ ] **Step 1: Write failing plugin parser, MCP, and hook tests**

Use a JSON-RPC helper in `code_buddy_mcp.test.cjs` to send:

```js
const result = call('assess_session_fit', {
  workspace,
  prompt: 'Build a CSV export endpoint in src/reports/exportController.ts.',
  previousPrompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts.',
  modelAssessment: { newTaskLikelihood: 82, confidence: 'high', reason: 'Distinct subsystem.' }
});
assert.equal(result.freshTaskRecommended, true);
```

For each policy fixture, invoke both parser executables and assert equal normalized policies/diagnostic codes. Extend hook tests so injected automatic context names all four `mcp__code_buddy__…` tools, requires the Code Buddy health line, and permits implementation only after every requirement completes. Add a context/session-fit failure test that permits the original task with limited-evidence instruction. Keep all curated-handoff tests.

- [ ] **Step 2: Run focused plugin tests to verify they fail**

```bash
node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
```

Expected: FAIL because no parser parity, session-fit MCP tool, or four-tool preflight exists.

- [ ] **Step 3: Implement policy-aware MCP checks**

Port the Task 1 strict grammar to `project_policy.cjs` and `project_policy.py`; each accepts a workspace path and prints normalized JSON only. The hook uses the Node parser; each Python MCP handler uses the Python parser. Parser diagnostics append a redacted `policy.configuration_invalid` intervention event and fall back field by field.

Add `assess_session_fit` to `TOOLS` and `HANDLERS` in `code_buddy_mcp.py`. Validate model input:

```python
{
    \"newTaskLikelihood\": 0 <= score <= 100,
    \"confidence\": \"high\" | \"medium\" | \"low\",
    \"reason\": \"non-empty\",
}
```

Apply the policy threshold. Fallback uses explicit continuation text and configured lexical overlap. Update review, decomposition, and context functions to consume the loaded policy. Context output with no records must retain `method: \"estimate\"`, low confidence, and the existing limitation text.

- [ ] **Step 4: Implement Codex four-tool hook context**

Add context/session-fit recognizers and convert fixed requirement loops to four-key iteration. `automaticPreflightContext` must require missing tools, preserve original choices, and direct the model to read results before using this exact leading response form:

```text
Code Buddy: prompt quality <status> · task scope <status> · estimated context pressure <status> · session fit <status>
```

Use `checked — limited evidence` for fallback/empty context and do not label estimates as actual. A session-fit recommendation offers curated fresh handoff or continue unchanged; it does not call curation. Keep pending-handoff gating before preflight and preserve the source-session exemption/exact bypass phrase. Persist redacted `health.check_completed` and `health.check_limited` events.

Update `SKILL.md` with the bundled rubric examples, four required calls, and status-line format.

- [ ] **Step 5: Verify the bundle**

```bash
node --check codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs
node --check codex-plugin/plugins/code-buddy/scripts/project_policy.cjs
python3 -m py_compile codex-plugin/plugins/code-buddy/scripts/project_policy.py codex-plugin/plugins/code-buddy/scripts/code_buddy.py codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py
node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex-plugin/plugins/code-buddy
```

Expected: PASS. The policy fixtures, all four tools, safe fallbacks, session-fit recommendation, and prior handoff gate are covered.

- [ ] **Step 6: Commit Codex behavior**

```bash
git add codex-plugin/plugins/code-buddy
git diff --cached --check
git commit -m "feat: add Codex health check workflow"
```

### Task 5: Document, synchronize, reinstall, and verify the release

**Files:**

- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `codex-plugin/README.md`
- Modify: `codex-plugin/plugins/code-buddy/README.md`
- Modify through cachebuster only: `codex-plugin/plugins/code-buddy/.codex-plugin/plugin.json`
- Synchronize: `/Users/rampetaravishankar/plugins/code-buddy`

**Interfaces:**

- Documents root YAML, strictness direction, legacy VS Code fallback, few-shot categories, status labels, and developer-controlled curation.
- Keeps `code-buddy.yaml` trackable while ignoring generated `.code-buddy/*.jsonl` and `.code-buddy/.state/`.
- Produces installed-source parity with the repository bundle, excluding generated Python cache files.

- [ ] **Step 1: Write failing documentation/parity checks**

Add a test that reads the example YAML/health-line sections and asserts every documented default is `DEFAULT_POLICY`’s value. Replace broad `.code-buddy/` ignore with:

```gitignore
.code-buddy/*.jsonl
.code-buddy/.state/
```

Update all READMEs with the exact YAML example, stricter-direction guidance, estimate terminology, limited-evidence label, and no-automatic-task guarantee.

- [ ] **Step 2: Verify complete repository behavior**

```bash
npm test
node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex-plugin/plugins/code-buddy
git diff --check main...HEAD
```

Expected: PASS with no whitespace errors.

- [ ] **Step 3: Synchronize and cache-bust the personal Codex plugin**

Only after Tasks 1–4 pass in the repository bundle, run:

```bash
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' codex-plugin/plugins/code-buddy/ /Users/rampetaravishankar/plugins/code-buddy/
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py /Users/rampetaravishankar/plugins/code-buddy
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' /Users/rampetaravishankar/plugins/code-buddy/ codex-plugin/plugins/code-buddy/
diff -qr /Users/rampetaravishankar/plugins/code-buddy codex-plugin/plugins/code-buddy -x '__pycache__' -x '*.pyc'
codex plugin add code-buddy@personal
codex plugin list | rg 'code-buddy@personal.*installed, enabled'
```

Expected: identical cache-busted plugin sources and an installed/enabled plugin.

- [ ] **Step 4: Run final fresh verification and commit**

```bash
npm test
node --check codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs
python3 -m py_compile codex-plugin/plugins/code-buddy/scripts/project_policy.py codex-plugin/plugins/code-buddy/scripts/code_buddy.py codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py
node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex-plugin/plugins/code-buddy
git diff --check
git add .gitignore README.md codex-plugin/README.md codex-plugin/plugins/code-buddy
git diff --cached --check
git commit -m "docs: document Code Buddy health policies"
```

Expected: all verification commands exit zero and only approved feature, documentation, and cache-busted version changes remain.
