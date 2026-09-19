import * as vscode from 'vscode';
import { extractJson } from './toolContracts';

export type ReasonerFailureCode = 'model_unavailable' | 'model_error' | 'invalid_output' | 'cancelled';

export class ReasonerError extends Error {
  public constructor(public readonly code: ReasonerFailureCode, message: string) {
    super(message);
  }
}

export interface StructuredReasoner {
  requestJson(request: string, token: vscode.CancellationToken): Promise<unknown>;
}

export class VscodeStructuredReasoner implements StructuredReasoner {
  public async requestJson(request: string, token: vscode.CancellationToken): Promise<unknown> {
    if (token.isCancellationRequested) {
      throw new ReasonerError('cancelled', 'The Code Buddy evaluation was cancelled.');
    }
    const models = await vscode.lm.selectChatModels();
    if (!models.length) {
      throw new ReasonerError('model_unavailable', 'No VS Code language model is available to Code Buddy.');
    }
    try {
      const response = await models[0].sendRequest([
        vscode.LanguageModelChatMessage.User(request)
      ], {}, token);
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      try {
        return extractJson(text);
      } catch (error) {
        throw new ReasonerError('invalid_output', error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      if (error instanceof ReasonerError) {
        throw error;
      }
      throw new ReasonerError('model_error', error instanceof Error ? error.message : String(error));
    }
  }
}
