import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeBuddyPolicy } from '../core/contracts';
import { EventAppendInput } from '../core/eventStore';
import { detectCurationBoundary } from '../core/policyEngine';
import { latestPrompts, observeSession, readHookRecords } from '../observability/sessionReader';
import { CodeBuddyWorkflow } from './workflow';

export interface GovernanceDependencies {
  policy: CodeBuddyPolicy;
  currentLogPath(): string;
  appendEvent(input: EventAppendInput): Promise<unknown>;
  workflow: CodeBuddyWorkflow;
}

const processedBoundaryPromptIdsKey = 'codeBuddy.processedBoundaryPromptIds';
const processedBoundarySessionIdsKey = 'codeBuddy.processedBoundarySessionIds';

function semanticSessionFit(records: Awaited<ReturnType<typeof readHookRecords>>, sessionId: string): {
  newTaskLikelihood: number;
  confidence: string;
  reason: string;
  freshTaskRecommended: boolean;
} | undefined {
  for (const record of [...records].reverse()) {
    if (String(record.sessionId ?? 'unknown') !== sessionId || record.recordType !== 'tool.completed') {
      continue;
    }
    const data = record.data ?? {};
    if (data.toolName !== 'code-buddy_assessSessionFit') {
      continue;
    }
    const result = data.toolResult;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      continue;
    }
    const value = result as Record<string, unknown>;
    if (typeof value.newTaskLikelihood !== 'number' || typeof value.freshTaskRecommended !== 'boolean') {
      continue;
    }
    return {
      newTaskLikelihood: value.newTaskLikelihood,
      confidence: typeof value.confidence === 'string' ? value.confidence : 'low',
      reason: typeof value.reason === 'string' ? value.reason : 'Code Buddy completed a semantic session-fit check.',
      freshTaskRecommended: value.freshTaskRecommended
    };
  }
  return undefined;
}

export class DeterministicGovernance {
  private readonly processedPromptIds = new Set<string>();
  private readonly processedSessionIds = new Set<string>();
  private readonly processedContextKeys = new Set<string>();
  private boundaryState?: vscode.Memento;
  private processing = false;
  private rerunRequested = false;
  private processTimer?: ReturnType<typeof setTimeout>;

  public constructor(private readonly dependencies: GovernanceDependencies) {}

  public register(context: vscode.ExtensionContext): void {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return;
    }
    this.boundaryState = context.workspaceState;
    for (const eventId of context.workspaceState.get<string[]>(processedBoundaryPromptIdsKey, [])) {
      this.processedPromptIds.add(eventId);
    }
    for (const eventId of context.workspaceState.get<string[]>(processedBoundarySessionIdsKey, [])) {
      this.processedSessionIds.add(eventId);
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace, '**/*.jsonl'));
      const handle = (uri: vscode.Uri): void => {
      let expected: string;
      try {
        expected = path.normalize(this.dependencies.currentLogPath());
      } catch {
        return;
      }
        if (path.normalize(uri.fsPath) === expected) {
        // Hook events are appended in quick succession (SessionStart followed by
        // UserPromptSubmit). Debounce the watcher so a boundary is evaluated only
        // after the complete prompt record is visible on disk.
        if (this.processTimer) {
          clearTimeout(this.processTimer);
        }
        this.processTimer = setTimeout(() => {
          this.processTimer = undefined;
          void this.process();
        }, 250);
        }
      };
    context.subscriptions.push(watcher, watcher.onDidChange(handle), watcher.onDidCreate(handle));
    void this.process();
  }

  private async rememberProcessedPrompt(eventId: string): Promise<void> {
    if (!eventId) {
      return;
    }
    this.processedPromptIds.add(eventId);
    await this.boundaryState?.update(processedBoundaryPromptIdsKey, [...this.processedPromptIds].slice(-200));
  }

  private async rememberProcessedSession(eventId: string): Promise<void> {
    if (!eventId) {
      return;
    }
    this.processedSessionIds.add(eventId);
    await this.boundaryState?.update(processedBoundarySessionIdsKey, [...this.processedSessionIds].slice(-200));
  }

  private async process(): Promise<void> {
    if (this.processing) {
      this.rerunRequested = true;
      return;
    }
    this.processing = true;
    try {
      const records = await readHookRecords(this.dependencies.currentLogPath());
      const prompts = latestPrompts(records, 2);
      const current = prompts.at(-1);
      let boundaryOffered = false;
      const sessionStarts = records.filter((record) => record.recordType === 'session.started' && record.sessionId);
      const latestSessionStart = sessionStarts.at(-1);
      const previousSessionStart = sessionStarts.at(-2);
      if (
        current
        && latestSessionStart
        && previousSessionStart
        && current.sessionId === String(latestSessionStart.sessionId)
        && latestSessionStart.eventId
        && !this.processedSessionIds.has(latestSessionStart.eventId)
        && String(previousSessionStart.sessionId) !== current.sessionId
        && this.dependencies.policy.context.offerCurationOnNewSession
      ) {
        boundaryOffered = true;
        await this.rememberProcessedSession(latestSessionStart.eventId);
        await this.rememberProcessedPrompt(current.eventId);
        await this.dependencies.appendEvent({
          eventType: 'session.boundary_detected',
          sessionId: current.sessionId,
          data: {
            promptEventId: current.eventId,
            previousSessionId: String(previousSessionStart.sessionId),
            currentSessionId: current.sessionId,
            trigger: 'new_session',
            reason: 'A new Copilot session started and has a meaningful first prompt.'
          }
        });
        const action = await vscode.window.showInformationMessage(
          'New Copilot session detected. Carry forward only the relevant context from your previous Code Buddy session?',
          'Carry forward curated context',
          'Start without prior context'
        );
        await this.dependencies.appendEvent({
          eventType: 'session.boundary_choice',
          sessionId: current.sessionId,
          data: {
            promptEventId: current.eventId,
            previousSessionId: String(previousSessionStart.sessionId),
            selectedAction: action ?? 'closed'
          }
        });
        if (action === 'Carry forward curated context') {
          await this.dependencies.workflow.curate(current.prompt, 'fresh_task', 'current_chat');
        }
      }
      if (current && !this.processedPromptIds.has(current.eventId) && !boundaryOffered) {
        await this.rememberProcessedPrompt(current.eventId);
        const previous = prompts.at(-2);
        if (previous) {
          const boundary = detectCurationBoundary(previous, current);
          const sessionFit = semanticSessionFit(records, current.sessionId);
          if (boundary.kind === 'new_session' && this.dependencies.policy.context.offerCurationOnNewSession) {
            boundaryOffered = true;
            await this.dependencies.appendEvent({
              eventType: 'session.boundary_detected',
              sessionId: current.sessionId,
              data: {
                promptEventId: current.eventId,
                previousSessionId: previous.sessionId,
                currentSessionId: current.sessionId,
                trigger: 'new_session',
                reason: boundary.reason
              }
            });
            const action = await vscode.window.showInformationMessage(
              'New Copilot session detected. Carry forward only the relevant context from your previous Code Buddy session?',
              'Carry forward curated context',
              'Start without prior context'
            );
            await this.dependencies.appendEvent({
              eventType: 'session.boundary_choice',
              sessionId: current.sessionId,
              data: {
                promptEventId: current.eventId,
                previousSessionId: previous.sessionId,
                selectedAction: action ?? 'closed'
              }
            });
            if (action === 'Carry forward curated context') {
              await this.dependencies.workflow.curate(current.prompt, 'fresh_task', 'current_chat');
            }
          } else if ((boundary.taskBoundary || sessionFit) && this.dependencies.policy.context.offerCurationOnNewTask) {
            const taskBoundary = sessionFit
              ? {
                isLikelyNewTask: sessionFit.freshTaskRecommended,
                confidence: sessionFit.confidence,
                overlap: boundary.taskBoundary?.overlap ?? 0,
                reason: sessionFit.reason,
                newTaskLikelihood: sessionFit.newTaskLikelihood,
                assessmentSource: 'session_fit'
              }
              : { ...boundary.taskBoundary!, assessmentSource: 'lexical_fallback' };
            await this.dependencies.appendEvent({
              eventType: 'task.boundary_evaluated',
              sessionId: current.sessionId,
              data: { promptEventId: current.eventId, ...taskBoundary }
            });
            if (taskBoundary.isLikelyNewTask) {
              boundaryOffered = true;
              const action = await vscode.window.showInformationMessage(
                'This looks like a new task. Code Buddy can create fresh task-specific context from only the relevant prior work.',
                'Curate for a fresh chat',
                'Continue unchanged'
              );
              await this.dependencies.appendEvent({
                eventType: 'task.boundary_choice',
                sessionId: current.sessionId,
                data: { promptEventId: current.eventId, selectedAction: action ?? 'closed' }
              });
              if (action === 'Curate for a fresh chat') {
                await this.dependencies.workflow.curate(current.prompt, 'fresh_task');
              }
            }
          }
        }
      }

      const snapshot = observeSession(records, this.dependencies.policy);
      if (!snapshot || !['warning', 'critical'].includes(snapshot.estimate.thresholdState) || boundaryOffered) {
        return;
      }
      const contextKey = `${snapshot.sessionId}:${snapshot.timestamp}:${snapshot.estimate.value}:${snapshot.estimate.thresholdState}`;
      if (this.processedContextKeys.has(contextKey)) {
        return;
      }
      this.processedContextKeys.add(contextKey);
      const measurement = await this.dependencies.workflow.measureContext(false);
      if (!['warning', 'critical'].includes(measurement.measurement.thresholdState)) {
        return;
      }
      await this.dependencies.appendEvent({
        eventType: 'context.warning',
        sessionId: snapshot.sessionId,
        data: {
          contextMeasurement: measurement.measurement,
          observableSignals: snapshot.signals
        }
      });
      const contextDetail = measurement.measurement.utilization !== undefined && measurement.measurement.capacityTokens
        ? `${(measurement.measurement.utilization * 100).toFixed(1)}% (${measurement.measurement.value.toLocaleString()} / ${measurement.measurement.capacityTokens.toLocaleString()} input tokens)`
        : `~${measurement.measurement.value.toLocaleString()} ${measurement.measurement.unit.replace('_', ' ')}`;
      const action = await vscode.window.showWarningMessage(
        `${measurement.measurement.terminology} is ${measurement.measurement.thresholdState} (${contextDetail}). Continuing may increase noise or token cost.`,
        'Start fresh with curated context',
        'Curate current task',
        'Continue unchanged'
      );
      await this.dependencies.appendEvent({
        eventType: 'context.warning_choice',
        sessionId: snapshot.sessionId,
        data: { selectedAction: action ?? 'closed', contextMeasurement: measurement.measurement }
      });
      if (action === 'Start fresh with curated context') {
        await this.dependencies.workflow.curate(undefined, 'fresh_task');
      } else if (action === 'Curate current task') {
        await this.dependencies.workflow.curate(current?.prompt, 'continue_current');
      }
    } catch {
      // Governance is advisory. Hook logging and normal coding continue when observation fails.
    } finally {
      this.processing = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.process();
      }
    }
  }
}
