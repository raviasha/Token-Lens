import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextCurationInput, ContextMeasurementResult, SessionContextSnapshot } from '../core/contracts';
import { EventAppendInput } from '../core/eventStore';
import { ContextMeasurementService } from '../providers/contextMeasurement';
import { InterventionPresenter } from '../ui/interventionPresenter';
import { ContextCurationService, PromptReviewService, TaskDecompositionService } from '../ai/services';
import { renderHandoffPayload } from '../ai/tools';
import { createPendingFreshHandoff, handoffMarker } from './pendingHandoff';

export interface WorkflowDependencies {
  promptReviewer: PromptReviewService;
  taskDecomposer: TaskDecompositionService;
  contextCurator: ContextCurationService;
  contextMeasurement: ContextMeasurementService;
  presenter: InterventionPresenter;
  currentSnapshot(): Promise<SessionContextSnapshot | undefined>;
  curationHistory(): Promise<string[]>;
  currentLogPath(): string;
  appendEvent(input: EventAppendInput): Promise<unknown>;
}

export type CurationDestination = 'fresh_chat' | 'current_chat';

export class CodeBuddyWorkflow {
  public constructor(private readonly dependencies: WorkflowDependencies) {}

  public async reviewPrompt(initialPrompt?: string): Promise<void> {
    const prompt = initialPrompt ?? await vscode.window.showInputBox({
      title: 'Code Buddy Prompt Reviewer',
      prompt: 'Enter the coding prompt to evaluate',
      ignoreFocusOut: true
    });
    if (!prompt?.trim()) {
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const result = await this.dependencies.promptReviewer.review({ prompt }, cancellation.token);
      const selectedOptionId = await this.dependencies.presenter.presentPromptReview(result);
      const selected = result.options.find((option) => option.id === selectedOptionId);
      if (selected && selected.id !== 'original') {
        await vscode.env.clipboard.writeText(selected.prompt);
        await vscode.window.showInformationMessage('Enhanced prompt copied. Review it before submitting to your coding agent.');
      }
      await this.dependencies.appendEvent({
        eventType: result.status === 'ok' ? 'prompt.reviewed' : 'tool.failed',
        data: {
          invocationSource: 'command_or_governance',
          command: 'tokenLens.reviewPrompt',
          originalPrompt: prompt,
          score: result.score,
          dimensions: result.dimensions,
          issues: result.issues,
          interventionRecommended: result.interventionRecommended,
          optionsPresented: result.options,
          selectedOptionId: selectedOptionId ?? null,
          originalPromptRetained: !selectedOptionId || selectedOptionId === 'original',
          failure: result.failure ?? null
        }
      });
    } finally {
      cancellation.dispose();
    }
  }

  public async decomposeTask(initialTask?: string): Promise<void> {
    const task = initialTask ?? await vscode.window.showInputBox({
      title: 'Code Buddy Task Decomposer',
      prompt: 'Enter the coding task to assess',
      ignoreFocusOut: true
    });
    if (!task?.trim()) {
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const result = await this.dependencies.taskDecomposer.decompose({ task }, cancellation.token);
      const selection = await this.dependencies.presenter.presentTaskDecomposition(result);
      await this.dependencies.appendEvent({
        eventType: result.status === 'ok' ? 'task.decomposition_evaluated' : 'tool.failed',
        data: {
          invocationSource: 'command_or_governance',
          command: 'tokenLens.decomposeTask',
          originalPrompt: task,
          complexityScore: result.complexityScore,
          decompositionRecommended: result.decompositionRecommended,
          strategies: result.strategies,
          selection,
          originalTaskRetained: !selection.strategyId || selection.strategyId === 'original',
          failure: result.failure ?? null
        }
      });
    } finally {
      cancellation.dispose();
    }
  }

  public async measureContext(showNotification = true): Promise<ContextMeasurementResult> {
    const snapshot = await this.dependencies.currentSnapshot();
    const result = this.dependencies.contextMeasurement.measure({
      sessionId: snapshot?.sessionId,
      nativeMeasurement: snapshot?.estimate.method === 'api' ? {
        value: snapshot.estimate.value,
        unit: 'tokens',
        confidence: snapshot.estimate.confidence,
        providerId: snapshot.estimate.providerId ?? 'codex-cli-token-count',
        capacityTokens: snapshot.estimate.capacityTokens,
        utilization: snapshot.estimate.utilization,
        measurementTimestamp: snapshot.estimate.measurementTimestamp,
        cachedInputTokens: snapshot.estimate.cachedInputTokens,
        cacheWriteInputTokens: snapshot.estimate.cacheWriteInputTokens,
        outputTokens: snapshot.estimate.outputTokens,
        reasoningTokens: snapshot.estimate.reasoningTokens,
        totalTokens: snapshot.estimate.totalTokens
      } : undefined,
      estimate: snapshot?.estimate.method === 'estimate' ? {
        value: snapshot.estimate.value,
        unit: 'estimated_tokens',
        utilization: snapshot.estimate.utilization,
        confidence: snapshot.estimate.confidence,
        thresholdState: snapshot.estimate.thresholdState,
        estimatorVersion: snapshot.estimate.estimatorVersion
      } : undefined
    });
    await this.dependencies.appendEvent({
      eventType: result.status === 'ok' ? 'context.measured' : 'tool.failed',
      sessionId: snapshot?.sessionId,
      data: {
        invocationSource: 'command_or_governance',
        command: 'tokenLens.measureContext',
        ...(result as unknown as Record<string, unknown>)
      }
    });
    if (showNotification) {
      const detail = result.measurement.utilization !== undefined && result.measurement.capacityTokens
        ? `${(result.measurement.utilization * 100).toFixed(1)}% (${result.measurement.value.toLocaleString()} / ${result.measurement.capacityTokens.toLocaleString()} input tokens)`
        : `${result.measurement.value.toLocaleString()} ${result.measurement.unit.replace('_', ' ')}${result.measurement.unit === 'tokens' ? ' (model context window unavailable)' : ''}`;
      await vscode.window.showInformationMessage(
        `${result.measurement.terminology}: ${detail} (${result.measurement.thresholdState}, ${result.measurement.method}).`
      );
    }
    return result;
  }

  public async curate(
    targetTask?: string,
    mode: ContextCurationInput['mode'] = 'fresh_task',
    destination: CurationDestination = 'fresh_chat'
  ): Promise<boolean> {
    const task = targetTask ?? await vscode.window.showInputBox({
      title: 'Code Buddy Context Curator',
      prompt: mode === 'fresh_task' ? 'What task should the fresh chat continue with?' : 'Confirm the current task',
      ignoreFocusOut: true
    });
    if (!task?.trim()) {
      return false;
    }
    const history = await this.dependencies.curationHistory();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      let bundle = await this.dependencies.contextCurator.curate({
        targetTask: task,
        mode,
        conversationHistory: history
      }, cancellation.token);
      bundle = await this.dependencies.presenter.presentCuratedBundle(bundle, destination);
      let pendingHandoffId: string | undefined;
      if (bundle.accepted) {
        const snapshot = await this.dependencies.currentSnapshot();
        const sourceSessionId = snapshot?.sessionId ?? 'unknown';
        const pending = mode === 'fresh_task'
          ? await createPendingFreshHandoff(
            path.join(path.dirname(this.dependencies.currentLogPath()), '.state'),
            sourceSessionId,
            task
          )
          : undefined;
        pendingHandoffId = pending?.handoffId;
        await vscode.env.clipboard.writeText(renderHandoffPayload(bundle, pending && handoffMarker(pending.handoffId)));
        if (pending) {
          await this.dependencies.appendEvent({
            eventType: 'context.handoff_pending',
            sessionId: sourceSessionId,
            data: { handoffId: pending.handoffId, targetTask: task }
          });
        }
        await vscode.window.showInformationMessage(destination === 'current_chat'
          ? 'Curated context copied. Paste it into this new chat when ready.'
          : 'Curated handoff copied. Start a fresh chat and paste it when ready.');
      }
      await this.dependencies.appendEvent({
        eventType: bundle.status === 'ok' ? 'context.curation_completed' : 'tool.failed',
        data: {
          invocationSource: 'command_or_governance',
          command: 'tokenLens.curateContext',
          targetTask: task,
          mode,
          handoffDestination: destination,
          curationOffered: true,
          accepted: bundle.accepted,
          handoffId: pendingHandoffId ?? null,
          itemCount: bundle.items.length,
          pinnedItemCount: bundle.items.filter((item) => item.pinned).length,
          excludedHistoryCount: bundle.excludedHistory.length,
          bundleMetadata: bundle.items.map((item) => ({ id: item.id, section: item.section, pinned: item.pinned })),
          failure: bundle.failure ?? null
        }
      });
      return bundle.accepted;
    } finally {
      cancellation.dispose();
    }
  }
}
