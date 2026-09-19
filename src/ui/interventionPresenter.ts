import * as vscode from 'vscode';
import {
  CuratedContextBundle,
  CuratedContextItem,
  PromptReviewResult,
  TaskDecompositionResult
} from '../core/contracts';

interface IdentifiedQuickPick extends vscode.QuickPickItem {
  id: string;
}

export interface TaskSelection {
  strategyId?: string;
  stepId?: string;
}

export class InterventionPresenter {
  public async presentPromptReview(result: PromptReviewResult): Promise<string | undefined> {
    if (!result.interventionRecommended || result.status !== 'ok') {
      return undefined;
    }
    const choices: IdentifiedQuickPick[] = result.options.map((option) => ({
      id: option.id,
      label: option.id === 'original' ? `$(arrow-right) ${option.label}` : `$(sparkle) ${option.label}`,
      description: option.id === 'original' ? 'Retain intent exactly' : option.prompt.slice(0, 100),
      detail: option.prompt
    }));
    return (await vscode.window.showQuickPick(choices, {
      title: `Code Buddy Prompt Review — ${result.score}/100`,
      placeHolder: result.issues[0]?.reason ?? 'Choose how to continue',
      matchOnDescription: true,
      matchOnDetail: true
    }))?.id;
  }

  public async presentTaskDecomposition(result: TaskDecompositionResult): Promise<TaskSelection> {
    if (!result.decompositionRecommended || result.status !== 'ok') {
      return {};
    }
    const choices: IdentifiedQuickPick[] = [
      { id: 'original', label: '$(arrow-right) Continue with the original task', description: 'Do not decompose' },
      ...result.strategies.map((strategy) => ({
        id: strategy.id,
        label: `$(list-ordered) ${strategy.label}`,
        description: `${strategy.steps.length} steps`,
        detail: strategy.rationale
      }))
    ];
    const strategyChoice = await vscode.window.showQuickPick(choices, {
      title: `Code Buddy Task Assessment — complexity ${result.complexityScore}/100`,
      placeHolder: result.reasons[0] ?? 'Choose a decomposition or retain the original task',
      matchOnDetail: true
    });
    if (!strategyChoice || strategyChoice.id === 'original') {
      return { strategyId: strategyChoice?.id };
    }
    const strategy = result.strategies.find((item) => item.id === strategyChoice.id);
    if (!strategy) {
      return {};
    }
    const stepChoices: IdentifiedQuickPick[] = [
      { id: 'all', label: '$(run-all) Use the complete decomposition', description: 'Start with the first dependency-ready step' },
      ...strategy.steps.map((step) => ({
        id: step.id,
        label: step.title,
        description: step.dependsOn.length ? `Depends on ${step.dependsOn.join(', ')}` : 'Ready to start',
        detail: step.objective
      }))
    ];
    const stepChoice = await vscode.window.showQuickPick(stepChoices, {
      title: strategy.label,
      placeHolder: 'Use the plan or select a sub-task to start'
    });
    return { strategyId: strategy.id, stepId: stepChoice?.id };
  }

  public async presentCuratedBundle(
    bundle: CuratedContextBundle,
    destination: 'fresh_chat' | 'current_chat' = 'fresh_chat'
  ): Promise<CuratedContextBundle> {
    if (bundle.status !== 'ok') {
      return bundle;
    }
    const keepChoices: Array<IdentifiedQuickPick & { source: CuratedContextItem; picked: boolean }> = bundle.items.map((item) => ({
      id: item.id,
      source: item,
      label: `${item.pinned ? '$(pinned)' : '$(note)'} ${item.section.replaceAll('_', ' ')}`,
      description: item.content.slice(0, 120),
      detail: item.content,
      picked: true
    }));
    const kept = await vscode.window.showQuickPick(keepChoices, {
      title: 'Code Buddy Context Handoff',
      placeHolder: 'Uncheck irrelevant history; pinned items are always retained',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!kept) {
      return bundle;
    }
    const keptIds = new Set(kept.map((item) => item.id));
    for (const item of bundle.items.filter((candidate) => candidate.pinned)) {
      keptIds.add(item.id);
    }
    let items = bundle.items.filter((item) => keptIds.has(item.id));
    const pinAction = await vscode.window.showInformationMessage(
      'Pin any context that must survive later edits?',
      'Choose pinned items',
      'Skip'
    );
    if (pinAction === 'Choose pinned items') {
      const pinned = await vscode.window.showQuickPick(items.map((item) => ({
        id: item.id,
        label: item.section.replaceAll('_', ' '),
        description: item.content.slice(0, 120),
        picked: item.pinned
      })), { canPickMany: true, title: 'Pin required context' });
      if (pinned) {
        const pinnedIds = new Set(pinned.map((item) => item.id));
        items = items.map((item) => ({ ...item, pinned: pinnedIds.has(item.id) }));
      }
    }
    const added = await vscode.window.showInputBox({
      title: 'Add missing context (optional)',
      prompt: 'Add one fact the curator missed, or press Enter to skip',
      ignoreFocusOut: true
    });
    if (added?.trim()) {
      items.push({ id: `manual_${Date.now()}`, section: 'background', content: added.trim(), pinned: true });
    }
    const updated = { ...bundle, items };
    const preview = await vscode.workspace.openTextDocument({ content: renderCuratedBundle(updated), language: 'markdown' });
    await vscode.window.showTextDocument(preview, { preview: true });
    const decision = await vscode.window.showInformationMessage(
      'Use this curated handoff?',
      {
        modal: true,
        detail: destination === 'current_chat'
          ? 'Code Buddy will copy it for this new chat; it cannot insert or submit native Copilot chat content through a supported API.'
          : 'Code Buddy will copy it for a fresh chat; it cannot submit or seed native Copilot chat through a supported API.'
      },
      'Accept and copy',
      'Cancel'
    );
    return { ...updated, accepted: decision === 'Accept and copy' };
  }
}

export function renderCuratedBundle(bundle: CuratedContextBundle): string {
  const lines = [
    '# Code Buddy Context Handoff',
    '',
    '## Task objective',
    bundle.taskObjective,
    ''
  ];
  for (const item of bundle.items) {
    lines.push(`- **${item.section.replaceAll('_', ' ')}${item.pinned ? ' (pinned)' : ''}:** ${item.content}`);
  }
  lines.push('', '## Starting instruction', bundle.suggestedStartingInstruction, '');
  if (bundle.excludedHistory.length) {
    lines.push('## Explicitly excluded history', ...bundle.excludedHistory.map((item) => `- ${item}`), '');
  }
  return lines.join('\n');
}
