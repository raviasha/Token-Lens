const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.join(__dirname, '..');
const hookPath = path.join(pluginRoot, 'hooks', 'code_buddy_hook.cjs');

function runPluginHook(payload, workspace, environment = {}) {
  const logPath = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_LOG_FILE: logPath,
      TOKEN_LENS_INTERVENTION_LOG_FILE: path.join(workspace, '.code-buddy', 'interventions.jsonl'),
      TOKEN_LENS_REDACT_SENSITIVE: 'true',
      ...environment
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const records = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { output: result.stdout.trim() ? JSON.parse(result.stdout) : null, records };
}

function writePendingHandoff(workspace, handoff = {}) {
  const stateDirectory = path.join(workspace, '.code-buddy', '.state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, 'pending-fresh-handoff.json'), JSON.stringify({
    schemaVersion: 1,
    handoffId: 'handoff-1',
    sourceSessionId: 'source-session',
    targetTask: 'Create a command.',
    createdAt: '2026-08-12T00:00:00.000Z',
    ...handoff
  }), 'utf8');
}

function writeRollout(sessionsRoot, workspace, sessionId, inputTokens, modelContextWindow = 200_000) {
  const directory = path.join(sessionsRoot, '2026', '08', '18');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-08-18T00-00-00-${sessionId}.jsonl`);
  const usage = {
    input_tokens: inputTokens,
    cached_input_tokens: Math.max(0, inputTokens - 1_000),
    output_tokens: 100,
    reasoning_output_tokens: 50,
    total_tokens: inputTokens + 150
  };
  fs.writeFileSync(filePath, [
    { timestamp: '2026-08-18T00:00:00.000Z', type: 'turn_context', payload: { cwd: workspace } },
    { timestamp: '2026-08-18T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage, model_context_window: modelContextWindow } } }
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');
}

test('injects automatic Code Buddy preflight for a meaningful request', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-preflight-'));
  const { output } = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'enabled-session',
    cwd: workspace,
    prompt: 'Create a Cursor plugin with a command and tests.'
  }, workspace);

  const context = output?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /mcp__code_buddy__review_prompt/);
  assert.match(context, /mcp__code_buddy__decompose_task/);
  assert.match(context, /mcp__code_buddy__measure_context/);
  assert.match(context, /mcp__code_buddy__assess_session_fit/);
  assert.match(context, /Code Buddy:/);
  assert.match(context, /measure_context\.healthLineStatus/);
  assert.match(context, /actual percentage/);
  assert.match(context, /Personalized recommendation — Not enough data/);
});

test('surfaces warning native context snapshots without relabeling them as estimates', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-native-warning-'));
  const logPath = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, [
    { schemaVersion: 2, eventId: 'prior-prompt', recordType: 'user.prompt', sessionId: 'native-warning', timestamp: '2026-08-18T00:00:00.000Z', data: { prompt: 'Implement authentication token refresh.' } },
    { schemaVersion: 2, eventId: 'native-context', recordType: 'context.load_snapshot', sessionId: 'native-warning', timestamp: '2026-08-18T00:00:01.000Z', data: { actualContextUtilization: { value: 150_000, unit: 'tokens', utilization: 0.75, capacityTokens: 200_000, thresholdState: 'warning' } } }
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');

  const { output } = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'native-warning',
    cwd: workspace,
    prompt: 'Continue authentication work and add expiry tests.'
  }, workspace);
  const context = output?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /warning Actual Context Utilization/);
  assert.match(context, /native input-token\/model-window ratio/);
  assert.doesNotMatch(context, /Never claim this estimate is actual/);
});

test('uses a live native token count to warn before curation is recommended', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-early-warning-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-sessions-'));
  writeRollout(sessionsRoot, workspace, 'early-warning', 120_000);

  const { output } = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'early-warning',
    cwd: workspace,
    prompt: 'Continue the current implementation and run its focused tests.'
  }, workspace, { CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot });

  const context = output?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /warning Actual Context Utilization/);
  assert.match(context, /curation choices begin at 65%/);
  assert.doesNotMatch(context, /all three choices/);
});

test('recommends curation from the live native token count at 65 percent', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-curation-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-sessions-'));
  writeRollout(sessionsRoot, workspace, 'curation-session', 132_000);

  const { output } = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'curation-session',
    cwd: workspace,
    prompt: 'Continue the current implementation and run its focused tests.'
  }, workspace, { CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot });

  const context = output?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /critical Actual Context Utilization/);
  assert.match(context, /fresh-task curation, current-task curation, or continuing unchanged/);
});

test('pauses implementation at 70 percent until the developer choice is recorded', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-pause-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-sessions-'));
  const environment = { CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot };
  writeRollout(sessionsRoot, workspace, 'pause-session', 144_000);

  const blocked = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'pause-session', cwd: workspace,
    tool_name: 'apply_patch', tool_use_id: 'edit-before-choice'
  }, workspace, environment);
  assert.equal(blocked.output?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(blocked.output?.hookSpecificOutput?.permissionDecisionReason || '', /72\.0% actual/);
  assert.match(blocked.output?.hookSpecificOutput?.permissionDecisionReason || '', /Curate for a fresh task/);

  const observational = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'pause-session', cwd: workspace,
    tool_name: 'read_file', tool_use_id: 'read-during-pause'
  }, workspace, environment);
  assert.equal(observational.output, null);

  runPluginHook({
    hook_event_name: 'PostToolUse', session_id: 'pause-session', cwd: workspace,
    tool_name: 'mcp__code_buddy__record_intervention', tool_use_id: 'record-choice',
    tool_input: { eventType: 'context.pre_compaction_choice', data: { choice: 'continue_unchanged' } },
    tool_response: { status: 'recorded' }
  }, workspace, environment);

  const allowed = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'pause-session', cwd: workspace,
    tool_name: 'apply_patch', tool_use_id: 'edit-after-choice'
  }, workspace, environment);
  assert.equal(allowed.output, null);
  assert.ok(allowed.records.some((record) => record.recordType === 'context.pre_compaction_choice'
    && record.data.choice === 'continue_unchanged'));
});

test('records when Codex compacts before a pre-compaction choice is completed', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-missed-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-sessions-'));
  const environment = { CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot };
  writeRollout(sessionsRoot, workspace, 'missed-session', 164_000);

  const compacted = runPluginHook({
    hook_event_name: 'PreCompact', session_id: 'missed-session', cwd: workspace,
    trigger: 'auto'
  }, workspace, environment);

  const missed = compacted.records.findLast((record) => record.recordType === 'context.pre_compaction_missed');
  assert.ok(missed);
  assert.equal(missed.data.missed, true);
  assert.equal(missed.data.reason, 'no_pre_compaction_pause_observed');
});

test('requires all four automatic Code Buddy tools before implementation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-four-checks-'));
  const environment = { TOKEN_LENS_PREFLIGHT_DENIALS_BEFORE_FALLBACK: '5' };
  runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'four-check-session',
    cwd: workspace,
    prompt: 'Create a Cursor plugin with a command and tests.'
  }, workspace, environment);

  const initiallyBlocked = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'four-check-session', cwd: workspace,
    tool_name: 'apply_patch', tool_use_id: 'edit-1'
  }, workspace, environment);
  assert.match(initiallyBlocked.output?.hookSpecificOutput?.permissionDecisionReason || '', /mcp__code_buddy__measure_context/);
  assert.match(initiallyBlocked.output?.hookSpecificOutput?.permissionDecisionReason || '', /mcp__code_buddy__assess_session_fit/);

  for (const [tool_name, tool_use_id, tool_response] of [
    ['mcp__code_buddy__review_prompt', 'review-1', { status: 'ok' }],
    ['mcp__code_buddy__decompose_task', 'decompose-1', { status: 'ok' }]
  ]) {
    runPluginHook({ hook_event_name: 'PostToolUse', session_id: 'four-check-session', cwd: workspace, tool_name, tool_use_id, tool_response }, workspace, environment);
  }
  const stillBlocked = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'four-check-session', cwd: workspace,
    tool_name: 'apply_patch', tool_use_id: 'edit-2'
  }, workspace, environment);
  assert.match(stillBlocked.output?.hookSpecificOutput?.permissionDecisionReason || '', /mcp__code_buddy__measure_context/);

  for (const [tool_name, tool_use_id, tool_response] of [
    ['mcp__code_buddy__measure_context', 'context-1', { status: 'fallback' }],
    ['mcp__code_buddy__assess_session_fit', 'fit-1', { status: 'ok', freshTaskRecommended: false }]
  ]) {
    runPluginHook({ hook_event_name: 'PostToolUse', session_id: 'four-check-session', cwd: workspace, tool_name, tool_use_id, tool_response }, workspace, environment);
  }
  const allowed = runPluginHook({
    hook_event_name: 'PreToolUse', session_id: 'four-check-session', cwd: workspace,
    tool_name: 'apply_patch', tool_use_id: 'edit-3'
  }, workspace, environment);
  assert.equal(allowed.output, null);
  assert.ok(allowed.records.some((record) => record.recordType === 'health.check_limited'));
});

test('denies every target-session tool while a curated handoff waits', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-waiting-'));
  writePendingHandoff(workspace);
  const submitted = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: workspace,
    prompt: 'Create the requested command.'
  }, workspace);
  assert.match(submitted.output?.hookSpecificOutput?.additionalContext || '', /paste.*handoff|continue without curated context/i);

  const denied = runPluginHook({
    hook_event_name: 'PreToolUse',
    session_id: 'target-session',
    cwd: workspace,
    tool_name: 'read_file',
    tool_use_id: 'read-while-waiting'
  }, workspace);
  assert.equal(denied.output?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('releases a target session when its marked handoff is pasted', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-pasted-'));
  writePendingHandoff(workspace);
  const pasted = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: workspace,
    prompt: '<!-- code-buddy-handoff:handoff-1 -->\n[CONTEXT HANDOFF]\nCreate the command.'
  }, workspace);

  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), false);
  assert.ok(pasted.records.some((record) => record.recordType === 'context.handoff_pasted'));
  assert.match(pasted.output?.hookSpecificOutput?.additionalContext || '', /mcp__code_buddy__review_prompt/);
});

test('releases a target session after explicit no-context continuation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-bypassed-'));
  writePendingHandoff(workspace);
  const bypassed = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: workspace,
    prompt: 'Code Buddy: continue without curated context'
  }, workspace);

  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), false);
  assert.ok(bypassed.records.some((record) => record.recordType === 'context.handoff_bypassed'));
  assert.match(bypassed.output?.hookSpecificOutput?.additionalContext || '', /mcp__code_buddy__review_prompt/);
});

test('ignores transport whitespace around explicit no-context continuation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-bypass-whitespace-'));
  writePendingHandoff(workspace);
  const bypassed = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: workspace,
    prompt: '  Code Buddy: continue without curated context\n'
  }, workspace);

  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), false);
  assert.ok(bypassed.records.some((record) => record.recordType === 'context.handoff_bypassed'));
  assert.match(bypassed.output?.hookSpecificOutput?.additionalContext || '', /mcp__code_buddy__review_prompt/);
});

test('does not accept a non-exact no-context continuation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-inexact-'));
  writePendingHandoff(workspace);
  const submitted = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'target-session',
    cwd: workspace,
    prompt: 'Code Buddy: continue without curated context!'
  }, workspace);

  assert.match(submitted.output?.hookSpecificOutput?.additionalContext || '', /paste.*handoff|continue without curated context/i);
  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), true);
});

test('does not gate the source session that created the handoff', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-source-'));
  writePendingHandoff(workspace);
  runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'source-session',
    cwd: workspace,
    prompt: 'Continue the current implementation work.'
  }, workspace);
  const observational = runPluginHook({
    hook_event_name: 'PreToolUse',
    session_id: 'source-session',
    cwd: workspace,
    tool_name: 'read_file',
    tool_use_id: 'source-read'
  }, workspace);
  assert.equal(observational.output, null);
});
