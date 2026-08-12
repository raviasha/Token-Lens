import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  codeBuddyInstructionsEndMarker,
  codeBuddyInstructionsMarker,
  codeBuddyInstructionsStartMarker,
  mergeCodeBuddyAgentInstructions,
  removeCodeBuddyAgentInstructions
} from './agentInstructions';

export const hookConfigRelativePath = path.join('.github', 'hooks', 'token-lens.json');
export const agentInstructionsRelativePath = path.join('.github', 'copilot-instructions.md');
export const legacyAgentInstructionsRelativePath = path.join('.github', 'instructions', 'code-buddy.instructions.md');
const defaultLogFile = path.join('.code-buddy', 'copilot-session.jsonl');
const defaultInterventionLogFile = path.join('.code-buddy', 'interventions.jsonl');
const legacyLogFile = path.join('.token-lens', 'copilot-session.jsonl');

type HookValue = Record<string, unknown>;

export interface HookSettings {
  logFile: string;
  redactSensitiveData: boolean;
  captureTranscripts: boolean;
  hookTimeoutSeconds: number;
  feedbackFile: string;
  analyticsFile: string;
  trackWorktreeChanges: boolean;
  snapshotMaxFileSizeBytes: number;
  pythonCommand: string;
  interventionLogFile: string;
  contextEstimatedCapacityTokens: number;
  contextWarningThreshold: number;
  contextCriticalThreshold: number;
  contextAllowVisionVerification: boolean;
  contextOfferCurationOnNewSession: boolean;
  contextOfferCurationOnNewTask: boolean;
  promptReviewEnabled: boolean;
  taskDecompositionEnabled: boolean;
  preflightEnforceBeforeImplementation: boolean;
  preflightDenialsBeforeFallback: number;
}

export interface HookInstallResult {
  configPath: string;
  logPath: string;
  feedbackPath: string;
  analyticsPath: string;
  interventionLogPath: string;
  instructionsPath: string;
  created: boolean;
}

const hookEvents = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptTransformed',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'ErrorOccurred',
  'PreCompact'
];

function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return 10;
  }
  return Math.min(30, Math.max(1, Math.round(value)));
}

function getWorkspaceRoot(): vscode.Uri {
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    if (activeFolder) {
      return activeFolder.uri;
    }
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Open a workspace folder before installing Code Buddy hooks.');
  }
  return folder.uri;
}

export function resolveLogPath(root: vscode.Uri, configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) {
    return path.normalize(configuredPath);
  }
  return path.normalize(path.join(root.fsPath, configuredPath));
}

function getSettings(root: vscode.Uri): HookSettings & { logPath: string; feedbackPath: string; analyticsPath: string; interventionLogPath: string } {
  const configuration = vscode.workspace.getConfiguration('tokenLens', root);
  const logFile = configuration.get<string>('logFile', defaultLogFile);
  const redactSensitiveData = configuration.get<boolean>('redactSensitiveData', true);
  const captureTranscripts = configuration.get<boolean>('captureTranscripts', true);
  const hookTimeoutSeconds = clampTimeout(configuration.get<number>('hookTimeoutSeconds', 10));
  const feedbackFile = configuration.get<string>('feedbackFile', 'Code Buddy.md');
  const analyticsFile = configuration.get<string>('analyticsFile', 'Code Buddy Analytics.md');
  const trackWorktreeChanges = configuration.get<boolean>('trackWorktreeChanges', true);
  const snapshotMaxFileSizeBytes = Math.min(
    10_000_000,
    Math.max(10_000, Math.round(configuration.get<number>('snapshotMaxFileSizeBytes', 1_000_000)))
  );
  const pythonCommand = configuration.get<string>('pythonCommand', '');
  const interventionLogFile = configuration.get<string>('interventionLogFile', defaultInterventionLogFile);
  const contextEstimatedCapacityTokens = Math.max(1_000, Math.round(configuration.get<number>('context.estimatedContextCapacityTokens', 40_000)));
  const contextWarningThreshold = Math.min(1, Math.max(0, configuration.get<number>('context.warningThreshold', 0.70)));
  const contextCriticalThreshold = Math.min(1, Math.max(contextWarningThreshold, configuration.get<number>('context.criticalThreshold', 0.85)));
  const contextAllowVisionVerification = configuration.get<boolean>('context.allowVisionVerification', true);
  const contextOfferCurationOnNewSession = configuration.get<boolean>('context.offerCurationOnNewSession', true);
  const contextOfferCurationOnNewTask = configuration.get<boolean>('context.offerCurationOnNewTask', true);
  const promptReviewEnabled = configuration.get<boolean>('promptReview.enabled', true);
  const taskDecompositionEnabled = configuration.get<boolean>('taskDecomposition.enabled', true);
  const preflightEnforceBeforeImplementation = configuration.get<boolean>('preflight.enforceBeforeImplementation', true);
  const preflightDenialsBeforeFallback = Math.min(
    5,
    Math.max(1, Math.round(configuration.get<number>('preflight.denialsBeforeFallback', 1)))
  );

  return {
    logFile,
    redactSensitiveData,
    captureTranscripts,
    hookTimeoutSeconds,
    feedbackFile,
    analyticsFile,
    trackWorktreeChanges,
    snapshotMaxFileSizeBytes,
    pythonCommand,
    interventionLogFile,
    contextEstimatedCapacityTokens,
    contextWarningThreshold,
    contextCriticalThreshold,
    contextAllowVisionVerification,
    contextOfferCurationOnNewSession,
    contextOfferCurationOnNewTask,
    promptReviewEnabled,
    taskDecompositionEnabled,
    preflightEnforceBeforeImplementation,
    preflightDenialsBeforeFallback,
    logPath: resolveLogPath(root, logFile),
    feedbackPath: resolveLogPath(root, feedbackFile),
    analyticsPath: resolveLogPath(root, analyticsFile),
    interventionLogPath: resolveLogPath(root, interventionLogFile)
  };
}

async function migrateLegacyLog(root: vscode.Uri, settings: HookSettings & { logPath: string }): Promise<void> {
  if (settings.logFile !== defaultLogFile) {
    return;
  }

  const oldLogPath = path.join(root.fsPath, legacyLogFile);
  if (oldLogPath === settings.logPath) {
    return;
  }

  try {
    await fs.access(settings.logPath);
    return;
  } catch {
    try {
      await fs.access(oldLogPath);
    } catch {
      return;
    }
  }

  await fs.mkdir(path.dirname(settings.logPath), { recursive: true });
  await fs.rename(oldLogPath, settings.logPath);

  const oldStatePath = path.join(root.fsPath, '.token-lens', '.state');
  const newStatePath = path.join(path.dirname(settings.logPath), '.state');
  try {
    await fs.access(newStatePath);
  } catch {
    try {
      await fs.rename(oldStatePath, newStatePath);
    } catch {
      return;
    }
  }
}

function hookCommand(extensionPath: string): { bash: string; powershell: string } {
  const hookPath = path.join(extensionPath, 'hook.cjs');

  return {
    bash: `${quoteBash('node')} ${quoteBash(hookPath)}`,
    powershell: `& ${quotePowerShell('node')} ${quotePowerShell(hookPath)}`
  };
}

function createHookEntry(
  extensionPath: string,
  root: vscode.Uri,
  settings: HookSettings & { logPath: string; feedbackPath: string; analyticsPath: string; interventionLogPath: string }
): HookValue {
  return {
    type: 'command',
    ...hookCommand(extensionPath),
    cwd: root.fsPath,
    env: {
      TOKEN_LENS_LOG_FILE: settings.logPath,
      TOKEN_LENS_REDACT_SENSITIVE: String(settings.redactSensitiveData),
      TOKEN_LENS_CAPTURE_TRANSCRIPTS: String(settings.captureTranscripts),
      TOKEN_LENS_STATE_DIR: path.join(path.dirname(settings.logPath), '.state'),
      TOKEN_LENS_ANALYTICS_SCRIPT: path.join(extensionPath, 'code_buddy.py'),
      TOKEN_LENS_FEEDBACK_FILE: settings.feedbackPath,
      TOKEN_LENS_ANALYTICS_FILE: settings.analyticsPath,
      TOKEN_LENS_TRACK_WORKTREE_CHANGES: String(settings.trackWorktreeChanges),
      TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES: String(settings.snapshotMaxFileSizeBytes),
      TOKEN_LENS_PYTHON_COMMAND: settings.pythonCommand,
      TOKEN_LENS_INTERVENTION_LOG_FILE: settings.interventionLogPath,
      TOKEN_LENS_CONTEXT_CAPACITY_TOKENS: String(settings.contextEstimatedCapacityTokens),
      TOKEN_LENS_CONTEXT_WARNING_THRESHOLD: String(settings.contextWarningThreshold),
      TOKEN_LENS_CONTEXT_CRITICAL_THRESHOLD: String(settings.contextCriticalThreshold),
      TOKEN_LENS_CONTEXT_ALLOW_VISION: String(settings.contextAllowVisionVerification),
      TOKEN_LENS_CONTEXT_OFFER_CURATION_ON_NEW_SESSION: String(settings.contextOfferCurationOnNewSession),
      TOKEN_LENS_CONTEXT_OFFER_CURATION_ON_NEW_TASK: String(settings.contextOfferCurationOnNewTask),
      TOKEN_LENS_PROMPT_REVIEW_ENABLED: String(settings.promptReviewEnabled),
      TOKEN_LENS_TASK_DECOMPOSITION_ENABLED: String(settings.taskDecompositionEnabled),
      TOKEN_LENS_PREFLIGHT_ENFORCE: String(settings.preflightEnforceBeforeImplementation),
      TOKEN_LENS_PREFLIGHT_DENIALS_BEFORE_FALLBACK: String(settings.preflightDenialsBeforeFallback)
    },
    timeoutSec: settings.hookTimeoutSeconds
  };
}

function createHookConfig(
  extensionPath: string,
  root: vscode.Uri,
  settings: HookSettings & { logPath: string; feedbackPath: string; analyticsPath: string; interventionLogPath: string }
): HookValue {
  const entry = createHookEntry(extensionPath, root, settings);
  const hooks: Record<string, HookValue[]> = {};
  for (const event of hookEvents) {
    hooks[event] = [entry];
  }

  return {
    version: 1,
    hooks
  };
}

function isTokenLensConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const hooks = (value as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object') {
    return false;
  }

  return Object.values(hooks as Record<string, unknown>).some((entries) => {
    if (!Array.isArray(entries)) {
      return false;
    }
    return entries.some((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const env = (entry as { env?: unknown }).env;
      return Boolean(env && typeof env === 'object' && 'TOKEN_LENS_LOG_FILE' in env);
    });
  });
}

async function readJson(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as unknown;
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isManagedInstruction(value: string): boolean {
  return value.includes(codeBuddyInstructionsMarker)
    || (value.includes(codeBuddyInstructionsStartMarker) && value.includes(codeBuddyInstructionsEndMarker));
}

async function installAgentInstructions(root: vscode.Uri): Promise<string> {
  const instructionsPath = path.join(root.fsPath, agentInstructionsRelativePath);
  const legacyInstructionsPath = path.join(root.fsPath, legacyAgentInstructionsRelativePath);
  const existing = await readTextIfPresent(instructionsPath);

  await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
  await fs.writeFile(instructionsPath, mergeCodeBuddyAgentInstructions(existing), 'utf8');

  const legacy = await readTextIfPresent(legacyInstructionsPath);
  if (legacy !== undefined && isManagedInstruction(legacy)) {
    await fs.unlink(legacyInstructionsPath);
  }

  return instructionsPath;
}

async function removeAgentInstructions(root: vscode.Uri): Promise<void> {
  const instructionsPath = path.join(root.fsPath, agentInstructionsRelativePath);
  const existing = await readTextIfPresent(instructionsPath);
  if (existing !== undefined) {
    const remaining = removeCodeBuddyAgentInstructions(existing);
    if (remaining.trim()) {
      await fs.writeFile(instructionsPath, remaining, 'utf8');
    } else {
      await fs.unlink(instructionsPath);
    }
  }

  const legacyInstructionsPath = path.join(root.fsPath, legacyAgentInstructionsRelativePath);
  const legacy = await readTextIfPresent(legacyInstructionsPath);
  if (legacy !== undefined && isManagedInstruction(legacy)) {
    await fs.unlink(legacyInstructionsPath);
  }
}

export async function installHooks(context: vscode.ExtensionContext): Promise<HookInstallResult> {
  const root = getWorkspaceRoot();
  const settings = getSettings(root);
  const configPath = path.join(root.fsPath, hookConfigRelativePath);
  let created = false;

  try {
    const existing = await readJson(configPath);
    if (!isTokenLensConfig(existing)) {
      throw new Error(`Refusing to overwrite an existing non-Code Buddy hook file: ${configPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    created = true;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(settings.logPath), { recursive: true });
  await fs.mkdir(path.dirname(settings.interventionLogPath), { recursive: true });
  await fs.mkdir(path.dirname(settings.feedbackPath), { recursive: true });
  await fs.mkdir(path.dirname(settings.analyticsPath), { recursive: true });
  await migrateLegacyLog(root, settings);
  await fs.writeFile(
    configPath,
    `${JSON.stringify(createHookConfig(context.extensionPath, root, settings), null, 2)}\n`,
    'utf8'
  );
  const instructionsPath = await installAgentInstructions(root);

  return {
    configPath,
    logPath: settings.logPath,
    feedbackPath: settings.feedbackPath,
    analyticsPath: settings.analyticsPath,
    interventionLogPath: settings.interventionLogPath,
    instructionsPath,
    created
  };
}

export async function removeHooks(): Promise<string> {
  const root = getWorkspaceRoot();
  const configPath = path.join(root.fsPath, hookConfigRelativePath);
  const existing = await readJson(configPath);
  if (!isTokenLensConfig(existing)) {
    throw new Error(`Refusing to remove a hook file not created by Code Buddy: ${configPath}`);
  }
  await fs.unlink(configPath);
  await removeAgentInstructions(root);
  return configPath;
}

export function getCurrentLogPath(): string {
  return getSettings(getWorkspaceRoot()).logPath;
}

export function getCurrentFeedbackPath(): string {
  return getSettings(getWorkspaceRoot()).feedbackPath;
}

export function getCurrentAnalyticsPath(): string {
  return getSettings(getWorkspaceRoot()).analyticsPath;
}

export function getCurrentInterventionLogPath(): string {
  return getSettings(getWorkspaceRoot()).interventionLogPath;
}

export function getCurrentAgentInstructionsPath(): string {
  return path.join(getWorkspaceRoot().fsPath, agentInstructionsRelativePath);
}

export function getCurrentHookConfigPath(): string {
  return path.join(getWorkspaceRoot().fsPath, hookConfigRelativePath);
}
