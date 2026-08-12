const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.join(__dirname, '..');
const hookPath = path.join(pluginRoot, 'hooks', 'code_buddy_hook.cjs');

function runPluginHook(payload, workspace) {
  const logPath = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_LOG_FILE: logPath,
      TOKEN_LENS_INTERVENTION_LOG_FILE: path.join(workspace, '.code-buddy', 'interventions.jsonl'),
      TOKEN_LENS_REDACT_SENSITIVE: 'true'
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
