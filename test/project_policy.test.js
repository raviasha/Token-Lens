const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtures = require('./fixtures/code-buddy-policy-fixtures.json');
const { DEFAULT_POLICY, classifyContext, shouldRecommendFreshTask } = require('../dist/core/policyEngine.js');
const {
  createProjectPolicyFile,
  DEFAULT_PROJECT_POLICY_YAML,
  loadProjectPolicy
} = require('../dist/core/projectPolicy.js');

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
  assert.equal(result.policy.context.pauseThreshold, 0.75);
  assert.deepEqual(result.policy.measurement.humanRetries, {
    minimumComparableTasks: 6,
    minimumTasksPerFactor: 4,
    reliabilityThreshold: 0.55,
    minimumEffectSize: 0.1,
    overdispersionThreshold: 1.25
  });
  assert.equal(result.diagnostics.length, 0);
});

test('project policy retains valid sibling values and diagnoses invalid threshold relationships', () => {
  const workspace = workspaceWithPolicy(fixtures.invalidRelationship);
  const result = loadProjectPolicy(workspace, DEFAULT_POLICY);

  assert.equal(result.policy.context.warningThreshold, 0.60);
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
  assert.equal(classifyContext(0.55, DEFAULT_POLICY), 'warning');
  assert.equal(classifyContext(0.65, DEFAULT_POLICY), 'critical');
});

test('project policy diagnoses a pause threshold below the curation threshold', () => {
  const workspace = workspaceWithPolicy(fixtures.invalidPauseRelationship);
  const result = loadProjectPolicy(workspace, DEFAULT_POLICY);

  assert.equal(result.policy.context.pauseThreshold, DEFAULT_POLICY.context.pauseThreshold);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === 'thresholds.estimatedContextPressure.pauseAt'));
});

test('project policy creator writes the documented defaults and never overwrites personalization', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-buddy-policy-create-'));
  const first = createProjectPolicyFile(workspace);

  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(first.filePath, 'utf8'), DEFAULT_PROJECT_POLICY_YAML);
  const loaded = loadProjectPolicy(workspace, DEFAULT_POLICY);
  assert.deepEqual(loaded.policy, DEFAULT_POLICY);
  assert.deepEqual(loaded.diagnostics, []);

  const personalized = DEFAULT_PROJECT_POLICY_YAML.replace('warningAt: 0.55', 'warningAt: 0.50');
  fs.writeFileSync(first.filePath, personalized, 'utf8');
  const second = createProjectPolicyFile(workspace);
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(second.filePath, 'utf8'), personalized);
});
