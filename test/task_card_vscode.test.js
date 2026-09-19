const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('VS Code Task Card opens on demand and restores after minimize without generating', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-view-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const commands = new Map(); const panels = [];
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: () => {
        const panel = { webview: { html: '', onDidReceiveMessage(callback) { panel.receive = callback; } },
          onDidDispose(callback) { panel.onDispose = callback; }, reveal() {}, dispose() { panel.onDispose(); } };
        panels.push(panel); return panel;
      },
      showQuickPick: async () => undefined,
      showErrorMessage: async message => { throw new Error(message); },
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
  };
  const load = Module._load; Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : load.call(this, request, parent, isMain); };
  try {
    const { registerTaskCards } = require('../dist/taskCards.js');
    registerTaskCards({ extensionPath: path.join(__dirname, '..'), subscriptions: [] }, { appendLine() {} });
    await commands.get('tokenLens.openTaskCard')();
    assert.equal(panels.length, 1);
    assert.match(panels[0].webview.html, /Generate card/);
    await panels[0].receive({ action: 'minimize' });
    await commands.get('tokenLens.openTaskCard')();
    assert.equal(panels.length, 2);
    assert.match(panels[1].webview.html, /Not generated/);
    panels[1].dispose();
    assert.equal(fs.existsSync(path.join(workspace, '.code-buddy/task-cards')), false);
  } finally { Module._load = load; }
});
