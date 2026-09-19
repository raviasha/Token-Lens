# Code Buddy Individual Developer Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Build the local-only, VS Code-native individual developer workflow for proactive Code Buddy recommendations, verified context value, and personal insights while preserving current retrospective analytics.

**Architecture:** Keep \`src/extension.ts\` as the VS Code composition root and put deterministic, testable domain logic in focused modules under \`src/individual/\`. The existing hook and Python analytics retain schema-v2 log/report compatibility and gain a versioned context snapshot; an append-only local event ledger derives recommendations, verification, and dashboard views without Code Buddy Cloud.

**Tech Stack:** TypeScript 5, VS Code Extension API 1.90+, Node \`node:test\`, existing CommonJS hook, Python 3 standard library analytics.

## Global Constraints

- Preserve the schema-v2 JSONL log, \`Code Buddy.md\`, \`Code Buddy Analytics.md\`, prompt scoring, worktree snapshots, and context instrumentation.
- Keep all interaction inside documented VS Code commands, Quick Picks, Input Boxes, editor tabs, notifications, clipboard, and \`vscode.lm\`.
- Call a Copilot language model only from an explicit developer action. Do not scrape, inject into, or submit native Copilot Chat.
- This individual release is local-only: no Code Buddy Cloud calls, telemetry upload, tenant data, Teams views, Enterprise policy, or local paid entitlement flags.
- New ledger events store hashes and derived metrics by default. Do not duplicate raw source, prompt, handoff, or model-response text.
- Persist \`code_buddy_context_estimator_v1\` on context snapshots and label estimates as estimates.
- Keep quality/effectiveness interventions non-monetary. Use an immediate verified counterfactual only; never claim productivity, hours saved, or extrapolated future financial value.
- Run \`npm test\` before each task commit. Stage only files that belong to the task.

---

## File Structure

| Path | Responsibility |
|---|---|
| \`src/individual/types.ts\` | Shared preflight, context, recommendation, verification, pricing, and savings contracts. |
| \`src/individual/promptAnalysis.ts\` | Deterministic preflight rubric and task size. |
| \`src/individual/contextLoad.ts\` | Read schema-v2 log observations and versioned context snapshots. |
| \`src/individual/contextStrategy.ts\` | Recommend Start Clean, Smart Context Handoff, or Continue Here. |
| \`src/individual/contextCandidates.ts\` | Filter task-relevant local observations before model curation. |
| \`src/individual/localEventStore.ts\` | Canonicalized hash-chain JSONL event store. |
| \`src/individual/recommendationService.ts\` | Immutable recommendation ID and valid lifecycle transitions. |
| \`src/individual/verifiers.ts\` | Prompt and context intervention evidence checks. |
| \`src/individual/valueEngine.ts\` | Immediate context-benefit and optional local-pricing calculations. |
| \`src/individual/languageModelService.ts\` | Supported Copilot prompt enhancement and handoff curation requests. |
| \`src/individual/developerViews.ts\` | Local dashboard, review, privacy, and export renderers. |
| \`src/individual/workflowController.ts\` | Native VS Code approval and copy-to-new-chat orchestration. |
| \`src/extension.ts\` | Service construction and command registration. |
| \`hook.cjs\`, \`code_buddy.py\` | Compatible per-turn \`context.load_snapshot\` emission. |
| \`test/individual/*.test.js\` | New deterministic Node tests. |

## Task 1: Add Shared Contracts and Deterministic Prompt Preflight

**Files:**
- Create: \`src/individual/types.ts\`
- Create: \`src/individual/promptAnalysis.ts\`
- Create: \`test/individual/promptAnalysis.test.js\`
- Modify: \`package.json:115-122\`

**Interfaces:**
- Produces \`PromptAnalysis\`, \`PromptFinding\`, \`EstimatedContextLoad\`, \`Recommendation\`, \`VerificationResult\`, \`ContextCandidate\`, \`PricingConfiguration\`, and \`SavingRecord\`.
- Produces \`PreflightAnalyzer.analyze(prompt: string): PromptAnalysis\` and \`PreflightAnalyzer.taskSize(prompt: string): TaskSizeAssessment\`.

- [ ] **Step 1: Write the failing preflight tests**

\`\`\`js
const { PreflightAnalyzer } = require('../../dist/individual/promptAnalysis.js');

test('flags the missing fields in a weak task', () => {
  const result = new PreflightAnalyzer().analyze('Add refresh-token support.');
  assert.equal(result.score < 60, true);
  assert.deepEqual(
    result.findings.filter((finding) => finding.status === 'missing').map((finding) => finding.dimension),
    ['scope', 'context', 'constraints', 'acceptance_criteria', 'validation']
  );
});

test('scores an explicit bounded task', () => {
  const result = new PreflightAnalyzer().analyze(
    'Implement refresh tokens in src/auth/tokenService.ts. Keep the login response shape. Done when refresh and expiry tests pass. Validate with npm test.'
  );
  assert.equal(result.score >= 80, true);
});
\`\`\`

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: \`npm run build && node --test test/individual/promptAnalysis.test.js\`

Expected: FAIL with \`Cannot find module '../../dist/individual/promptAnalysis.js'\`.

- [ ] **Step 3: Implement the contracts and rubric**

\`\`\`ts
export const CONTEXT_ESTIMATOR_VERSION = 'code_buddy_context_estimator_v1';
export type PromptDimension = 'goal' | 'scope' | 'context' | 'constraints' | 'acceptance_criteria' | 'validation';
export interface PromptFinding {
  dimension: PromptDimension;
  status: 'present' | 'missing';
  severity: 'low' | 'medium' | 'high';
  points: number;
  message: string;
}
export interface PromptAnalysis {
  promptId: string;
  score: number;
  findings: PromptFinding[];
  wordCount: number;
}
export interface EstimatedContextLoad {
  value: number;
  unit: 'estimated_tokens' | 'characters' | 'bytes' | 'provider_units' | 'unknown';
  estimationMethod: string;
  confidence?: 'high' | 'medium' | 'low';
  estimatorVersion: string;
  components?: Record<string, number>;
}
\`\`\`

Match the six current Python rubric dimensions and points. Use SHA-256 of the prompt for \`promptId\`; missing scope or acceptance criteria is high severity, missing context/constraints/validation is medium, and missing goal is low. Make task size a deterministic evaluation of explicit list items, action count, and word count.

- [ ] **Step 4: Run the focused test and regression suite**

Run: \`npm test\`

Expected: PASS; both new tests and current hook/Python tests succeed.

- [ ] **Step 5: Commit the preflight foundation**

\`\`\`bash
git add src/individual/types.ts src/individual/promptAnalysis.ts test/individual/promptAnalysis.test.js package.json
git commit -m "feat: add deterministic prompt preflight"
\`\`\`

## Task 2: Add Tamper-Evident Local Recommendation Lifecycle

**Files:**
- Create: \`src/individual/localEventStore.ts\`
- Create: \`src/individual/recommendationService.ts\`
- Create: \`test/individual/recommendationService.test.js\`

**Interfaces:**
- Consumes \`Recommendation\` and lifecycle status types from \`types.ts\`.
- Produces \`LocalEventStore.append(input): Promise<LedgerEvent>\`, \`LocalEventStore.read(): Promise<LedgerReadResult>\`, and \`RecommendationService.create(input): Promise<Recommendation>\`.

- [ ] **Step 1: Write failing lifecycle and integrity tests**

\`\`\`js
test('records immutable lifecycle events in a verifiable hash chain', async () => {
  const store = new LocalEventStore(path.join(directory, 'events.jsonl'));
  const service = new RecommendationService(store, () => '2026-08-10T10:00:00.000Z');
  const recommendation = await service.create({
    type: 'prompt_enhancement', category: 'quality', sessionId: 's1', metadata: { originalPromptHash: 'hash' }
  });
  await service.transition(recommendation.id, 'shown', {});
  await service.transition(recommendation.id, 'accepted', {});
  assert.equal((await store.read()).integrity, 'verified');
  assert.equal((await service.get(recommendation.id)).status, 'accepted');
});

test('detects an altered historical ledger line', async () => {
  const original = await store.append({
    eventId: 'evt_1', timestamp: '2026-08-10T10:00:00.000Z', eventType: 'recommendation_generated', metadata: {}
  });
  fs.writeFileSync(storePath, `${JSON.stringify({ ...original, metadata: { changed: true } })}\n`, 'utf8');
  const result = await store.read();
  assert.equal(result.integrity, 'integrity_unverified');
});
\`\`\`

- [ ] **Step 2: Run the test and confirm the store module is missing**

Run: \`npm run build && node --test test/individual/recommendationService.test.js\`

Expected: FAIL with a missing \`localEventStore\` module.

- [ ] **Step 3: Implement canonical JSONL chain and transition rules**

\`\`\`ts
export interface LedgerEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  recommendationId?: string;
  metadata: Record<string, unknown>;
  previousEventHash: string | null;
  eventHash: string;
}

export class LocalEventStore {
  constructor(private readonly filePath: string) {}
  async append(input: Omit<LedgerEvent, 'eventHash' | 'previousEventHash'>): Promise<LedgerEvent> {
    const previousEventHash = (await this.read()).events.at(-1)?.eventHash ?? null;
    const body = { ...input, previousEventHash };
    const event = { ...body, eventHash: sha256(canonicalJson(body)) };
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }
  async read(): Promise<{ events: LedgerEvent[]; integrity: 'verified' | 'integrity_unverified' }> {
    const events = await readJsonLines<LedgerEvent>(this.filePath);
    return { events, integrity: verifyHashChain(events) ? 'verified' : 'integrity_unverified' };
  }
}
\`\`\`

Canonicalize keys recursively before calculating SHA-256 over the event body plus prior hash. Append one JSON record per line, create parent directories, and apply mode \`0o600\` when supported. Lifecycle transitions move only forward through generated, shown, accepted, applied, verification_pending, verified/partially_verified/not_verified/not_observable, measured/measurement_failed, dismissed, or ignored. Preserve every prior event and never store raw prompt/capsule body.

- [ ] **Step 4: Run lifecycle tests and all tests**

Run: \`npm test\`

Expected: PASS; untouched chain reads verified and altered content reads integrity_unverified.

- [ ] **Step 5: Commit ledger work**

\`\`\`bash
git add src/individual/localEventStore.ts src/individual/recommendationService.ts test/individual/recommendationService.test.js
git commit -m "feat: add local recommendation lifecycle ledger"
\`\`\`

## Task 3: Add Context Snapshots, Strategy, and Candidate Selection

**Files:**
- Create: \`src/individual/contextLoad.ts\`
- Create: \`src/individual/contextStrategy.ts\`
- Create: \`src/individual/contextCandidates.ts\`
- Create: \`test/individual/contextStrategy.test.js\`
- Modify: \`code_buddy.py:380-1047\`
- Modify: \`test/code_buddy.test.js:1-199\`

**Interfaces:**
- Produces \`ContextLoadService.readSnapshots(): Promise<ContextSnapshot[]>\`, \`ContextStrategyEngine.recommend(input): ContextStrategyRecommendation\`, and \`ContextCandidateSelector.select(task, observations): ContextCandidate[]\`.
- Adds schema-v2 \`context.load_snapshot\` records with \`estimatedContextLoad\`, \`estimatorVersion\`, \`sessionId\`, \`turnId\`, and timestamp.

- [ ] **Step 1: Write failing strategy/candidate and snapshot tests**

\`\`\`js
test('recommends handoff for related work with high growing context', () => {
  const result = new ContextStrategyEngine().recommend({
    task: 'Add refresh-token revocation in src/auth/tokenService.ts',
    latestLoad: load(124000), previousLoad: load(82000), relatedness: 0.8, candidateLoad: load(31000)
  });
  assert.equal(result.strategy, 'smart_handoff');
});

test('excludes unrelated tool output from local candidates', () => {
  const selected = new ContextCandidateSelector().select(task, observations);
  assert.equal(selected.some((candidate) => candidate.content.includes('tokenService')), true);
  assert.equal(selected.some((candidate) => candidate.content.includes('unrelated verbose build output')), false);
});
\`\`\`

Extend the completed-turn analytics test to assert a \`context.load_snapshot\` record with \`code_buddy_context_estimator_v1\`, \`estimated_tokens\`, and the existing report assertions unchanged.

- [ ] **Step 2: Run focused tests and confirm the missing behavior**

Run: \`npm run build && node --test test/individual/contextStrategy.test.js test/code_buddy.test.js\`

Expected: FAIL because the individual modules and \`context.load_snapshot\` do not exist.

- [ ] **Step 3: Implement context logic and compatible Python snapshot**

\`\`\`ts
export class ContextLoadService {
  constructor(private readonly logPath: string) {}
  async readSnapshots(): Promise<ContextSnapshot[]> {
    return (await readJsonLines<HookRecord>(this.logPath))
      .filter((record) => record.recordType === 'context.load_snapshot')
      .map((record) => fromHookSnapshot(record))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }
  async latest(): Promise<ContextSnapshot | undefined> { return (await this.readSnapshots()).at(-1); }
}

export class ContextStrategyEngine {
  recommend(input: ContextStrategyInput): ContextStrategyRecommendation {
    const growth = input.previousLoad ? input.latestLoad.value / Math.max(1, input.previousLoad.value) : 1;
    if (input.relatedness < 0.3) return { strategy: 'start_clean', reason: 'Prior work has little task overlap.' };
    if (input.relatedness >= 0.75 && growth < 1.25) return { strategy: 'continue_here', reason: 'Current work is a direct continuation.' };
    return input.candidateLoad.value + input.curationLoad.value < input.latestLoad.value
      ? { strategy: 'smart_handoff', reason: 'Relevant local context is smaller than continuing context.' }
      : { strategy: 'continue_here', reason: 'Curation overhead exceeds immediate context reduction.' };
  }
}
\`\`\`

Parse only schema-v2 JSONL locally. Rank candidate user prompts, assistant output, errors, worktree changes, and validations by recency plus exact task keyword/file/symbol overlap. Exclude transcript snapshots, duplicate content, unrelated completed work, and low-relevance tool blobs. The strategy chooses Start Clean for low relationship, Continue Here for direct continuation where current state remains relevant, and Smart Context Handoff only when relevant candidate context is materially smaller than observed current context after curation overhead is considered.

In \`code_buddy.py\`, add an analytics record after existing turn outcome/report derivation. Its \`data\` holds existing exposure token estimate as \`estimatedContextLoad\`, component counts where observable, \`code_buddy_context_estimator_v1\`, \`estimated_tokens\`, \`observed_text_estimate\`, low confidence, and prior/current growth metrics. Keep \`turn.outcome\` and every current report field unchanged.

- [ ] **Step 4: Run context tests and regression suite**

Run: \`npm test\`

Expected: PASS; high related context selects handoff, independent work selects fresh, direct continuation selects continue, and old reports still render.

- [ ] **Step 5: Commit context services**

\`\`\`bash
git add src/individual/contextLoad.ts src/individual/contextStrategy.ts src/individual/contextCandidates.ts test/individual/contextStrategy.test.js code_buddy.py test/code_buddy.test.js
git commit -m "feat: add local context strategy and snapshots"
\`\`\`

## Task 4: Add Recommendation Verifiers and Conservative Value Calculations

**Files:**
- Create: \`src/individual/verifiers.ts\`
- Create: \`src/individual/valueEngine.ts\`
- Create: \`test/individual/valueEngine.test.js\`

**Interfaces:**
- Produces \`RecommendationVerifier.verify(recommendation, before, after): VerificationResult\` and \`ValueEngine.calculate(input): SavingRecord\`.

- [ ] **Step 1: Write failing verifier/value tests**

\`\`\`js
test('verifies an enhanced prompt only when its approved hash is later observed', () => {
  const result = verifyPromptEnhancement(recommendation, { observedPromptHash: recommendation.metadata.finalPromptHash });
  assert.equal(result.status, 'verified');
});

test('subtracts curation overhead and keeps negative immediate value at zero', () => {
  const record = new ValueEngine().calculate({
    recommendationId: 'rec_1', verificationStatus: 'verified',
    contextBefore: load(100000), contextAfter: load(90000), curationLoad: load(30000)
  });
  assert.equal(record.netEstimatedContextBenefit.value, 0);
  assert.equal(record.financialClassification, 'none');
});

test('applies active local pricing only to verified estimated benefit', () => {
  const record = new ValueEngine().calculate(pricedVerifiedBenefit);
  assert.equal(record.financialClassification, 'estimated_attributed');
  assert.equal(record.monetarySaving, 0.2);
});
\`\`\`

- [ ] **Step 2: Run the test and confirm the missing modules**

Run: \`npm run build && node --test test/individual/valueEngine.test.js\`

Expected: FAIL with missing verifier/value modules.

- [ ] **Step 3: Implement evidence checks and immediate counterfactual**

\`\`\`ts
export class RecommendationVerifier {
  verify(recommendation: Recommendation, before: ObservationState, after: ObservationState): VerificationResult {
    const expected = String(recommendation.metadata.finalPromptHash ?? '');
    if (recommendation.type === 'prompt_enhancement') {
      const observed = String(after.observedPromptHash ?? '');
      return observed === expected
        ? { recommendationId: recommendation.id, status: 'verified', evidence: { observedPromptHash: observed } }
        : { recommendationId: recommendation.id, status: 'not_observable', evidence: { expectedPromptHash: expected } };
    }
    return after.contextLoad && after.payloadHash === expected
      ? { recommendationId: recommendation.id, status: 'verified', evidence: { contextAfter: after.contextLoad } }
      : { recommendationId: recommendation.id, status: 'not_observable', evidence: { payloadObserved: false } };
  }
}
export class ValueEngine {
  calculate(input: ValueCalculationInput): SavingRecord {
    const curation = input.curationLoad?.value ?? 0;
    const net = Math.max(0, input.contextBefore.value - input.contextAfter.value - curation);
    const price = input.pricing?.inputCostPerMillionTokens;
    const monetarySaving = input.verificationStatus === 'verified' && price !== undefined ? (net / 1_000_000) * price : undefined;
    return buildSavingRecord(input, net, monetarySaving);
  }
}
\`\`\`

Prompt enhancement is verified only when a later hook prompt hash equals the developer-approved final prompt hash and final analysis improved the relevant dimensions. Context actions require payload-use evidence plus a usable after snapshot; unavailable evidence stays pending or becomes not_observable. For Smart Handoff subtract measurable curation request load; preserve candidate/capsule load and compression ratio separately. Use exact_attributed only with exact provider usage and billing. Use estimated_attributed only for a verified estimate with effective dated local input pricing. Create zero-value records for zero/negative benefits and include estimator version, pricing version, and provenance.

- [ ] **Step 4: Run deterministic value tests and full suite**

Run: \`npm test\`

Expected: PASS; no price yields no money, negatives are zero, and quality remains non-monetary.

- [ ] **Step 5: Commit verification and value work**

\`\`\`bash
git add src/individual/verifiers.ts src/individual/valueEngine.ts test/individual/valueEngine.test.js
git commit -m "feat: verify recommendations and calculate local value"
\`\`\`

## Task 5: Add Supported Copilot Prompt and Handoff Requests

**Files:**
- Create: \`src/individual/languageModelService.ts\`
- Create: \`test/individual/languageModelService.test.js\`

**Interfaces:**
- Produces \`buildPromptEnhancementRequest(prompt, analysis): string\`, \`buildHandoffCurationRequest(task, candidates, findings): string\`, and \`LanguageModelService.requestText(request, token): Promise<ModelResult>\`.

- [ ] **Step 1: Write failing request-construction tests**

\`\`\`js
test('builds an enhancement request that preserves intent and forbids invented requirements', () => {
  const request = buildPromptEnhancementRequest('Add refresh tokens.', analysis);
  assert.match(request, /Preserve original intent/);
  assert.match(request, /Do not invent business requirements/);
  assert.match(request, /acceptance_criteria/);
});

test('builds a task-conditioned handoff only from selected candidates', () => {
  const request = buildHandoffCurationRequest('Add token revocation.', candidates, findings);
  assert.match(request, /NEXT TASK:/);
  assert.match(request, /tokenService/);
  assert.doesNotMatch(request, /unrelated verbose build output/);
});
\`\`\`

- [ ] **Step 2: Run tests and confirm the service is missing**

Run: \`npm run build && node --test test/individual/languageModelService.test.js\`

Expected: FAIL with a missing \`languageModelService\` module.

- [ ] **Step 3: Implement prompt builders and VS Code LM adapter**

\`\`\`ts
export class LanguageModelService {
  async requestText(request: string, token: vscode.CancellationToken): Promise<ModelResult> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) return { ok: false, error: 'No Copilot language model is available.' };
    const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User(request)], {}, token);
    let text = '';
    for await (const part of response.text) text += part;
    return { ok: true, text: text.trim(), model: models[0].id };
  }
}
\`\`\`

Use documented \`vscode.lm.selectChatModels\`, \`LanguageModelChatMessage.User\`, and \`sendRequest\` only. Builders must preserve intent, forbid invented facts, label unresolved choices, request concise output, and make curation conditional on the next task. Convert \`LanguageModelError\` and ordinary failures to non-throwing result objects so the controller preserves drafts.

- [ ] **Step 4: Run deterministic model-service tests and the full suite**

Run: \`npm test\`

Expected: PASS; no live model is used by tests.

- [ ] **Step 5: Commit model support**

\`\`\`bash
git add src/individual/languageModelService.ts test/individual/languageModelService.test.js
git commit -m "feat: add supported Copilot workflow requests"
\`\`\`

## Task 6: Orchestrate VS Code-Only Preflight, Approval, and Handoff

**Files:**
- Create: \`src/individual/workflowController.ts\`
- Create: \`test/individual/workflowController.test.js\`
- Modify: \`src/extension.ts:1-143\`
- Modify: \`src/hookInstaller.ts:8-295\`
- Modify: \`package.json:18-114\`

**Interfaces:**
- Produces \`IndividualWorkflowController.runPreflight(): Promise<void>\`, \`improvePrompt(): Promise<void>\`, \`prepareHandoff(): Promise<void>\`, and \`verifyPending(): Promise<void>\`.

- [ ] **Step 1: Write failing payload/lifecycle controller tests**

\`\`\`js
test('keeps the approved handoff separate from final task prompt', () => {
  assert.equal(
    composeFinalSessionPayload({ capsule: 'Relevant implementation: src/auth/tokenService.ts', finalPrompt: 'Add revocation.' }),
    '[CONTEXT HANDOFF]\\n\\nRelevant implementation: src/auth/tokenService.ts\\n\\n[TASK]\\n\\nAdd revocation.'
  );
});

test('keeps approval verification pending until hook evidence exists', () => {
  assert.equal(nextRecommendationStatus('accepted', 'payload_prepared'), 'verification_pending');
});
\`\`\`

- [ ] **Step 2: Run tests and confirm controller is missing**

Run: \`npm run build && node --test test/individual/workflowController.test.js\`

Expected: FAIL with a missing \`workflowController\` module.

- [ ] **Step 3: Implement native actions and payload preparation**

\`\`\`ts
async runPreflight(): Promise<void> {
  const draft = await vscode.window.showInputBox({ prompt: 'Describe the coding-agent task', value: this.selectedText() });
  if (!draft?.trim()) return;
  const analysis = this.preflight.analyze(draft);
  const action = await vscode.window.showQuickPick([
    { label: 'Improve with Copilot', value: 'enhance' },
    { label: 'Review Context', value: 'context' },
    { label: 'Edit Myself', value: 'edit' },
    { label: 'Send Anyway', value: 'prepare' }
  ], { placeHolder: this.preflightSummary(analysis) });
  await this.handleAction(action?.value, draft, analysis);
}
\`\`\`

Open review artifacts in VS Code editor tabs for original/enhanced prompt and handoff capsule. Use Input Boxes for developer edits and write clipboard text only after approval. The prepared view instructs the developer to create a fresh supported Copilot chat and paste the payload. Never issue native Chat commands, private command IDs, DOM access, synthetic keys, or automatic submission. Record enhancement/handoff events and final payload hashes in the ledger, then mark them verification_pending until later hook evidence is seen.

Register Preflight Task, Improve Prompt with Copilot, Prepare Smart Context Handoff, Verify Recommendations, Open Personal Dashboard, View My Data, Export My Data, and View Privacy & Telemetry. Add local event path, ledger raw-content retention default false, and versioned local pricing config using existing active-workspace path resolution.

- [ ] **Step 4: Build and run all tests**

Run: \`npm test\`

Expected: PASS; extension TypeScript compiles with supported LM types and existing hook commands remain available.

- [ ] **Step 5: Commit VS Code workflow**

\`\`\`bash
git add src/individual/workflowController.ts test/individual/workflowController.test.js src/extension.ts src/hookInstaller.ts package.json
git commit -m "feat: add VS Code preflight and handoff workflow"
\`\`\`

## Task 7: Render Personal Dashboard, Data Views, Privacy, and Export

**Files:**
- Create: \`src/individual/developerViews.ts\`
- Create: \`test/individual/developerViews.test.js\`
- Modify: \`src/extension.ts:53-143\`
- Modify: \`package.json:18-114\`
- Modify: \`README.md:1-56\`

**Interfaces:**
- Produces \`renderDashboard(data): string\`, \`renderPrivacy(): string\`, and \`exportPersonalData(data): PersonalDataExport\`.

- [ ] **Step 1: Write failing dashboard/export tests**

\`\`\`js
test('renders verified avoided context separately from quality and unavailable money', () => {
  const markdown = renderDashboard({ verifiedContextAvoided: 79000, monetarySaving: undefined, quality: { promptEnhancementsUsed: 1 } });
  assert.match(markdown, /Verified Context Avoided\\s+79,000/);
  assert.match(markdown, /Monetary value: unavailable/);
  assert.match(markdown, /QUALITY VALUE/);
});

test('exports derived data without raw prompt or handoff text', () => {
  const exported = exportPersonalData(events);
  assert.equal(JSON.stringify(exported).includes('original prompt body'), false);
  assert.equal(exported.ledgerIntegrity, 'verified');
});
\`\`\`

- [ ] **Step 2: Run tests and confirm views are missing**

Run: \`npm run build && node --test test/individual/developerViews.test.js\`

Expected: FAIL with a missing \`developerViews\` module.

- [ ] **Step 3: Implement local Markdown/JSON views**

\`\`\`ts
export function renderPrivacy(): string {
  return [
    '# Code Buddy Privacy & Telemetry',
    '',
    '- Individual mode is local-only and does not send Code Buddy telemetry.',
    '- The ledger stores hashes and derived metrics, not raw prompts, source code, handoffs, or model responses by default.',
    '- Copilot receives selected text only after you choose Improve with Copilot or Curate Context.'
  ].join('\\n');
}
\`\`\`

Render current ledger summaries for Estimated Context Carried, Verified Context Avoided, Estimated Attributed Saving or \`Monetary value: unavailable\`, Smart Handoffs Used, Recommendations Applied, Enhanced Prompts Used, Acceptance Criteria Added, Tasks Decomposed, and Validation Improvements. Include per-recommendation evidence/context/pricing/provenance drill-down. Export only activity/outcome data and exclude raw content, secrets, proprietary policy logic, and organization information. Document every command, local storage artifact, estimation limitation, pricing behavior, and manual paste-to-new-chat boundary in README.

- [ ] **Step 4: Run dashboard tests and all tests**

Run: \`npm test\`

Expected: PASS; dashboard does not monetize quality and export omits raw content.

- [ ] **Step 5: Commit developer transparency views**

\`\`\`bash
git add src/individual/developerViews.ts test/individual/developerViews.test.js src/extension.ts package.json README.md
git commit -m "feat: add local personal value views"
\`\`\`

## Task 8: Perform Final Regression and Documentation Verification

**Files:**
- Modify: \`README.md:1-56\`
- Modify: \`test/hook.test.js:1-181\` only when a hook fixture needs a new snapshot assertion
- Modify: \`test/code_buddy.test.js:1-199\` only when the completed-turn assertion needs final refinement

**Interfaces:**
- Consumes all completed services and existing hook/report behavior.
- Produces a verified build and accurate individual-local documentation.

- [ ] **Step 1: Add the final end-to-end regression assertion**

\`\`\`js
test('retains retrospective feedback while adding a versioned context snapshot', { skip: !pythonCommand }, () => {
  const records = runHook({ hook_event_name: 'Stop', session_id: 'analytics-session', cwd: workspace }, environment);
  assert.ok(records.some((record) => record.recordType === 'turn.outcome'));
  const snapshot = records.find((record) => record.recordType === 'context.load_snapshot');
  assert.ok(snapshot);
  assert.equal(snapshot.data.estimatedContextLoad.unit, 'estimated_tokens');
  assert.equal(snapshot.data.estimatedContextLoad.estimatorVersion, 'code_buddy_context_estimator_v1');
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /Prompt quality:/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Context By Turn/);
});
\`\`\`

- [ ] **Step 2: Run the complete focused test matrix**

Run: \`npm run build && node --test test/hook.test.js test/code_buddy.test.js test/individual/*.test.js\`

Expected: PASS; if a failure remains, diagnose that evidence before editing.

- [ ] **Step 3: Review README against approved scope**

Verify direct statements for VS Code-only workflow, explicit Copilot action/approval, no native-chat injection, local-only telemetry, ledger minimization, Estimated Context Load limitations, curation-overhead subtraction, zero/negative value behavior, and deferred Cloud/Teams work.

- [ ] **Step 4: Run final verification**

Run: \`npm test && git diff --check && git status --short\`

Expected: PASS, no whitespace errors, and only intended implementation changes plus user pre-existing changes visible.

- [ ] **Step 5: Commit final regression documentation changes**

\`\`\`bash
git add README.md test/hook.test.js test/code_buddy.test.js
git commit -m "test: verify individual developer workflow"
\`\`\`

## Plan Self-Review

- **Spec coverage:** Task 1 is preflight; Task 2 is lifecycle/auditability; Task 3 is versioned context, strategy, and local candidate filtering; Task 4 is verification and conservative savings; Task 5 is supported Copilot requests; Task 6 is developer-controlled VS Code workflow; Task 7 is dashboard/privacy/export; Task 8 is preservation and release verification. Cloud, Teams, Enterprise, tenants, and server entitlements remain out of scope.
- **Placeholder scan:** Every task lists exact files, interfaces, tests, commands, expected results, and implementation behavior.
- **Type consistency:** Shared types are defined first in \`types.ts\` and retain the names \`Recommendation\`, \`EstimatedContextLoad\`, \`ContextSnapshot\`, \`VerificationResult\`, \`PricingConfiguration\`, and \`SavingRecord\` through all consumers.
