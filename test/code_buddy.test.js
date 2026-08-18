const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const hookPath = path.join(__dirname, '..', 'hook.cjs');
const scriptPath = path.join(__dirname, '..', 'code_buddy.py');

function findPython() {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  return candidates.find((command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0) || null;
}

function runHook(payload, environment) {
  const logPath = environment.TOKEN_LENS_LOG_FILE;
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_REDACT_SENSITIVE: 'true',
      TOKEN_LENS_CAPTURE_TRANSCRIPTS: 'true',
      ...environment
    }
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const pythonCommand = findPython();

function writeCodexRollout(sessionsRoot, workspace, sessionId) {
  const directory = path.join(sessionsRoot, '2026', '08', '18');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-2026-08-18T00-00-00-${sessionId}.jsonl`), [
    { timestamp: '2026-08-18T00:00:00.000Z', type: 'turn_context', payload: { cwd: workspace } },
    { timestamp: '2026-08-18T00:00:02.500Z', type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 30_000, cached_input_tokens: 20_000, output_tokens: 2_000, reasoning_output_tokens: 500, total_tokens: 32_500 },
      total_token_usage: { input_tokens: 45_000, cached_input_tokens: 30_000, output_tokens: 3_000, reasoning_output_tokens: 700, total_tokens: 48_700 },
      model_context_window: 40_000
    } } }
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');
}

test('generates deterministic Code Buddy reports from a completed turn', { skip: !pythonCommand }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-code-buddy-'));
  const workspace = path.join(directory, 'workspace');
  const logPath = path.join(workspace, '.token-lens', 'copilot-session.jsonl');
  const statePath = path.join(workspace, '.token-lens', '.state');
  const feedbackPath = path.join(workspace, 'Code Buddy.md');
  const analyticsPath = path.join(workspace, 'Code Buddy Analytics.md');
  const interventionPath = path.join(workspace, '.code-buddy', 'interventions.jsonl');
  const sessionsRoot = path.join(directory, 'codex-sessions');
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app.js'), 'one\ntwo\n', 'utf8');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant.message',
    data: { content: 'Updated app.js', toolRequests: [] },
    id: 'assistant-1',
    timestamp: '2026-08-08T00:00:02.000Z'
  })}\n`, 'utf8');
  writeCodexRollout(sessionsRoot, workspace, 'analytics-session');

  const environment = {
    TOKEN_LENS_LOG_FILE: logPath,
    TOKEN_LENS_STATE_DIR: statePath,
    TOKEN_LENS_ANALYTICS_SCRIPT: scriptPath,
    TOKEN_LENS_FEEDBACK_FILE: feedbackPath,
    TOKEN_LENS_ANALYTICS_FILE: analyticsPath,
    TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'true',
    TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES: '1000000',
    TOKEN_LENS_PYTHON_COMMAND: pythonCommand,
    TOKEN_LENS_INTERVENTION_LOG_FILE: interventionPath,
    CODE_BUDDY_CODEX_SESSIONS_DIR: sessionsRoot
  };

  fs.mkdirSync(path.dirname(interventionPath), { recursive: true });
  fs.writeFileSync(interventionPath, `${JSON.stringify({
    schemaVersion: 1,
    eventId: 'review-1',
    timestamp: '2026-08-08T00:00:01.500Z',
    eventType: 'prompt.reviewed',
    sessionId: 'analytics-session',
    data: { score: 85, originalPromptRetained: true }
  })}\n${JSON.stringify({
    schemaVersion: 1,
    eventId: 'session-fit-1',
    timestamp: '2026-08-08T00:00:01.750Z',
    eventType: 'session.fit_evaluated',
    sessionId: 'analytics-session',
    data: { newTaskLikelihood: 20, freshTaskRecommended: false, assessmentSource: 'codex_model' }
  })}\n${JSON.stringify({
    schemaVersion: 1,
    eventId: 'health-limited-1',
    timestamp: '2026-08-08T00:00:01.900Z',
    eventType: 'health.check_limited',
    sessionId: 'analytics-session',
    data: { categories: { contextMeasurement: 'checked — limited evidence' } }
  })}\n`, 'utf8');

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'analytics-session',
    timestamp: '2026-08-08T00:00:01.000Z',
    cwd: workspace,
    prompt: 'Implement the change in app.js. Done when tests pass.'
  }, environment);

  fs.writeFileSync(path.join(workspace, 'app.js'), 'one\ntwo\nthree\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'new.txt'), 'new\n', 'utf8');

  const records = runHook({
    hook_event_name: 'Stop',
    session_id: 'analytics-session',
    timestamp: '2026-08-08T00:00:03.000Z',
    cwd: workspace,
    transcript_path: transcriptPath
  }, environment);

  const outcome = records.find((record) => record.recordType === 'turn.outcome');
  assert.ok(outcome);
  assert.equal(outcome.data.metrics.filesChanged, 2);
  assert.equal(outcome.data.metrics.filesAdded, 1);
  assert.equal(outcome.data.metrics.filesModified, 1);
  assert.equal(outcome.data.metrics.linesAdded, 2);
  assert.equal(outcome.data.metrics.linesDeleted, 0);
  assert.equal(outcome.data.metrics.lineCountsComplete, true);
  const contextSnapshot = records.find((record) => record.recordType === 'context.load_snapshot');
  assert.ok(contextSnapshot);
  assert.equal(contextSnapshot.data.actualContextUtilization.unit, 'tokens');
  assert.equal(contextSnapshot.data.actualContextUtilization.measurementMethod, 'codex_token_count_event');
  assert.equal(contextSnapshot.data.actualContextUtilization.terminology, 'Actual Context Utilization');
  assert.equal(contextSnapshot.data.actualContextUtilization.value, 30_000);
  assert.equal(contextSnapshot.data.actualContextUtilization.capacityTokens, 40_000);
  assert.equal(contextSnapshot.data.actualContextUtilization.utilization, 0.75);
  assert.match(outcome.localTimestamp, /[+-]\d{2}:\d{2}$/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /# Code Buddy/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /Prompt quality:/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /Actual Context Utilization:/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /75\.0%/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /Session fit:/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /limited evidence/i);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Changed Files/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Latest Turn Context/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /Actual Context Utilization — 75\.0%/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Context By Turn/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Code Buddy Interventions/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /\| Prompt reviews \| 1 \|/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /\| Session-fit evaluations \| 1 \|/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /\| Preflights started \/ completed \| 1 \/ 0 \|/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /app\.js/);
});

test('preserves the first snapshot across multiple prompts before stop', { skip: !pythonCommand }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-multi-prompt-'));
  const workspace = path.join(directory, 'workspace');
  const logPath = path.join(workspace, '.code-buddy', 'copilot-session.jsonl');
  const statePath = path.join(workspace, '.code-buddy', '.state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app.js'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'removed.txt'), 'remove me\n', 'utf8');

  const environment = {
    TOKEN_LENS_LOG_FILE: logPath,
    TOKEN_LENS_STATE_DIR: statePath,
    TOKEN_LENS_ANALYTICS_SCRIPT: scriptPath,
    TOKEN_LENS_FEEDBACK_FILE: path.join(workspace, 'Code Buddy.md'),
    TOKEN_LENS_ANALYTICS_FILE: path.join(workspace, 'Code Buddy Analytics.md'),
    TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'true',
    TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES: '1000000',
    TOKEN_LENS_PYTHON_COMMAND: pythonCommand
  };

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'multi-prompt-session',
    timestamp: '2026-08-08T00:00:01.000Z',
    cwd: workspace,
    prompt: 'Create the first part of the task.'
  }, environment);

  fs.writeFileSync(path.join(workspace, 'app.js'), 'one\ntwo\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'added.txt'), 'new file\n', 'utf8');
  fs.unlinkSync(path.join(workspace, 'removed.txt'));

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'multi-prompt-session',
    timestamp: '2026-08-08T00:00:02.000Z',
    cwd: workspace,
    prompt: 'Continue with the next part.'
  }, environment);

  const records = runHook({
    hook_event_name: 'Stop',
    session_id: 'multi-prompt-session',
    timestamp: '2026-08-08T00:00:03.000Z',
    cwd: workspace
  }, environment);
  const outcome = records.find((record) => record.recordType === 'turn.outcome');
  assert.ok(outcome);
  assert.equal(outcome.data.worktreeTrackingAvailable, true);
  assert.equal(outcome.data.metrics.filesAdded, 1);
  assert.equal(outcome.data.metrics.filesModified, 1);
  assert.equal(outcome.data.metrics.filesDeleted, 1);
  assert.deepEqual(
    outcome.data.promptEventIds.length,
    2
  );
  const analytics = fs.readFileSync(path.join(workspace, 'Code Buddy Analytics.md'), 'utf8');
  assert.match(analytics, /\| Turn \| Time \| Prompt tokens \| Model calls \| Estimated Context Pressure/);
  assert.match(analytics, /\| 2 \|/);
});

test('recommends reducing context when observed exposure is high', { skip: !pythonCommand }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-context-warning-'));
  const workspace = path.join(directory, 'workspace');
  const environment = {
    TOKEN_LENS_LOG_FILE: path.join(workspace, '.code-buddy', 'copilot-session.jsonl'),
    TOKEN_LENS_STATE_DIR: path.join(workspace, '.code-buddy', '.state'),
    TOKEN_LENS_ANALYTICS_SCRIPT: scriptPath,
    TOKEN_LENS_FEEDBACK_FILE: path.join(workspace, 'Code Buddy.md'),
    TOKEN_LENS_ANALYTICS_FILE: path.join(workspace, 'Code Buddy Analytics.md'),
    TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'true',
    TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES: '1000000',
    TOKEN_LENS_PYTHON_COMMAND: pythonCommand
  };
  fs.mkdirSync(workspace, { recursive: true });
  const prompt = `Implement the change in app.js. Context: ${'existing context '.repeat(20000)} Done when tests pass. Validate with npm test.`;

  runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'context-warning-session',
    timestamp: '2026-08-08T00:00:01.000Z',
    cwd: workspace,
    prompt
  }, environment);
  runHook({
    hook_event_name: 'Stop',
    session_id: 'context-warning-session',
    timestamp: '2026-08-08T00:00:02.000Z',
    cwd: workspace
  }, environment);

  const feedback = fs.readFileSync(path.join(workspace, 'Code Buddy.md'), 'utf8');
  assert.match(feedback, /Start fresh with a compact handoff/);
  assert.match(feedback, /Start a new Copilot session/);
  assert.match(feedback, /300 words or fewer/);
  assert.match(fs.readFileSync(path.join(workspace, 'Code Buddy Analytics.md'), 'utf8'), /\| Warning level \| high \|/);
});
