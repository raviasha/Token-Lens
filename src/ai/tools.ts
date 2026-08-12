import * as vscode from 'vscode';
import {
  CodeBuddyPolicy,
  ContextCurationInput,
  ContextMeasurementInput,
  PromptReviewInput,
  SessionContextSnapshot,
  TaskDecompositionInput
} from '../core/contracts';
import { EventAppendInput } from '../core/eventStore';
import { isMeaningfulPrompt } from '../core/policyEngine';
import { ContextMeasurementService } from '../providers/contextMeasurement';
import { InterventionPresenter } from '../ui/interventionPresenter';
import { ContextCurationService, PromptReviewService, TaskDecompositionService } from './services';

export const toolNames = {
  promptReviewer: 'code-buddy_reviewPrompt',
  taskDecomposer: 'code-buddy_decomposeTask',
  contextMeasurement: 'code-buddy_measureContext',
  contextCurator: 'code-buddy_curateContext'
} as const;

export interface ToolEventLogger {
  append(input: EventAppendInput): Promise<unknown>;
}

export interface CodeBuddyToolDependencies {
  policy: CodeBuddyPolicy;
  promptReviewer: PromptReviewService;
  taskDecomposer: TaskDecompositionService;
  contextCurator: ContextCurationService;
  contextMeasurement: ContextMeasurementService;
  presenter: InterventionPresenter;
  eventLogger(): ToolEventLogger;
  currentSnapshot(): Promise<SessionContextSnapshot | undefined>;
  curationHistory(): Promise<string[]>;
}

function toolResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value))
  ]);
}

class PromptReviewerTool implements vscode.LanguageModelTool<PromptReviewInput> {
  public constructor(private readonly dependencies: CodeBuddyToolDependencies) {}

  public async invoke(options: vscode.LanguageModelToolInvocationOptions<PromptReviewInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (!isMeaningfulPrompt(input.prompt)) {
      const result = {
        contractVersion: 1,
        kind: 'prompt_review',
        status: 'ok',
        score: 100,
        dimensions: [],
        reasons: ['Control input; semantic evaluation was not required.'],
        issues: [],
        interventionRecommended: false,
        suggestions: [],
        options: [{ id: 'original', label: 'Continue with my original prompt', prompt: input.prompt, preservesOriginalIntent: true }],
        selectedOptionId: 'original',
        originalPromptRetained: true
      };
      return toolResult(result);
    }
    const result = await this.dependencies.promptReviewer.review(input, token);
    const selection = await this.dependencies.presenter.presentPromptReview(result);
    result.selectedOptionId = selection;
    result.originalPromptRetained = !selection || selection === 'original';
    await this.dependencies.eventLogger().append({
      eventType: result.status === 'ok' ? 'prompt.reviewed' : 'tool.failed',
      sessionId: input.sessionId,
      taskId: input.taskId,
      data: {
        invocationSource: 'language_model_tool',
        toolName: toolNames.promptReviewer,
        originalPrompt: input.prompt,
        score: result.score,
        dimensions: result.dimensions,
        issues: result.issues,
        interventionRecommended: result.interventionRecommended,
        optionsPresented: result.options,
        selectedOptionId: selection ?? null,
        originalPromptRetained: result.originalPromptRetained,
        failure: result.failure ?? null
      }
    });
    return toolResult(result);
  }

  public prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: 'Reviewing prompt quality with Code Buddy…' };
  }
}

class TaskDecomposerTool implements vscode.LanguageModelTool<TaskDecompositionInput> {
  public constructor(private readonly dependencies: CodeBuddyToolDependencies) {}

  public async invoke(options: vscode.LanguageModelToolInvocationOptions<TaskDecompositionInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (!isMeaningfulPrompt(input.task)) {
      return toolResult({
        contractVersion: 1,
        kind: 'task_decomposition',
        status: 'ok',
        complexityScore: 0,
        reasons: ['Control input; task decomposition was not required.'],
        decompositionRecommended: false,
        strategies: [],
        originalTaskOption: { id: 'original', label: 'Continue with the original task', task: input.task },
        selectedStrategyId: 'original',
        originalTaskRetained: true
      });
    }
    const result = await this.dependencies.taskDecomposer.decompose(input, token);
    const selection = await this.dependencies.presenter.presentTaskDecomposition(result);
    result.selectedStrategyId = selection.strategyId;
    result.selectedStepId = selection.stepId;
    result.originalTaskRetained = !selection.strategyId || selection.strategyId === 'original';
    await this.dependencies.eventLogger().append({
      eventType: result.status === 'ok' ? 'task.decomposition_evaluated' : 'tool.failed',
      sessionId: input.sessionId,
      taskId: input.taskId,
      data: {
        invocationSource: 'language_model_tool',
        toolName: toolNames.taskDecomposer,
        originalPrompt: input.task,
        complexityScore: result.complexityScore,
        reasons: result.reasons,
        decompositionRecommended: result.decompositionRecommended,
        optionsPresented: result.strategies,
        selectedStrategyId: result.selectedStrategyId ?? null,
        selectedStepId: result.selectedStepId ?? null,
        originalTaskRetained: result.originalTaskRetained,
        failure: result.failure ?? null
      }
    });
    return toolResult(result);
  }

  public prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: 'Assessing task complexity with Code Buddy…' };
  }
}

class ContextMeasurementTool implements vscode.LanguageModelTool<ContextMeasurementInput> {
  public constructor(private readonly dependencies: CodeBuddyToolDependencies) {}

  public async invoke(options: vscode.LanguageModelToolInvocationOptions<ContextMeasurementInput>): Promise<vscode.LanguageModelToolResult> {
    const snapshot = await this.dependencies.currentSnapshot();
    const input: ContextMeasurementInput = {
      ...options.input,
      estimate: options.input.estimate ?? (snapshot ? {
        value: snapshot.estimate.value,
        unit: 'estimated_tokens',
        utilization: snapshot.estimate.utilization,
        confidence: snapshot.estimate.confidence,
        thresholdState: snapshot.estimate.thresholdState,
        estimatorVersion: snapshot.estimate.estimatorVersion
      } : undefined)
    };
    const result = this.dependencies.contextMeasurement.measure(input);
    await this.dependencies.eventLogger().append({
      eventType: result.status === 'ok' ? 'context.measured' : 'tool.failed',
      sessionId: input.sessionId,
      data: {
        invocationSource: 'language_model_tool',
        toolName: toolNames.contextMeasurement,
        value: result.measurement.value,
        unit: result.measurement.unit,
        measurementMethod: result.measurement.method,
        confidence: result.measurement.confidence,
        thresholdState: result.measurement.thresholdState,
        terminology: result.measurement.terminology,
        recommendation: result.recommendation,
        failure: result.failure ?? null
      }
    });
    return toolResult(result);
  }

  public prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: 'Checking the best available context measurement…' };
  }
}

class ContextCuratorTool implements vscode.LanguageModelTool<ContextCurationInput> {
  public constructor(private readonly dependencies: CodeBuddyToolDependencies) {}

  public async invoke(options: vscode.LanguageModelToolInvocationOptions<ContextCurationInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const input = {
      ...options.input,
      conversationHistory: options.input.conversationHistory?.length
        ? options.input.conversationHistory
        : await this.dependencies.curationHistory()
    };
    let result = await this.dependencies.contextCurator.curate(input, token);
    result = await this.dependencies.presenter.presentCuratedBundle(result);
    if (result.accepted) {
      await vscode.env.clipboard.writeText(renderHandoffPayload(result));
    }
    await this.dependencies.eventLogger().append({
      eventType: result.status === 'ok' ? 'context.curation_completed' : 'tool.failed',
      sessionId: input.sessionId,
      data: {
        invocationSource: 'language_model_tool',
        toolName: toolNames.contextCurator,
        targetTask: input.targetTask,
        mode: input.mode,
        curationOffered: true,
        accepted: result.accepted,
        itemCount: result.items.length,
        pinnedItemCount: result.items.filter((item) => item.pinned).length,
        excludedHistoryCount: result.excludedHistory.length,
        bundleMetadata: result.items.map((item) => ({ id: item.id, section: item.section, pinned: item.pinned })),
        failure: result.failure ?? null
      }
    });
    return toolResult(result);
  }

  public prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: 'Curating minimum sufficient task context…' };
  }
}

export function renderHandoffPayload(bundle: { taskObjective: string; items: Array<{ section: string; content: string }>; suggestedStartingInstruction: string }): string {
  return [
    '[CONTEXT HANDOFF]',
    '',
    `Task objective: ${bundle.taskObjective}`,
    ...bundle.items.map((item) => `- ${item.section.replaceAll('_', ' ')}: ${item.content}`),
    '',
    '[STARTING INSTRUCTION]',
    '',
    bundle.suggestedStartingInstruction
  ].join('\n');
}

export function registerCodeBuddyTools(context: vscode.ExtensionContext, dependencies: CodeBuddyToolDependencies): void {
  context.subscriptions.push(
    vscode.lm.registerTool(toolNames.promptReviewer, new PromptReviewerTool(dependencies)),
    vscode.lm.registerTool(toolNames.taskDecomposer, new TaskDecomposerTool(dependencies)),
    vscode.lm.registerTool(toolNames.contextMeasurement, new ContextMeasurementTool(dependencies)),
    vscode.lm.registerTool(toolNames.contextCurator, new ContextCuratorTool(dependencies))
  );
}
