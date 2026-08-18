const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.join(__dirname, '..');
const mcpPath = path.join(pluginRoot, 'scripts', 'code_buddy_mcp.py');
const nodePolicyPath = path.join(pluginRoot, 'scripts', 'project_policy.cjs');
const pythonPolicyPath = path.join(pluginRoot, 'scripts', 'project_policy.py');
const fixtures = require('./fixtures/code-buddy-policy-fixtures.json');

function call(name, arguments, environment = {}) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments }
  };
  const result = spawnSync('python3', [mcpPath], {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).result.structuredContent;
}

function writeRollout(sessionsRoot, workspace, sessionId, usage, modelContextWindow) {
  const directory = path.join(sessionsRoot, '2026', '08', '18');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-08-18T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    { timestamp: '2026-08-18T00:00:00.000Z', type: 'turn_context', payload: { cwd: workspace } },
    { timestamp: '2026-08-18T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage, model_context_window: modelContextWindow } } }
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');
}

function curate(workspace, mode, developerConfirmed) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'curate_context',
      arguments: {
        workspace,
        sessionId: 'source-session',
        targetTask: 'Create a command.',
        mode,
        developerConfirmed,
        conversationHistory: ['The command must preserve compatibility.']
      }
    }
  };
  const result = spawnSync('python3', [mcpPath], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).result.structuredContent;
}

test('confirmed fresh-task curation creates a marked pending handoff', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-fresh-'));
  const result = curate(workspace, 'fresh_task', true);
  assert.match(result.handoffId || '', /^[a-f0-9-]{36}$/);
  assert.equal(result.handoffMarker, `<!-- code-buddy-handoff:${result.handoffId} -->`);
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.code-buddy', '.state', 'pending-fresh-handoff.json'), 'utf8'));
  assert.equal(state.handoffId, result.handoffId);
  assert.equal(state.sourceSessionId, 'source-session');
});

test('unconfirmed and current-task curation do not create a pending handoff', () => {
  const unconfirmedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-unconfirmed-'));
  const unconfirmed = curate(unconfirmedWorkspace, 'fresh_task', false);
  assert.equal(unconfirmed.handoffId, undefined);
  assert.equal(fs.existsSync(path.join(unconfirmedWorkspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), false);

  const currentWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-current-'));
  const current = curate(currentWorkspace, 'continue_current', true);
  assert.equal(current.handoffId, undefined);
  assert.equal(fs.existsSync(path.join(currentWorkspace, '.code-buddy', '.state', 'pending-fresh-handoff.json')), false);
});

test('session fit uses a model assessment but keeps fresh-task action developer-controlled', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-fit-'));
  const result = call('assess_session_fit', {
    workspace,
    prompt: 'Build a CSV export endpoint in src/reports/exportController.ts.',
    previousPrompt: 'Implement OAuth refresh handling in src/auth/tokenService.ts.',
    modelAssessment: { newTaskLikelihood: 82, confidence: 'high', reason: 'Distinct subsystem.' }
  });

  assert.equal(result.freshTaskRecommended, true);
  assert.equal(result.assessmentSource, 'codex_model');
  assert.equal(result.newTaskLikelihood, 82);
});

test('session status exposes task telemetry and replay paths', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-status-'));
  const telemetryState = path.join(workspace, '.code-buddy', 'telemetry', '.state', 'telemetry-state.json');
  fs.mkdirSync(path.dirname(telemetryState), { recursive: true });
  fs.writeFileSync(telemetryState, JSON.stringify({
    active_task: { task_id: 'task_status' },
    tasks: { task_status: { task_id: 'task_status' } }
  }), 'utf8');
  const status = call('session_status', { workspace });
  assert.equal(status.telemetrySchemaVersion, '1.1');
  assert.equal(status.telemetryTaskCount, 1);
  assert.equal(status.activeTaskId, 'task_status');
  assert.match(status.telemetryRawDirectory, /\.code-buddy[/\\]telemetry[/\\]raw$/);
  assert.match(status.telemetryReplayCommand, /telemetry\.cjs.*replay/);
  assert.match(status.humanRetryAnalysisCommand, /telemetry\.cjs.*analyze/);
});

test('human retry analysis always returns model-derived cold-start feedback', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-analysis-'));
  const analysis = call('analyze_human_retries', { workspace });
  assert.equal(analysis.analysis_schema_version, 'human-retry-analysis-v1');
  assert.match(analysis.feedback, /^Personalized recommendation — Not enough data yet/);
  assert.equal(analysis.reliability.enough_data, false);
});

test('context measurement automatically uses native Codex input tokens and model window', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-native-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-codex-sessions-'));
  writeRollout(sessionsRoot, workspace, 'native-session', {
    input_tokens: 150_000,
    cached_input_tokens: 120_000,
    output_tokens: 4_000,
    reasoning_output_tokens: 2_000,
    total_tokens: 156_000
  }, 200_000);

  const result = call('measure_context', { workspace, sessionId: 'native-session' }, {
    CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot
  });
  assert.equal(result.measurement.method, 'codex_token_count_event');
  assert.equal(result.measurement.value, 150_000);
  assert.equal(result.measurement.capacity, 200_000);
  assert.equal(result.measurement.utilization, 0.75);
  assert.equal(result.measurement.cachedInputTokens, 120_000);
  assert.equal(result.measurement.thresholdState, 'warning');
  assert.equal(result.measurement.terminology, 'Actual Context Utilization');
});

test('context measurement keeps actual tokens but omits percent when Codex omits capacity', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-mcp-no-capacity-'));
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-codex-sessions-'));
  writeRollout(sessionsRoot, workspace, 'no-capacity-session', { input_tokens: 8_000, total_tokens: 8_000 }, undefined);
  const result = call('measure_context', { workspace, sessionId: 'no-capacity-session' }, {
    CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot
  });
  assert.equal(result.measurement.value, 8_000);
  assert.equal(result.measurement.capacity, null);
  assert.equal(result.measurement.utilization, null);
  assert.equal(result.measurement.thresholdState, 'unavailable');
  assert.equal(result.recommendation, 'continue');
});

test('Node and Python policy parsers produce the same normalized policy', () => {
  for (const contents of Object.values(fixtures)) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-plugin-policy-'));
    fs.writeFileSync(path.join(workspace, 'code-buddy.yaml'), contents, 'utf8');
    const nodeResult = spawnSync(process.execPath, [nodePolicyPath, workspace], { encoding: 'utf8' });
    const pythonResult = spawnSync('python3', [pythonPolicyPath, workspace], { encoding: 'utf8' });
    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.equal(pythonResult.status, 0, pythonResult.stderr);
    assert.deepEqual(JSON.parse(nodeResult.stdout), JSON.parse(pythonResult.stdout));
  }
});
