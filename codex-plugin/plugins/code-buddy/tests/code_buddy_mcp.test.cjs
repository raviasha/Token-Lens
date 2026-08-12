const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.join(__dirname, '..');
const mcpPath = path.join(pluginRoot, 'scripts', 'code_buddy_mcp.py');

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
