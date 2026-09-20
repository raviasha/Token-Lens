import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
type Session = { platform: string; sessionId: string; timestamp?: string | null; taskName?: string | null };
type Scope = { sessions: Session[] };
type Card = { id: string; revision: number; title?: string; status?: string; scope: Scope; claims?: { id: string; section: string; text: string; basis: string; evidenceIds: string[] }[]; nextAction?: { text: string; evidenceIds: string[] }; corrections?: unknown[] };
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function registerTaskCards(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const script = path.join(context.extensionPath, 'task-cards', 'cli.cjs');
  let panel: vscode.WebviewPanel | undefined;
  let cardId: string | undefined;
  let renderedRevision = -1;
  let timer: NodeJS.Timeout | undefined;
  let autoOpenAttempt = 0;
  const autoOpenedSessions = new Set<string>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.text = '$(note) Task Card';
  status.tooltip = 'Open or restore the local task card';
  status.command = 'tokenLens.openTaskCard';
  status.show();
  context.subscriptions.push(status);

  function workspace(): string {
    const value = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!value) throw new Error('Open a workspace folder first.');
    return value;
  }
  async function cli(command: string, ...args: string[]): Promise<any> {
    const result = await execFileAsync(process.execPath, [script, command, workspace(), ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
    return JSON.parse(result.stdout);
  }
  function html(card: Card | null, error = ''): string {
    const sections = card?.claims?.map(claim => `<section><h3>${escapeHtml(claim.section)}</h3><p>${escapeHtml(claim.text)}</p><small>${escapeHtml(claim.basis)} · ${claim.evidenceIds.map(id => `<button data-action="evidence" data-id="${escapeHtml(id)}">Evidence ${escapeHtml(id.slice(0, 8))}</button>`).join(' ')}</small><button data-action="correct" data-id="${escapeHtml(claim.id)}">Correct</button></section>`).join('') || '';
    const scope = card?.scope.sessions.map(s => s.taskName ? `${s.taskName} · ${s.platform}: ${s.sessionId}` : `${s.platform}: ${s.sessionId}`).join(', ') || 'Choose a session';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;line-height:1.4}button{font:inherit;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:4px;padding:6px 10px;margin:3px}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}section{border-top:1px solid var(--vscode-panel-border);padding:10px 0}small{display:block;color:var(--vscode-descriptionForeground)}.toolbar{display:flex;flex-wrap:wrap;gap:4px}.error{color:var(--vscode-errorForeground)}
    </style></head><body><div class="toolbar"><button data-action="scope">Change scope</button><button data-action="generate">${card?.revision ? 'Update card' : 'Generate card'}</button><button data-action="refresh">Refresh</button><button data-action="export">Export Markdown</button><button data-action="minimize">Minimize</button></div>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<small>Scope: ${escapeHtml(scope)}</small>
    <h1>${escapeHtml(card?.title || 'Task Card')}</h1><p>Status: ${escapeHtml(card?.status || 'Not generated')} · Revision ${card?.revision || 0}</p>
    ${sections}${card?.nextAction ? `<section><h3>Next action</h3><p>${escapeHtml(card.nextAction.text)}</p></section>` : '<p>Select a session, then generate a card with Copilot.</p>'}
    <script>const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button)api.postMessage({action:button.dataset.action,id:button.dataset.id});});</script>
    </body></html>`;
  }
  async function refresh(error = ''): Promise<void> {
    if (!panel) return;
    let card: Card | null = null;
    if (cardId) card = await cli('load', cardId);
    renderedRevision = card?.revision ?? 0;
    panel.webview.html = html(card, error);
  }
  async function chooseScope(): Promise<void> {
    const sessions = await cli('sessions') as Session[];
    const picked = await vscode.window.showQuickPick(sessions.map(s => ({ label: s.taskName || 'Untitled task', description: `${s.platform} · ${s.sessionId}${s.timestamp ? ` · ${s.timestamp}` : ''}`, value: s })), { placeHolder: 'Select the task for this card' });
    if (!picked) return;
    const card = await cli('create', JSON.stringify({ sessions: [{ platform: picked.value.platform, sessionId: picked.value.sessionId, ...(picked.value.taskName ? { taskName: picked.value.taskName } : {}) }] }));
    cardId = card.id;
    await refresh();
  }
  async function handle(action: string, id?: string): Promise<void> {
    if (action === 'minimize') { panel?.dispose(); return; }
    if (action === 'scope') { await chooseScope(); return; }
    if (action === 'refresh') { await refresh(); return; }
    if (!cardId) { await chooseScope(); if (!cardId) return; }
    if (action === 'generate') {
      const card = await cli('load', cardId) as Card;
      const prompt = await cli('prompt', cardId, String(card.revision)) as string;
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true });
      await refresh('Review and send the prepared request in Copilot Chat. The card will appear here after the agent saves it.');
    } else if (action === 'correct' && id) {
      const text = await vscode.window.showInputBox({ prompt: 'Correct this claim', ignoreFocusOut: true });
      if (text?.trim()) { await cli('correct', cardId, id, text); await refresh(); }
    } else if (action === 'export') {
      const file = path.join(workspace(), '.code-buddy', 'task-cards', cardId, 'card.md');
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    } else if (action === 'evidence' && id) {
      const card = await cli('load', cardId) as Card;
      for (let offset = 0; ;) {
        const page = await cli('evidence-card', cardId, String(offset), '200');
        const item = page.items.find((x: any) => x.id === id);
        if (item) {
          const uri = vscode.Uri.file(path.join(workspace(), item.source));
          const editor = await vscode.window.showTextDocument(uri, { preview: false });
          const position = new vscode.Position(Math.max(0, item.sourceLine - 1), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
          return;
        }
        if (page.nextOffset === null) throw new Error('Evidence is no longer available in the selected scope.');
        offset = page.nextOffset;
      }
    }
  }
  async function openPanel(): Promise<void> {
      if (panel) { await refresh(); panel.reveal(); return; }
      panel = vscode.window.createWebviewPanel('codeBuddy.taskCard', 'Task Card', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
      panel.onDidDispose(() => { panel = undefined; if (timer) clearInterval(timer); timer = undefined; });
      panel.webview.onDidReceiveMessage(async (message: { action: string; id?: string }) => {
        try { await handle(message.action, message.id); }
        catch (error) { output.appendLine(`Task Card: ${String(error)}`); await refresh(error instanceof Error ? error.message : String(error)); }
      });
      if (!cardId) {
        const cards = await cli('cards') as { id: string; title: string }[];
        if (cards.length === 1) cardId = cards[0].id;
        else if (cards.length > 1) {
          const choice = await vscode.window.showQuickPick([{ label: 'New card', id: '' }, ...cards.map(c => ({ label: c.title, id: c.id }))], { placeHolder: 'Open a saved card or create a new one' });
          cardId = choice?.id || undefined;
        }
      }
      await refresh();
      timer = setInterval(async () => {
        if (!panel || !cardId) return;
        try { const card = await cli('load', cardId) as Card; if (card.revision !== renderedRevision) await refresh(); }
        catch (error) { output.appendLine(`Task Card refresh: ${String(error)}`); }
      }, 3000);
  }
  async function openLatestCopilotTaskCard(): Promise<void> {
    const attempt = ++autoOpenAttempt;
    try {
      const sessions = await cli('sessions') as Session[];
      const latest = sessions.find(session => session.platform === 'github-copilot');
      if (!latest || autoOpenedSessions.has(latest.sessionId)) return;
      const live = await cli('live', latest.sessionId, latest.platform) as { card: Card };
      if (attempt !== autoOpenAttempt) return;
      cardId = live.card.id;
      await openPanel();
      autoOpenedSessions.add(latest.sessionId);
    } catch (error) {
      output.appendLine(`Task Card auto-open: ${String(error)}`);
    }
  }
  context.subscriptions.push(vscode.commands.registerCommand('tokenLens.openTaskCard', async () => {
    try { await openPanel(); }
    catch (error) { await vscode.window.showErrorMessage(`Task Card could not open: ${String(error)}`); }
  }));
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '.code-buddy/copilot-session.jsonl'));
    watcher.onDidChange(() => { void openLatestCopilotTaskCard(); });
    watcher.onDidCreate(() => { void openLatestCopilotTaskCard(); });
    context.subscriptions.push(watcher);
    void openLatestCopilotTaskCard();
  }
}
