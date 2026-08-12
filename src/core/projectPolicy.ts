import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeBuddyPolicy, ProjectPolicyDiagnostic, ProjectPolicyLoad } from './contracts';

type PolicyValue = boolean | number | PolicyMapping;
interface PolicyMapping { [key: string]: PolicyValue; }

function clonePolicy(policy: CodeBuddyPolicy): CodeBuddyPolicy {
  return {
    healthCheck: { ...policy.healthCheck },
    promptReview: { ...policy.promptReview },
    taskDecomposition: { ...policy.taskDecomposition },
    sessionFit: { ...policy.sessionFit },
    context: { ...policy.context }
  };
}

function diagnostic(
  diagnostics: ProjectPolicyDiagnostic[],
  code: ProjectPolicyDiagnostic['code'],
  pathValue: string,
  message: string
): void {
  diagnostics.push({ code, path: pathValue, message });
}

function stripComment(line: string): string {
  return line.replace(/\s+#.*$/, '').trimEnd();
}

function parseScalar(value: string): boolean | number | undefined {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseYaml(contents: string, diagnostics: ProjectPolicyDiagnostic[]): PolicyMapping {
  const root: PolicyMapping = {};
  const stack: Array<{ indent: number; value: PolicyMapping; path: string }> = [{ indent: -2, value: root, path: '' }];

  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const line = stripComment(sourceLine);
    if (!line.trim()) {
      continue;
    }
    if (/\t/.test(sourceLine)) {
      diagnostic(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Tabs are not supported in code-buddy.yaml.');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      diagnostic(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Indentation must use two-space mappings.');
      continue;
    }
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (!match) {
      diagnostic(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Only simple YAML mappings are supported.');
      continue;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (indent !== parent.indent + 2) {
      diagnostic(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Mappings must be nested by exactly two spaces.');
      continue;
    }
    const key = match[1];
    const keyPath = parent.path ? `${parent.path}.${key}` : key;
    if (Object.prototype.hasOwnProperty.call(parent.value, key)) {
      diagnostic(diagnostics, 'unsupported_syntax', keyPath, 'Duplicate keys are not supported.');
      continue;
    }
    const rawValue = match[2] ?? '';
    if (!rawValue) {
      const nested: PolicyMapping = {};
      parent.value[key] = nested;
      stack.push({ indent, value: nested, path: keyPath });
      continue;
    }
    const scalar = parseScalar(rawValue);
    if (scalar === undefined || /[\[\]{}&*!|>]/.test(rawValue)) {
      diagnostic(diagnostics, 'unsupported_syntax', keyPath, 'Only boolean and numeric scalar values are supported.');
      continue;
    }
    parent.value[key] = scalar;
  }
  return root;
}

function mapping(value: PolicyValue | undefined): PolicyMapping | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

function numberValue(
  value: PolicyValue | undefined,
  pathValue: string,
  diagnostics: ProjectPolicyDiagnostic[],
  minimum: number,
  maximum: number,
  integer = false
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    diagnostic(diagnostics, 'invalid_value', pathValue, `Expected a ${integer ? 'whole ' : ''}number from ${minimum} to ${maximum}.`);
    return undefined;
  }
  return value;
}

function booleanValue(
  value: PolicyValue | undefined,
  pathValue: string,
  diagnostics: ProjectPolicyDiagnostic[]
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    diagnostic(diagnostics, 'invalid_value', pathValue, 'Expected true or false.');
    return undefined;
  }
  return value;
}

function rejectUnknownKeys(
  value: PolicyMapping,
  allowed: readonly string[],
  pathValue: string,
  diagnostics: ProjectPolicyDiagnostic[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostic(diagnostics, 'unknown_key', pathValue ? `${pathValue}.${key}` : key, 'This key is not supported by code-buddy.yaml.');
    }
  }
}

export function loadProjectPolicy(workspacePath: string | undefined, legacyPolicy: CodeBuddyPolicy): ProjectPolicyLoad {
  const policy = clonePolicy(legacyPolicy);
  const diagnostics: ProjectPolicyDiagnostic[] = [];
  if (!workspacePath) {
    return { policy, diagnostics };
  }
  const filePath = path.join(workspacePath, 'code-buddy.yaml');
  if (!fs.existsSync(filePath)) {
    return { policy, diagnostics };
  }

  let parsed: PolicyMapping;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, 'utf8'), diagnostics);
  } catch (error) {
    diagnostic(diagnostics, 'invalid_value', 'code-buddy.yaml', error instanceof Error ? error.message : String(error));
    return { policy, diagnostics };
  }

  rejectUnknownKeys(parsed, ['version', 'healthCheck', 'thresholds'], '', diagnostics);
  const version = numberValue(parsed.version, 'version', diagnostics, 1, 1, true);
  if (parsed.version !== undefined && version !== 1) {
    diagnostic(diagnostics, 'invalid_value', 'version', 'Only policy version 1 is supported.');
  }

  const healthCheck = mapping(parsed.healthCheck);
  if (parsed.healthCheck !== undefined && !healthCheck) {
    diagnostic(diagnostics, 'invalid_value', 'healthCheck', 'Expected a mapping.');
  }
  if (healthCheck) {
    rejectUnknownKeys(healthCheck, ['showOnEveryMeaningfulCodingTask'], 'healthCheck', diagnostics);
    const visible = booleanValue(healthCheck.showOnEveryMeaningfulCodingTask, 'healthCheck.showOnEveryMeaningfulCodingTask', diagnostics);
    if (visible !== undefined) {
      policy.healthCheck.showOnEveryMeaningfulCodingTask = visible;
    }
  }

  const thresholds = mapping(parsed.thresholds);
  if (parsed.thresholds !== undefined && !thresholds) {
    diagnostic(diagnostics, 'invalid_value', 'thresholds', 'Expected a mapping.');
  }
  if (!thresholds) {
    return { policy, diagnostics };
  }
  rejectUnknownKeys(thresholds, ['promptQuality', 'taskScope', 'estimatedContextPressure', 'sessionFit'], 'thresholds', diagnostics);

  const promptQuality = mapping(thresholds.promptQuality);
  if (promptQuality) {
    rejectUnknownKeys(promptQuality, ['enhanceBelow'], 'thresholds.promptQuality', diagnostics);
    const value = numberValue(promptQuality.enhanceBelow, 'thresholds.promptQuality.enhanceBelow', diagnostics, 0, 100);
    if (value !== undefined) {
      policy.promptReview.interventionThreshold = value;
    }
  }

  const taskScope = mapping(thresholds.taskScope);
  if (taskScope) {
    rejectUnknownKeys(taskScope, ['decomposeAtOrAbove'], 'thresholds.taskScope', diagnostics);
    const value = numberValue(taskScope.decomposeAtOrAbove, 'thresholds.taskScope.decomposeAtOrAbove', diagnostics, 0, 100);
    if (value !== undefined) {
      policy.taskDecomposition.interventionThreshold = value;
    }
  }

  const context = mapping(thresholds.estimatedContextPressure);
  if (context) {
    rejectUnknownKeys(context, ['capacityTokens', 'warningAt', 'criticalAt'], 'thresholds.estimatedContextPressure', diagnostics);
    const capacity = numberValue(context.capacityTokens, 'thresholds.estimatedContextPressure.capacityTokens', diagnostics, 1000, Number.MAX_SAFE_INTEGER, true);
    if (capacity !== undefined) {
      policy.context.estimatedContextCapacityTokens = capacity;
    }
    const warning = numberValue(context.warningAt, 'thresholds.estimatedContextPressure.warningAt', diagnostics, 0, 1);
    if (warning !== undefined) {
      policy.context.warningThreshold = warning;
    }
    const critical = numberValue(context.criticalAt, 'thresholds.estimatedContextPressure.criticalAt', diagnostics, 0, 1);
    if (critical !== undefined) {
      if (critical < policy.context.warningThreshold) {
        diagnostic(diagnostics, 'invalid_value', 'thresholds.estimatedContextPressure.criticalAt', 'criticalAt must be greater than or equal to warningAt.');
      } else {
        policy.context.criticalThreshold = critical;
      }
    }
    if (policy.context.criticalThreshold < policy.context.warningThreshold) {
      policy.context.criticalThreshold = policy.context.warningThreshold;
    }
  }

  const sessionFit = mapping(thresholds.sessionFit);
  if (sessionFit) {
    rejectUnknownKeys(sessionFit, ['recommendFreshTaskAtOrAbove', 'fallbackLexicalOverlapBelow'], 'thresholds.sessionFit', diagnostics);
    const recommendation = numberValue(sessionFit.recommendFreshTaskAtOrAbove, 'thresholds.sessionFit.recommendFreshTaskAtOrAbove', diagnostics, 0, 100);
    if (recommendation !== undefined) {
      policy.sessionFit.recommendFreshTaskAtOrAbove = recommendation;
    }
    const overlap = numberValue(sessionFit.fallbackLexicalOverlapBelow, 'thresholds.sessionFit.fallbackLexicalOverlapBelow', diagnostics, 0, 1);
    if (overlap !== undefined) {
      policy.sessionFit.fallbackLexicalOverlapBelow = overlap;
    }
  }

  return { policy, diagnostics };
}
