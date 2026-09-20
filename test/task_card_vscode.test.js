const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { promisify } = require('node:util');

test('VS Code Task Card opens on demand and restores after minimize without generating', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-view-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const commands = new Map(); const panels = [];
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], createFileSystemWatcher: () => ({ onDidChange() { return { dispose() {} }; }, onDidCreate() { return { dispose() {} }; }, dispose() {} }) },
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
    delete require.cache[require.resolve('../dist/taskCards.js')];
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

test('VS Code opens the latest Copilot task card once per session and reopens it after restart', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-auto-view-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const log = path.join(workspace, '.code-buddy', 'copilot-session.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const append = (sessionId, timestamp) => fs.appendFileSync(log, JSON.stringify({ schemaVersion: 2, sessionId, recordType: 'user.message', timestamp, data: { role: 'user', content: [{ text: `Task ${sessionId}` }] } }) + '\n');
  append('copilot-s1', '2026-09-20T01:00:00Z');

  const commands = new Map(); const panels = []; const output = []; let watcher;
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 20 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 },
    Uri: { file: fsPath => ({ fsPath }) },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      createFileSystemWatcher: () => {
        watcher = { onDidChange(callback) { watcher.change = callback; return { dispose() {} }; }, onDidCreate(callback) { watcher.create = callback; return { dispose() {} }; }, dispose() {} };
        return watcher;
      }
    },
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
    delete require.cache[require.resolve('../dist/taskCards.js')];
    const { registerTaskCards } = require('../dist/taskCards.js');
    const context = { extensionPath: path.join(__dirname, '..'), subscriptions: [] };
    registerTaskCards(context, { appendLine(line) { output.push(line); } });
    await waitFor(() => panels.length === 1 && panels[0].webview.html);
    assert.equal(panels.length, 1, output.join('\n'));
    assert.match(panels[0].webview.html, /github-copilot: copilot-s1/);

    await panels[0].receive({ action: 'minimize' });
    await watcher.change();
    assert.equal(panels.length, 1, 'minimize suppresses repeated opens in this VS Code session');

    append('copilot-s2', '2026-09-20T01:01:00Z');
    await watcher.change();
    await waitFor(() => panels.length === 2 && panels[1].webview.html);
    assert.equal(panels.length, 2);
    assert.match(panels[1].webview.html, /github-copilot: copilot-s2/);

    panels[1].dispose();
    registerTaskCards({ extensionPath: path.join(__dirname, '..'), subscriptions: [] }, { appendLine() {} });
    await waitFor(() => panels.length === 3 && panels[2].webview.html);
    assert.equal(panels.length, 3, 'a VS Code restart opens the latest captured session again');
    assert.match(panels[2].webview.html, /github-copilot: copilot-s2/);
    panels[2].dispose();
  } finally { Module._load = load; }
});

test('VS Code ignores an older live-card lookup that finishes after a newer session', async (t) => {
  const commands = new Map(); const panels = []; const output = []; let watcher; let failSessionDiscovery = false; const liveCallbacks = new Map();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'card-race-view-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const cards = new Map([
    ['card-s1', { id: 'card-s1', revision: 0, scope: { sessions: [{ platform: 'github-copilot', sessionId: 's1' }] } }],
    ['card-s2', { id: 'card-s2', revision: 0, scope: { sessions: [{ platform: 'github-copilot', sessionId: 's2' }] } }],
  ]);
  const sessionResponses = [
    [{ platform: 'github-copilot', sessionId: 's1' }],
    [{ platform: 'github-copilot', sessionId: 's2' }],
  ];
  const execFile = (_file, args, _options, callback) => {
      const command = args[1];
      if (command === 'sessions') return queueMicrotask(() => failSessionDiscovery ? callback(new Error('capture unavailable'), '', '') : callback(null, JSON.stringify(sessionResponses.shift() || [{ platform: 'github-copilot', sessionId: 's2' }]), ''));
      if (command === 'live') return liveCallbacks.set(args[3], callback);
      if (command === 'load') return queueMicrotask(() => callback(null, JSON.stringify(cards.get(args[3])), ''));
      throw new Error(`unexpected CLI command: ${command}`);
  };
  execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  const childProcess = { execFile };
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 20 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Beside: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      createFileSystemWatcher: () => {
        watcher = { onDidChange(callback) { watcher.change = callback; return { dispose() {} }; }, onDidCreate(callback) { watcher.create = callback; return { dispose() {} }; }, dispose() {} };
        return watcher;
      }
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: () => {
        const panel = { webview: { html: '', onDidReceiveMessage(callback) { panel.receive = callback; } }, onDidDispose(callback) { panel.onDispose = callback; }, reveal() {}, dispose() { panel.onDispose(); } };
        panels.push(panel); return panel;
      },
      showQuickPick: async () => undefined,
      showErrorMessage: async message => { throw new Error(message); },
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
  };
  const load = Module._load; Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'node:child_process') return childProcess;
    return load.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../dist/taskCards.js')];
    const { registerTaskCards } = require('../dist/taskCards.js');
    registerTaskCards({ extensionPath: path.join(__dirname, '..'), subscriptions: [] }, { appendLine(line) { output.push(line); } });
    await waitFor(() => liveCallbacks.has('s1'));
    await watcher.change();
    await waitFor(() => liveCallbacks.has('s2'));
    liveCallbacks.get('s2')(null, JSON.stringify({ card: cards.get('card-s2') }), '');
    await waitFor(() => panels.length === 1 && panels[0].webview.html);
    liveCallbacks.get('s1')(null, JSON.stringify({ card: cards.get('card-s1') }), '');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(panels[0].webview.html, /github-copilot: s2/);
    failSessionDiscovery = true;
    await watcher.change();
    await waitFor(() => output.some(line => line.includes('capture unavailable')));
    assert.equal(output.some(line => line.includes('Task Card auto-open: Error: capture unavailable')), true);
  } finally {
    panels.forEach(panel => panel.dispose());
    Module._load = load;
  }
});
