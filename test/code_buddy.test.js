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

test('generates deterministic Code Buddy reports from a completed turn', { skip: !pythonCommand }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-code-buddy-'));
  const workspace = path.join(directory, 'workspace');
  const logPath = path.join(workspace, '.token-lens', 'copilot-session.jsonl');
  const statePath = path.join(workspace, '.token-lens', '.state');
  const feedbackPath = path.join(workspace, 'Code Buddy.md');
  const analyticsPath = path.join(workspace, 'Code Buddy Analytics.md');
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app.js'), 'one\ntwo\n', 'utf8');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant.message',
    data: { content: 'Updated app.js', toolRequests: [] },
    id: 'assistant-1',
    timestamp: '2026-08-08T00:00:02.000Z'
  })}\n`, 'utf8');

  const environment = {
    TOKEN_LENS_LOG_FILE: logPath,
    TOKEN_LENS_STATE_DIR: statePath,
    TOKEN_LENS_ANALYTICS_SCRIPT: scriptPath,
    TOKEN_LENS_FEEDBACK_FILE: feedbackPath,
    TOKEN_LENS_ANALYTICS_FILE: analyticsPath,
    TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'true',
    TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES: '1000000',
    TOKEN_LENS_PYTHON_COMMAND: pythonCommand
  };

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
  assert.match(outcome.localTimestamp, /[+-]\d{2}:\d{2}$/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /# Code Buddy/);
  assert.match(fs.readFileSync(feedbackPath, 'utf8'), /Prompt quality:/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /## Changed Files/);
  assert.match(fs.readFileSync(analyticsPath, 'utf8'), /app\.js/);
});
