'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const path = require('node:path');
const { loadProjectPolicy } = require('../scripts/project_policy.cjs');
const { captureHookEvent, getPersonalizedRecommendation } = require('../scripts/telemetry.cjs');

const sensitiveKeyPattern = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const secretPatterns = [
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]+/gi,
  /sk-[a-z0-9_-]+/gi,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
];
const contextEstimateCharactersPerToken = 4;
const preflightStateSchemaVersion = 1;
const pendingHandoffSchemaVersion = 1;
const promptReviewerToolNames = new Set([
  'code-buddy_reviewprompt',
  'codebuddypromptreviewer',
  'mcp__code_buddy__review_prompt',
  'mcp__code_buddy__reviewprompt'
]);
const taskDecomposerToolNames = new Set([
  'code-buddy_decomposetask',
  'codebuddytaskdecomposer',
  'mcp__code_buddy__decompose_task',
  'mcp__code_buddy__decomposetask'
]);
const contextMeasurementToolNames = new Set([
  'code-buddy_measurecontext',
  'codebuddycontextmeasurement',
  'mcp__code_buddy__measure_context',
  'mcp__code_buddy__measurecontext'
]);
const sessionFitToolNames = new Set([
  'code-buddy_assesssessionfit',
  'codebuddysessionfit',
  'mcp__code_buddy__assess_session_fit',
  'mcp__code_buddy__assesssessionfit'
]);
const codeBuddyToolPattern = /^(?:code-buddy_|codebuddy|mcp__code_buddy__)/i;
const observationalToolPattern = /^(?:ask(?:_|-)?questions?|fetch|find|file_search|grep|grep_search|get|hover|list|open|read|resolve|search|screenshot|semantic_search|terminal_last_command|terminal_selection|tool_search)(?:$|_|-)/i;

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value !== 'false' && value !== '0';
}

function envInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

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

function captureTelemetry(payload, options) {
  let thresholds = null;
  if (/^(?:PostToolUse|postToolUse|PostToolUseFailure|postToolUseFailure)$/.test(getEventName(payload))) {
    try {
      const policy = loadProjectPolicy(getWorkspace(payload)).policy;
      thresholds = {
        prompt_quality: policy.thresholds.promptQuality.enhanceBelow,
        task_decomposition: policy.thresholds.taskScope.decomposeAtOrAbove,
        context_pressure: policy.thresholds.estimatedContextPressure.warningAt,
        session_fit: policy.thresholds.sessionFit.recommendFreshTaskAtOrAbove
      };
    } catch {
      thresholds = null;
    }
  }
  const result = captureHookEvent(payload, { ...options, thresholds });
  if (!result.captured && result.reason === 'telemetry_failure') {
    process.stderr.write(`Code Buddy telemetry warning: ${result.error || 'capture failed safely'}\n`);
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

function getLogPath(payload) {
  const configured = process.env.TOKEN_LENS_LOG_FILE;
  return configured || path.join(getWorkspace(payload), '.code-buddy', 'codex-session.jsonl');
}

function getInterventionLogPath(logPath) {
  return process.env.TOKEN_LENS_INTERVENTION_LOG_FILE || path.join(path.dirname(logPath), 'interventions.jsonl');
}

function getAnalyticsScriptPath() {
  if (process.env.TOKEN_LENS_ANALYTICS_SCRIPT) {
    return process.env.TOKEN_LENS_ANALYTICS_SCRIPT;
  }
  if (process.env.PLUGIN_ROOT) {
    return path.join(process.env.PLUGIN_ROOT, 'scripts', 'code_buddy.py');
  }
  return null;
}

function getTurnId(payload) {
  const turnId = getValue(payload, 'turn_id', 'turnId');
  return turnId === undefined || turnId === null ? null : String(turnId);
}

function textCharacterCount(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === 'string') {
    return Array.from(value).length;
  }
  try {
    return textCharacterCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function createContextMetrics(componentValues, options = {}) {
  const components = Object.fromEntries(
    Object.entries(componentValues)
      .map(([name, value]) => [name, textCharacterCount(value)])
      .filter(([, count]) => count > 0)
  );
  const observedChars = options.observedValue === undefined
    ? Object.values(components).reduce((total, count) => total + count, 0)
    : textCharacterCount(options.observedValue);
  const modelFacingChars = options.modelFacingValue === undefined
    ? observedChars
    : textCharacterCount(options.modelFacingValue);

  if (!observedChars && !modelFacingChars) {
    return null;
  }

  return {
    measurement: 'observed_text_estimate',
    tokenEstimateMethod: 'characters_div_4',
    role: options.role || 'unknown_text',
    observedChars,
    estimatedTokens: Math.ceil(observedChars / contextEstimateCharactersPerToken),
    modelFacingChars,
    modelFacingTokensEstimate: Math.ceil(modelFacingChars / contextEstimateCharactersPerToken),
    components
  };
}

function getUsageNumber(value, keys) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeProviderUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const usage = {};
  const inputTokens = getUsageNumber(value, [
    'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'promptTokenCount', 'prompt_token_count'
  ]);
  const outputTokens = getUsageNumber(value, [
    'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidatesTokenCount', 'candidates_token_count'
  ]);
  const cachedInputTokens = getUsageNumber(value, [
    'cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cachedTokens', 'cached_tokens'
  ]);
  const cacheWriteTokens = getUsageNumber(value, [
    'cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'
  ]);
  const totalTokens = getUsageNumber(value, ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count']);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length ? usage : null;
}

function findProviderUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) {
    return null;
  }
  const directUsage = normalizeProviderUsage(value);
  if (directUsage) {
    return directUsage;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/(usage|token|metric)/i.test(key) || !child || typeof child !== 'object') {
      continue;
    }
    const nestedUsage = findProviderUsage(child, depth + 1);
    if (nestedUsage) {
      return nestedUsage;
    }
  }
  return null;
}

function hookContextMetrics(eventName, payload) {
  const prompt = getValue(payload, 'prompt');
  const transformedPrompt = getValue(payload, 'transformedPrompt', 'transformed_prompt');
  const toolInput = getValue(payload, 'tool_input', 'toolArgs');
  const toolResult = getValue(payload, 'tool_response', 'tool_result', 'toolResult');
  const error = getValue(payload, 'error');

  switch (eventName) {
    case 'SessionStart':
    case 'sessionStart':
      return createContextMetrics({ initialPrompt: getValue(payload, 'initial_prompt', 'initialPrompt') }, {
        role: 'session_prompt',
        modelFacingValue: getValue(payload, 'initial_prompt', 'initialPrompt')
      });
    case 'UserPromptSubmit':
    case 'userPromptSubmitted':
      return createContextMetrics({ prompt }, { role: 'user_prompt', modelFacingValue: prompt });
    case 'UserPromptTransformed':
    case 'userPromptTransformed':
      return createContextMetrics({ prompt, transformedPrompt }, {
        role: 'model_facing_prompt',
        observedValue: transformedPrompt || prompt,
        modelFacingValue: transformedPrompt || prompt
      });
    case 'PreToolUse':
    case 'preToolUse':
      return createContextMetrics({ toolInput }, { role: 'tool_request' });
    case 'PostToolUse':
    case 'postToolUse':
      return createContextMetrics({ toolInput, toolResult }, {
        role: 'tool_result',
        modelFacingValue: toolResult
      });
    case 'PostToolUseFailure':
    case 'postToolUseFailure':
      return createContextMetrics({ toolInput, error }, { role: 'tool_error', modelFacingValue: error });
    case 'SubagentStop':
    case 'subagentStop':
      return createContextMetrics({ response: getValue(payload, 'last_assistant_message', 'response') }, {
        role: 'assistant_output',
        modelFacingValue: getValue(payload, 'last_assistant_message', 'response')
      });
    case 'Stop':
    case 'agentStop':
      return createContextMetrics({ response: getValue(payload, 'last_assistant_message', 'response') }, {
        role: 'assistant_output',
        modelFacingValue: getValue(payload, 'last_assistant_message', 'response')
      });
    case 'PreCompact':
    case 'preCompact':
      return createContextMetrics({ customInstructions: getValue(payload, 'custom_instructions', 'customInstructions') }, {
        role: 'compaction_instruction',
        modelFacingValue: getValue(payload, 'custom_instructions', 'customInstructions')
      });
    case 'ErrorOccurred':
    case 'errorOccurred':
      return createContextMetrics({ error }, { role: 'error', modelFacingValue: error });
    default:
      return null;
  }
}

function createEventId(prefix, value) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function appendRecord(logPath, record) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeToolName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isPromptReviewerTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return promptReviewerToolNames.has(normalized)
    || /(?:^|__)code_buddy__(?:review_prompt|reviewprompt)$/.test(normalized);
}

function isTaskDecomposerTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return taskDecomposerToolNames.has(normalized)
    || /(?:^|__)code_buddy__(?:decompose_task|decomposetask)$/.test(normalized);
}

function isContextMeasurementTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return contextMeasurementToolNames.has(normalized)
    || /(?:^|__)code_buddy__(?:measure_context|measurecontext)$/.test(normalized);
}

function isSessionFitTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return sessionFitToolNames.has(normalized)
    || /(?:^|__)code_buddy__(?:assess_session_fit|assesssessionfit)$/.test(normalized);
}

function isCodeBuddyTool(toolName) {
  return codeBuddyToolPattern.test(normalizeToolName(toolName));
}

function isObservationalTool(toolName) {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return false;
  }
  return observationalToolPattern.test(normalized)
    || /(?:^|[_-])(?:fetch|find|get|grep|hover|list|open|read|resolve|search|screenshot)(?:$|[_-])/.test(normalized);
}

function isMeaningfulPrompt(prompt) {
  if (typeof prompt !== 'string') {
    return false;
  }
  const normalized = prompt.trim().toLowerCase();
  if (!normalized
    || /^(?:yes|no|continue|go ahead|run it|do it|ok|okay|cancel|stop|retry)[.!]?$/.test(normalized)
    || /^code-buddy-action\b/.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length >= 3 || normalized.length >= 20;
}

function isControlledFallbackApproval(prompt) {
  return typeof prompt === 'string'
    && /^\s*code\s*buddy\s*:\s*(?:continue|proceed)\s+without\s+preflight\s*[.!]?\s*$/i.test(prompt);
}

function preflightStateDirectory(logPath) {
  const stateDirectory = process.env.TOKEN_LENS_STATE_DIR || path.join(path.dirname(logPath), '.state');
  return path.join(stateDirectory, 'preflight');
}

function safeStatePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getPreflightStatePath(logPath, sessionId) {
  return path.join(preflightStateDirectory(logPath), `${safeStatePart(sessionId)}.json`);
}

function getPreflightRequirementPath(logPath, state, requirement) {
  return path.join(
    preflightStateDirectory(logPath),
    `${safeStatePart(state.sessionId)}.${safeStatePart(state.promptId)}.${safeStatePart(requirement)}.json`
  );
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The atomic rename normally removes the temporary path.
    }
  }
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pendingHandoffPath(logPath) {
  const stateDirectory = process.env.TOKEN_LENS_STATE_DIR || path.join(path.dirname(logPath), '.state');
  return path.join(stateDirectory, 'pending-fresh-handoff.json');
}

function loadPendingHandoff(logPath) {
  const filePath = pendingHandoffPath(logPath);
  const pending = readJsonIfPresent(filePath);
  if (!pending) {
    return { pending: null, malformed: fs.existsSync(filePath) };
  }
  const valid = pending.schemaVersion === pendingHandoffSchemaVersion
    && typeof pending.handoffId === 'string' && pending.handoffId
    && typeof pending.sourceSessionId === 'string' && pending.sourceSessionId
    && typeof pending.targetTask === 'string' && pending.targetTask;
  return { pending: valid ? pending : null, malformed: !valid };
}

function clearPendingHandoff(logPath) {
  try {
    fs.unlinkSync(pendingHandoffPath(logPath));
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

function isHandoffBypassPrompt(prompt) {
  // Codex can append transport whitespace that is not visible in the submitted prompt.
  return typeof prompt === 'string'
    && prompt.trim() === 'Code Buddy: continue without curated context';
}

function hasHandoffMarker(prompt, handoffId) {
  return String(prompt || '').includes(`<!-- code-buddy-handoff:${handoffId} -->`);
}

function savePreflightState(logPath, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(getPreflightStatePath(logPath, state.sessionId), state);
}

function loadPreflightState(logPath, sessionId) {
  const state = readJsonIfPresent(getPreflightStatePath(logPath, sessionId));
  if (!state || state.schemaVersion !== preflightStateSchemaVersion || state.sessionId !== (sessionId || 'unknown')) {
    return null;
  }
  for (const requirement of Object.keys(state.requirements || {})) {
    const marker = readJsonIfPresent(getPreflightRequirementPath(logPath, state, requirement));
    if (marker && marker.promptId === state.promptId && (marker.status === 'completed' || marker.status === 'failed')) {
      state.requirements[requirement].status = marker.status;
      state.requirements[requirement].toolName = marker.toolName || null;
      state.requirements[requirement].toolUseId = marker.toolUseId || null;
      state.requirements[requirement].limited = marker.limited === true;
    }
  }
  return state;
}

function initializePreflightState(logPath, payload, sessionId, promptId) {
  const prompt = getValue(payload, 'prompt');
  const policy = loadProjectPolicy(getWorkspace(payload)).policy;
  const state = {
    schemaVersion: preflightStateSchemaVersion,
    sessionId: sessionId || 'unknown',
    promptId,
    promptHash: crypto.createHash('sha256').update(typeof prompt === 'string' ? prompt : '').digest('hex'),
    promptLength: typeof prompt === 'string' ? Array.from(prompt).length : 0,
    meaningful: isMeaningfulPrompt(prompt),
    requirements: {
      promptReviewer: {
        required: envBoolean('TOKEN_LENS_PROMPT_REVIEW_ENABLED', true),
        status: 'pending'
      },
      taskDecomposer: {
        required: envBoolean('TOKEN_LENS_TASK_DECOMPOSITION_ENABLED', true),
        status: 'pending'
      },
      contextMeasurement: {
        required: policy.healthCheck.showOnEveryMeaningfulCodingTask,
        status: 'pending'
      },
      sessionFit: {
        required: policy.healthCheck.showOnEveryMeaningfulCodingTask,
        status: 'pending'
      }
    },
    denialCount: 0,
    fallbackPendingToolUseId: null,
    fallbackPendingToolName: null,
    bypassed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  savePreflightState(logPath, state);
  return state;
}

function toolResultFromPayload(payload) {
  const value = getValue(payload, 'tool_response', 'tool_result', 'toolResult');
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function hasLimitedEvidence(payload, status) {
  if (status === 'failed') return true;
  const result = toolResultFromPayload(payload);
  return Boolean(result && typeof result === 'object' && (result.status === 'fallback'
    || (result.measurement && result.measurement.method === 'estimate' && result.measurement.confidence === 'low')));
}

function markPreflightRequirement(logPath, state, requirement, status, payload) {
  const marker = {
    schemaVersion: preflightStateSchemaVersion,
    sessionId: state.sessionId,
    promptId: state.promptId,
    requirement,
    status,
    limited: hasLimitedEvidence(payload, status),
    toolName: getValue(payload, 'tool_name', 'toolName') || null,
    toolUseId: getValue(payload, 'tool_use_id', 'toolUseId') || null,
    timestamp: getTimestamp(payload)
  };
  writeJsonAtomic(getPreflightRequirementPath(logPath, state, requirement), marker);
  state.requirements[requirement].status = status;
  state.requirements[requirement].toolName = marker.toolName;
  state.requirements[requirement].toolUseId = marker.toolUseId;
  state.requirements[requirement].limited = marker.limited;
}

function missingPreflightRequirements(state) {
  return Object.entries(state.requirements)
    .filter(([, value]) => value.required && value.status !== 'completed' && value.status !== 'failed')
    .map(([name]) => name);
}

function appendPreflightRecord(logPath, payload, state, recordType, data = {}) {
  const timestamp = getTimestamp(payload);
  const recordData = redact({
    promptId: state.promptId,
    meaningful: state.meaningful,
    requirements: state.requirements,
    denialCount: state.denialCount,
    bypassed: state.bypassed,
    ...data
  });
  appendRecord(logPath, {
    schemaVersion: 2,
    eventId: createEventId('preflight', { recordType, sessionId: state.sessionId, timestamp, data: recordData }),
    recordType,
    source: 'governance',
    sourceEventType: getEventName(payload),
    sessionId: state.sessionId,
    turnId: getTurnId(payload),
    parentId: null,
    timestamp,
    localTimestamp: getLocalTimestamp(timestamp),
    recordedAt: getLocalTimestamp(),
    workspace: getWorkspace(payload),
    model: getValue(payload, 'model') || null,
    data: recordData
  });

  const interventionPath = getInterventionLogPath(logPath);
  if (interventionPath) {
    appendRecord(interventionPath, {
      schemaVersion: 1,
      eventId: createEventId('intervention', { recordType, sessionId: state.sessionId, timestamp, data: recordData }),
      timestamp,
      eventType: recordType,
      sessionId: state.sessionId,
      taskId: state.promptId,
      data: recordData
    });
  }
}

function appendHandoffRecord(logPath, payload, recordType, data = {}) {
  const timestamp = getTimestamp(payload);
  const sessionId = getSessionId(payload) || 'unknown';
  const recordData = redact(data);
  appendRecord(logPath, {
    schemaVersion: 2,
    eventId: createEventId('handoff', { recordType, sessionId, timestamp, data: recordData }),
    recordType,
    source: 'governance',
    sourceEventType: getEventName(payload),
    sessionId,
    turnId: getTurnId(payload),
    parentId: null,
    timestamp,
    localTimestamp: getLocalTimestamp(timestamp),
    recordedAt: getLocalTimestamp(),
    workspace: getWorkspace(payload),
    model: getValue(payload, 'model') || null,
    data: recordData
  });
  appendRecord(getInterventionLogPath(logPath), {
    schemaVersion: 1,
    eventId: createEventId('intervention', { recordType, sessionId, timestamp, data: recordData }),
    timestamp,
    eventType: recordType,
    sessionId,
    taskId: getTurnId(payload),
    workspace: getWorkspace(payload),
    data: recordData
  });
}

function handlePendingHandoffEvent(logPath, payload, eventName) {
  const { pending, malformed } = loadPendingHandoff(logPath);
  const sessionId = getSessionId(payload) || 'unknown';
  const isUserPrompt = eventName === 'UserPromptSubmit' || eventName === 'userPromptSubmitted';
  const isPreToolUse = eventName === 'PreToolUse' || eventName === 'preToolUse';

  if (!pending) {
    if (malformed && isUserPrompt) {
      clearPendingHandoff(logPath);
      appendHandoffRecord(logPath, payload, 'context.handoff_invalid', { reason: 'malformed_pending_handoff' });
    }
    return { waiting: false, resolved: false, output: null };
  }
  if (pending.sourceSessionId === sessionId) {
    return { waiting: false, resolved: false, output: null };
  }

  if (isUserPrompt) {
    const prompt = getValue(payload, 'prompt');
    if (hasHandoffMarker(prompt, pending.handoffId)) {
      clearPendingHandoff(logPath);
      appendHandoffRecord(logPath, payload, 'context.handoff_pasted', { handoffId: pending.handoffId, targetTask: pending.targetTask });
      return { waiting: false, resolved: true, output: null };
    }
    if (isHandoffBypassPrompt(prompt)) {
      clearPendingHandoff(logPath);
      appendHandoffRecord(logPath, payload, 'context.handoff_bypassed', { handoffId: pending.handoffId, targetTask: pending.targetTask });
      return { waiting: false, resolved: true, output: null };
    }
    const message = 'A Code Buddy curated handoff is waiting for this fresh task. Do not plan, inspect files, run tools, or begin implementation. Ask the developer to either paste the handoff containing its Code Buddy marker or submit exactly `Code Buddy: continue without curated context`.';
    appendHandoffRecord(logPath, payload, 'context.handoff_waiting', { handoffId: pending.handoffId, targetTask: pending.targetTask });
    return {
      waiting: true,
      resolved: false,
      output: {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: message
        }
      }
    };
  }

  if (isPreToolUse) {
    const toolName = getValue(payload, 'tool_name', 'toolName') || 'this tool';
    const message = `Code Buddy blocked ${toolName} because this fresh task is waiting for curated context. Paste the marked handoff or submit exactly \`Code Buddy: continue without curated context\` before using any tool.`;
    appendHandoffRecord(logPath, payload, 'context.handoff_waiting', { handoffId: pending.handoffId, targetTask: pending.targetTask, toolName });
    return {
      waiting: true,
      resolved: false,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
          additionalContext: message
        }
      }
    };
  }

  return { waiting: false, resolved: false, output: null };
}

function preflightToolLabel(requirement) {
  return {
    promptReviewer: 'mcp__code_buddy__review_prompt',
    taskDecomposer: 'mcp__code_buddy__decompose_task',
    contextMeasurement: 'mcp__code_buddy__measure_context',
    sessionFit: 'mcp__code_buddy__assess_session_fit'
  }[requirement] || requirement;
}

function preflightGateReason(toolName, missing) {
  const tools = missing.map(preflightToolLabel);
  return `Code Buddy blocked ${toolName || 'this implementation tool'} because required preflight is incomplete. `
    + `Use tool_search to load ${tools.join(' and ')}, invoke ${tools.join(' and ')}, then retry the implementation tool. `
    + 'Do not retry implementation before those evaluations finish.';
}

function automaticPreflightContext(state) {
  const required = missingPreflightRequirements(state).map(preflightToolLabel);
  return [
    'Code Buddy is enabled for this task.',
    `For this meaningful coding request, invoke ${required.join(' and ')} before substantive implementation.`,
    'If any MCP tool is deferred, use tool_search to load it before continuing.',
    'Pass the unchanged user request and a concise semantic modelAssessment to prompt review, task decomposition, and session fit. Measure context from available local evidence.',
    'Read all four results. Before substantive work, begin exactly: Code Buddy: prompt quality <status> · task scope <status> · context utilization <status> · session fit <status>. Copy measure_context.healthLineStatus verbatim into the context utilization slot. When native capacity exists, it must include current tokens, model-window tokens, and the actual percentage; a token count alone is incomplete. Use checked — limited evidence when native context data and a useful fallback are unavailable.',
    'Do not silently rewrite, submit, curate, or discard the developer request or context.'
  ].join(' ');
}

function handlePreflightEvent(logPath, payload, eventName, eventId) {
  if (!envBoolean('TOKEN_LENS_PREFLIGHT_ENFORCE', true)) {
    return null;
  }

  const sessionId = getSessionId(payload) || 'unknown';
  if (eventName === 'UserPromptSubmit' || eventName === 'userPromptSubmitted') {
    if (isControlledFallbackApproval(getValue(payload, 'prompt'))) {
      const activeState = loadPreflightState(logPath, sessionId);
      if (activeState && activeState.meaningful && missingPreflightRequirements(activeState).length) {
        activeState.bypassed = true;
        activeState.fallbackPendingToolUseId = null;
        activeState.fallbackPendingToolName = null;
        savePreflightState(logPath, activeState);
        appendPreflightRecord(logPath, payload, activeState, 'preflight.bypassed', {
          reason: 'developer_approved_controlled_fallback',
          approvalPrompt: 'Code Buddy: continue without preflight'
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'The developer explicitly approved Code Buddy\'s controlled fail-open path. Continue with the original task and keep the approval in the local intervention log.'
          }
        };
      }
    }
    const state = initializePreflightState(logPath, payload, sessionId, eventId);
    appendPreflightRecord(
      logPath,
      payload,
      state,
      state.meaningful ? 'preflight.started' : 'preflight.skipped',
      state.meaningful ? {} : { reason: 'control_or_non_meaningful_prompt' }
    );
    if (!state.meaningful || !missingPreflightRequirements(state).length) {
      return null;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: automaticPreflightContext(state)
      }
    };
  }

  const state = loadPreflightState(logPath, sessionId);
  if (!state || !state.meaningful) {
    return null;
  }

  const toolName = getValue(payload, 'tool_name', 'toolName');
  const normalizedToolName = normalizeToolName(toolName);
  const toolUseId = getValue(payload, 'tool_use_id', 'toolUseId');

  if (eventName === 'PostToolUse' || eventName === 'postToolUse'
    || eventName === 'PostToolUseFailure' || eventName === 'postToolUseFailure') {
    const status = eventName === 'PostToolUseFailure' || eventName === 'postToolUseFailure' ? 'failed' : 'completed';
    let requirement = null;
    if (isPromptReviewerTool(normalizedToolName)) {
      requirement = 'promptReviewer';
    } else if (isTaskDecomposerTool(normalizedToolName)) {
      requirement = 'taskDecomposer';
    } else if (isContextMeasurementTool(normalizedToolName)) {
      requirement = 'contextMeasurement';
    } else if (isSessionFitTool(normalizedToolName)) {
      requirement = 'sessionFit';
    }

    if (requirement) {
      markPreflightRequirement(logPath, state, requirement, status, payload);
      appendPreflightRecord(logPath, payload, state, status === 'failed' ? 'preflight.tool_failed' : 'preflight.tool_completed', {
        invocationSource: 'language_model_tool',
        requirement,
        toolName,
        toolUseId: toolUseId || null
      });
      if (!missingPreflightRequirements(state).length) {
        appendPreflightRecord(logPath, payload, state, 'preflight.completed', {
          completedWithFallback: Object.values(state.requirements).some((value) => value.status === 'failed')
        });
        const categories = Object.fromEntries(Object.entries(state.requirements).map(([name, value]) => [
          name,
          value.status === 'failed' || value.limited ? 'checked — limited evidence' : 'satisfactory'
        ]));
        const limited = Object.values(state.requirements).some((value) => value.status === 'failed' || value.limited);
        appendPreflightRecord(logPath, payload, state, limited ? 'health.check_limited' : 'health.check_completed', { categories });
      }
      return null;
    }

    const matchesFallback = state.fallbackPendingToolUseId
      ? state.fallbackPendingToolUseId === toolUseId
      : state.fallbackPendingToolName === normalizedToolName;
    if (matchesFallback) {
      state.bypassed = true;
      state.fallbackPendingToolUseId = null;
      state.fallbackPendingToolName = null;
      savePreflightState(logPath, state);
      appendPreflightRecord(logPath, payload, state, 'preflight.bypassed', {
        reason: 'user_approved_controlled_fallback',
        toolName,
        toolUseId: toolUseId || null
      });
    }
    return null;
  }

  if (eventName !== 'PreToolUse' && eventName !== 'preToolUse') {
    return null;
  }

  const missing = missingPreflightRequirements(state);
  if (!missing.length || state.bypassed || isCodeBuddyTool(normalizedToolName) || isObservationalTool(normalizedToolName)) {
    return null;
  }

  const denialsBeforeFallback = envInteger('TOKEN_LENS_PREFLIGHT_DENIALS_BEFORE_FALLBACK', 1, 1, 5);
  if (state.denialCount < denialsBeforeFallback) {
    state.denialCount += 1;
    savePreflightState(logPath, state);
    const reason = preflightGateReason(toolName, missing);
    appendPreflightRecord(logPath, payload, state, 'preflight.gate_denied', {
      toolName,
      toolUseId: toolUseId || null,
      missing,
      reason
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
        additionalContext: reason
      }
    };
  }

  const fallbackReason = `Code Buddy preflight is still incomplete (${missing.map(preflightToolLabel).join(', ')}). `
    + 'Codex hooks cannot open an approval dialog from PreToolUse. To use the controlled fail-open path, submit exactly: `Code Buddy: continue without preflight`.';
  state.fallbackPendingToolUseId = toolUseId || null;
  state.fallbackPendingToolName = normalizedToolName;
  savePreflightState(logPath, state);
  appendPreflightRecord(logPath, payload, state, 'preflight.fallback_requested', {
    toolName,
    toolUseId: toolUseId || null,
    missing,
    reason: fallbackReason
  });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: fallbackReason,
      additionalContext: fallbackReason
    }
  };
}

const ignoredTaskWords = new Set([
  'about', 'after', 'again', 'also', 'and', 'before', 'code', 'continue', 'current', 'existing', 'for', 'from',
  'have', 'into', 'make', 'more', 'please', 'should', 'task', 'that', 'the', 'then', 'this', 'with', 'work'
]);

function readHookRecords(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          return record && record.schemaVersion === 2 ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function taskTerms(prompt) {
  return new Set(
    (String(prompt || '').toLowerCase().match(/[a-z0-9_.\\/-]{3,}/g) || [])
      .filter((term) => !ignoredTaskWords.has(term))
  );
}

function evaluateTaskBoundary(previousPrompt, currentPrompt) {
  if (/^(continue|next|now|also|then|build on|following up|same task)\b/i.test(currentPrompt.trim())) {
    return { isLikelyNewTask: false, confidence: 'high', overlap: 1, reason: 'The prompt explicitly continues prior work.' };
  }
  const previous = taskTerms(previousPrompt);
  const current = taskTerms(currentPrompt);
  const shared = [...current].filter((term) => previous.has(term)).length;
  const overlap = shared / Math.max(1, Math.min(previous.size, current.size));
  const isLikelyNewTask = previous.size >= 2 && current.size >= 2 && overlap < 0.2;
  return {
    isLikelyNewTask,
    confidence: overlap < 0.1 ? 'high' : overlap < 0.3 ? 'medium' : 'low',
    overlap: Number(overlap.toFixed(2)),
    reason: isLikelyNewTask
      ? 'The new prompt has little task-specific overlap with the prior prompt.'
      : 'The prompts retain task-specific overlap.'
  };
}

function appendGovernanceIntervention(logPath, payload, eventType, data) {
  const timestamp = getTimestamp(payload);
  const recordData = redact(data);
  appendRecord(getInterventionLogPath(logPath), {
    schemaVersion: 1,
    eventId: createEventId('intervention', { eventType, sessionId: getSessionId(payload), timestamp, data: recordData }),
    timestamp,
    eventType,
    sessionId: getSessionId(payload) || 'unknown',
    taskId: getTurnId(payload),
    workspace: getWorkspace(payload),
    data: recordData
  });
}

function governanceContext(logPath, payload, eventName, eventId) {
  if (eventName !== 'UserPromptSubmit' && eventName !== 'userPromptSubmitted') {
    return null;
  }
  const currentPrompt = getValue(payload, 'prompt');
  const sessionId = getSessionId(payload) || 'unknown';
  if (!isMeaningfulPrompt(currentPrompt) || isControlledFallbackApproval(currentPrompt)) {
    return null;
  }

  const records = readHookRecords(logPath);
  const priorPrompts = records
    .filter((record) => record.recordType === 'user.prompt' && record.eventId !== eventId && isMeaningfulPrompt(record.data?.prompt))
    .slice(-20);
  const previous = priorPrompts.at(-1);
  const messages = [];

  if (previous) {
    const previousPrompt = previous.data?.prompt;
    const previousSession = previous.sessionId || 'unknown';
    if (previousSession !== 'unknown' && sessionId !== 'unknown' && previousSession !== sessionId) {
      const data = {
        previousSessionId: previousSession,
        currentSessionId: sessionId,
        reason: 'The first meaningful prompt is in a different Codex session and prior Code Buddy context exists.'
      };
      appendGovernanceIntervention(logPath, payload, 'session.boundary_detected', data);
      messages.push('Code Buddy detected a fresh Codex session with prior local context. Before implementation, offer the developer: (1) carry forward a curated handoff, or (2) start without prior context. Only call curate_context after they choose the handoff.');
    } else if (previousSession === sessionId && typeof previousPrompt === 'string') {
      const boundary = evaluateTaskBoundary(previousPrompt, currentPrompt);
      appendGovernanceIntervention(logPath, payload, 'task.boundary_evaluated', boundary);
      if (boundary.isLikelyNewTask) {
        messages.push(`Code Buddy detected a likely new task in this session (task-term overlap ${boundary.overlap}). Before implementation, offer the developer: (1) curate a handoff for a fresh task, or (2) continue unchanged. Do not curate automatically.`);
      }
    }
  }

  const snapshot = [...records].reverse().find((record) => record.recordType === 'context.load_snapshot' && record.sessionId === sessionId);
  const actual = snapshot?.data?.actualContextUtilization;
  const pressure = actual || snapshot?.data?.estimatedContextPressure;
  if (pressure && ['warning', 'critical'].includes(pressure.thresholdState)) {
    appendGovernanceIntervention(logPath, payload, 'context.warning', {
      thresholdState: pressure.thresholdState,
      value: pressure.value,
      unit: pressure.unit,
      utilization: pressure.utilization
    });
    const label = actual ? 'Actual Context Utilization' : 'Estimated Context Pressure';
    const qualification = actual
      ? 'Use the native input-token/model-window ratio and do not substitute cumulative usage.'
      : 'Never claim this fallback estimate is actual context utilization.';
    messages.push(`Code Buddy's prior local snapshot reports ${pressure.thresholdState} ${label}. Call measure_context before discussing it, then offer fresh-task curation, current-task curation, or continuing unchanged. ${qualification}`);
  }

  if (!messages.length) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: messages.join('\n\n')
    }
  };
}

function mergeHookOutput(first, second) {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const firstSpecific = first.hookSpecificOutput || {};
  const secondSpecific = second.hookSpecificOutput || {};
  return {
    ...first,
    hookSpecificOutput: {
      ...firstSpecific,
      ...secondSpecific,
      additionalContext: [firstSpecific.additionalContext, secondSpecific.additionalContext].filter(Boolean).join('\n\n') || undefined
    }
  };
}

function personalizedFeedbackOutput(payload, eventName) {
  if (eventName !== 'UserPromptSubmit' && eventName !== 'userPromptSubmitted') return null;
  let policy = {};
  try {
    policy = loadProjectPolicy(getWorkspace(payload)).policy?.measurement?.humanRetries || {};
  } catch { /* use conservative local defaults */ }
  const telemetryPath = process.env.CODE_BUDDY_TELEMETRY_DIR
    || process.env.TOKEN_LENS_TELEMETRY_DIR
    || getWorkspace(payload);
  const analysis = getPersonalizedRecommendation(telemetryPath, { policy });
  const prompt = getValue(payload, 'prompt');
  const placement = isMeaningfulPrompt(prompt)
    ? 'Immediately after the required Code Buddy health line'
    : 'At the beginning of the response';
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${placement}, show this exact model-derived local feedback line to the developer: "${analysis.feedback}" Do not omit the line. Treat the evidence as observational, never causal.`
    }
  };
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
    preCompact: 'context.compacted',
    PostCompact: 'context.compaction_completed',
    postCompact: 'context.compaction_completed'
  };
  return types[eventName] || 'hook.event';
}

function normalizeHookData(eventName, payload) {
  const toolName = getValue(payload, 'tool_name', 'toolName');
  const toolInput = getValue(payload, 'tool_input', 'toolArgs');
  const toolResult = getValue(payload, 'tool_response', 'tool_result', 'toolResult');
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
        stopHookActive: getValue(payload, 'stop_hook_active', 'stopHookActive'),
        response: getValue(payload, 'last_assistant_message', 'response')
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
    case 'PostCompact':
    case 'postCompact':
      return redact({
        transcriptPath,
        contextBeforeTokensEstimate: getValue(payload, 'context_before_tokens_estimate', 'contextBeforeTokensEstimate'),
        contextAfterTokensEstimate: getValue(payload, 'context_after_tokens_estimate', 'contextAfterTokensEstimate')
      });
    default:
      return redact(payload);
  }
}

function appendHookRecord(logPath, payload, eventName, sessionId) {
  const workspace = getWorkspace(payload);
  const eventId = createEventId('hook', { eventName, payload });
  const data = normalizeHookData(eventName, payload);
  const context = hookContextMetrics(eventName, payload);
  const providerUsage = findProviderUsage(payload);
  if (context) {
    data.context = context;
  }
  if (providerUsage) {
    data.providerUsage = providerUsage;
  }
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
    data,
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

function transcriptContextMetrics(eventType, eventData) {
  if (!eventData || typeof eventData !== 'object') {
    return null;
  }
  const fieldNames = ['content', 'prompt', 'transformedPrompt', 'result', 'text', 'output', 'error', 'summary', 'details', 'toolRequests', 'attachments'];
  const components = {};
  for (const fieldName of fieldNames) {
    if (eventData[fieldName] !== undefined && eventData[fieldName] !== null) {
      components[fieldName] = eventData[fieldName];
    }
  }
  if (!Object.keys(components).length) {
    return null;
  }
  const role = eventType === 'user.message'
    ? 'user_prompt'
    : eventType === 'assistant.message'
      ? 'assistant_output'
      : /tool|result/i.test(eventType)
        ? 'tool_result'
        : 'transcript_text';
  const modelFacingValue = eventData.content ?? eventData.result ?? eventData.text ?? eventData.output ?? eventData.error;
  return createContextMetrics(components, { role, modelFacingValue });
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

  const redactedData = redact(eventData);
  const data = redactedData && typeof redactedData === 'object' && !Array.isArray(redactedData)
    ? { ...redactedData }
    : { value: redactedData };
  const context = transcriptContextMetrics(eventType, eventData);
  const providerUsage = findProviderUsage(transcriptEvent);
  if (context) {
    data.context = context;
  }
  if (providerUsage) {
    data.providerUsage = providerUsage;
  }

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
    data,
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
  const scriptPath = getAnalyticsScriptPath();
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
    TOKEN_LENS_WORKSPACE: getWorkspace(payload),
    TOKEN_LENS_LOG_FILE: getLogPath(payload),
    TOKEN_LENS_INTERVENTION_LOG_FILE: getInterventionLogPath(getLogPath(payload)),
    TOKEN_LENS_FEEDBACK_FILE: process.env.TOKEN_LENS_FEEDBACK_FILE || path.join(getWorkspace(payload), 'Code Buddy.md'),
    TOKEN_LENS_ANALYTICS_FILE: process.env.TOKEN_LENS_ANALYTICS_FILE || path.join(getWorkspace(payload), 'Code Buddy Analytics.md')
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
  const logPath = getLogPath(payload);

  const eventId = appendHookRecord(logPath, payload, event, sessionId);
  const isStopEvent = event === 'Stop' || event === 'agentStop';
  if (!isStopEvent) {
    captureTelemetry(payload, { platform: 'codex', editor: 'codex', legacyLogPath: logPath });
  }
  const handoff = handlePendingHandoffEvent(logPath, payload, event);
  const hookOutput = mergeHookOutput(
    handoff.waiting
      ? handoff.output
      : mergeHookOutput(
        handlePreflightEvent(logPath, payload, event, eventId),
        handoff.resolved ? null : governanceContext(logPath, payload, event, eventId)
      ),
    personalizedFeedbackOutput(payload, event)
  );

  if (event === 'UserPromptSubmit' || event === 'userPromptSubmitted') {
    runCodeBuddy('start_turn', payload, sessionId, eventId);
  }

  if (isStopEvent) {
    captureTranscript(logPath, payload, event, sessionId);
    runCodeBuddy('end_turn', payload, sessionId, eventId);
    captureTelemetry(payload, { platform: 'codex', editor: 'codex', legacyLogPath: logPath });
  }

  return hookOutput;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const output = main(input);
    if (output) {
      process.stdout.write(JSON.stringify(output));
    }
  } catch (error) {
    process.stderr.write(`Code Buddy hook error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
