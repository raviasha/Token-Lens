import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  getCurrentAnalyticsPath,
  getCurrentFeedbackPath,
  getCurrentHookConfigPath,
  getCurrentLogPath,
  installHooks,
  removeHooks
} from './hookInstaller';

async function openWorkspaceFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '', 'utf8');
  }
  await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
}

function watchCodeBuddyFile(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  let feedbackPath: string;
  try {
    feedbackPath = path.normalize(getCurrentFeedbackPath());
  } catch {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, '**/*.md')
  );
  const refreshOpenFile = (uri: vscode.Uri): void => {
    if (path.normalize(uri.fsPath) !== feedbackPath) {
      return;
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.isDirty || path.normalize(activeEditor.document.uri.fsPath) !== feedbackPath) {
      return;
    }
    void vscode.commands.executeCommand('workbench.action.files.revert');
  };

  context.subscriptions.push(watcher, watcher.onDidChange(refreshOpenFile), watcher.onDidCreate(refreshOpenFile));
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code Buddy');
  context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(record) Code Buddy';
  status.tooltip = 'Open Code Buddy session log';
  status.command = 'tokenLens.openLog';
  status.show();
  context.subscriptions.push(status);
  watchCodeBuddyFile(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.installHooks', async () => {
      try {
        const result = await installHooks(context);
        output.appendLine(`Installed Copilot hooks at ${result.configPath}`);
        output.appendLine(`Writing structured records to ${result.logPath}`);
        output.appendLine(`Writing current feedback to ${result.feedbackPath}`);
        output.appendLine(`Writing detailed analytics to ${result.analyticsPath}`);
        await vscode.window.showInformationMessage(
          result.created ? 'Code Buddy Copilot hooks installed.' : 'Code Buddy Copilot hooks updated.'
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Install failed: ${message}`);
        await vscode.window.showErrorMessage(`Code Buddy could not install hooks: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.removeHooks', async () => {
      try {
        const configPath = await removeHooks();
        output.appendLine(`Removed Copilot hooks at ${configPath}`);
        await vscode.window.showInformationMessage('Code Buddy Copilot hooks removed. Existing logs were kept.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Remove failed: ${message}`);
        await vscode.window.showErrorMessage(`Code Buddy could not remove hooks: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.openLog', async () => {
      try {
        await openWorkspaceFile(getCurrentLogPath());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Code Buddy could not open the log: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.openCodeBuddy', async () => {
      try {
        await openWorkspaceFile(getCurrentFeedbackPath());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Code Buddy could not open feedback: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.openAnalytics', async () => {
      try {
        await openWorkspaceFile(getCurrentAnalyticsPath());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Code Buddy could not open analytics: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.openHookConfig', async () => {
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(getCurrentHookConfigPath()), { preview: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Code Buddy could not open the hook configuration: ${message}`);
      }
    })
  );
}

export function deactivate(): void {}
