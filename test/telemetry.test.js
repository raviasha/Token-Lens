const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const {
  TELEMETRY_SCHEMA_VERSION,
  SUPPORTED_TELEMETRY_SCHEMA_VERSIONS,
  captureHookEvent,
  readTelemetryEvents,
  aggregateTask,
  buildHumanRetryDataset,
  analyzeHumanRetries,
  getPersonalizedRecommendation,
  readCodexNativeContext,
  renderTaskReplay,
  validateTelemetryEvent,
  TaskAggregator
} = require('../telemetry.cjs');

function writeCodexRollout(sessionsRoot, sessionId, workspace, tokenEvents) {
  const directory = path.join(sessionsRoot, '2026', '08', '18');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-08-18T12-00-00-${sessionId}.jsonl`);
  const records = [
    { timestamp: '2026-08-18T12:00:00.000Z', type: 'turn_context', payload: { cwd: workspace, workspace_roots: [workspace] } },
    { timestamp: '2026-08-18T12:00:01.000Z', type: 'response_item', payload: { type: 'message', content: 'private prompt content must never be returned' } },
    ...tokenEvents.map((event, index) => ({
      timestamp: `2026-08-18T12:00:${String(index + 2).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: 'token_count', info: event }
    }))
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

const telemetryEnvironmentKeys = [
  'TOKEN_LENS_TELEMETRY_ENABLED',
  'TOKEN_LENS_TELEMETRY_LEVEL',
  'TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT',
  'TOKEN_LENS_TELEMETRY_DIR',
  'TOKEN_LENS_DEVELOPER_ID',
  'TOKEN_LENS_PROMPT_REVIEW_THRESHOLD',
  'TOKEN_LENS_TASK_DECOMPOSITION_THRESHOLD',
  'TOKEN_LENS_CONTEXT_WARNING_THRESHOLD',
  'TOKEN_LENS_SESSION_FIT_THRESHOLD',
  'TOKEN_LENS_HUMAN_RETRY_MIN_TASKS',
  'TOKEN_LENS_HUMAN_RETRY_MIN_FACTOR_TASKS',
  'TOKEN_LENS_HUMAN_RETRY_RELIABILITY_THRESHOLD',
  'TOKEN_LENS_HUMAN_RETRY_MIN_EFFECT',
  'TOKEN_LENS_HUMAN_RETRY_OVERDISPERSION_THRESHOLD'
];

function withTelemetryWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-telemetry-'));
  const workspace = path.join(directory, 'workspace');
  const telemetry = path.join(workspace, '.code-buddy', 'telemetry');
  fs.mkdirSync(workspace, { recursive: true });
  process.env.TOKEN_LENS_TELEMETRY_ENABLED = 'true';
  process.env.TOKEN_LENS_TELEMETRY_LEVEL = 'standard';
  process.env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT = 'false';
  process.env.TOKEN_LENS_TELEMETRY_DIR = telemetry;
  process.env.TOKEN_LENS_DEVELOPER_ID = 'local-test-developer';
  return { directory, workspace, telemetry };
}

function hook(workspace, hook_event_name, extra = {}) {
  return captureHookEvent({
    hook_event_name,
    session_id: extra.session_id || 'session-1',
    timestamp: extra.timestamp || new Date().toISOString(),
    cwd: workspace,
    ...extra
  }, { platform: 'codex', editor: 'codex' });
}

function postTool(workspace, tool_name, tool_input, tool_response, timestamp, failure = false) {
  return hook(workspace, failure ? 'PostToolUseFailure' : 'PostToolUse', {
    timestamp,
    tool_name,
    tool_input,
    tool_response
  });
}

function syntheticTaskEvents(index, promptClarity, humanRetryCount, options = {}) {
  const taskId = options.taskId || `task_synthetic_${index}`;
  const sessionId = `session_synthetic_${index}`;
  let sequence = 0;
  let minute = index * 10;
  const make = (event_type, interaction_id, payload) => ({
    schema_version: '1.1',
    event_id: `evt_synthetic_${index}_${++sequence}`,
    event_type,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString(),
    session_sequence: sequence,
    developer_id: 'synthetic-developer',
    session_id: sessionId,
    task_id: taskId,
    interaction_id,
    platform: 'test',
    editor: 'test',
    environment: {},
    payload
  });
  const initialInteraction = `interaction_${index}_0`;
  const events = [
    make('task_created', initialInteraction, {
      task_type: 'implementation',
      initial_complexity: 'medium',
      objective: { action: 'implement', target_kind: 'api' },
      task_detection: { method: 'synthetic', confidence: 1, reason: ['fixture'] }
    }),
    make('prompt_submitted', initialInteraction, {
      prompt_length_chars: 80,
      prompt_length_tokens_estimate: 20,
      contains_file_reference: true,
      contains_acceptance_criteria: true,
      contains_constraints: true,
      contains_validation_request: true
    }),
    make('preflight_completed', initialInteraction, {
      prompt_quality: { score: promptClarity, threshold: 0.75, decision: 'observed' },
      task_decomposition: { score: 0.5, threshold: 0.65, decision: 'continue' },
      context_pressure: { score: 0.3, threshold: 0.7, decision: 'continue' },
      session_fit: { score: 0.2, threshold: 0.75, decision: 'continue' }
    }),
    make('implementation_attempt_observed', initialInteraction, {
      attempt_id: `attempt_${index}_0`,
      attempt_number: 1,
      attempt_kind: 'initial',
      evidence: ['successful_file_change'],
      confidence: 0.95,
      detector_version: 'human_retry_detector_v1'
    })
  ];
  for (let retry = 1; retry <= humanRetryCount; retry += 1) {
    const interactionId = `interaction_${index}_${retry}`;
    events.push(
      make('developer_followup', interactionId, {
        classification: 'correction',
        classification_confidence: 0.9,
        prompt_length_tokens_estimate: 10,
        signals: { correction_language: true, material_change_request: true }
      }),
      make('retry_detected', interactionId, {
        retry_type: 'implementation_retry',
        confidence: 0.9,
        trigger: 'developer_correction'
      }),
      make('implementation_attempt_observed', interactionId, {
        attempt_id: `attempt_${index}_${retry}`,
        attempt_number: retry + 1,
        attempt_kind: 'human_retry',
        evidence: ['successful_file_change'],
        confidence: 0.95,
        detector_version: 'human_retry_detector_v1'
      }),
      make('human_retry_detected', interactionId, {
        human_retry_id: `human_retry_${index}_${retry}`,
        source_followup_event_id: `followup_${index}_${retry}`,
        attempt_id: `attempt_${index}_${retry}`,
        prior_attempt_id: `attempt_${index}_${retry - 1}`,
        human_retry_number: retry,
        implementation_attempt_number: retry + 1,
        classification: 'correction',
        classification_confidence: 0.9,
        task_match_confidence: 0.95,
        material_attempt_confidence: 0.95,
        trigger: 'developer_correction',
        detector_version: 'human_retry_detector_v1'
      })
    );
  }
  events.push(
    make('test_run', `interaction_${index}_${humanRetryCount}`, {
      framework: 'node-test', tests_run: 10, passed: 10, failed: 0, skipped: 0, duration_ms: 100
    }),
    make('task_completed', `interaction_${index}_${humanRetryCount}`, {
      completion_method: 'synthetic_fixture', completion_confidence: 1
    }),
    make('task_state_changed', `interaction_${index}_${humanRetryCount}`, {
      from: 'active', to: 'completed', reason: 'synthetic_fixture'
    })
  );
  return events;
}

test('reads the latest native Codex token count without exposing rollout content', () => {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-codex-sessions-'));
  const workspace = path.join(sessionsRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const sessionId = '01a012cf-21d8-7a63-ad34-3a92e4d71f2a';
  writeCodexRollout(sessionsRoot, sessionId, workspace, [
    {
      total_token_usage: { input_tokens: 150000, cached_input_tokens: 90000, output_tokens: 800, reasoning_output_tokens: 200, total_tokens: 151000 },
      last_token_usage: { input_tokens: 90000, cached_input_tokens: 50000, output_tokens: 500, reasoning_output_tokens: 100, total_tokens: 90600 },
      model_context_window: 200000
    },
    {
      total_token_usage: { input_tokens: 300000, cached_input_tokens: 180000, output_tokens: 1500, reasoning_output_tokens: 400, total_tokens: 301900 },
      last_token_usage: { input_tokens: 150000, cached_input_tokens: 90000, output_tokens: 700, reasoning_output_tokens: 200, total_tokens: 150900 },
      model_context_window: 200000
    }
  ]);

  const result = readCodexNativeContext({ sessionsRoot, workspace, sessionId });
  assert.equal(result.status, 'actual');
  assert.equal(result.measurement_method, 'codex_token_count_event');
  assert.equal(result.input_tokens, 150000);
  assert.equal(result.cached_input_tokens, 90000);
  assert.equal(result.output_tokens, 700);
  assert.equal(result.reasoning_tokens, 200);
  assert.equal(result.model_context_window_tokens, 200000);
  assert.equal(result.context_utilization, 0.75);
  assert.equal(result.cumulative_usage.total_tokens, 301900);
  assert.equal(JSON.stringify(result).includes('private prompt content'), false);
  assert.equal(Object.hasOwn(result, 'source_file'), false);
});

test('reports actual input tokens without inventing a utilization percentage when capacity is missing', () => {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-codex-capacity-'));
  const workspace = path.join(sessionsRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const sessionId = '01a012cf-21d8-7a63-ad34-3a92e4d71f2b';
  writeCodexRollout(sessionsRoot, sessionId, workspace, [{
    total_token_usage: { input_tokens: 42000, total_tokens: 42500 },
    last_token_usage: { input_tokens: 42000, output_tokens: 500, total_tokens: 42500 }
  }]);

  const result = readCodexNativeContext({ sessionsRoot, workspace });
  assert.equal(result.status, 'actual');
  assert.equal(result.input_tokens, 42000);
  assert.equal(result.model_context_window_tokens, null);
  assert.equal(result.context_utilization, null);
});

test('fails open when no matching Codex rollout is available', () => {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-codex-empty-'));
  const result = readCodexNativeContext({ sessionsRoot, workspace: path.join(sessionsRoot, 'missing') });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.measurement_method, 'unavailable');
});

test.afterEach(() => {
  for (const key of telemetryEnvironmentKeys) delete process.env[key];
});

test('reconstructs the PRD acceptance lifecycle without raw conversation content', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const prompt = 'Add pagination to the user API. Keep the public response compatible and run npm test.';
  const submitted = hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T09:12:00.000Z',
    prompt
  });
  const taskId = submitted.emitted.find((event) => event.event_type === 'task_created').task_id;
  const taskCreated = submitted.emitted.find((event) => event.event_type === 'task_created');
  assert.equal(taskCreated.payload.objective.action, 'add');
  assert.equal(taskCreated.payload.objective.target_kind, 'api');

  postTool(workspace, 'mcp__code_buddy__review_prompt', {}, {
    structuredContent: {
      score: 62,
      interventionRecommended: true,
      issues: [{ reason: 'Add explicit pagination acceptance criteria.' }]
    }
  }, '2026-08-17T09:12:01.000Z');
  postTool(workspace, 'mcp__code_buddy__decompose_task', {}, {
    structuredContent: { complexityScore: 40, decompositionRecommended: false }
  }, '2026-08-17T09:12:02.000Z');
  postTool(workspace, 'mcp__code_buddy__measure_context', {}, {
    structuredContent: { measurement: { utilization: 0.35, thresholdState: 'normal' }, recommendation: 'continue' }
  }, '2026-08-17T09:12:03.000Z');
  postTool(workspace, 'mcp__code_buddy__assess_session_fit', {}, {
    structuredContent: { newTaskLikelihood: 10, freshTaskRecommended: false }
  }, '2026-08-17T09:12:04.000Z');
  postTool(workspace, 'mcp__code_buddy__record_intervention', {
    eventType: 'prompt.review_choice',
    data: { selectedOptionId: 'clarified' }
  }, { structuredContent: { status: 'recorded' } }, '2026-08-17T09:13:00.000Z');
  postTool(workspace, 'exec_command', { cmd: 'npm test' }, {
    output: 'TAP version 13\n# tests 2\n# pass 1\n# fail 1',
    exit_code: 1
  }, '2026-08-17T09:16:00.000Z');

  hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T09:17:00.000Z',
    prompt: 'The pagination test failed and the cursor is incorrect. Fix that implementation.'
  });
  postTool(workspace, 'exec_command', { cmd: 'npm test' }, {
    output: 'TAP version 13\n# tests 2\n# pass 2\n# fail 0',
    exit_code: 0
  }, '2026-08-17T09:23:00.000Z');
  postTool(workspace, 'exec_command', { cmd: 'git commit -m pagination' }, {
    output: 'commit created',
    exit_code: 0
  }, '2026-08-17T09:25:00.000Z');

  const { events, invalid } = readTelemetryEvents(telemetry);
  assert.deepEqual(invalid, []);
  assert.ok(events.length > 10);
  assert.ok(events.every((event) => event.schema_version === TELEMETRY_SCHEMA_VERSION));
  assert.ok(events.every((event) => event.developer_id === 'local-test-developer'));
  assert.equal(events.find((event) => event.event_type === 'prompt_submitted').payload.raw_prompt, undefined);
  assert.equal(JSON.stringify(events).includes(prompt), false);

  const preflight = events.find((event) => event.event_type === 'preflight_completed');
  assert.equal(preflight.payload.prompt_quality.score, 0.62);
  assert.equal(preflight.payload.prompt_quality.threshold, 0.75);
  assert.ok(events.some((event) => event.event_type === 'recommendation_shown'
    && event.payload.recommendation_type === 'enhance_prompt'));
  assert.ok(events.some((event) => event.event_type === 'recommendation_decision'
    && event.payload.decision === 'accepted'));
  const correction = events.find((event) => event.event_type === 'developer_followup'
    && event.payload.classification === 'correction');
  assert.equal(correction.payload.signals.correction_language, true);
  assert.equal(typeof correction.payload.signals.prior_task_term_overlap, 'number');

  const record = aggregateTask(events, taskId);
  assert.equal(record.initial_prompt_quality, 0.62);
  assert.equal(record.recommendations.enhance_prompt, true);
  assert.equal(record.recommendation_evidence.enhance_prompt.shown, 1);
  assert.equal(record.recommendation_evidence.enhance_prompt.accepted, 1);
  assert.equal(record.recommendations_accepted, 1);
  assert.equal(record.implementation_attempts, 2);
  assert.equal(record.corrective_turns, 1);
  assert.equal(record.test_runs, 2);
  assert.equal(record.tests_initially_passed, false);
  assert.equal(record.tests_finally_passed, true);
  assert.equal(record.commit_created, true);
  assert.equal(record.completed, true);
  assert.equal(record.completed_without_retry, false);
  assert.equal(record.completed_in_original_session, true);
  assert.equal(record.total_developer_turns, 2);

  const replay = renderTaskReplay(events, taskId);
  assert.match(replay, /Prompt submitted/);
  assert.match(replay, /enhance_prompt recommended/);
  assert.match(replay, /Tests failed/);
  assert.match(replay, /Developer correction/);
  assert.match(replay, /Tests passed/);
  assert.match(replay, /Git commit_created/);
  assert.match(replay, /Task completed/);
});

test('the installed Copilot hook writes the versioned task stream', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-hook-telemetry-'));
  const workspace = path.join(directory, 'workspace');
  const telemetry = path.join(workspace, '.code-buddy', 'telemetry');
  fs.mkdirSync(workspace, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'hook.cjs')], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'copilot-session',
      timestamp: '2026-08-17T09:00:00.000Z',
      cwd: workspace,
      prompt: 'Implement the user API pagination and run npm test.'
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_LOG_FILE: path.join(workspace, '.code-buddy', 'copilot-session.jsonl'),
      TOKEN_LENS_TELEMETRY_DIR: telemetry,
      TOKEN_LENS_TELEMETRY_LEVEL: 'standard',
      TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'false',
      TOKEN_LENS_CAPTURE_TRANSCRIPTS: 'false',
      TOKEN_LENS_DEVELOPER_ID: 'hook-test-developer'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const { events, invalid } = readTelemetryEvents(telemetry);
  assert.deepEqual(invalid, []);
  assert.ok(events.some((event) => event.event_type === 'task_created'
    && event.platform === 'github-copilot'));
  assert.ok(events.some((event) => event.event_type === 'prompt_submitted'
    && event.interaction_id?.startsWith('interaction_')));
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /Personalized recommendation — Not enough data/);
});

test('counts one human retry only after a prior and subsequent material implementation attempt', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const first = hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T10:00:00.000Z',
    prompt: 'Implement the billing API endpoint and keep the response compatible.'
  });
  const taskId = first.emitted.find((event) => event.event_type === 'task_created').task_id;
  postTool(workspace, 'apply_patch', { filePath: 'src/billing/api.ts' }, { success: true }, '2026-08-17T10:01:00.000Z');
  hook(workspace, 'Stop', {
    timestamp: '2026-08-17T10:02:00.000Z',
    last_assistant_message: 'Implemented the billing endpoint.'
  });

  hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T10:03:00.000Z',
    prompt: 'To clarify, the response field should be called invoiceId.'
  });
  hook(workspace, 'Stop', {
    timestamp: '2026-08-17T10:04:00.000Z',
    last_assistant_message: 'Thanks for clarifying.'
  });

  hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T10:05:00.000Z',
    prompt: 'Also add audit logging to the billing API.'
  });
  postTool(workspace, 'apply_patch', { filePath: 'src/billing/audit.ts' }, { success: true }, '2026-08-17T10:06:00.000Z');
  hook(workspace, 'Stop', {
    timestamp: '2026-08-17T10:07:00.000Z',
    last_assistant_message: 'Added audit logging.'
  });

  hook(workspace, 'UserPromptSubmit', {
    timestamp: '2026-08-17T10:08:00.000Z',
    prompt: 'The billing API implementation is incorrect. Fix the response compatibility bug.'
  });
  postTool(workspace, 'apply_patch', { filePath: 'src/billing/api.ts' }, { success: true }, '2026-08-17T10:09:00.000Z');
  postTool(workspace, 'apply_patch', { filePath: 'src/billing/types.ts' }, { success: true }, '2026-08-17T10:09:30.000Z');
  hook(workspace, 'Stop', {
    timestamp: '2026-08-17T10:10:00.000Z',
    last_assistant_message: 'Corrected the compatibility behavior.'
  });

  const { events, invalid } = readTelemetryEvents(telemetry);
  assert.deepEqual(invalid, []);
  const attempts = events.filter((event) => event.event_type === 'implementation_attempt_observed');
  const retries = events.filter((event) => event.event_type === 'human_retry_detected');
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((event) => event.payload.attempt_kind), ['initial', 'followup', 'human_retry']);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].payload.prior_attempt_id, attempts[1].payload.attempt_id);
  assert.equal(retries[0].payload.attempt_id, attempts[2].payload.attempt_id);
  const record = aggregateTask(events, taskId);
  assert.equal(record.human_retry_count, 1);
  assert.equal(record.material_implementation_attempt_count, 3);
  assert.equal(record.human_retry_derivation_source, 'detected_v1_1');
  assert.equal(record.corrective_turns, 1);
  assert.equal(record.human_retry_candidate_count, 1);
});

test('does not count clarification, scope expansion, new-task work, or multiple agent tools as human retries', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const first = hook(workspace, 'UserPromptSubmit', { session_id: 'boundary', prompt: 'Implement the auth API token service.' });
  const firstTaskId = first.emitted.find((event) => event.event_type === 'task_created').task_id;
  hook(workspace, 'PostToolUse', { session_id: 'boundary', tool_name: 'apply_patch', tool_input: { filePath: 'src/auth.ts' }, tool_response: { success: true } });
  hook(workspace, 'PostToolUse', { session_id: 'boundary', tool_name: 'exec_command', tool_input: { cmd: 'npm test' }, tool_response: { output: '# pass 2\n# fail 0', exit_code: 0 } });
  hook(workspace, 'Stop', { session_id: 'boundary', last_assistant_message: 'Implemented and tested.' });
  hook(workspace, 'UserPromptSubmit', { session_id: 'boundary', prompt: 'To clarify, which token expiry is used?' });
  hook(workspace, 'Stop', { session_id: 'boundary', last_assistant_message: 'The access token expiry.' });
  hook(workspace, 'UserPromptSubmit', { session_id: 'boundary', prompt: 'Also add documentation for the same auth API.' });
  hook(workspace, 'PostToolUse', { session_id: 'boundary', tool_name: 'apply_patch', tool_input: { filePath: 'docs/auth.md' }, tool_response: { success: true } });
  hook(workspace, 'Stop', { session_id: 'boundary', last_assistant_message: 'Added documentation.' });
  const next = hook(workspace, 'UserPromptSubmit', {
    session_id: 'boundary-next',
    prompt: 'Build a CSV export worker for the reporting database.'
  });
  const nextTaskId = next.emitted.find((event) => event.event_type === 'task_created').task_id;
  assert.notEqual(nextTaskId, firstTaskId);
  hook(workspace, 'PostToolUse', { session_id: 'boundary-next', tool_name: 'apply_patch', tool_input: { filePath: 'src/export.ts' }, tool_response: { success: true } });
  hook(workspace, 'Stop', { session_id: 'boundary-next', last_assistant_message: 'Built the export worker.' });
  const { events } = readTelemetryEvents(telemetry);
  assert.equal(events.filter((event) => event.event_type === 'human_retry_detected').length, 0);
  assert.equal(aggregateTask(events, firstTaskId).human_retry_count, 0);
  assert.equal(aggregateTask(events, firstTaskId).material_implementation_attempt_count, 2);
  assert.equal(aggregateTask(events, nextTaskId).human_retry_count, 0);
  assert.equal(aggregateTask(events, nextTaskId).material_implementation_attempt_count, 1);
});

test('preflight events preserve the thresholds active at capture time', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  process.env.TOKEN_LENS_PROMPT_REVIEW_THRESHOLD = '82';
  process.env.TOKEN_LENS_TASK_DECOMPOSITION_THRESHOLD = '55';
  process.env.TOKEN_LENS_CONTEXT_WARNING_THRESHOLD = '0.45';
  process.env.TOKEN_LENS_SESSION_FIT_THRESHOLD = '60';
  const submitted = hook(workspace, 'UserPromptSubmit', { prompt: 'Implement the API change and run tests.' });
  const taskId = submitted.emitted.find((event) => event.event_type === 'task_created').task_id;
  postTool(workspace, 'mcp__code_buddy__review_prompt', {}, {
    structuredContent: { score: 80, interventionRecommended: false }
  });
  postTool(workspace, 'mcp__code_buddy__decompose_task', {}, {
    structuredContent: { complexityScore: 50, decompositionRecommended: false }
  });
  postTool(workspace, 'mcp__code_buddy__measure_context', {}, {
    structuredContent: { measurement: {
      method: 'codex_token_count_event',
      value: 80_000,
      unit: 'tokens',
      utilization: 0.4,
      capacity: 200_000,
      confidence: 'high',
      providerId: 'codex-cli-token-count',
      measurementTimestamp: '2026-08-18T00:00:00.000Z',
      cachedInputTokens: 60_000,
      outputTokens: 2_000,
      reasoningTokens: 500,
      totalTokens: 82_500
    }, recommendation: 'continue' }
  });
  postTool(workspace, 'mcp__code_buddy__assess_session_fit', {}, {
    structuredContent: { newTaskLikelihood: 30, freshTaskRecommended: false }
  });
  const preflight = readTelemetryEvents(telemetry).events.find((event) => event.event_type === 'preflight_completed');
  assert.equal(preflight.payload.prompt_quality.threshold, 0.82);
  assert.equal(preflight.payload.task_decomposition.threshold, 0.55);
  assert.equal(preflight.payload.context_pressure.threshold, 0.45);
  assert.equal(preflight.payload.session_fit.threshold, 0.6);
  const snapshot = readTelemetryEvents(telemetry).events.find((event) => event.event_type === 'context_snapshot'
    && event.payload.checkpoint === 'preflight_measurement');
  assert.equal(snapshot.payload.actual_context_tokens, 80_000);
  assert.equal(snapshot.payload.model_context_window_tokens, 200_000);
  assert.equal(snapshot.payload.context_utilization, 0.4);
  assert.equal(snapshot.payload.cached_input_tokens, 60_000);
  assert.equal(snapshot.payload.measurement_provider_id, 'codex-cli-token-count');
  const aggregate = aggregateTask(readTelemetryEvents(telemetry).events, taskId);
  assert.equal(aggregate.initial_actual_context_tokens, 80_000);
  assert.equal(aggregate.initial_model_context_window_tokens, 200_000);
  assert.equal(aggregate.initial_context_utilization, 0.4);
  assert.equal(aggregate.max_context_utilization, 0.4);
});

test('links recommendation exposure, acceptance, and observed application separately', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const submitted = hook(workspace, 'UserPromptSubmit', { prompt: 'Implement the API migration across services and tests.' });
  const taskId = submitted.emitted.find((event) => event.event_type === 'task_created').task_id;
  postTool(workspace, 'mcp__code_buddy__review_prompt', {}, {
    structuredContent: { score: 90, interventionRecommended: false }
  });
  postTool(workspace, 'mcp__code_buddy__decompose_task', {}, {
    structuredContent: { complexityScore: 82, decompositionRecommended: true, reasons: ['Broad change.'] }
  });
  postTool(workspace, 'mcp__code_buddy__measure_context', {}, {
    structuredContent: { measurement: { utilization: 0.3 }, recommendation: 'continue' }
  });
  postTool(workspace, 'mcp__code_buddy__assess_session_fit', {}, {
    structuredContent: { newTaskLikelihood: 10, freshTaskRecommended: false }
  });
  postTool(workspace, 'mcp__code_buddy__record_intervention', {
    eventType: 'task.decomposition_choice',
    data: { selectedOptionId: 'strategy-1', strategyId: 'strategy-1', stepId: 'step-1' }
  }, { structuredContent: { status: 'recorded' } });
  postTool(workspace, 'apply_patch', { filePath: 'src/migration.ts' }, { success: true });
  hook(workspace, 'Stop', { last_assistant_message: 'Implemented the first decomposition step.' });
  const { events } = readTelemetryEvents(telemetry);
  const applied = events.find((event) => event.event_type === 'recommendation_applied'
    && event.payload.recommendation_type === 'decompose_task');
  assert.equal(applied.payload.evidence.strategy_id, 'strategy-1');
  assert.equal(applied.payload.evidence.step_id, 'step-1');
  const record = aggregateTask(events, taskId);
  assert.equal(record.decomposition_recommended, true);
  assert.equal(record.decomposition_accepted, true);
  assert.equal(record.task_was_decomposed, true);
  assert.deepEqual(record.recommendation_evidence.decompose_task, {
    shown: 1, accepted: 1, rejected: 0, dismissed: 0, modified: 0, applied: 1
  });
});

test('replayed hook deliveries do not duplicate raw task events', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const payload = {
    hook_event_name: 'UserPromptSubmit',
    event_id: 'platform-event-1',
    session_id: 'session-dedup',
    timestamp: '2026-08-17T09:00:00.000Z',
    cwd: workspace,
    prompt: 'Implement pagination for the user API and run tests.'
  };
  const first = captureHookEvent(payload, { platform: 'codex', editor: 'codex' });
  const duplicate = captureHookEvent(payload, { platform: 'codex', editor: 'codex' });
  assert.equal(first.duplicate, undefined);
  assert.equal(duplicate.duplicate, true);
  const { events } = readTelemetryEvents(telemetry);
  assert.equal(events.filter((event) => event.event_type === 'task_created').length, 1);
  assert.equal(events.filter((event) => event.event_type === 'prompt_submitted').length, 1);
});

test('concurrent hook processes retain monotonic unique session sequences', async () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  hook(workspace, 'UserPromptSubmit', {
    session_id: 'session-concurrent',
    event_id: 'prompt-concurrent',
    prompt: 'Implement the API service and its tests.'
  });
  const modulePath = path.join(root, 'telemetry.cjs');
  const source = `
    const telemetry = require(process.env.TELEMETRY_MODULE);
    const index = process.env.EVENT_INDEX;
    const result = telemetry.captureHookEvent({
      hook_event_name: 'PostToolUse',
      event_id: 'event-' + index,
      tool_use_id: 'tool-' + index,
      tool_name: 'read_file',
      tool_input: { filePath: 'src/file-' + index + '.ts' },
      tool_response: { success: true },
      session_id: 'session-concurrent',
      timestamp: '2026-08-17T10:00:00.000Z',
      cwd: process.env.TEST_WORKSPACE
    }, { platform: 'codex', editor: 'codex' });
    process.exit(result.captured ? 0 : 1);
  `;
  const children = Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      env: {
        ...process.env,
        TELEMETRY_MODULE: modulePath,
        EVENT_INDEX: String(index),
        TEST_WORKSPACE: workspace,
        TOKEN_LENS_TELEMETRY_DIR: telemetry,
        TOKEN_LENS_TELEMETRY_LEVEL: 'standard',
        TOKEN_LENS_DEVELOPER_ID: 'local-test-developer'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  }));
  await Promise.all(children);
  const toolEvents = readTelemetryEvents(telemetry).events.filter((event) => event.event_type === 'tool_activity'
    && event.session_id === 'session-concurrent');
  assert.equal(toolEvents.length, 8);
  assert.equal(new Set(toolEvents.map((event) => event.session_sequence)).size, 8);
});

test('keeps task and session identity separate across compaction and a fresh session', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const first = hook(workspace, 'UserPromptSubmit', {
    session_id: 'session-a',
    timestamp: '2026-08-17T10:00:00.000Z',
    prompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts and add expiry tests.'
  });
  const taskId = first.emitted.find((event) => event.event_type === 'task_created').task_id;
  hook(workspace, 'PreCompact', {
    session_id: 'session-a',
    timestamp: '2026-08-17T10:05:00.000Z'
  });
  hook(workspace, 'PostCompact', {
    session_id: 'session-a',
    timestamp: '2026-08-17T10:05:01.000Z',
    context_after_tokens_estimate: 1200
  });
  hook(workspace, 'SessionEnd', {
    session_id: 'session-a',
    timestamp: '2026-08-17T10:06:00.000Z'
  });
  hook(workspace, 'UserPromptSubmit', {
    session_id: 'session-b',
    timestamp: '2026-08-17T10:07:00.000Z',
    prompt: 'Continue OAuth refresh handling in src/auth/tokenService.ts and finish the expiry tests.'
  });

  const { events } = readTelemetryEvents(telemetry);
  const taskEvents = events.filter((event) => event.task_id === taskId);
  assert.ok(taskEvents.some((event) => event.event_type === 'conversation_compacted'
    && event.payload.context_after_tokens_estimate === 1200));
  assert.ok(taskEvents.some((event) => event.event_type === 'session_changed'
    && event.payload.previous_session_id === 'session-a'
    && event.payload.new_session_id === 'session-b'));
  assert.equal(new Set(taskEvents.map((event) => event.session_id)).size, 2);
  assert.equal(new Set(taskEvents.map((event) => event.task_id)).size, 1);
});

test('keeps concurrent sessions attributed to their own active tasks', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const first = hook(workspace, 'UserPromptSubmit', {
    session_id: 'session-auth',
    prompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts with expiry tests.'
  });
  const authTask = first.emitted.find((event) => event.event_type === 'task_created').task_id;
  const second = hook(workspace, 'UserPromptSubmit', {
    session_id: 'session-export',
    prompt: 'Build a CSV export endpoint in src/reports/exportController.ts with pagination.'
  });
  const exportTask = second.emitted.find((event) => event.event_type === 'task_created').task_id;
  assert.notEqual(authTask, exportTask);

  hook(workspace, 'PostToolUse', {
    session_id: 'session-auth',
    tool_name: 'apply_patch',
    tool_input: { filePath: 'src/auth/tokenService.ts' },
    tool_response: { status: 'ok' }
  });
  hook(workspace, 'PostToolUse', {
    session_id: 'session-export',
    tool_name: 'apply_patch',
    tool_input: { filePath: 'src/reports/exportController.ts' },
    tool_response: { status: 'ok' }
  });

  const { events } = readTelemetryEvents(telemetry);
  const authFileEvent = events.find((event) => event.event_type === 'file_activity'
    && event.session_id === 'session-auth');
  const exportFileEvent = events.find((event) => event.event_type === 'file_activity'
    && event.session_id === 'session-export');
  assert.equal(authFileEvent.task_id, authTask);
  assert.equal(exportFileEvent.task_id, exportTask);
});

test('records scope expansion, abandonment, and a subsequent new task', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  const first = hook(workspace, 'UserPromptSubmit', {
    prompt: 'Implement the billing API endpoint with tests.'
  });
  const firstTask = first.emitted.find((event) => event.event_type === 'task_created').task_id;
  hook(workspace, 'UserPromptSubmit', {
    prompt: 'Also add audit logging to the same billing API.'
  });
  hook(workspace, 'UserPromptSubmit', { prompt: 'Cancel this task.' });
  const next = hook(workspace, 'UserPromptSubmit', {
    prompt: 'Build a CSV export worker for the reporting database.'
  });
  const nextTask = next.emitted.find((event) => event.event_type === 'task_created').task_id;
  assert.notEqual(firstTask, nextTask);

  const { events } = readTelemetryEvents(telemetry);
  assert.ok(events.some((event) => event.task_id === firstTask
    && event.event_type === 'scope_changed'
    && event.payload.direction === 'expanded'));
  assert.ok(events.some((event) => event.task_id === firstTask
    && event.event_type === 'task_abandoned'));
  assert.ok(events.some((event) => event.task_id === firstTask
    && event.event_type === 'task_state_changed'
    && event.payload.to === 'abandoned'));
});

test('projects legacy worktree outcomes into metadata-only file events at stop', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  hook(workspace, 'UserPromptSubmit', {
    prompt: 'Update src/api/users.ts and verify the endpoint tests.'
  });
  const legacyLog = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, `${JSON.stringify({
    schemaVersion: 2,
    eventId: 'outcome-1',
    recordType: 'turn.outcome',
    sessionId: 'session-1',
    data: {
      metrics: {
        filesChanged: 1,
        changedFiles: [{ path: 'src/api/users.ts', change: 'modified', linesAdded: 8, linesDeleted: 3 }]
      }
    }
  })}\n${JSON.stringify({
    schemaVersion: 2,
    eventId: 'context-1',
    recordType: 'context.load_snapshot',
    sessionId: 'session-1',
    data: { estimatedContextPressure: { value: 2400 } }
  })}\n`, 'utf8');
  captureHookEvent({
    hook_event_name: 'Stop',
    session_id: 'session-1',
    cwd: workspace,
    timestamp: '2026-08-17T12:00:00.000Z'
  }, { platform: 'codex', editor: 'codex', legacyLogPath: legacyLog });

  const { events } = readTelemetryEvents(telemetry);
  const file = events.find((event) => event.event_type === 'file_activity'
    && event.payload.source === 'observed_worktree_delta');
  assert.ok(file.payload.file_hash.startsWith('file_'));
  assert.equal(file.payload.file_extension, '.ts');
  assert.equal(file.payload.lines_added, 8);
  assert.equal(file.payload.lines_removed, 3);
  assert.equal(JSON.stringify(file).includes('src/api/users.ts'), false);
  const snapshot = events.find((event) => event.event_type === 'context_snapshot'
    && event.payload.checkpoint === 'after_agent_response');
  assert.equal(snapshot.payload.estimated_context_tokens, 2400);
  const response = events.find((event) => event.event_type === 'agent_response');
  assert.equal(response.payload.files_modified, 1);
  const taskId = events.find((event) => event.event_type === 'task_created').task_id;
  const aggregate = aggregateTask(events, taskId);
  assert.equal(aggregate.lines_added, 8);
  assert.equal(aggregate.lines_removed, 3);
  assert.equal(aggregate.code_churn, 0.2727);
});

test('raw prompts require both diagnostic level and explicit raw-content opt-in', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  process.env.TOKEN_LENS_TELEMETRY_LEVEL = 'diagnostic';
  process.env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT = 'true';
  hook(workspace, 'UserPromptSubmit', {
    prompt: 'Create the diagnostic-only sample with apiKey=do-not-store and verify it.'
  });
  const event = readTelemetryEvents(telemetry).events.find((item) => item.event_type === 'prompt_submitted');
  assert.match(event.payload.raw_prompt, /\[REDACTED\]/);
  assert.doesNotMatch(event.payload.raw_prompt, /do-not-store/);
});

test('minimal telemetry keeps lifecycle and preflight data but omits activity detail', () => {
  const { workspace, telemetry } = withTelemetryWorkspace();
  process.env.TOKEN_LENS_TELEMETRY_LEVEL = 'minimal';
  hook(workspace, 'UserPromptSubmit', { prompt: 'Implement the API endpoint and its tests.' });
  postTool(workspace, 'apply_patch', { filePath: 'src/api.ts' }, { success: true });
  const { events } = readTelemetryEvents(telemetry);
  assert.ok(events.some((event) => event.event_type === 'task_created'));
  assert.ok(events.some((event) => event.event_type === 'prompt_submitted'));
  assert.equal(events.some((event) => event.event_type === 'tool_activity'), false);
  assert.equal(events.some((event) => event.event_type === 'file_activity'), false);
});

test('telemetry validation rejects malformed events and capture fails open', () => {
  assert.match(validateTelemetryEvent({ schema_version: '0.1' }).join(' '), /schema_version/);
  assert.deepEqual([...SUPPORTED_TELEMETRY_SCHEMA_VERSIONS], ['1.0', '1.1']);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-telemetry-fail-open-'));
  const blockedPath = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockedPath, 'file', 'utf8');
  process.env.TOKEN_LENS_TELEMETRY_DIR = blockedPath;
  const result = captureHookEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-fail-open',
    cwd: directory,
    prompt: 'Implement the requested change.'
  });
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'telemetry_failure');
});

test('always returns cold-start feedback and exposes the task-level analytical dataset', () => {
  const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-recommendation-empty-'));
  const coldStart = getPersonalizedRecommendation(emptyWorkspace, {
    policy: { minimumComparableTasks: 8 }
  });
  assert.equal(coldStart.reliability.enough_data, false);
  assert.equal(coldStart.reliability.strength, 'insufficient');
  assert.equal(coldStart.recommendation, null);
  assert.match(coldStart.feedback, /^Personalized recommendation — Not enough data yet/);

  const events = syntheticTaskEvents(1, 0.8, 0);
  const dataset = buildHumanRetryDataset(events);
  assert.equal(dataset.dataset_schema_version, 'human-retry-task-v1');
  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].acceptance_criteria_present, true);
  assert.equal(dataset.records[0].human_retry_count, 0);
  assert.equal(dataset.records[0].task_completed, true);
  assert.equal(dataset.records[0].recommendation_shown, false);
  assert.equal(dataset.records[0].quality_guardrail_passed, true);
});

test('uses comparable completed cohorts, a reliability gate, Poisson analysis, and NB fallback', () => {
  const retryCounts = [3, 2, 3, 2, 2, 1, 1, 1, 0, 1, 0, 0];
  const clarity = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  const events = clarity.flatMap((score, index) => syntheticTaskEvents(index, score, retryCounts[index]));
  events.push(...syntheticTaskEvents(99, 0.5, 0, { taskId: 'task_current' }));
  const poisson = analyzeHumanRetries(events, {
    currentTaskId: 'task_current',
    policy: {
      minimumComparableTasks: 8,
      minimumTasksPerFactor: 5,
      reliabilityThreshold: 0.6,
      minimumEffectSize: 0.05,
      overdispersionThreshold: 100
    }
  });
  assert.equal(poisson.cohort.comparable_completed_tasks, 12);
  assert.equal(poisson.descriptive.confirmed_human_retries, 16);
  assert.equal(poisson.descriptive.tasks_with_human_retry, 9);
  assert.equal(poisson.reliability.enough_data, true);
  assert.equal(poisson.reliability.quality_guardrail_coverage, 1);
  const clarityAssociation = poisson.associations.find((association) => association.factor === 'prompt_clarity_score');
  assert.equal(clarityAssociation.model, 'poisson');
  assert.equal(clarityAssociation.direction_matches_hypothesis, true);
  assert.ok(clarityAssociation.descriptive_comparison.lower_group_mean_retries
    > clarityAssociation.descriptive_comparison.upper_group_mean_retries);
  assert.equal(poisson.reliability.reliable, true);
  assert.equal(poisson.reliability.strength, 'strong');
  assert.equal(poisson.recommendation.factor, 'prompt_clarity_score');
  assert.match(poisson.feedback, /^Personalized recommendation — Clarify the task/);
  assert.match(poisson.feedback, /observational, not causal/);

  const overdispersedCounts = [10, 0, 8, 0, 7, 0, 5, 0, 3, 0, 1, 0];
  const overdispersedEvents = clarity.flatMap((score, index) => syntheticTaskEvents(index + 200, score, overdispersedCounts[index]));
  overdispersedEvents.push(...syntheticTaskEvents(299, 0.5, 0, { taskId: 'task_current_nb' }));
  const negativeBinomial = analyzeHumanRetries(overdispersedEvents, {
    currentTaskId: 'task_current_nb',
    policy: { minimumComparableTasks: 8, minimumTasksPerFactor: 5, overdispersionThreshold: 1 }
  });
  assert.ok(negativeBinomial.associations.some((association) => association.model === 'negative_binomial'));
});

test('reprocesses legacy retry candidates conservatively without inventing 1.1 events', () => {
  const legacy = syntheticTaskEvents(400, 0.5, 1)
    .flatMap((event) => event.event_type === 'implementation_attempt_observed'
      ? [{
          ...event,
          event_type: 'agent_response',
          payload: {
            response_tokens: 20,
            model: null,
            tools_invoked: 1,
            files_read: 1,
            files_modified: 1,
            execution_duration_ms: 100
          }
        }]
      : ['human_retry_detected', 'recommendation_applied'].includes(event.event_type) ? [] : [event])
    .map((event) => ({ ...event, schema_version: '1.0' }));
  const record = aggregateTask(legacy, 'task_synthetic_400');
  assert.equal(record.human_retry_count, 1);
  assert.equal(record.human_retry_derivation_source, 'legacy_v1_0_reprocessed');
  assert.equal(record.material_implementation_attempt_count, 2);

  const withoutPriorAttempt = legacy.filter((event) => event.interaction_id !== 'interaction_400_0'
    || !['test_run', 'agent_response', 'file_activity', 'build_run', 'git_event'].includes(event.event_type));
  assert.equal(aggregateTask(withoutPriorAttempt, 'task_synthetic_400').human_retry_count, 0);
});

test('VS Code and Codex runtime copies use the same telemetry implementation', () => {
  assert.equal(
    fs.readFileSync(path.join(root, 'telemetry.cjs'), 'utf8'),
    fs.readFileSync(path.join(root, 'codex-plugin', 'plugins', 'code-buddy', 'scripts', 'telemetry.cjs'), 'utf8')
  );
});

test('published schema, audit, dictionary, and synthetic dataset stay usable', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'telemetry-schema-v1.1.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, TELEMETRY_SCHEMA_VERSION);
  const legacySchema = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'telemetry-schema-v1.json'), 'utf8'));
  assert.equal(legacySchema.properties.schema_version.const, '1.0');
  const sample = readTelemetryEvents(path.join(root, 'docs', 'examples', 'telemetry-events-v1.jsonl'));
  assert.deepEqual(sample.invalid, []);
  assert.equal(aggregateTask(sample.events, 'task_T123').completed, true);
  const aggregator = new TaskAggregator(sample.events);
  assert.equal(aggregator.getTask('task_T123').recommendations_accepted, 1);
  assert.equal(aggregator.finalizeTask('task_T123').completed, true);
  assert.equal(aggregator.rebuildTask('task_T123').test_runs, 2);
  const humanRetrySample = readTelemetryEvents(path.join(root, 'docs', 'examples', 'human-retry-events-v1.1.jsonl'));
  assert.deepEqual(humanRetrySample.invalid, []);
  assert.equal(aggregateTask(humanRetrySample.events, 'task_HR1').human_retry_count, 1);
  for (const document of ['telemetry-data-dictionary.md', 'telemetry-raw-log-audit.md']) {
    const contents = fs.readFileSync(path.join(root, 'docs', document), 'utf8');
    assert.match(contents, /schema [`']?1\.1/i);
  }
});
