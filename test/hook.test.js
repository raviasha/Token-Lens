const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const hookPath = path.join(__dirname, '..', 'hook.cjs');

function runHook(payload, environment = {}, existingDirectory = null) {
  const directory = existingDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-'));
  const logPath = environment.TOKEN_LENS_LOG_FILE || path.join(directory, 'session.jsonl');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_LOG_FILE: logPath,
      TOKEN_LENS_REDACT_SENSITIVE: 'true',
      TOKEN_LENS_CAPTURE_TRANSCRIPTS: 'true',
      ...environment
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const records = fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { directory, records, output };
}

function writePendingHandoff(stateDirectory, handoff = {}) {
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, 'pending-fresh-handoff.json'), JSON.stringify({
    schemaVersion: 1,
    handoffId: 'handoff-1',
    sourceSessionId: 'source-session',
    targetTask: 'Implement the requested command.',
    createdAt: '2026-08-12T00:00:00.000Z',
    ...handoff
  }), 'utf8');
}

test('writes structured events, redacts sensitive fields, and injects cold-start feedback', () => {
  const { records, output } = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: '/workspace/project',
    prompt: 'Use apiKey=do-not-log and bearer abc123 to fix this'
  });

  const promptRecord = records.find((record) => record.recordType === 'user.prompt');
  assert.ok(promptRecord);
  assert.equal(promptRecord.schemaVersion, 2);
  assert.equal(promptRecord.sourceEventType, 'UserPromptSubmit');
  assert.equal(promptRecord.sessionId, 'session-1');
  assert.match(promptRecord.localTimestamp, /[+-]\d{2}:\d{2}$/);
  assert.match(promptRecord.recordedAt, /[+-]\d{2}:\d{2}$/);
  assert.match(promptRecord.data.prompt, /\[REDACTED\]/);
  assert.doesNotMatch(promptRecord.data.prompt, /do-not-log/);
  assert.equal(promptRecord.data.context.measurement, 'observed_text_estimate');
  assert.equal(promptRecord.data.context.role, 'user_prompt');
  assert.equal(promptRecord.data.context.estimatedTokens, Math.ceil(promptRecord.data.context.observedChars / 4));
  assert.ok(records.some((record) => record.recordType === 'preflight.started'));
  assert.match(output?.hookSpecificOutput?.additionalContext || '', /Personalized recommendation — Not enough data/);
});

test('preflight gate redirects implementation until all four Code Buddy checks complete', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-preflight-'));
  const environment = {
    TOKEN_LENS_PREFLIGHT_ENFORCE: 'true',
    TOKEN_LENS_PREFLIGHT_DENIALS_BEFORE_FALLBACK: '5',
    TOKEN_LENS_INTERVENTION_LOG_FILE: path.join(directory, 'interventions.jsonl')
  };

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'preflight-session',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: directory,
    prompt: 'Implement input validation and add automated tests.'
  }, environment, directory);

  const observational = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'preflight-session',
    tool_name: 'read_file',
    tool_use_id: 'read-1',
    tool_input: { filePath: 'src/input.ts' }
  }, environment, directory);
  assert.equal(observational.output, null);

  const blocked = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'preflight-session',
    tool_name: 'replace_string_in_file',
    tool_use_id: 'edit-1',
    tool_input: { filePath: 'src/input.ts' }
  }, environment, directory);
  assert.equal(blocked.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_reviewPrompt/);
  assert.match(blocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_decomposeTask/);
  assert.match(blocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_measureContext/);
  assert.match(blocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_assessSessionFit/);

  const reviewerStart = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'preflight-session',
    tool_name: 'code-buddy_reviewPrompt',
    tool_use_id: 'review-1',
    tool_input: { prompt: 'Implement input validation and add automated tests.' }
  }, environment, directory);
  assert.equal(reviewerStart.output, null);
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'preflight-session',
    tool_name: 'code-buddy_reviewPrompt',
    tool_use_id: 'review-1',
    tool_result: { status: 'ok' }
  }, environment, directory);

  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'preflight-session',
    tool_name: 'code-buddy_decomposeTask',
    tool_use_id: 'decompose-1',
    tool_result: { status: 'ok' }
  }, environment, directory);

  const stillBlocked = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'preflight-session',
    tool_name: 'replace_string_in_file',
    tool_use_id: 'edit-2',
    tool_input: { filePath: 'src/input.ts' }
  }, environment, directory);
  assert.equal(stillBlocked.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(stillBlocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_measureContext/);
  assert.match(stillBlocked.output.hookSpecificOutput.permissionDecisionReason, /code-buddy_assessSessionFit/);

  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'preflight-session',
    tool_name: 'code-buddy_measureContext',
    tool_use_id: 'context-1',
    tool_result: { status: 'fallback' }
  }, environment, directory);
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'preflight-session',
    tool_name: 'code-buddy_assessSessionFit',
    tool_use_id: 'fit-1',
    tool_result: { status: 'ok', freshTaskRecommended: false }
  }, environment, directory);

  const allowed = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'preflight-session',
    tool_name: 'replace_string_in_file',
    tool_use_id: 'edit-2',
    tool_input: { filePath: 'src/input.ts' }
  }, environment, directory);
  assert.equal(allowed.output, null);
  assert.ok(allowed.records.some((record) => record.recordType === 'preflight.completed'));
  const health = allowed.records.findLast((record) => record.recordType === 'health.check_limited');
  assert.ok(health);
  assert.deepEqual(Object.keys(health.data.categories).sort(), ['contextMeasurement', 'promptReviewer', 'sessionFit', 'taskDecomposer']);

  const interventions = fs.readFileSync(environment.TOKEN_LENS_INTERVENTION_LOG_FILE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(interventions.some((record) => record.eventType === 'preflight.gate_denied'));
  assert.ok(interventions.some((record) => record.eventType === 'preflight.tool_completed'
    && record.data.invocationSource === 'language_model_tool'));
});

test('preflight gate offers an explicit controlled fallback instead of permanently blocking', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-fallback-'));
  const environment = {
    TOKEN_LENS_PREFLIGHT_ENFORCE: 'true',
    TOKEN_LENS_PREFLIGHT_DENIALS_BEFORE_FALLBACK: '1'
  };

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'fallback-session',
    prompt: 'Implement the requested migration across the service.'
  }, environment, directory);
  const denied = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'fallback-session',
    tool_name: 'run_in_terminal',
    tool_use_id: 'terminal-1'
  }, environment, directory);
  assert.equal(denied.output.hookSpecificOutput.permissionDecision, 'deny');

  const fallback = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'fallback-session',
    tool_name: 'run_in_terminal',
    tool_use_id: 'terminal-2'
  }, environment, directory);
  assert.equal(fallback.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(fallback.output.hookSpecificOutput.permissionDecisionReason, /controlled fail-open/);

  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'fallback-session',
    tool_name: 'run_in_terminal',
    tool_use_id: 'terminal-2',
    tool_result: { status: 'ok' }
  }, environment, directory);
  const allowedAfterApproval = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'fallback-session',
    tool_name: 'create_file',
    tool_use_id: 'create-1'
  }, environment, directory);
  assert.equal(allowedAfterApproval.output, null);
  assert.ok(allowedAfterApproval.records.some((record) => record.recordType === 'preflight.bypassed'));
});

test('semantic tool failures satisfy preflight through the safe fallback contract', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-tool-failure-'));
  const environment = { TOKEN_LENS_PREFLIGHT_ENFORCE: 'true' };
  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'failure-session',
    prompt: 'Refactor the provider implementation and update its tests.'
  }, environment, directory);
  runHook({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'failure-session',
    tool_name: 'code-buddy_reviewPrompt',
    tool_use_id: 'review-failed',
    error: 'Model unavailable'
  }, environment, directory);
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'failure-session',
    tool_name: 'code-buddy_decomposeTask',
    tool_use_id: 'decompose-ok',
    tool_result: { status: 'fallback' }
  }, environment, directory);
  runHook({
    hook_event_name: 'PostToolUse',
    session_id: 'failure-session',
    tool_name: 'code-buddy_measureContext',
    tool_use_id: 'context-fallback',
    tool_result: { status: 'fallback' }
  }, environment, directory);
  runHook({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'failure-session',
    tool_name: 'code-buddy_assessSessionFit',
    tool_use_id: 'fit-failed',
    error: 'Model unavailable'
  }, environment, directory);
  const allowed = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'failure-session',
    tool_name: 'create_file',
    tool_use_id: 'create-after-failure'
  }, environment, directory);
  assert.equal(allowed.output, null);
  const completion = allowed.records.findLast((record) => record.recordType === 'preflight.completed');
  assert.ok(completion);
  assert.equal(completion.data.completedWithFallback, true);
});

test('control replies bypass semantic preflight enforcement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-control-'));
  const submitted = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'control-session',
    prompt: 'continue'
  }, {}, directory);
  assert.match(submitted.output?.hookSpecificOutput?.additionalContext || '', /At the beginning.*Personalized recommendation — Not enough data/);
  const allowed = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'control-session',
    tool_name: 'run_in_terminal',
    tool_use_id: 'control-terminal'
  }, {}, directory);
  assert.equal(allowed.output, null);
  assert.ok(allowed.records.some((record) => record.recordType === 'preflight.skipped'));
});

test('blocks every target-session tool until the marked handoff is pasted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-waiting-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  const submitted = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: 'Implement the requested command.'
  }, environment, directory);
  assert.match(submitted.output?.hookSpecificOutput?.additionalContext || '', /paste.*handoff|continue without curated context/i);

  const deniedRead = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'target-session',
    cwd: directory,
    tool_name: 'read_file',
    tool_use_id: 'read-while-waiting'
  }, environment, directory);
  assert.equal(deniedRead.output?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(deniedRead.records.some((record) => record.recordType === 'context.handoff_waiting'));
});

test('releases a target session after the marked handoff is pasted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-pasted-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  const pasted = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: '<!-- code-buddy-handoff:handoff-1 -->\n[CONTEXT HANDOFF]\n\nTask objective: Implement the requested command.'
  }, environment, directory);
  assert.match(pasted.output?.hookSpecificOutput?.additionalContext || '', /Personalized recommendation — Not enough data/);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'pending-fresh-handoff.json')), false);
  assert.ok(pasted.records.some((record) => record.recordType === 'context.handoff_pasted'));
  assert.ok(pasted.records.some((record) => record.recordType === 'preflight.started'));
});

test('releases a target session after the explicit no-context continuation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-bypassed-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  const bypassed = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: 'Code Buddy: continue without curated context'
  }, environment, directory);
  assert.match(bypassed.output?.hookSpecificOutput?.additionalContext || '', /Personalized recommendation — Not enough data/);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'pending-fresh-handoff.json')), false);
  assert.ok(bypassed.records.some((record) => record.recordType === 'context.handoff_bypassed'));
  assert.ok(bypassed.records.some((record) => record.recordType === 'preflight.started'));
});

test('ignores transport whitespace around the explicit no-context continuation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-bypass-whitespace-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  const bypassed = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: '  Code Buddy: continue without curated context\n'
  }, environment, directory);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'pending-fresh-handoff.json')), false);
  assert.ok(bypassed.records.some((record) => record.recordType === 'context.handoff_bypassed'));
  assert.ok(bypassed.records.some((record) => record.recordType === 'preflight.started'));
});

test('does not accept a non-exact no-context continuation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-inexact-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  const submitted = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: 'Code Buddy: continue without curated context!'
  }, environment, directory);
  assert.match(submitted.output?.hookSpecificOutput?.additionalContext || '', /paste.*handoff|continue without curated context/i);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'pending-fresh-handoff.json')), true);
});

test('fails open when pending handoff state is malformed and cannot be removed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-malformed-'));
  const stateDirectory = path.join(directory, '.state');
  fs.mkdirSync(path.join(stateDirectory, 'pending-fresh-handoff.json'), { recursive: true });
  const submitted = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: directory,
    prompt: 'Implement the requested command.'
  }, { TOKEN_LENS_STATE_DIR: stateDirectory }, directory);

  assert.ok(submitted.records.some((record) => record.recordType === 'context.handoff_invalid'));
  assert.ok(submitted.records.some((record) => record.recordType === 'preflight.started'));
});

test('does not block the source session that created the handoff', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-handoff-source-'));
  const stateDirectory = path.join(directory, '.state');
  const environment = { TOKEN_LENS_STATE_DIR: stateDirectory };
  writePendingHandoff(stateDirectory);

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'source-session',
    cwd: directory,
    prompt: 'Continue the current implementation work.'
  }, environment, directory);
  const observational = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'source-session',
    cwd: directory,
    tool_name: 'read_file',
    tool_use_id: 'source-read'
  }, environment, directory);
  assert.equal(observational.output, null);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'pending-fresh-handoff.json')), true);
});

test('captures transformed prompt context and provider usage when supplied', () => {
  const { records } = runHook({
    hook_event_name: 'UserPromptTransformed',
    session_id: 'session-usage',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: '/workspace/project',
    prompt: 'Fix the bug',
    transformedPrompt: 'Fix the bug in the selected authentication module.',
    usage: {
      input_tokens: 1200,
      cached_input_tokens: 800,
      output_tokens: 300,
      total_tokens: 2300
    }
  });

  assert.equal(records[0].data.context.role, 'model_facing_prompt');
  assert.equal(records[0].data.context.observedChars, records[0].data.transformedPrompt.length);
  assert.deepEqual(records[0].data.providerUsage, {
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 300,
    totalTokens: 2300
  });
});

test('captures a transcript snapshot on stop', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-transcript-'));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'session.start',
      data: { sessionId: 'session-2' },
      id: 'event-session-start',
      timestamp: '2026-08-08T00:00:00.000Z',
      parentId: null
    }),
    JSON.stringify({
      type: 'assistant.turn_start',
      data: { turnId: '0' },
      id: 'event-turn-start',
      timestamp: '2026-08-08T00:00:00.100Z',
      parentId: 'event-user'
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: { messageId: 'message-1', content: 'done', toolRequests: [] },
      id: 'event-assistant-message',
      timestamp: '2026-08-08T00:00:00.200Z',
      parentId: 'event-turn-start'
    }),
    JSON.stringify({
      type: 'assistant.turn_end',
      data: { turnId: '0' },
      id: 'event-turn-end',
      timestamp: '2026-08-08T00:00:00.300Z',
      parentId: 'event-assistant-message'
    })
  ].join('\n') + '\n', 'utf8');
  const { records } = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-2',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  });

  assert.equal(records.length, 5);
  assert.equal(records[1].recordType, 'turn.started');
  assert.equal(records[2].recordType, 'assistant.message');
  assert.equal(records[2].data.content, 'done');
  assert.equal(records[3].recordType, 'turn.ended');
  assert.equal(records[4].recordType, 'transcript.snapshot');
  assert.equal(records[4].sessionId, 'session-2');
  assert.match(records[4].data.content, /assistant.message/);
});

test('does not duplicate transcript events across repeated stop hooks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-dedupe-'));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant.message',
    data: { messageId: 'message-1', content: 'one' },
    id: 'event-assistant-message',
    timestamp: '2026-08-08T00:00:00.200Z',
    parentId: null
  }) + '\n', 'utf8');

  const first = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-3',
    timestamp: '2026-08-08T00:00:01.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  });
  const second = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-3',
    timestamp: '2026-08-08T00:00:02.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  }, {}, directory);

  const allRecords = [...first.records, ...second.records];
  const assistantEventIds = new Set(
    allRecords
      .filter((record) => record.recordType === 'assistant.message')
      .map((record) => record.eventId)
  );
  assert.equal(assistantEventIds.size, 1);
});

test('continues without blocking when logging cannot be configured', () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
    env: { ...process.env, TOKEN_LENS_LOG_FILE: '' }
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /TOKEN_LENS_LOG_FILE/);
});
