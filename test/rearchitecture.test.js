const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCodeBuddyAgentInstructions,
  mergeCodeBuddyAgentInstructions,
  removeCodeBuddyAgentInstructions
} = require('../dist/agentInstructions.js');
const {
  contextCurationFallback,
  normalizeCuratedContext,
  normalizePromptReview,
  normalizeSessionFit,
  normalizeTaskDecomposition,
  promptReviewFallback,
  sessionFitFallback,
  taskDecompositionFallback
} = require('../dist/ai/toolContracts.js');
const { JsonlInterventionStore } = require('../dist/core/eventStore.js');
const { DEFAULT_POLICY, detectCurationBoundary, detectNewTask, isMeaningfulPrompt } = require('../dist/core/policyEngine.js');
const { latestPrompts, observeSession } = require('../dist/observability/sessionReader.js');
const { ContextMeasurementService } = require('../dist/providers/contextMeasurement.js');

test('prompt reviewer contract always preserves an explicit original option', () => {
  const input = { prompt: 'Fix login.' };
  const result = normalizePromptReview({
    score: 55,
    dimensions: [
      { dimension: 'goalClarity', assessment: 'adequate', reason: 'The action is clear.' },
      { dimension: 'scope', assessment: 'weak', reason: 'No module is named.' }
    ],
    reasons: ['The affected login path is ambiguous.'],
    issues: [{ dimension: 'scope', reason: 'No module is named.', severity: 'high' }],
    interventionRecommended: true,
    suggestions: ['Name the authentication module.'],
    options: [{ id: 'scoped', label: 'Add scope', prompt: 'Fix login in src/auth.', preservesOriginalIntent: true }]
  }, input, DEFAULT_POLICY);

  assert.equal(result.interventionRecommended, true);
  assert.equal(result.options[0].id, 'original');
  assert.equal(result.options[0].prompt, input.prompt);
  assert.equal(result.originalPromptRetained, true);
});

test('invalid semantic output is rejected and fallback keeps normal coding unblocked', () => {
  assert.throws(
    () => normalizePromptReview({ score: 'high', dimensions: [] }, { prompt: 'Implement feature.' }, DEFAULT_POLICY),
    /invalid score/
  );
  const fallback = promptReviewFallback(
    { prompt: 'Implement feature.' },
    { code: 'invalid_output', message: 'Bad model output.', continuation: 'use_original' }
  );
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.selectedOptionId, 'original');
  assert.equal(fallback.interventionRecommended, false);
});

test('task decomposition is dynamic and retains the original task option', () => {
  const task = 'Rearchitect authentication and migrate tests.';
  const result = normalizeTaskDecomposition({
    complexityScore: 88,
    reasons: ['The task crosses architecture and tests.'],
    decompositionRecommended: true,
    strategies: [{
      id: 'architecture-first',
      label: 'Architecture first',
      rationale: 'Stabilize interfaces before migration.',
      steps: [
        { id: 'interfaces', title: 'Define interfaces', objective: 'Introduce provider contracts.', dependsOn: [] },
        { id: 'migration', title: 'Migrate callers', objective: 'Move callers to contracts.', dependsOn: ['interfaces'], suggestedValidation: 'npm test' }
      ]
    }]
  }, { task }, DEFAULT_POLICY);

  assert.equal(result.decompositionRecommended, true);
  assert.equal(result.originalTaskOption.task, task);
  assert.deepEqual(result.strategies[0].steps[1].dependsOn, ['interfaces']);
});

test('task and curation failures preserve the original session path', () => {
  const taskFallback = taskDecompositionFallback(
    { task: 'Migrate the service.' },
    { code: 'model_unavailable', message: 'No model.', continuation: 'use_original' }
  );
  assert.equal(taskFallback.originalTaskRetained, true);
  assert.equal(taskFallback.decompositionRecommended, false);

  const curationFallback = contextCurationFallback(
    { targetTask: 'Continue migration.', mode: 'continue_current' },
    { code: 'model_error', message: 'Request failed.', continuation: 'continue_current_session' }
  );
  assert.equal(curationFallback.accepted, false);
  assert.equal(curationFallback.suggestedStartingInstruction, 'Continue migration.');
});

test('context curator preserves pinned facts and exposes excluded history', () => {
  const pinned = 'Keep the public API backward compatible.';
  const bundle = normalizeCuratedContext({
    taskObjective: 'Migrate the authentication provider.',
    items: [
      { id: 'constraint-1', section: 'constraint', content: pinned, pinned: false },
      { id: 'file-1', section: 'file', content: 'src/auth/provider.ts', pinned: false }
    ],
    suggestedStartingInstruction: 'Migrate the provider and run npm test.',
    excludedHistory: ['Unrelated reporting dashboard work.']
  }, {
    targetTask: 'Migrate the authentication provider.',
    mode: 'fresh_task',
    pinnedItems: [pinned]
  });
  assert.equal(bundle.items[0].pinned, true);
  assert.deepEqual(bundle.excludedHistory, ['Unrelated reporting dashboard work.']);
  assert.equal(bundle.accepted, false);
});

test('context measurement follows API then vision then estimate and labels estimates honestly', () => {
  const service = new ContextMeasurementService(DEFAULT_POLICY);
  const result = service.measure({
    nativeMeasurement: { value: 31_000, unit: 'tokens', confidence: 'high', providerId: 'native-api', capacityTokens: 40_000 },
    visionMeasurement: { value: 30_000, unit: 'tokens', confidence: 'medium', providerId: 'screen' },
    estimate: { value: 29_000, unit: 'estimated_tokens', confidence: 'low', thresholdState: 'warning', utilization: 0.725 }
  });
  assert.equal(result.measurement.method, 'api');
  assert.equal(result.measurement.terminology, 'Actual Context Utilization');
  assert.equal(result.measurement.utilization, 0.775);
  assert.equal(result.measurement.capacityTokens, 40_000);
  assert.equal(result.healthLineStatus, 'warning — 31,000 / 40,000 tokens (77.5% actual)');

  const actualWithoutCapacity = service.measure({
    nativeMeasurement: { value: 31_000, unit: 'tokens', confidence: 'high', providerId: 'native-api' }
  });
  assert.equal(actualWithoutCapacity.measurement.utilization, undefined);
  assert.equal(actualWithoutCapacity.measurement.thresholdState, 'unavailable');
  assert.equal(actualWithoutCapacity.healthLineStatus, 'checked — 31,000 actual tokens; percentage unavailable');
  assert.equal(actualWithoutCapacity.recommendation, 'none');

  const estimated = service.measure({
    estimate: { value: 35_000, unit: 'estimated_tokens', confidence: 'low', thresholdState: 'critical', utilization: 0.875, estimatorVersion: 'v2' }
  });
  assert.equal(estimated.measurement.method, 'estimate');
  assert.equal(estimated.measurement.unit, 'estimated_tokens');
  assert.equal(estimated.measurement.terminology, 'Estimated Context Pressure');
  assert.equal(estimated.healthLineStatus, 'critical — ~35,000 estimated tokens (87.5% estimated)');
  assert.equal(estimated.recommendation, 'curate_or_start_fresh');

  const unavailable = service.measure({});
  assert.equal(unavailable.status, 'fallback');
  assert.equal(unavailable.failure.continuation, 'use_estimate');
});

test('deterministic governance distinguishes same-session new tasks from new sessions', () => {
  assert.equal(isMeaningfulPrompt('continue'), false);
  const previousPrompt = 'Implement OAuth refresh handling in src/auth/tokenService.ts and test expiry.';
  const currentPrompt = 'Build a CSV export endpoint in src/reports/exportController.ts with pagination.';
  const taskBoundary = detectNewTask(previousPrompt, currentPrompt);
  assert.equal(taskBoundary.isLikelyNewTask, true);

  const sameSession = detectCurationBoundary(
    { sessionId: 'session-1', prompt: previousPrompt },
    { sessionId: 'session-1', prompt: currentPrompt }
  );
  assert.equal(sameSession.kind, 'new_task');
  assert.equal(sameSession.taskBoundary.isLikelyNewTask, true);

  const newSession = detectCurationBoundary(
    { sessionId: 'session-1', prompt: previousPrompt },
    { sessionId: 'session-2', prompt: `Continue this work: ${previousPrompt}` }
  );
  assert.equal(newSession.kind, 'new_session');
  assert.equal(newSession.taskBoundary, undefined);

  const controlReply = detectCurationBoundary(
    { sessionId: 'session-1', prompt: previousPrompt },
    { sessionId: 'session-2', prompt: 'continue' }
  );
  assert.equal(controlReply.kind, 'none');
});

test('prompt history ignores control replies when finding curation boundaries', () => {
  const prompts = latestPrompts([
    { schemaVersion: 2, eventId: 'p1', recordType: 'user.prompt', sessionId: 's1', data: { prompt: 'Implement authentication token refresh handling.' } },
    { schemaVersion: 2, eventId: 'p2', recordType: 'user.prompt', sessionId: 's1', data: { prompt: 'continue' } },
    { schemaVersion: 2, eventId: 'p3', recordType: 'user.prompt', sessionId: 's2', data: { prompt: 'Finish authentication token refresh handling.' } }
  ], 2);
  assert.deepEqual(prompts.map((prompt) => prompt.eventId), ['p1', 'p3']);
});

test('fallback context observation is explicitly estimated', () => {
  const snapshot = observeSession([
    { schemaVersion: 2, eventId: 'p1', recordType: 'user.prompt', sessionId: 's1', timestamp: '2026-08-08T00:00:00Z', data: { prompt: 'Implement auth.', context: { observedChars: 200, role: 'user_prompt' } } },
    { schemaVersion: 2, eventId: 'a1', recordType: 'assistant.message', sessionId: 's1', timestamp: '2026-08-08T00:00:01Z', data: { content: 'Done.', context: { observedChars: 400, role: 'assistant_output' } } }
  ], DEFAULT_POLICY);
  assert.equal(snapshot.estimate.method, 'estimate');
  assert.equal(snapshot.estimate.unit, 'estimated_tokens');
  assert.equal(snapshot.estimate.terminology, 'Estimated Context Pressure');
  assert.equal(snapshot.signals.durationSeconds, 1);
});

test('emitted native context snapshots take priority over estimates', () => {
  const snapshot = observeSession([
    { schemaVersion: 2, eventId: 'p1', recordType: 'user.prompt', sessionId: 's1', timestamp: '2026-08-18T00:00:00Z', data: { prompt: 'Implement auth.' } },
    { schemaVersion: 2, eventId: 'c1', recordType: 'context.load_snapshot', sessionId: 's1', timestamp: '2026-08-18T00:00:01Z', data: {
      actualContextUtilization: {
        value: 150_000,
        unit: 'tokens',
        utilization: 0.75,
        capacityTokens: 200_000,
        confidence: 'high',
        thresholdState: 'warning',
        measurementProviderId: 'codex-cli-token-count',
        measurementTimestamp: '2026-08-18T00:00:00.500Z',
        cachedInputTokens: 120_000
      },
      observableSignals: { turns: 1, promptCharacters: 15, observedCharacters: 15 }
    } }
  ], DEFAULT_POLICY);
  assert.equal(snapshot.estimate.method, 'api');
  assert.equal(snapshot.estimate.terminology, 'Actual Context Utilization');
  assert.equal(snapshot.estimate.value, 150_000);
  assert.equal(snapshot.estimate.capacityTokens, 200_000);
  assert.equal(snapshot.estimate.utilization, 0.75);
  assert.equal(snapshot.estimate.providerId, 'codex-cli-token-count');
  assert.equal(snapshot.signals.estimatedTokens, 0);
});

test('session fit uses a calibrated semantic assessment and an explicit continuation fallback', () => {
  const input = {
    prompt: 'Build a CSV export endpoint in src/reports/exportController.ts.',
    previousPrompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts.'
  };
  const result = normalizeSessionFit({
    newTaskLikelihood: 82,
    confidence: 'high',
    reason: 'CSV export is unrelated to authentication.'
  }, input, DEFAULT_POLICY);

  assert.equal(result.freshTaskRecommended, true);
  assert.equal(result.assessmentSource, 'codex_model');
  assert.equal(sessionFitFallback({
    prompt: 'Continue authentication work and add expiry tests.',
    previousPrompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts.'
  }, DEFAULT_POLICY).newTaskLikelihood, 0);
});

test('managed agent instructions enforce evaluation and developer control', () => {
  const instructions = buildCodeBuddyAgentInstructions();
  assert.match(instructions, /#tool:codeBuddyPromptReviewer/);
  assert.match(instructions, /#tool:codeBuddyTaskDecomposer/);
  assert.match(instructions, /#tool:codeBuddyContextMeasurement/);
  assert.match(instructions, /#tool:codeBuddySessionFit/);
  assert.match(instructions, /Code Buddy:/);
  assert.match(instructions, /healthLineStatus/);
  assert.match(instructions, /actual percentage/);
  assert.match(instructions, /Estimated Context Pressure/);
  assert.match(instructions, /Never silently rewrite/);
  assert.match(instructions, /Continue with the original/);
  assert.match(instructions, /normal user-visible response/);
  assert.match(instructions, /collapsed Thinking section/);
  assert.match(instructions, /never ask the developer to choose unless that same visible response contains the choices/i);
  assert.match(instructions, /new Copilot session/);
  assert.match(instructions, /starting without prior context/);
});

test('managed instructions merge idempotently without overwriting workspace rules', () => {
  const existing = '# Workspace rules\n\n- Keep public APIs stable.\n';
  const merged = mergeCodeBuddyAgentInstructions(existing);
  const mergedAgain = mergeCodeBuddyAgentInstructions(merged);

  assert.match(merged, /# Workspace rules/);
  assert.match(merged, /Keep public APIs stable/);
  assert.match(merged, /# Code Buddy governance/);
  assert.equal(mergedAgain, merged);
});

test('removing managed instructions preserves unrelated workspace rules', () => {
  const existing = '# Workspace rules\n\n- Keep public APIs stable.\n';
  const merged = mergeCodeBuddyAgentInstructions(existing);

  assert.equal(removeCodeBuddyAgentInstructions(merged), existing);
  assert.equal(removeCodeBuddyAgentInstructions(buildCodeBuddyAgentInstructions()), '');
});

test('intervention events stay local and redact sensitive values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-buddy-events-'));
  const store = new JsonlInterventionStore(path.join(directory, 'interventions.jsonl'), true);
  await store.append({
    eventType: 'prompt.reviewed',
    sessionId: 's1',
    data: { originalPrompt: 'Use apiKey=do-not-log to fix auth.', score: 70 }
  });
  const records = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].eventType, 'prompt.reviewed');
  assert.doesNotMatch(records[0].data.originalPrompt, /do-not-log/);
});
