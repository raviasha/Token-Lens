'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const path = require('node:path');

const sensitiveKeyPattern = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const secretPatterns = [
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]+/gi,
  /sk-[a-z0-9_-]+/gi,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
];

function shouldRedact() {
  return process.env.TOKEN_LENS_REDACT_SENSITIVE !== 'false';
}

function redactString(value) {
  if (!shouldRedact()) {
    return value;
  }

  let redacted = value;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

function redact(value, key) {
  if (!shouldRedact()) {
    return value;
  }

  if (key && sensitiveKeyPattern.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
  }
  return value;
}

function parseInput(input) {
  try {
    return JSON.parse(input);
  } catch {
    return { rawInput: input };
  }
}

function getEventName(payload) {
  if (payload && typeof payload.hook_event_name === 'string') {
    return payload.hook_event_name;
  }
  return 'unknown';
}

function getValue(payload, ...keys) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    if (payload[key] !== undefined) {
      return payload[key];
    }
  }
  return undefined;
}

function getSessionId(payload) {
  return payload && (payload.session_id || payload.sessionId) || null;
}

function getTimestamp(payload) {
  if (payload && typeof payload.timestamp === 'string') {
    return payload.timestamp;
  }
  if (payload && typeof payload.timestamp === 'number') {
    return new Date(payload.timestamp).toISOString();
  }
  return new Date().toISOString();
}

function getLocalTimestamp(value) {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (part, length = 2) => String(part).padStart(length, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${offset}`;
}

function getWorkspace(payload) {
  const workspace = getValue(payload, 'cwd');
  return typeof workspace === 'string' ? workspace : process.cwd();
}

function getTurnId(payload) {
  const turnId = getValue(payload, 'turn_id', 'turnId');
  return turnId === undefined || turnId === null ? null : String(turnId);
}

function createEventId(prefix, value) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function appendRecord(logPath, record) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeHookType(eventName) {
  const types = {
    SessionStart: 'session.started',
    sessionStart: 'session.started',
    SessionEnd: 'session.ended',
    sessionEnd: 'session.ended',
    UserPromptSubmit: 'user.prompt',
    userPromptSubmitted: 'user.prompt',
    UserPromptTransformed: 'prompt.transformed',
    userPromptTransformed: 'prompt.transformed',
    PreToolUse: 'tool.started',
    preToolUse: 'tool.started',
    PostToolUse: 'tool.completed',
    postToolUse: 'tool.completed',
    PostToolUseFailure: 'tool.failed',
    postToolUseFailure: 'tool.failed',
    Stop: 'agent.stopped',
    agentStop: 'agent.stopped',
    SubagentStart: 'subagent.started',
    subagentStart: 'subagent.started',
    SubagentStop: 'subagent.completed',
    subagentStop: 'subagent.completed',
    ErrorOccurred: 'error.occurred',
    errorOccurred: 'error.occurred',
    PreCompact: 'context.compacted',
    preCompact: 'context.compacted'
  };
  return types[eventName] || 'hook.event';
}

function normalizeHookData(eventName, payload) {
  const toolName = getValue(payload, 'tool_name', 'toolName');
  const toolInput = getValue(payload, 'tool_input', 'toolArgs');
  const toolResult = getValue(payload, 'tool_result', 'toolResult');
  const transcriptPath = getValue(payload, 'transcript_path', 'transcriptPath');

  switch (eventName) {
    case 'SessionStart':
    case 'sessionStart':
      return redact({
        source: getValue(payload, 'source'),
        initialPrompt: getValue(payload, 'initial_prompt', 'initialPrompt'),
        model: getValue(payload, 'model'),
        copilotVersion: getValue(payload, 'copilot_version', 'copilotVersion'),
        vscodeVersion: getValue(payload, 'vscode_version', 'vscodeVersion'),
        transcriptPath
      });
    case 'SessionEnd':
    case 'sessionEnd':
      return redact({ reason: getValue(payload, 'reason') });
    case 'UserPromptSubmit':
    case 'userPromptSubmitted':
      return redact({ prompt: getValue(payload, 'prompt') });
    case 'UserPromptTransformed':
    case 'userPromptTransformed':
      return redact({
        prompt: getValue(payload, 'prompt'),
        transformedPrompt: getValue(payload, 'transformedPrompt', 'transformed_prompt')
      });
    case 'PreToolUse':
    case 'preToolUse':
      return redact({ toolName, toolInput });
    case 'PostToolUse':
    case 'postToolUse':
      return redact({ toolName, toolInput, toolResult });
    case 'PostToolUseFailure':
    case 'postToolUseFailure':
      return redact({
        toolName,
        toolInput,
        error: getValue(payload, 'error')
      });
    case 'Stop':
    case 'agentStop':
      return redact({
        transcriptPath,
        stopReason: getValue(payload, 'stop_reason', 'stopReason'),
        stopHookActive: getValue(payload, 'stop_hook_active', 'stopHookActive')
      });
    case 'SubagentStart':
    case 'subagentStart':
      return redact({
        transcriptPath,
        agentId: getValue(payload, 'agent_id', 'agentId'),
        agentName: getValue(payload, 'agent_name', 'agentName'),
        agentType: getValue(payload, 'agent_type', 'agentType'),
        agentDisplayName: getValue(payload, 'agent_display_name', 'agentDisplayName')
      });
    case 'SubagentStop':
    case 'subagentStop':
      return redact({
        transcriptPath,
        agentId: getValue(payload, 'agent_id', 'agentId'),
        agentName: getValue(payload, 'agent_name', 'agentName'),
        response: getValue(payload, 'last_assistant_message', 'response'),
        stopReason: getValue(payload, 'stop_reason', 'stopReason')
      });
    case 'ErrorOccurred':
    case 'errorOccurred':
      return redact({
        error: getValue(payload, 'error'),
        errorContext: getValue(payload, 'error_context', 'errorContext'),
        recoverable: getValue(payload, 'recoverable')
      });
    case 'PreCompact':
    case 'preCompact':
      return redact({
        transcriptPath,
        trigger: getValue(payload, 'trigger'),
        customInstructions: getValue(payload, 'custom_instructions', 'customInstructions')
      });
    default:
      return redact(payload);
  }
}

function appendHookRecord(logPath, payload, eventName, sessionId) {
  const workspace = getWorkspace(payload);
  const eventId = createEventId('hook', { eventName, payload });
  appendRecord(logPath, {
    schemaVersion: 2,
    eventId,
    recordType: normalizeHookType(eventName),
    source: 'hook',
    sourceEventType: eventName,
    sessionId,
    turnId: getTurnId(payload),
    parentId: getValue(payload, 'parent_id', 'parentId') || null,
    timestamp: getTimestamp(payload),
    localTimestamp: getLocalTimestamp(getTimestamp(payload)),
    recordedAt: getLocalTimestamp(),
    workspace,
    model: getValue(payload, 'model') || null,
    data: normalizeHookData(eventName, payload),
    rawPayload: redact(payload)
  });
  return eventId;
}

function getTranscriptPath(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  return payload.transcript_path || payload.transcriptPath || null;
}

function normalizeTranscriptType(eventType) {
  const types = {
    'assistant.turn_start': 'turn.started',
    'assistant.message': 'assistant.message',
    'assistant.turn_end': 'turn.ended'
  };
  return types[eventType] || 'transcript.event';
}

function getTranscriptStatePath(logPath, sessionId) {
  const stateDirectory = process.env.TOKEN_LENS_STATE_DIR || path.join(path.dirname(logPath), '.state');
  const safeSessionId = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(stateDirectory, `${safeSessionId}.json`);
}

function loadTranscriptState(logPath, sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(getTranscriptStatePath(logPath, sessionId), 'utf8'));
    return new Set(Array.isArray(state.seenEventIds) ? state.seenEventIds : []);
  } catch {
    return new Set();
  }
}

function saveTranscriptState(logPath, sessionId, seenEventIds) {
  const statePath = getTranscriptStatePath(logPath, sessionId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ sessionId, seenEventIds: [...seenEventIds] }), {
    encoding: 'utf8',
    mode: 0o600
  });
}

function appendTranscriptRecord(logPath, payload, sessionId, transcriptPath, transcriptEvent) {
  const eventType = typeof transcriptEvent.type === 'string' ? transcriptEvent.type : 'unknown';
  const sourceEventId = typeof transcriptEvent.id === 'string' && transcriptEvent.id
    ? transcriptEvent.id
    : createEventId('line', transcriptEvent);
  const eventData = transcriptEvent.data === undefined ? transcriptEvent : transcriptEvent.data;
  const turnId = eventData && typeof eventData === 'object'
    ? (eventData.turnId ?? eventData.turn_id ?? null)
    : null;

  appendRecord(logPath, {
    schemaVersion: 2,
    eventId: `transcript_${sessionId || 'unknown'}_${sourceEventId}`,
    recordType: normalizeTranscriptType(eventType),
    source: 'transcript',
    sourceEventType: eventType,
    sourceEventId,
    sessionId,
    turnId: turnId === null ? null : String(turnId),
    parentId: transcriptEvent.parentId || null,
    timestamp: typeof transcriptEvent.timestamp === 'string' ? transcriptEvent.timestamp : null,
    localTimestamp: getLocalTimestamp(typeof transcriptEvent.timestamp === 'string' ? transcriptEvent.timestamp : null),
    recordedAt: getLocalTimestamp(),
    workspace: getWorkspace(payload),
    model: getValue(payload, 'model') || null,
    transcriptPath,
    data: redact(eventData),
    rawPayload: redact(transcriptEvent)
  });
}

function appendTranscriptParseError(logPath, payload, sessionId, transcriptPath, lineNumber, line) {
  appendRecord(logPath, {
    schemaVersion: 2,
    eventId: createEventId('transcript_parse_error', { sessionId, transcriptPath, lineNumber, line }),
    recordType: 'transcript.parse_error',
    source: 'transcript',
    sourceEventType: 'parse_error',
    sessionId,
    turnId: null,
    parentId: null,
    timestamp: null,
    localTimestamp: null,
    recordedAt: getLocalTimestamp(),
    workspace: getWorkspace(payload),
    transcriptPath,
    data: redact({ lineNumber, line })
  });
}

function captureTranscript(logPath, payload, eventName, sessionId) {
  if (process.env.TOKEN_LENS_CAPTURE_TRANSCRIPTS === 'false') {
    return;
  }

  const transcriptPath = getTranscriptPath(payload);
  if (!transcriptPath || !path.isAbsolute(transcriptPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const seenEventIds = loadTranscriptState(logPath, sessionId);
    const transcriptLines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    transcriptLines.forEach((line, index) => {
      let transcriptEvent;
      try {
        transcriptEvent = JSON.parse(line);
      } catch {
        appendTranscriptParseError(logPath, payload, sessionId, transcriptPath, index + 1, line);
        return;
      }

      const sourceEventId = typeof transcriptEvent.id === 'string' && transcriptEvent.id
        ? transcriptEvent.id
        : createEventId('line', transcriptEvent);
      if (seenEventIds.has(sourceEventId)) {
        return;
      }
      seenEventIds.add(sourceEventId);
      if (transcriptEvent.type !== 'session.start') {
        appendTranscriptRecord(logPath, payload, sessionId, transcriptPath, transcriptEvent);
      }
    });

    saveTranscriptState(logPath, sessionId, seenEventIds);
    appendRecord(logPath, {
      schemaVersion: 2,
      eventId: createEventId('snapshot', { sessionId, eventName, content }),
      recordType: 'transcript.snapshot',
      source: 'transcript',
      sourceEventType: eventName,
      sessionId,
      turnId: null,
      parentId: null,
      timestamp: getTimestamp(payload),
      localTimestamp: getLocalTimestamp(getTimestamp(payload)),
      recordedAt: getLocalTimestamp(),
      workspace: getWorkspace(payload),
      transcriptPath,
      data: {
        contentHash: crypto.createHash('sha256').update(content).digest('hex'),
        content: redactString(content)
      }
    });
  } catch (error) {
    appendRecord(logPath, {
      schemaVersion: 2,
      eventId: createEventId('snapshot_error', { sessionId, eventName, transcriptPath }),
      recordType: 'transcript.snapshot_error',
      source: 'transcript',
      sourceEventType: eventName,
      sessionId,
      turnId: null,
      parentId: null,
      timestamp: getTimestamp(payload),
      localTimestamp: getLocalTimestamp(getTimestamp(payload)),
      recordedAt: getLocalTimestamp(),
      workspace: getWorkspace(payload),
      transcriptPath,
      data: {
        error: redactString(error instanceof Error ? error.message : String(error))
      }
    });
  }
}

function runCodeBuddy(action, payload, sessionId, eventId) {
  const scriptPath = process.env.TOKEN_LENS_ANALYTICS_SCRIPT;
  if (!scriptPath) {
    return;
  }

  const configuredCommand = process.env.TOKEN_LENS_PYTHON_COMMAND;
  const candidates = configuredCommand
    ? [{ command: configuredCommand, args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  const environment = {
    ...process.env,
    TOKEN_LENS_ANALYTICS_ACTION: action,
    TOKEN_LENS_SESSION_ID: sessionId || 'unknown',
    TOKEN_LENS_EVENT_ID: eventId || '',
    TOKEN_LENS_WORKSPACE: getWorkspace(payload)
  };

  for (const candidate of candidates) {
    const result = childProcess.spawnSync(
      candidate.command,
      [...candidate.args, scriptPath],
      {
        cwd: getWorkspace(payload),
        env: environment,
        stdio: 'ignore',
        timeout: 8000,
        windowsHide: true
      }
    );
    if (result.error && result.error.code === 'ENOENT') {
      continue;
    }
    if (result.error) {
      process.stderr.write(`Code Buddy analytics warning: ${result.error.message}\n`);
    } else if (result.status !== 0) {
      process.stderr.write(`Code Buddy analytics warning: process exited with status ${result.status}\n`);
    }
    return;
  }

  process.stderr.write('Code Buddy analytics warning: Python was not found; session logging continues without analytics.\n');
}

function main(input) {
  const payload = parseInput(input);
  const event = getEventName(payload);
  const sessionId = getSessionId(payload);
  const logPath = process.env.TOKEN_LENS_LOG_FILE;

  if (!logPath) {
    throw new Error('TOKEN_LENS_LOG_FILE is not configured.');
  }

  const eventId = appendHookRecord(logPath, payload, event, sessionId);

  if (event === 'UserPromptSubmit' || event === 'userPromptSubmitted') {
    runCodeBuddy('start_turn', payload, sessionId, eventId);
  }

  if (event === 'Stop' || event === 'agentStop') {
    captureTranscript(logPath, payload, event, sessionId);
    runCodeBuddy('end_turn', payload, sessionId, eventId);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    main(input);
  } catch (error) {
    process.stderr.write(`Code Buddy hook error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
