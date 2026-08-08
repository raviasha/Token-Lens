const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const hookPath = path.join(__dirname, '..', 'hook.cjs');

function runHook(payload, environment = {}, existingDirectory = null) {
  const directory = existingDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-'));
  const logPath = environment.TOKEN_LENS_LOG_FILE || path.join(directory, 'session.jsonl');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_LENS_LOG_FILE: logPath,
      TOKEN_LENS_REDACT_SENSITIVE: 'true',
      TOKEN_LENS_CAPTURE_TRANSCRIPTS: 'true',
      ...environment
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const records = fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { directory, records };
}

test('writes structured events and redacts sensitive fields', () => {
  const { records } = runHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: '/workspace/project',
    prompt: 'Use apiKey=do-not-log and bearer abc123 to fix this'
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].schemaVersion, 2);
  assert.equal(records[0].recordType, 'user.prompt');
  assert.equal(records[0].sourceEventType, 'UserPromptSubmit');
  assert.equal(records[0].sessionId, 'session-1');
  assert.match(records[0].localTimestamp, /[+-]\d{2}:\d{2}$/);
  assert.match(records[0].recordedAt, /[+-]\d{2}:\d{2}$/);
  assert.match(records[0].data.prompt, /\[REDACTED\]/);
  assert.doesNotMatch(records[0].data.prompt, /do-not-log/);
});

test('captures a transcript snapshot on stop', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-transcript-'));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'session.start',
      data: { sessionId: 'session-2' },
      id: 'event-session-start',
      timestamp: '2026-08-08T00:00:00.000Z',
      parentId: null
    }),
    JSON.stringify({
      type: 'assistant.turn_start',
      data: { turnId: '0' },
      id: 'event-turn-start',
      timestamp: '2026-08-08T00:00:00.100Z',
      parentId: 'event-user'
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: { messageId: 'message-1', content: 'done', toolRequests: [] },
      id: 'event-assistant-message',
      timestamp: '2026-08-08T00:00:00.200Z',
      parentId: 'event-turn-start'
    }),
    JSON.stringify({
      type: 'assistant.turn_end',
      data: { turnId: '0' },
      id: 'event-turn-end',
      timestamp: '2026-08-08T00:00:00.300Z',
      parentId: 'event-assistant-message'
    })
  ].join('\n') + '\n', 'utf8');
  const { records } = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-2',
    timestamp: '2026-08-08T00:00:00.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  });

  assert.equal(records.length, 5);
  assert.equal(records[1].recordType, 'turn.started');
  assert.equal(records[2].recordType, 'assistant.message');
  assert.equal(records[2].data.content, 'done');
  assert.equal(records[3].recordType, 'turn.ended');
  assert.equal(records[4].recordType, 'transcript.snapshot');
  assert.equal(records[4].sessionId, 'session-2');
  assert.match(records[4].data.content, /assistant.message/);
});

test('does not duplicate transcript events across repeated stop hooks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-dedupe-'));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant.message',
    data: { messageId: 'message-1', content: 'one' },
    id: 'event-assistant-message',
    timestamp: '2026-08-08T00:00:00.200Z',
    parentId: null
  }) + '\n', 'utf8');

  const first = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-3',
    timestamp: '2026-08-08T00:00:01.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  });
  const second = runHook({
    hook_event_name: 'Stop',
    session_id: 'session-3',
    timestamp: '2026-08-08T00:00:02.000Z',
    cwd: directory,
    transcript_path: transcriptPath,
    stop_reason: 'end_turn'
  }, {}, directory);

  const allRecords = [...first.records, ...second.records];
  const assistantEventIds = new Set(
    allRecords
      .filter((record) => record.recordType === 'assistant.message')
      .map((record) => record.eventId)
  );
  assert.equal(assistantEventIds.size, 1);
});

test('continues without blocking when logging cannot be configured', () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
    env: { ...process.env, TOKEN_LENS_LOG_FILE: '' }
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /TOKEN_LENS_LOG_FILE/);
});
