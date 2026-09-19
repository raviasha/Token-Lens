const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
};
const { renderHandoffPayload } = require('../dist/ai/tools.js');
Module._load = originalLoad;

function loadPendingHandoff() {
  try {
    return require('../dist/runtime/pendingHandoff.js');
  } catch {
    return {};
  }
}

test('creates an atomic pending fresh handoff with a paste marker', async (t) => {
  const pendingHandoff = loadPendingHandoff();
  assert.equal(typeof pendingHandoff.createPendingFreshHandoff, 'function');
  assert.equal(typeof pendingHandoff.handoffMarker, 'function');

  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-buddy-handoff-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const pending = await pendingHandoff.createPendingFreshHandoff(
    stateDirectory,
    'source-session',
    'Implement the requested command.'
  );

  assert.match(pending.handoffId, /^[a-f0-9-]{36}$/);
  assert.equal(pending.sourceSessionId, 'source-session');
  assert.equal(pending.targetTask, 'Implement the requested command.');
  assert.match(pending.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    pendingHandoff.handoffMarker(pending.handoffId),
    `<!-- code-buddy-handoff:${pending.handoffId} -->`
  );
  const stored = JSON.parse(await fs.readFile(path.join(stateDirectory, 'pending-fresh-handoff.json'), 'utf8'));
  assert.deepEqual(stored, pending);
});

test('prepends a pending handoff marker to the copied payload', () => {
  const marker = '<!-- code-buddy-handoff:handoff-1 -->';
  const payload = renderHandoffPayload({
    taskObjective: 'Implement the requested command.',
    items: [{ section: 'decision', content: 'Preserve existing command behavior.' }],
    suggestedStartingInstruction: 'Implement the command and its tests.'
  }, marker);

  assert.ok(payload.startsWith(`${marker}\n[CONTEXT HANDOFF]`));
});
