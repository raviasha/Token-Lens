'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY = Object.freeze({
  healthCheck: { showOnEveryMeaningfulCodingTask: true },
  thresholds: {
    promptQuality: { enhanceBelow: 75 },
    taskScope: { decomposeAtOrAbove: 65 },
    estimatedContextPressure: { capacityTokens: 40000, warningAt: 0.70, criticalAt: 0.85 },
    sessionFit: { recommendFreshTaskAtOrAbove: 75, fallbackLexicalOverlapBelow: 0.20 }
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function add(diagnostics, code, pathValue, message) {
  diagnostics.push({ code, path: pathValue, message });
}

function scalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) return Number(value);
  return undefined;
}

function parse(contents, diagnostics) {
  const root = {};
  const stack = [{ indent: -2, value: root, path: '' }];
  for (const [index, source] of contents.split(/\r?\n/).entries()) {
    const withoutComment = source.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!withoutComment.trim()) continue;
    if (/\t/.test(source)) {
      add(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Tabs are not supported in code-buddy.yaml.');
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    const match = withoutComment.trim().match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (indent % 2 || !match) {
      add(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Only two-space simple mappings are supported.');
      continue;
    }
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1);
    if (indent !== parent.indent + 2) {
      add(diagnostics, 'unsupported_syntax', `line.${index + 1}`, 'Mappings must be nested by exactly two spaces.');
      continue;
    }
    const key = match[1];
    const keyPath = parent.path ? `${parent.path}.${key}` : key;
    if (Object.hasOwn(parent.value, key)) {
      add(diagnostics, 'unsupported_syntax', keyPath, 'Duplicate keys are not supported.');
      continue;
    }
    const raw = match[2] || '';
    if (!raw) {
      parent.value[key] = {};
      stack.push({ indent, value: parent.value[key], path: keyPath });
      continue;
    }
    const value = scalar(raw);
    if (value === undefined || /[\[\]{}&*!|>]/.test(raw)) {
      add(diagnostics, 'unsupported_syntax', keyPath, 'Only boolean and numeric scalar values are supported.');
      continue;
    }
    parent.value[key] = value;
  }
  return root;
}

function mapping(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function unknown(value, allowed, prefix, diagnostics) {
  if (!value) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(diagnostics, 'unknown_key', prefix ? `${prefix}.${key}` : key, 'This key is not supported by code-buddy.yaml.');
  }
}

function number(value, fallback, key, diagnostics, minimum, maximum, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    add(diagnostics, 'invalid_value', key, `Expected a ${integer ? 'whole ' : ''}number from ${minimum} to ${maximum}.`);
    return fallback;
  }
  return value;
}

function loadProjectPolicy(workspace) {
  const policy = clone(DEFAULT_POLICY);
  const diagnostics = [];
  const filePath = path.join(String(workspace || ''), 'code-buddy.yaml');
  if (!workspace || !fs.existsSync(filePath)) return { policy, diagnostics };
  let parsed;
  try {
    parsed = parse(fs.readFileSync(filePath, 'utf8'), diagnostics);
  } catch (error) {
    add(diagnostics, 'invalid_value', 'code-buddy.yaml', String(error.message || error));
    return { policy, diagnostics };
  }
  unknown(parsed, ['version', 'healthCheck', 'thresholds'], '', diagnostics);
  if (parsed.version !== undefined && parsed.version !== 1) add(diagnostics, 'invalid_value', 'version', 'Only policy version 1 is supported.');
  const health = mapping(parsed.healthCheck);
  if (health) {
    unknown(health, ['showOnEveryMeaningfulCodingTask'], 'healthCheck', diagnostics);
    if (health.showOnEveryMeaningfulCodingTask !== undefined) {
      if (typeof health.showOnEveryMeaningfulCodingTask !== 'boolean') add(diagnostics, 'invalid_value', 'healthCheck.showOnEveryMeaningfulCodingTask', 'Expected true or false.');
      else policy.healthCheck.showOnEveryMeaningfulCodingTask = health.showOnEveryMeaningfulCodingTask;
    }
  }
  const thresholds = mapping(parsed.thresholds);
  if (!thresholds) return { policy, diagnostics };
  unknown(thresholds, ['promptQuality', 'taskScope', 'estimatedContextPressure', 'sessionFit'], 'thresholds', diagnostics);
  const prompt = mapping(thresholds.promptQuality);
  if (prompt) policy.thresholds.promptQuality.enhanceBelow = number(prompt.enhanceBelow, policy.thresholds.promptQuality.enhanceBelow, 'thresholds.promptQuality.enhanceBelow', diagnostics, 0, 100);
  const scope = mapping(thresholds.taskScope);
  if (scope) policy.thresholds.taskScope.decomposeAtOrAbove = number(scope.decomposeAtOrAbove, policy.thresholds.taskScope.decomposeAtOrAbove, 'thresholds.taskScope.decomposeAtOrAbove', diagnostics, 0, 100);
  const context = mapping(thresholds.estimatedContextPressure);
  if (context) {
    policy.thresholds.estimatedContextPressure.capacityTokens = number(context.capacityTokens, policy.thresholds.estimatedContextPressure.capacityTokens, 'thresholds.estimatedContextPressure.capacityTokens', diagnostics, 1000, Number.MAX_SAFE_INTEGER, true);
    policy.thresholds.estimatedContextPressure.warningAt = number(context.warningAt, policy.thresholds.estimatedContextPressure.warningAt, 'thresholds.estimatedContextPressure.warningAt', diagnostics, 0, 1);
    const critical = number(context.criticalAt, policy.thresholds.estimatedContextPressure.criticalAt, 'thresholds.estimatedContextPressure.criticalAt', diagnostics, 0, 1);
    if (critical < policy.thresholds.estimatedContextPressure.warningAt) add(diagnostics, 'invalid_value', 'thresholds.estimatedContextPressure.criticalAt', 'criticalAt must be greater than or equal to warningAt.');
    else policy.thresholds.estimatedContextPressure.criticalAt = critical;
  }
  const fit = mapping(thresholds.sessionFit);
  if (fit) {
    policy.thresholds.sessionFit.recommendFreshTaskAtOrAbove = number(fit.recommendFreshTaskAtOrAbove, policy.thresholds.sessionFit.recommendFreshTaskAtOrAbove, 'thresholds.sessionFit.recommendFreshTaskAtOrAbove', diagnostics, 0, 100);
    policy.thresholds.sessionFit.fallbackLexicalOverlapBelow = number(fit.fallbackLexicalOverlapBelow, policy.thresholds.sessionFit.fallbackLexicalOverlapBelow, 'thresholds.sessionFit.fallbackLexicalOverlapBelow', diagnostics, 0, 1);
  }
  return { policy, diagnostics };
}

module.exports = { DEFAULT_POLICY, loadProjectPolicy };

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(loadProjectPolicy(process.argv[2]))}\n`);
}
