import * as vscode from 'vscode';
import {
  CodeBuddyPolicy,
  ContextCurationInput,
  CuratedContextBundle,
  PromptReviewInput,
  PromptReviewResult,
  TaskDecompositionInput,
  TaskDecompositionResult,
  ToolFailure
} from '../core/contracts';
import {
  buildContextCurationRequest,
  buildPromptReviewRequest,
  buildTaskDecompositionRequest,
  contextCurationFallback,
  normalizeCuratedContext,
  normalizePromptReview,
  normalizeTaskDecomposition,
  promptReviewFallback,
  taskDecompositionFallback
} from './toolContracts';
import { ReasonerError, StructuredReasoner } from './vscodeReasoner';

function failureFromError(error: unknown, continuation: ToolFailure['continuation']): ToolFailure {
  if (error instanceof ReasonerError) {
    return { code: error.code, message: error.message, continuation };
  }
  return {
    code: 'invalid_output',
    message: error instanceof Error ? error.message : String(error),
    continuation
  };
}

export class PromptReviewService {
  public constructor(private readonly reasoner: StructuredReasoner, private readonly policy: CodeBuddyPolicy) {}

  public async review(input: PromptReviewInput, token: vscode.CancellationToken): Promise<PromptReviewResult> {
    if (!this.policy.promptReview.enabled) {
      return promptReviewFallback(input, { code: 'disabled', message: 'Prompt Reviewer is disabled by configuration.', continuation: 'use_original' });
    }
    try {
      const raw = await this.reasoner.requestJson(buildPromptReviewRequest(input), token);
      return normalizePromptReview(raw, input, this.policy);
    } catch (error) {
      return promptReviewFallback(input, failureFromError(error, 'use_original'));
    }
  }
}

export class TaskDecompositionService {
  public constructor(private readonly reasoner: StructuredReasoner, private readonly policy: CodeBuddyPolicy) {}

  public async decompose(input: TaskDecompositionInput, token: vscode.CancellationToken): Promise<TaskDecompositionResult> {
    if (!this.policy.taskDecomposition.enabled) {
      return taskDecompositionFallback(input, { code: 'disabled', message: 'Task Decomposer is disabled by configuration.', continuation: 'use_original' });
    }
    try {
      const raw = await this.reasoner.requestJson(buildTaskDecompositionRequest(input), token);
      return normalizeTaskDecomposition(raw, input, this.policy);
    } catch (error) {
      return taskDecompositionFallback(input, failureFromError(error, 'use_original'));
    }
  }
}

export class ContextCurationService {
  public constructor(private readonly reasoner: StructuredReasoner) {}

  public async curate(input: ContextCurationInput, token: vscode.CancellationToken): Promise<CuratedContextBundle> {
    try {
      const raw = await this.reasoner.requestJson(buildContextCurationRequest(input), token);
      return normalizeCuratedContext(raw, input);
    } catch (error) {
      return contextCurationFallback(input, failureFromError(error, 'continue_current_session'));
    }
  }
}
