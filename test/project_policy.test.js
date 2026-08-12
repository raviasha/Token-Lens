const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtures = require('./fixtures/code-buddy-policy-fixtures.json');
const { DEFAULT_POLICY, classifyContext, shouldRecommendFreshTask } = require('../dist/core/policyEngine.js');
const { loadProjectPolicy } = require('../dist/core/projectPolicy.js');

function workspaceWithPolicy(contents) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-policy-'));
  fs.writeFileSync(path.join(workspace, 'code-buddy.yaml'), contents, 'utf8');
  return workspace;
}

test('project policy overrides only documented YAML values over the legacy policy', () => {
  const workspace = workspaceWithPolicy(fixtures.validOverride);
  const legacyPolicy = {
    ...DEFAULT_POLICY,
    promptReview: { ...DEFAULT_POLICY.promptReview, interventionThreshold: 80 },
    context: { ...DEFAULT_POLICY.context, warningThreshold: 0.60 }
  };

  const result = loadProjectPolicy(workspace, legacyPolicy);

  assert.equal(result.policy.promptReview.interventionThreshold, 90);
  assert.equal(result.policy.context.warningThreshold, 0.50);
  assert.equal(result.policy.context.criticalThreshold, DEFAULT_POLICY.context.criticalThreshold);
  assert.equal(result.diagnostics.length, 0);
});

test('project policy retains valid sibling values and diagnoses invalid threshold relationships', () => {
  const workspace = workspaceWithPolicy(fixtures.invalidRelationship);
  const result = loadProjectPolicy(workspace, DEFAULT_POLICY);

  assert.equal(result.policy.context.warningThreshold, 0.70);
  assert.equal(result.policy.context.criticalThreshold, DEFAULT_POLICY.context.criticalThreshold);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === 'thresholds.estimatedContextPressure.criticalAt'));
});

test('project policy rejects unsupported YAML syntax without throwing', () => {
  const workspace = workspaceWithPolicy(fixtures.unsupportedSyntax);
  const result = loadProjectPolicy(workspace, DEFAULT_POLICY);

  assert.equal(result.policy.promptReview.interventionThreshold, DEFAULT_POLICY.promptReview.interventionThreshold);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_syntax'));
});

test('shared threshold helpers use their documented inclusive boundaries', () => {
  assert.equal(shouldRecommendFreshTask(75, DEFAULT_POLICY), true);
  assert.equal(shouldRecommendFreshTask(74, DEFAULT_POLICY), false);
  assert.equal(classifyContext(0.70, DEFAULT_POLICY), 'warning');
});
