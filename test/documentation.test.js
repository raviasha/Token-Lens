const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const documentation = [
  path.join(root, 'README.md'),
  path.join(root, 'codex-plugin', 'README.md'),
  path.join(root, 'codex-plugin', 'plugins', 'code-buddy', 'README.md')
];

test('all installation guides document the shared Code Buddy health policy', () => {
  for (const filePath of documentation) {
    const contents = fs.readFileSync(filePath, 'utf8');
    assert.match(contents, /code-buddy\.yaml/);
    assert.match(contents, /enhanceBelow: 75/);
    assert.match(contents, /decomposeAtOrAbove: 65/);
    assert.match(contents, /capacityTokens: 40000/);
    assert.match(contents, /warningAt: 0\.70/);
    assert.match(contents, /criticalAt: 0\.85/);
    assert.match(contents, /recommendFreshTaskAtOrAbove: 75/);
    assert.match(contents, /estimated context pressure/i);
    assert.match(contents, /continue unchanged/i);
  }
});
