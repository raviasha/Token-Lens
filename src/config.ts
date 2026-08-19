import * as vscode from 'vscode';
import { CodeBuddyPolicy } from './core/contracts';
import { clamp, DEFAULT_POLICY } from './core/policyEngine';
import { loadProjectPolicy } from './core/projectPolicy';

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function getCodeBuddyPolicy(scope?: vscode.ConfigurationScope): CodeBuddyPolicy {
  const configuration = vscode.workspace.getConfiguration('tokenLens', scope);
  const warningThreshold = clamp(finite(
    configuration.get<number>('context.warningThreshold', DEFAULT_POLICY.context.warningThreshold),
    DEFAULT_POLICY.context.warningThreshold
  ), 0, 1);
  const criticalThreshold = clamp(Math.max(warningThreshold, finite(
    configuration.get<number>('context.criticalThreshold', DEFAULT_POLICY.context.criticalThreshold),
    DEFAULT_POLICY.context.criticalThreshold
  )), 0, 1);
  const legacyPolicy: CodeBuddyPolicy = {
    healthCheck: { ...DEFAULT_POLICY.healthCheck },
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
    sessionFit: { ...DEFAULT_POLICY.sessionFit },
    context: {
      estimatedContextCapacityTokens: Math.max(1_000, Math.round(finite(
        configuration.get<number>('context.estimatedContextCapacityTokens', DEFAULT_POLICY.context.estimatedContextCapacityTokens),
        DEFAULT_POLICY.context.estimatedContextCapacityTokens
      ))),
      warningThreshold,
      criticalThreshold,
      pauseThreshold: clamp(Math.max(criticalThreshold, finite(
        configuration.get<number>('context.pauseThreshold', DEFAULT_POLICY.context.pauseThreshold),
        DEFAULT_POLICY.context.pauseThreshold
      )), 0, 1),
      allowVisionVerification: configuration.get<boolean>('context.allowVisionVerification', DEFAULT_POLICY.context.allowVisionVerification),
      offerCurationOnNewSession: configuration.get<boolean>('context.offerCurationOnNewSession', DEFAULT_POLICY.context.offerCurationOnNewSession),
      offerCurationOnNewTask: configuration.get<boolean>('context.offerCurationOnNewTask', DEFAULT_POLICY.context.offerCurationOnNewTask)
    },
    measurement: {
      humanRetries: {
        minimumComparableTasks: Math.max(2, Math.round(finite(configuration.get<number>('humanRetry.minimumComparableTasks', DEFAULT_POLICY.measurement.humanRetries.minimumComparableTasks), DEFAULT_POLICY.measurement.humanRetries.minimumComparableTasks))),
        minimumTasksPerFactor: Math.max(3, Math.round(finite(configuration.get<number>('humanRetry.minimumTasksPerFactor', DEFAULT_POLICY.measurement.humanRetries.minimumTasksPerFactor), DEFAULT_POLICY.measurement.humanRetries.minimumTasksPerFactor))),
        reliabilityThreshold: clamp(finite(configuration.get<number>('humanRetry.reliabilityThreshold', DEFAULT_POLICY.measurement.humanRetries.reliabilityThreshold), DEFAULT_POLICY.measurement.humanRetries.reliabilityThreshold), 0, 1),
        minimumEffectSize: Math.max(0, finite(configuration.get<number>('humanRetry.minimumEffectSize', DEFAULT_POLICY.measurement.humanRetries.minimumEffectSize), DEFAULT_POLICY.measurement.humanRetries.minimumEffectSize)),
        overdispersionThreshold: Math.max(1, finite(configuration.get<number>('humanRetry.overdispersionThreshold', DEFAULT_POLICY.measurement.humanRetries.overdispersionThreshold), DEFAULT_POLICY.measurement.humanRetries.overdispersionThreshold))
      }
    }
  };
  const workspacePath = scope instanceof vscode.Uri
    ? scope.fsPath
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return loadProjectPolicy(workspacePath, legacyPolicy).policy;
}
