const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSessions, readEvidence } = require('../task-cards/evidence.cjs');
const { createCard, saveRevision, loadCard, correctClaim, renderMarkdown } = require('../task-cards/card.cjs');
const { spawnSync } = require('node:child_process');
const { buildGenerationPrompt } = require('../task-cards/prompt.cjs');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-card-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.code-buddy', 'telemetry', 'raw'), { recursive: true });
  return dir;
}

function append(file, row) { fs.appendFileSync(file, JSON.stringify(row) + '\n'); }
const requiredSections = ['goal', 'constraints', 'acceptance_criteria', 'agreement', 'requirement_changes', 'progress', 'outcomes', 'reflection'];
function fullRevision(evidence) {
  return { title: 'Build it', status: 'in_progress', claims: requiredSections.map((section, index) => ({ id: index ? section : 'goal', section, text: section === 'goal' ? 'Build it' : 'Not recorded in selected evidence', basis: section === 'goal' ? 'observed' : 'inferred', evidenceIds: [evidence.id] })), nextAction: { text: 'Run tests', evidenceIds: [evidence.id] } };
}

test('reads only the selected Codex session and retains visible dialogue and request usage', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy', 'codex-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 'a', recordType: 'user.message', source: 'codex_rollout', sourceLine: 3, sourceEventId: 'm1', turnId: 't1', timestamp: '2026-09-19T01:00:00Z', data: { role: 'user', content: [{ type: 'input_text', text: 'Build a parser' }] } });
  append(file, { schemaVersion: 2, sessionId: 'a', recordType: 'assistant.message', source: 'codex_rollout', sourceLine: 4, sourceEventId: 'm2', turnId: 't1', timestamp: '2026-09-19T01:00:01Z', data: { role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will inspect it' }] } });
  append(file, { schemaVersion: 2, sessionId: 'a', recordType: 'provider.usage', source: 'codex_rollout', sourceLine: 5, timestamp: '2026-09-19T01:00:02Z', usageScope: 'request_with_cumulative_snapshots', data: { response_id: 'r1', usage: { input_tokens: 10, output_tokens: 2 }, thread_token_usage: { input_tokens: 10, output_tokens: 2 } } });
  append(file, { schemaVersion: 2, sessionId: 'b', recordType: 'user.message', source: 'codex_rollout', sourceLine: 6, data: { role: 'user', content: [{ text: 'Unrelated' }] } });
  assert.deepEqual(listSessions(dir).map(x => x.sessionId).sort(), ['a', 'b']);
  const page = readEvidence(dir, { sessions: [{ platform: 'codex', sessionId: 'a' }] });
  assert.deepEqual(page.items.map(x => x.text), ['Build a parser', 'I will inspect it', null]);
  assert.equal(page.items[1].phase, 'commentary');
  assert.equal(page.items[2].usage.request.input_tokens, 10);
  assert.equal(page.items[2].usage.cumulative.input_tokens, 10);
  assert.equal(page.items[2].usage.scope, 'request_with_cumulative_snapshots');
  assert.equal(page.items[0].messageId, 'm1');
});

test('reads Copilot dialogue and marks partial history without inventing provider usage', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy', 'copilot-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 'c', recordType: 'transcript.event', sourceEventType: 'user.message', sourceEventId: 'c1', sourceLine: 2, timestamp: '2026-09-19T01:00:00Z', data: { content: 'Fix it' } });
  append(file, { schemaVersion: 2, sessionId: 'c', recordType: 'assistant.message', sourceEventId: 'c2', sourceLine: 3, parentId: 'c1', timestamp: '2026-09-19T01:00:01Z', data: { content: 'Done' } });
  fs.appendFileSync(file, '{"unfinished":');
  const page = readEvidence(dir, { sessions: [{ platform: 'github-copilot', sessionId: 'c' }] });
  assert.deepEqual(page.items.map(x => x.text), ['Fix it', 'Done']);
  assert.equal(page.items[1].parentId, 'c1');
  assert.equal(page.coverage.complete, false);
  assert.equal(page.coverage.warnings.some(x => x.includes('partial')), true);
  assert.equal(page.items[1].usage, null);
});

test('invalid revision and conflict leave last card intact; corrections survive update', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy', 'codex-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 'a', recordType: 'user.message', source: 'codex_rollout', sourceLine: 1, sourceEventId: 'm1', data: { role: 'user', content: [{ text: 'Build it' }] } });
  const scope = { sessions: [{ platform: 'codex', sessionId: 'a' }] };
  const evidence = readEvidence(dir, scope).items[0];
  const card = createCard(dir, scope);
  const revision = fullRevision(evidence);
  assert.throws(() => saveRevision(dir, card.id, { ...revision, claims: [{ ...revision.claims[0], evidenceIds: ['bad'] }, ...revision.claims.slice(1)] }, 0), /evidence/i);
  assert.equal(loadCard(dir, card.id).revision, 0);
  saveRevision(dir, card.id, revision, 0);
  assert.throws(() => saveRevision(dir, card.id, revision, 0), /conflict/i);
  correctClaim(dir, card.id, 'goal', 'Build a useful parser');
  const renamed = fullRevision(evidence);
  renamed.claims[0].id = 'renamed-goal';
  assert.throws(() => saveRevision(dir, card.id, renamed, 1), /corrected claim must retain/);
  saveRevision(dir, card.id, revision, 1);
  const updated = loadCard(dir, card.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.claims[0].text, 'Build a useful parser');
  assert.match(renderMarkdown(updated), /Build a useful parser/);
});

test('CLI exposes selected sessions and a new card without changing capture logs', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy', 'codex-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 'a', recordType: 'user.message', source: 'codex_rollout', sourceLine: 1, data: { role: 'user', content: [{ text: 'Build it' }] } });
  const before = fs.readFileSync(file);
  const cli = path.join(__dirname, '../task-cards/cli.cjs');
  const sessions = spawnSync(process.execPath, [cli, 'sessions', dir], { encoding: 'utf8' });
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.equal(JSON.parse(sessions.stdout)[0].sessionId, 'a');
  const created = spawnSync(process.execPath, [cli, 'create', dir, JSON.stringify({ sessions: [{ platform: 'codex', sessionId: 'a' }] })], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  assert.match(JSON.parse(created.stdout).id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a claim may cite a selected source beyond the first 500 observations', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy', 'codex-session.jsonl');
  for (let n = 0; n < 510; n++) append(file, { schemaVersion: 2, sessionId: 'long', recordType: 'user.message', source: 'codex_rollout', sourceLine: n + 1, timestamp: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(), data: { role: 'user', content: [{ text: `Observation ${n}` }] } });
  const scope = { sessions: [{ platform: 'codex', sessionId: 'long' }] };
  const item = readEvidence(dir, scope, { offset: 500 }).items[9];
  const card = createCard(dir, scope);
  const revision = fullRevision(item); revision.title = 'Long task'; revision.claims[0].text = item.text;
  revision.nextAction.text = 'Review the goal';
  const saved = saveRevision(dir, card.id, revision, 0);
  assert.equal(saved.revision, 1);
});

test('card validation requires the full task narrative or explicit unavailable sections', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy/codex-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 's', recordType: 'user.message', source: 'codex_rollout', sourceLine: 1, data: { role: 'user', content: [{ text: 'Build it' }] } });
  const card = createCard(dir, { sessions: [{ platform: 'codex', sessionId: 's' }] });
  const item = readEvidence(dir, card.scope).items[0];
  assert.throws(() => saveRevision(dir, card.id, { ...fullRevision(item), claims: [fullRevision(item).claims[0]] }, 0), /missing section/);
  assert.throws(() => saveRevision(dir, card.id, { ...fullRevision(item), nextAction: { text: 'Run tests', evidenceIds: [] } }, 0), /next action evidence/);
});

test('generation request tells the current agent to page bounded evidence and save a cited revision', () => {
  const prompt = buildGenerationPrompt('/work/project', '11111111-1111-1111-1111-111111111111', 0, '/plugin/task-cards/cli.cjs');
  assert.match(prompt, /evidence-card/);
  assert.match(prompt, /nextOffset/);
  assert.match(prompt, /save/);
  assert.match(prompt, /11111111-1111-1111-1111-111111111111/);
  assert.match(prompt, /do not.*assume.*completion/i);
});

test('preparing generation freezes evidence before the agent adds its own messages', (t) => {
  const dir = workspace(t); const file = path.join(dir, '.code-buddy/codex-session.jsonl');
  append(file, { schemaVersion: 2, sessionId: 's', recordType: 'user.message', source: 'codex_rollout', sourceLine: 1, data: { role: 'user', content: [{ text: 'Initial goal' }] } });
  const card = createCard(dir, { sessions: [{ platform: 'codex', sessionId: 's' }] });
  const cli = path.join(__dirname, '../task-cards/cli.cjs');
  const prepared = spawnSync(process.execPath, [cli, 'prompt', dir, card.id, '0'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  append(file, { schemaVersion: 2, sessionId: 's', recordType: 'assistant.message', source: 'codex_rollout', sourceLine: 2, data: { role: 'assistant', content: [{ text: 'I am generating the card' }] } });
  const page = spawnSync(process.execPath, [cli, 'evidence-card', dir, card.id, '0'], { encoding: 'utf8' });
  assert.equal(page.status, 0, page.stderr);
  assert.deepEqual(JSON.parse(page.stdout).items.map(x => x.text), ['Initial goal']);
});
