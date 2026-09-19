const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const informationChoices = [];
let nextInformationChoice = 'Carry forward curated context';
const vscodeMock = {
  window: {
    showInformationMessage: async (...args) => {
      informationChoices.push(args);
      return nextInformationChoice;
    },
    showWarningMessage: async () => 'Continue unchanged'
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, parent, isMain);
};
const { DeterministicGovernance } = require('../dist/runtime/governance.js');
const { DEFAULT_POLICY } = require('../dist/core/policyEngine.js');
Module._load = originalLoad;

async function writeSessionLog(records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-buddy-governance-'));
  const logPath = path.join(directory, 'copilot-session.jsonl');
  await fs.writeFile(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return logPath;
}

test('a new session offers prior-context carry-forward for the first meaningful prompt', async () => {
  informationChoices.length = 0;
  nextInformationChoice = 'Carry forward curated context';
  const logPath = await writeSessionLog([
    {
      schemaVersion: 2,
      eventId: 'prior-prompt',
      recordType: 'user.prompt',
      sessionId: 'session-1',
      timestamp: '2026-08-11T00:00:00Z',
      data: { prompt: 'Implement authentication token refresh handling.' }
    },
    {
      schemaVersion: 2,
      eventId: 'new-session-prompt',
      recordType: 'user.prompt',
      sessionId: 'session-2',
      timestamp: '2026-08-11T00:01:00Z',
      data: { prompt: 'Continue authentication token refresh handling and add expiry tests.' }
    }
  ]);
  const events = [];
  const curationCalls = [];
  const governance = new DeterministicGovernance({
    policy: DEFAULT_POLICY,
    currentLogPath: () => logPath,
    appendEvent: async (event) => events.push(event),
    workflow: {
      curate: async (...args) => {
        curationCalls.push(args);
        return true;
      },
      measureContext: async () => {
        throw new Error('New-session curation should suppress a simultaneous context warning.');
      }
    }
  });

  await governance.process();
  await governance.process();

  assert.equal(informationChoices.length, 1);
  assert.match(informationChoices[0][0], /New Copilot session detected/);
  assert.deepEqual(curationCalls, [[
    'Continue authentication token refresh handling and add expiry tests.',
    'fresh_task',
    'current_chat'
  ]]);
  assert.deepEqual(events.map((event) => event.eventType), [
    'session.boundary_detected',
    'session.boundary_choice'
  ]);
  assert.equal(events[0].data.previousSessionId, 'session-1');
  assert.equal(events[0].data.currentSessionId, 'session-2');
  assert.equal(events[1].data.selectedAction, 'Carry forward curated context');
});

test('a completed semantic session-fit result offers a developer-controlled fresh-task choice', async () => {
  informationChoices.length = 0;
  nextInformationChoice = 'Curate for a fresh chat';
  const logPath = await writeSessionLog([
    {
      schemaVersion: 2,
      eventId: 'prior-prompt',
      recordType: 'user.prompt',
      sessionId: 'session-1',
      timestamp: '2026-08-11T00:00:00Z',
      data: { prompt: 'Implement authentication token refresh handling.' }
    },
    {
      schemaVersion: 2,
      eventId: 'current-prompt',
      recordType: 'user.prompt',
      sessionId: 'session-1',
      timestamp: '2026-08-11T00:01:00Z',
      data: { prompt: 'Add an authentication export endpoint.' }
    },
    {
      schemaVersion: 2,
      eventId: 'session-fit',
      recordType: 'tool.completed',
      sessionId: 'session-1',
      timestamp: '2026-08-11T00:01:01Z',
      data: {
        toolName: 'code-buddy_assessSessionFit',
        toolResult: { status: 'ok', newTaskLikelihood: 82, confidence: 'high', freshTaskRecommended: true, reason: 'Separate export subsystem.' }
      }
    }
  ]);
  const events = [];
  const curationCalls = [];
  const governance = new DeterministicGovernance({
    policy: DEFAULT_POLICY,
    currentLogPath: () => logPath,
    appendEvent: async (event) => events.push(event),
    workflow: {
      curate: async (...args) => {
        curationCalls.push(args);
        return true;
      },
      measureContext: async () => {
        throw new Error('The fresh-task choice should suppress a simultaneous context warning.');
      }
    }
  });

  await governance.process();

  assert.equal(informationChoices.length, 1);
  assert.match(informationChoices[0][0], /new task/i);
  assert.deepEqual(curationCalls, [[
    'Add an authentication export endpoint.',
    'fresh_task'
  ]]);
  const evaluation = events.find((event) => event.eventType === 'task.boundary_evaluated');
  assert.equal(evaluation.data.assessmentSource, 'session_fit');
  assert.equal(evaluation.data.newTaskLikelihood, 82);
});
