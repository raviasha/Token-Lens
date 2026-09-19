const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Module = require('node:module');

const root = path.join(__dirname, '..');

test('Codex transcript captures visible source evidence incrementally without reasoning or cumulative usage loss', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const transcript = path.join(workspace, 'rollout.jsonl');
  const log = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'native-session', cwd: workspace, base_instructions: 'private-internal-marker' } },
    { type: 'turn_context', payload: { turn_id: 'native-turn', model: 'native-model' } },
    { type: 'response_item', payload: { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: 'Add CSV export', attachment: 'file.csv' }] } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'private-reasoning-marker', summary: ['private-summary-marker'] } },
    { type: 'response_item', payload: { type: 'message', id: 'assistant-1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will check the exporter.' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: '{"exit_code":1,"output":"one test failed"}' } },
    { type: 'token_usage_record', payload: { response_id: 'response-1', turn_id: 'native-turn', usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 }, thread_token_usage: { input_tokens: 300 }, turn_token_usage: { input_tokens: 200 } } }
  ].map((r, i) => ({ timestamp: `2026-09-19T10:00:0${i}Z`, ...r }));
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n') + '\n');
  const env = { ...process.env, TOKEN_LENS_LOG_FILE: log, TOKEN_LENS_STATE_DIR: path.join(workspace, '.code-buddy', '.state'),
    TOKEN_LENS_TELEMETRY_DIR: path.join(workspace, '.code-buddy', 'telemetry'), TOKEN_LENS_CAPTURE_TRANSCRIPTS: 'true',
    TOKEN_LENS_TELEMETRY_LEVEL: 'diagnostic', TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT: 'true', CODE_BUDDY_LEGACY_GOVERNANCE: 'false' };
  const run = (event) => {
    const r = spawnSync(process.execPath, [path.join(root, 'codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs')], {
      input: JSON.stringify({ cwd: workspace, session_id: 'native-session', hook_event_name: event, transcript_path: transcript }), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  };
  run('PostToolUse');
  run('PostToolUse');
  let records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const messages = records.filter(r => r.recordType === 'assistant.message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sourceEventId, 'assistant-1');
  assert.equal(messages[0].turnId, 'native-turn');
  assert.equal(messages[0].model, 'native-model');
  assert.equal(messages[0].data.phase, 'commentary');
  assert.equal(messages[0].sourceLine, 5);
  assert.doesNotMatch(JSON.stringify(records), /private-(internal|reasoning|summary)-marker/);
  const usage = records.find(r => r.recordType === 'provider.usage');
  assert.equal(usage.data.usage.input_tokens, 100);
  assert.equal(usage.data.usage.reasoning_output_tokens, 5);
  assert.equal(usage.data.thread_token_usage.input_tokens, 300);
  assert.equal(usage.usageScope, 'request_with_cumulative_snapshots');
  assert.equal(usage.sourceResponseId, 'response-1');
  env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT = 'false';
  fs.appendFileSync(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'disabled-message', role: 'assistant', content: 'disabled-content-marker' } }) + '\n');
  run('PostToolUse');
  records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(JSON.stringify(records), /disabled-content-marker/);
  assert.equal(records.at(-1).data.contentCaptureStatus, 'disabled');
  env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT = 'true';
  fs.appendFileSync(transcript, '{"type":"response_item","payload":');
  run('PostToolUse');
  records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).data.historyStatus, 'partial');
  fs.appendFileSync(transcript, '{"type":"message","id":"assistant-final","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Test failed; work remains."}]}}\n');
  run('Stop');
  records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.sourceEventId === 'assistant-final').length, 1);
});

test('Codex workspace content opt-in is explicit and environment overrides it', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opt-in-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.code-buddy'));
  fs.writeFileSync(path.join(workspace, '.code-buddy', 'capture-settings.json'), JSON.stringify({ codex: { level: 'diagnostic', captureRawContent: true, captureTranscripts: true } }));
  for (const disabled of [false, true]) {
    const dest = path.join(workspace, disabled ? 'disabled' : 'enabled');
    const env = { ...process.env, TOKEN_LENS_LOG_FILE: path.join(dest, 'log.jsonl'), TOKEN_LENS_TELEMETRY_DIR: path.join(dest, 'telemetry'), TOKEN_LENS_STATE_DIR: path.join(dest, 'state'), CODE_BUDDY_LEGACY_GOVERNANCE: 'false' };
    delete env.TOKEN_LENS_TELEMETRY_LEVEL;
    delete env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT;
    if (disabled) env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT = 'false';
    const r = spawnSync(process.execPath, [path.join(root, 'codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs')], { env, encoding: 'utf8', input: JSON.stringify({ cwd: workspace, session_id: 'settings', hook_event_name: 'UserPromptSubmit', prompt: 'private-opt-in-marker' }) });
    assert.equal(r.status, 0, r.stderr);
    const { events } = require('../telemetry.cjs').readTelemetryEvents(path.join(dest, 'telemetry'));
    assert.equal(JSON.stringify(events).includes('private-opt-in-marker'), !disabled);
  }
});

test('secret redaction preserves ordinary task-card wording', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-redaction-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const env = { ...process.env, TOKEN_LENS_LOG_FILE: path.join(workspace, '.code-buddy', 'codex-session.jsonl'),
    TOKEN_LENS_TELEMETRY_LEVEL: 'diagnostic', TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT: 'true', CODE_BUDDY_LEGACY_GOVERNANCE: 'false' };
  const run = spawnSync(process.execPath, [path.join(root, 'codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs')], {
    input: JSON.stringify({ cwd: workspace, session_id: 'redaction', hook_event_name: 'UserPromptSubmit', prompt: 'Build a task-card; keep sk-abc123 private.' }), encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const log = fs.readFileSync(env.TOKEN_LENS_LOG_FILE, 'utf8');
  assert.match(log, /task-card/);
  assert.doesNotMatch(log, /sk-abc123/);
  const { events } = require('../telemetry.cjs').readTelemetryEvents(workspace);
  const prompt = events.find(x => x.event_type === 'prompt_submitted').payload.raw_prompt;
  assert.match(prompt, /task-card/);
  assert.doesNotMatch(prompt, /sk-abc123/);
});

test('Copilot preserves intermediate dialogue, source positions, usage counters and partial history', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-evidence-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const transcript = path.join(workspace, 'transcript.jsonl');
  const log = path.join(workspace, 'log.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant.message', id: 'msg-1', parentId: 'user-1',
    data: { turnId: 2, content: 'Checking the failed test.', password: 'snapshot-secret-marker', model: 'copilot-model', usage: { input_tokens: 70, reasoning_tokens: 5 }, attachments: [{ path: 'failure.png' }] } }) + '\n');
  const env = { ...process.env, TOKEN_LENS_LOG_FILE: log, TOKEN_LENS_STATE_DIR: path.join(workspace, 'state'), TOKEN_LENS_TELEMETRY_DIR: path.join(workspace, 'telemetry'), CODE_BUDDY_LEGACY_GOVERNANCE: 'false' };
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [path.join(root, 'hook.cjs')], { env, encoding: 'utf8', input: JSON.stringify({ cwd: workspace, session_id: 'copilot', hook_event_name: 'PostToolUse', transcript_path: transcript }) });
    assert.equal(r.status, 0, r.stderr);
  }
  const records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(JSON.stringify(records), /snapshot-secret-marker/);
  const message = records.find(r => r.recordType === 'assistant.message');
  assert.equal(message.sourceLine, 1);
  assert.equal(message.model, 'copilot-model');
  assert.equal(message.data.usage.input_tokens, 70);
  assert.equal(message.data.usage.reasoning_tokens, 5);
  assert.equal(message.data.attachments[0].path, 'failure.png');
  assert.equal(records.filter(r => r.recordType === 'transcript.snapshot').length, 1);
  assert.equal(records.find(r => r.recordType === 'transcript.snapshot').data.historyStatus, 'source_snapshot');
});
for (const [platform, hook, analytics] of [
  ['github-copilot', 'hook.cjs', 'code_buddy.py'],
  ['codex', 'codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs', 'codex-plugin/plugins/code-buddy/scripts/code_buddy.py']
]) {
  test(`${platform}: default capture ignores old gates and preserves reports and outcome evidence`, (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-only-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const log = path.join(workspace, '.code-buddy', `${platform}-session.jsonl`);
    const state = path.join(workspace, '.code-buddy', '.state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'pending-fresh-handoff.json'), JSON.stringify({
      schemaVersion: 1, handoffId: 'old-handoff', sourceSessionId: 'old-session', targetTask: 'Old task'
    }));
    for (const name of ['Code Buddy.md', 'Code Buddy Analytics.md']) fs.writeFileSync(path.join(workspace, name), 'Existing report\n');
    fs.writeFileSync(path.join(workspace, 'app.js'), 'before\n');
    const env = { ...process.env, TOKEN_LENS_LOG_FILE: log,
      TOKEN_LENS_STATE_DIR: state, TOKEN_LENS_ANALYTICS_SCRIPT: path.join(root, analytics),
      TOKEN_LENS_FEEDBACK_FILE: path.join(workspace, 'Code Buddy.md'),
      TOKEN_LENS_ANALYTICS_FILE: path.join(workspace, 'Code Buddy Analytics.md'),
      TOKEN_LENS_TELEMETRY_LEVEL: 'diagnostic', TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT: 'true',
      TOKEN_LENS_TELEMETRY_DIR: path.join(workspace, '.code-buddy', 'telemetry'),
      TOKEN_LENS_PREFLIGHT_ENFORCE: 'true', TOKEN_LENS_TRACK_WORKTREE_CHANGES: 'true'
    };
    delete env.CODE_BUDDY_LEGACY_GOVERNANCE;
    function run(payload) {
      const result = spawnSync(process.execPath, [path.join(root, hook)], {
        input: JSON.stringify({ cwd: workspace, session_id: 'capture-session', ...payload }), encoding: 'utf8', env
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      if (platform === 'codex' && payload.hook_event_name === 'UserPromptSubmit') {
        const output = JSON.parse(result.stdout);
        assert.match(output.hookSpecificOutput?.additionalContext || '', /mcp__code_buddy__task_card_open/);
        assert.match(output.hookSpecificOutput?.additionalContext || '', /liveSessionId.*capture-session/);
        assert.doesNotMatch(output.hookSpecificOutput?.additionalContext || '', /Generate\/Update/);
      } else {
        assert.equal(result.stdout, '', 'capture must not inject advice or block tools');
      }
    }
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'Implement pagination with a boundary test.' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'edit-1', tool_input: { path: 'app.js' } });
    fs.writeFileSync(path.join(workspace, 'app.js'), 'after\n');
    run({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'edit-1', tool_input: { path: 'app.js' }, tool_response: { success: true } });
    run({ hook_event_name: 'Stop', last_assistant_message: 'Pagination implemented; tests pending.' });
    const records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(r => r.recordType === 'user.prompt'));
    assert.ok(records.some(r => r.recordType === 'turn.outcome' && r.data.metrics.filesModified === 1));
    assert.ok(!records.some(r => /preflight|handoff.wait|governance/.test(r.recordType)));
    for (const name of ['Code Buddy.md', 'Code Buddy Analytics.md']) assert.equal(fs.readFileSync(path.join(workspace, name), 'utf8'), 'Existing report\n');
    const { readTelemetryEvents } = require('../telemetry.cjs');
    const { events, invalid } = readTelemetryEvents(workspace);
    assert.deepEqual(invalid, []);
    assert.ok(events.some(e => e.platform === platform && e.event_type === 'prompt_submitted' && e.payload.raw_prompt));
    assert.ok(events.some(e => e.event_type === 'tool_activity'));
  });
}

test('Codex capture-only MCP omits governance tools and rejects stale calls without recording them', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-only-mcp-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.CODE_BUDDY_LEGACY_GOVERNANCE;
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review_prompt', arguments: { workspace, prompt: 'Implement pagination' } } }
  ];
  const result = spawnSync('python3', [path.join(root, 'codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py')], {
    input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', env
  });
  assert.equal(result.status, 0, result.stderr);
  const [listed, called] = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(listed.result.tools.map(t => t.name), ['session_status', 'task_card_sessions', 'task_card_open', 'task_card_prepare', 'task_card_evidence', 'task_card_save', 'task_card_correct']);
  assert.equal(called.result.structuredContent.status, 'disabled');
  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy', 'interventions.jsonl')), false);
});

test('VS Code activation offers capture commands without registering legacy model tools or commands', () => {
  const commands = new Map();
  const registeredTools = [];
  const disposable = { dispose() {} };
  const vscode = {
    Uri: class Uri {}, StatusBarAlignment: { Right: 1 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {} })
    },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable; } },
    lm: { registerTool: (name) => { registeredTools.push(name); return disposable; } }
  };
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : load.call(this, request, parent, isMain);
  };
  try {
    require('../dist/extension.js').activate({ subscriptions: [], extensionPath: root });
    assert.deepEqual(registeredTools, []);
    for (const name of ['reviewPrompt', 'decomposeTask', 'measureContext', 'curateContext', 'openHumanRetryEvidence', 'createProjectConfig', 'openCodeBuddy', 'openAnalytics', 'openInterventions', 'replayTelemetryTask']) {
      assert.equal(commands.has(`tokenLens.${name}`), false, name);
    }
    assert.equal(commands.has('tokenLens.installHooks'), true);
    assert.equal(commands.has('tokenLens.openLog'), true);
    assert.equal(commands.has('tokenLens.openTaskCard'), true);
  } finally { Module._load = load; }
});
