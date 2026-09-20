const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.join(__dirname, '..');
const server = path.join(__dirname, '../scripts/code_buddy_mcp.py');
const cardCli = path.join(__dirname, '../task-cards/cli.cjs');
function run(requests) {
  const env = { ...process.env, CODE_BUDDY_LEGACY_GOVERNANCE: 'false' };
  const result = spawnSync('python3', [server], { input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}

function runCardCli(workspace, command, ...args) {
  const result = spawnSync(process.execPath, [cardCli, command, workspace, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('live card scope is session-specific and reuses its local card', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-live-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const log = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, [
    { schemaVersion: 2, sessionId: 's1', recordType: 'user.message', data: { role: 'user', content: [{ text: 'Build it' }] } },
    { schemaVersion: 2, sessionId: 's1', recordType: 'assistant.message', data: { role: 'assistant', content: [{ text: 'I will build it.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const live = runCardCli(workspace, 'live', 's1');
  assert.equal(live.liveSessionId, 's1');
  assert.deepEqual(live.card.scope.sessions, [{ platform: 'codex', sessionId: 's1', taskName: 'Build it' }]);
  assert.equal(live.card.revision, 0);
  assert.equal(live.evidence.total, 2);
  assert.equal(live.evidence.changedSinceRevision, true);

  const reopened = runCardCli(workspace, 'live', 's1');
  assert.equal(reopened.card.id, live.card.id);
  assert.equal(reopened.history.length, 0);
});

test('capture-only skill describes the live task card lifecycle', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'code-buddy', 'SKILL.md'), 'utf8');
  assert.match(skill, /live Task Card/i);
  assert.match(skill, /Generate\/Update/);
  assert.match(skill, /History/);
});

test('capture-only Codex exposes on-demand task card tools and an interactive resource', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-mcp-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const log = path.join(workspace, '.code-buddy', 'codex-session.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ schemaVersion: 2, sessionId: 's1', recordType: 'user.message', source: 'codex_rollout', sourceLine: 1, data: { role: 'user', content: [{ text: 'Build it' }] } }) + '\n');
  const [init, tools, resources, sessions, opened, disabled] = run([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'task_card_sessions', arguments: { workspace } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'task_card_open', arguments: { workspace, scope: { sessions: [{ platform: 'codex', sessionId: 's1' }] } } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'review_prompt', arguments: { workspace, prompt: 'test' } } },
  ]);
  assert.equal(init.result.capabilities.resources.subscribe, false);
  assert.equal(tools.result.tools.some(x => x.name === 'task_card_open' && x._meta?.ui?.resourceUri), true);
  assert.equal(resources.result.resources[0].uri, 'ui://code-buddy/task-card.html');
  assert.equal(sessions.result.structuredContent[0].sessionId, 's1');
  assert.match(opened.result.structuredContent.cardId, /^[0-9a-f-]{36}$/);
  assert.equal(disabled.result.structuredContent.status, 'disabled');
  const [resource] = run([{ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://code-buddy/task-card.html' } }]);
  assert.match(resource.result.contents[0].text, /Minimize/);
  assert.match(resource.result.contents[0].text, /Generate card/);
  assert.match(resource.result.contents[0].text, /request\('ui\/initialize'/);
  assert.match(resource.result.contents[0].text, /ui\/notifications\/initialized/);
  assert.match(resource.result.contents[0].text, /ui\/message',\{role:'user'/);
  assert.match(resource.result.contents[0].text, /Current task/);
  assert.match(resource.result.contents[0].text, /History/);
  assert.match(resource.result.contents[0].text, /open\(\{liveSessionId:state\.liveSessionId\}\)/);
  assert.match(resource.result.contents[0].text, /const reopenArgs=state\.liveSessionId\?\{liveSessionId:state\.liveSessionId\}:\{cardId:state\.cardId\}/);
  assert.doesNotMatch(resource.result.contents[0].text, /localStorage|sessionStorage/);

  const [live, invalid] = run([
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'task_card_open', arguments: { workspace, liveSessionId: 's1' } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'task_card_open', arguments: { workspace, liveSessionId: '   ' } } },
  ]);
  assert.equal(live.result.structuredContent.liveSessionId, 's1');
  assert.equal(live.result.structuredContent.card.scope.liveSessionId, 's1');
  assert.ok(live.result.structuredContent.history.some(card => card.id === opened.result.structuredContent.cardId));
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /live sessionId is required/);
  assert.equal(fs.existsSync(path.join(workspace, '.code-buddy/interventions.jsonl')), false);
});
