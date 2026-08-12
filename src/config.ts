import * as vscode from 'vscode';
import { CodeBuddyPolicy } from './core/contracts';
import { clamp, DEFAULT_POLICY } from './core/policyEngine';

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function getCodeBuddyPolicy(scope?: vscode.ConfigurationScope): CodeBuddyPolicy {
  const configuration = vscode.workspace.getConfiguration('tokenLens', scope);
  const warningThreshold = clamp(finite(
    configuration.get<number>('context.warningThreshold', DEFAULT_POLICY.context.warningThreshold),
    DEFAULT_POLICY.context.warningThreshold
  ), 0, 1);
  return {
    promptReview: {
      enabled: configuration.get<boolean>('promptReview.enabled', DEFAULT_POLICY.promptReview.enabled),
      interventionThreshold: clamp(
        finite(configuration.get<number>('promptReview.interventionThreshold', DEFAULT_POLICY.promptReview.interventionThreshold), DEFAULT_POLICY.promptReview.interventionThreshold),
        0,
        100
      )
    },
    taskDecomposition: {
      enabled: configuration.get<boolean>('taskDecomposition.enabled', DEFAULT_POLICY.taskDecomposition.enabled),
      interventionThreshold: clamp(
        finite(configuration.get<number>('taskDecomposition.interventionThreshold', DEFAULT_POLICY.taskDecomposition.interventionThreshold), DEFAULT_POLICY.taskDecomposition.interventionThreshold),
        0,
        100
      )
    },
    context: {
      estimatedContextCapacityTokens: Math.max(1_000, Math.round(finite(
        configuration.get<number>('context.estimatedContextCapacityTokens', DEFAULT_POLICY.context.estimatedContextCapacityTokens),
        DEFAULT_POLICY.context.estimatedContextCapacityTokens
      ))),
      warningThreshold,
      criticalThreshold: clamp(Math.max(warningThreshold, finite(
        configuration.get<number>('context.criticalThreshold', DEFAULT_POLICY.context.criticalThreshold),
        DEFAULT_POLICY.context.criticalThreshold
      )), 0, 1),
      allowVisionVerification: configuration.get<boolean>('context.allowVisionVerification', DEFAULT_POLICY.context.allowVisionVerification),
      offerCurationOnNewSession: configuration.get<boolean>('context.offerCurationOnNewSession', DEFAULT_POLICY.context.offerCurationOnNewSession),
      offerCurationOnNewTask: configuration.get<boolean>('context.offerCurationOnNewTask', DEFAULT_POLICY.context.offerCurationOnNewTask)
    }
  };
}
