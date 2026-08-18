'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const os = require('node:os');

const TELEMETRY_SCHEMA_VERSION = '1.1';
const SUPPORTED_TELEMETRY_SCHEMA_VERSIONS = new Set(['1.0', '1.1']);
const STATE_SCHEMA_VERSION = 1;
const HUMAN_RETRY_DATASET_VERSION = 'human-retry-task-v1';
const HUMAN_RETRY_ANALYSIS_VERSION = 'human-retry-analysis-v1';
const HUMAN_RETRY_DETECTOR_VERSION = 'human_retry_detector_v1';
const DEFAULT_LEVEL = 'standard';
const LEVELS = new Set(['minimal', 'standard', 'diagnostic']);
const TASK_STATES = new Set(['created', 'active', 'paused', 'completed', 'abandoned', 'superseded', 'unknown']);
const FOLLOWUP_CLASSIFICATIONS = new Set([
  'clarification', 'correction', 'extension', 'scope_change', 'retry_request',
  'validation_request', 'new_requirement', 'approval', 'question', 'unknown'
]);
const RECOMMENDATION_DECISIONS = new Set(['accepted', 'rejected', 'dismissed', 'modified', 'unknown']);
const EVENT_TYPES = new Set([
  'task_created', 'task_continued', 'task_state_changed', 'task_completed', 'task_abandoned',
  'prompt_submitted', 'preflight_completed', 'recommendation_shown', 'recommendation_decision',
  'agent_response', 'developer_followup', 'retry_detected', 'implementation_attempt_observed',
  'human_retry_detected', 'recommendation_applied', 'scope_changed', 'context_snapshot',
  'conversation_compacted', 'session_changed', 'handoff_created', 'ai_usage', 'tool_activity',
  'file_activity', 'git_event', 'test_run', 'build_run'
]);
const REQUIRED_PAYLOAD_FIELDS = {
  task_created: ['task_type', 'initial_complexity', 'objective', 'task_detection'],
  task_continued: ['task_match_confidence', 'match_reason'],
  task_state_changed: ['from', 'to', 'reason'],
  task_completed: ['completion_method', 'completion_confidence'],
  task_abandoned: ['reason'],
  prompt_submitted: ['prompt_length_chars', 'prompt_length_tokens_estimate', 'contains_file_reference', 'contains_acceptance_criteria', 'contains_constraints', 'contains_validation_request'],
  preflight_completed: ['prompt_quality', 'task_decomposition', 'context_pressure', 'session_fit'],
  recommendation_shown: ['recommendation_id', 'recommendation_type', 'reason', 'source_check', 'source_score', 'suggested_action'],
  recommendation_decision: ['recommendation_id', 'decision'],
  agent_response: ['response_tokens', 'model', 'tools_invoked', 'files_read', 'files_modified', 'execution_duration_ms'],
  developer_followup: ['classification', 'classification_confidence', 'prompt_length_tokens_estimate', 'signals'],
  retry_detected: ['retry_type', 'confidence', 'trigger'],
  implementation_attempt_observed: ['attempt_id', 'attempt_number', 'attempt_kind', 'evidence', 'confidence', 'detector_version'],
  human_retry_detected: ['human_retry_id', 'source_followup_event_id', 'attempt_id', 'prior_attempt_id', 'human_retry_number', 'implementation_attempt_number', 'classification', 'classification_confidence', 'task_match_confidence', 'material_attempt_confidence', 'trigger', 'detector_version'],
  recommendation_applied: ['recommendation_id', 'recommendation_type', 'application_status', 'evidence'],
  scope_changed: ['direction', 'estimated_previous_scope', 'estimated_new_scope'],
  context_snapshot: ['checkpoint', 'estimated_context_tokens', 'conversation_turns', 'files_in_context', 'compaction_count', 'fresh_session', 'curated_handoff'],
  conversation_compacted: ['context_before_tokens_estimate', 'context_after_tokens_estimate', 'compaction_number'],
  session_changed: ['previous_session_id', 'new_session_id', 'transition_type', 'handoff_used'],
  handoff_created: ['source_context_tokens_estimate', 'handoff_tokens_estimate', 'compression_ratio'],
  ai_usage: ['model', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'ai_credits', 'estimated_cost'],
  tool_activity: ['tool_type', 'operation', 'success', 'duration_ms'],
  file_activity: ['operation', 'file_hash', 'file_extension', 'lines_added', 'lines_removed'],
  git_event: ['git_event_type', 'commit_hash', 'files_changed', 'lines_added', 'lines_removed'],
  test_run: ['framework', 'tests_run', 'passed', 'failed', 'skipped', 'duration_ms'],
  build_run: ['result', 'duration_ms', 'error_count']
};
const IGNORED_TASK_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'before', 'build', 'change', 'code', 'continue', 'create',
  'current', 'existing', 'fix', 'for', 'from', 'have', 'implement', 'into', 'make', 'more', 'please',
  'should', 'task', 'that', 'the', 'then', 'this', 'update', 'with', 'work'
]);
const CONTROL_PROMPT = /^(?:yes|no|continue|run it|retry|cancel|ok|okay|done|thanks|thank you|proceed|go ahead)[.!\s]*$/i;
const TASK_ABANDON_PROMPT = /^(?:abandon|cancel|drop|stop)(?:\s+this|\s+the)?\s*(?:task|work)?[.!\s]*$/i;
const CONTINUATION_PROMPT = /^(?:continue|next|now|also|then|build on|following up|same task|retry|fix that)\b/i;
const TEST_COMMAND = /(?:^|\s)(?:pytest|py\.test|npm\s+(?:run\s+)?test(?::[^\s]+)?|pnpm\s+(?:run\s+)?test(?::[^\s]+)?|yarn\s+test(?::[^\s]+)?|node\s+--test|jest|vitest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/i;
const BUILD_COMMAND = /(?:^|\s)(?:npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build|tsc(?:\s|$)|cargo\s+build|go\s+build|mvn\s+(?:package|compile)|gradle\s+build)(?:\s|$)/i;
const TERMINAL_TOOL = /(?:terminal|shell|command|exec|bash|powershell|run_process|run_in_terminal)/i;
const FILE_TOOL = /(?:apply_patch|edit|write|create_file|delete_file|move_file|rename_file)/i;
const SECRET_PATTERNS = [
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]+/gi,
  /sk-[a-z0-9_-]+/gi,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
];

function getValue(value, ...keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function redactRawContent(value) {
  let redacted = String(value || '');
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted;
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function privateHash(salt, value, length = 24) {
  return hash(`${salt || 'local'}:${String(value)}`, length);
}

function newId(prefix) {
  const value = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${value}`;
}

function isoTimestamp(value) {
  const candidate = typeof value === 'number' ? new Date(value) : new Date(asString(value) || Date.now());
  return Number.isNaN(candidate.getTime()) ? new Date().toISOString() : candidate.toISOString();
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function codexSessionsRoot(options = {}) {
  if (options.sessionsRoot) return path.resolve(options.sessionsRoot);
  if (process.env.CODE_BUDDY_CODEX_SESSIONS_DIR) {
    return path.resolve(process.env.CODE_BUDDY_CODEX_SESSIONS_DIR);
  }
  const configuredRoot = process.env.CODEX_HOME;
  const codexRoot = configuredRoot && path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.join(os.homedir(), '.codex');
  return path.join(codexRoot, 'sessions');
}

function collectCodexRollouts(root, maximumFiles = 120) {
  const files = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (!current || current.depth > 4) continue;
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try {
          files.push({ path: entryPath, modified: fs.statSync(entryPath).mtimeMs });
        } catch {
          // A concurrently rotated rollout is simply unavailable for this observation.
        }
      }
    }
  }
  return files.sort((left, right) => right.modified - left.modified).slice(0, maximumFiles);
}

function readFileSection(filePath, start, length) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.max(0, length));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, start));
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function readRolloutWindows(filePath, bytesPerWindow = 768 * 1024) {
  let size;
  try { size = fs.statSync(filePath).size; } catch { return ''; }
  const first = readFileSection(filePath, 0, Math.min(size, bytesPerWindow));
  if (size <= bytesPerWindow) return first;
  const last = readFileSection(filePath, Math.max(0, size - bytesPerWindow), Math.min(size, bytesPerWindow));
  return `${first}\n${last}`;
}

function rolloutMatchesWorkspace(filePath, workspace) {
  if (!workspace) return false;
  const expected = path.resolve(workspace);
  const windows = readRolloutWindows(filePath);
  for (const line of windows.split(/\r?\n/)) {
    if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const candidates = [payload.cwd, ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [])]
      .filter((value) => typeof value === 'string');
    if (candidates.some((value) => path.resolve(value) === expected)) return true;
  }
  return false;
}

function rolloutSessionId(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match?.[1] || null;
}

function latestCodexTokenCount(filePath, maximumBytes = 16 * 1024 * 1024) {
  let size;
  try { size = fs.statSync(filePath).size; } catch { return null; }
  const length = Math.min(size, maximumBytes);
  const contents = readFileSection(filePath, Math.max(0, size - length), length);
  const lines = contents.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"token_count"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') continue;
    const info = record.payload.info;
    const last = info?.last_token_usage;
    if (!last || typeof last !== 'object') continue;
    const inputTokens = finiteNonNegative(last.input_tokens);
    if (inputTokens === null) continue;
    const modelContextWindowTokens = finiteNonNegative(info.model_context_window);
    const total = info.total_token_usage && typeof info.total_token_usage === 'object'
      ? info.total_token_usage
      : {};
    return {
      measurement_method: 'codex_token_count_event',
      measurement_confidence: 'high',
      terminology: 'Actual Context Utilization',
      measurement_timestamp: asString(record.timestamp) ? isoTimestamp(record.timestamp) : null,
      input_tokens: inputTokens,
      cached_input_tokens: finiteNonNegative(last.cached_input_tokens),
      cache_write_input_tokens: finiteNonNegative(last.cache_write_input_tokens),
      output_tokens: finiteNonNegative(last.output_tokens),
      reasoning_tokens: finiteNonNegative(last.reasoning_output_tokens),
      total_tokens: finiteNonNegative(last.total_tokens),
      model_context_window_tokens: modelContextWindowTokens && modelContextWindowTokens > 0
        ? modelContextWindowTokens
        : null,
      context_utilization: modelContextWindowTokens && modelContextWindowTokens > 0
        ? inputTokens / modelContextWindowTokens
        : null,
      cumulative_usage: {
        input_tokens: finiteNonNegative(total.input_tokens),
        cached_input_tokens: finiteNonNegative(total.cached_input_tokens),
        cache_write_input_tokens: finiteNonNegative(total.cache_write_input_tokens),
        output_tokens: finiteNonNegative(total.output_tokens),
        reasoning_tokens: finiteNonNegative(total.reasoning_output_tokens),
        total_tokens: finiteNonNegative(total.total_tokens)
      }
    };
  }
  return null;
}

function readCodexNativeContext(options = {}) {
  const sessionId = asString(options.sessionId);
  const workspace = asString(options.workspace);
  const rollouts = collectCodexRollouts(codexSessionsRoot(options));
  const candidates = sessionId && sessionId !== 'unknown'
    ? rollouts.filter((item) => path.basename(item.path).includes(sessionId))
    : rollouts.filter((item) => rolloutMatchesWorkspace(item.path, workspace));
  for (const candidate of candidates) {
    const measurement = latestCodexTokenCount(candidate.path);
    if (!measurement) continue;
    return {
      status: 'actual',
      session_id: sessionId && sessionId !== 'unknown' ? sessionId : rolloutSessionId(candidate.path),
      ...measurement
    };
  }
  return {
    status: 'unavailable',
    session_id: sessionId && sessionId !== 'unknown' ? sessionId : null,
    measurement_method: 'unavailable',
    measurement_confidence: 'low',
    terminology: 'Actual Context Utilization',
    limitation: 'No matching Codex token_count event was available for this workspace and session.'
  };
}

function workspaceFrom(payload) {
  const candidate = asString(getValue(payload, 'cwd', 'workspace', 'workspacePath'));
  return path.resolve(candidate || process.cwd());
}

function telemetryRoot(workspace) {
  const configured = process.env.CODE_BUDDY_TELEMETRY_DIR || process.env.TOKEN_LENS_TELEMETRY_DIR;
  return path.resolve(configured || path.join(workspace, '.code-buddy', 'telemetry'));
}

function telemetryLevel() {
  if (process.env.CODE_BUDDY_TELEMETRY_ENABLED === 'false' || process.env.TOKEN_LENS_TELEMETRY_ENABLED === 'false') {
    return 'off';
  }
  const configured = (process.env.CODE_BUDDY_TELEMETRY_LEVEL || process.env.TOKEN_LENS_TELEMETRY_LEVEL || DEFAULT_LEVEL).toLowerCase();
  return LEVELS.has(configured) ? configured : DEFAULT_LEVEL;
}

function captureRawContent() {
  return telemetryLevel() === 'diagnostic'
    && (process.env.CODE_BUDDY_TELEMETRY_CAPTURE_RAW_CONTENT === 'true'
      || process.env.TOKEN_LENS_TELEMETRY_CAPTURE_RAW_CONTENT === 'true');
}

function eventAllowed(eventType, level) {
  if (level === 'off') return false;
  if (level !== 'minimal') return true;
  return /^(?:task_|prompt_submitted|preflight_completed|recommendation_|developer_followup|retry_detected|implementation_attempt_observed|human_retry_detected|session_changed|handoff_created|task_state_changed)/.test(eventType);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlTail(filePath, maximumBytes = 2_000_000) {
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maximumBytes);
    const length = size - start;
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      const content = buffer.toString('utf8');
      const lines = content.split(/\r?\n/);
      if (start > 0) lines.shift();
      return lines.filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
}

function acquireTelemetryLock(root) {
  const stateDirectory = path.join(root, '.state');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDirectory, 'telemetry.lock');
  const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, token, 'utf8');
      } catch (error) {
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
        throw error;
      } finally {
        fs.closeSync(descriptor);
      }
      return () => {
        try {
          if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
        } catch { /* another process recovered a stale lock */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* the owner may have released it */ }
      Atomics.wait(waiter, 0, 0, 25);
    }
  }
  throw new Error('telemetry state lock was busy; capture skipped safely');
}

function initialState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    developer_id: null,
    privacy_salt: crypto.randomBytes(16).toString('hex'),
    environment: null,
    active_task: null,
    tasks: {},
    sessions: {},
    preflights: {},
    recommendations: {},
    seen_hook_events: []
  };
}

function loadState(root) {
  const value = readJson(path.join(root, '.state', 'telemetry-state.json'), initialState());
  if (!value || value.schema_version !== STATE_SCHEMA_VERSION) return initialState();
  value.sessions ||= {};
  value.privacy_salt ||= crypto.randomBytes(16).toString('hex');
  value.tasks ||= {};
  if (value.active_task?.task_id) {
    value.tasks[value.active_task.task_id] ||= value.active_task;
    value.active_task = value.tasks[value.active_task.task_id];
  }
  value.preflights ||= {};
  value.recommendations ||= {};
  value.seen_hook_events ||= [];
  return value;
}

function hookDeduplicationKey(payload, eventName, sessionId) {
  const explicit = getValue(payload, 'event_id', 'eventId', 'hook_event_id', 'hookEventId', 'tool_use_id', 'toolUseId');
  if (explicit !== undefined && explicit !== null && String(explicit)) {
    return hash(`${eventName}:${sessionId}:${String(explicit)}`, 32);
  }
  let fingerprint;
  try { fingerprint = JSON.stringify(payload); } catch { fingerprint = String(payload); }
  return hash(`${eventName}:${sessionId}:${fingerprint}`, 32);
}

function saveState(root, state) {
  writeJsonAtomic(path.join(root, '.state', 'telemetry-state.json'), state);
}

function runGit(workspace, args) {
  try {
    const result = childProcess.spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 800,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return result.status === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

function environmentFor(workspace, state, options) {
  if (!state.environment) {
    const repositoryRoot = runGit(workspace, ['rev-parse', '--show-toplevel']) || workspace;
    state.environment = {
      editor: options.editor || (options.platform === 'codex' ? 'codex' : 'vscode'),
      repository_id: `repo_${privateHash(state.privacy_salt, repositoryRoot)}`,
      branch: runGit(workspace, ['branch', '--show-current']) || null
    };
  } else if (options.refreshBranch) {
    const branch = runGit(workspace, ['branch', '--show-current']);
    if (branch) state.environment.branch = branch;
  }
  return state.environment;
}

function developerId(state) {
  const explicit = process.env.CODE_BUDDY_DEVELOPER_ID || process.env.TOKEN_LENS_DEVELOPER_ID;
  if (explicit) return explicit;
  if (!state.developer_id) {
    let localIdentity = os.hostname();
    try { localIdentity = `${os.userInfo().username}@${os.hostname()}`; } catch { /* hostname is sufficient */ }
    state.developer_id = `dev_${hash(localIdentity)}`;
  }
  return state.developer_id;
}

function sessionState(state, sessionId) {
  state.sessions[sessionId] ||= {
    sequence: 0,
    interaction_count: 0,
    current_interaction_id: null,
    context_tokens_estimate: 0,
    conversation_turns: 0,
    compaction_count: 0,
    pending_compaction: null,
    activity: null,
    task_id: null,
    model: null,
    context_file_hashes: []
  };
  return state.sessions[sessionId];
}

function taskById(state, taskId) {
  if (!taskId) return null;
  return state.tasks?.[taskId]
    || (state.active_task?.task_id === taskId ? state.active_task : null);
}

function taskForSession(state, sessionId) {
  const session = sessionState(state, sessionId);
  return taskById(state, session.task_id) || null;
}

function appendEvent(root, state, context, eventType, payload, overrides = {}) {
  const level = telemetryLevel();
  if (!eventAllowed(eventType, level)) return null;
  const sessionId = overrides.session_id ?? context.session_id;
  const session = sessionState(state, sessionId || 'unknown');
  session.sequence += 1;
  const timestamp = overrides.timestamp || context.timestamp;
  const record = {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    event_id: newId('evt'),
    event_type: eventType,
    timestamp,
    session_sequence: session.sequence,
    developer_id: context.developer_id,
    session_id: sessionId || null,
    task_id: overrides.task_id === undefined ? context.task_id : overrides.task_id,
    interaction_id: overrides.interaction_id === undefined ? context.interaction_id : overrides.interaction_id,
    platform: context.platform,
    environment: context.environment,
    payload
  };
  const validationErrors = validateTelemetryEvent(record);
  if (validationErrors.length) {
    throw new Error(`invalid telemetry event: ${validationErrors.join('; ')}`);
  }
  const fileName = `events-${timestamp.slice(0, 10)}.jsonl`;
  const filePath = path.join(root, 'raw', fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

function promptTerms(prompt) {
  const raw = String(prompt || '').toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) || [];
  const normalized = raw.map((term) => term.replace(/^[._/-]+|[._/-]+$/g, '')).filter(Boolean);
  return [...new Set(normalized.filter((term) => !IGNORED_TASK_WORDS.has(term)).map((term) => hash(term, 16)))].slice(0, 80);
}

function termOverlap(previous, current) {
  const prior = new Set(previous || []);
  const shared = (current || []).filter((term) => prior.has(term)).length;
  return shared / Math.max(1, Math.min(prior.size, (current || []).length));
}

function classifyTaskType(prompt) {
  if (/\b(fix|bug|error|failing|failure|regression|race condition)\b/i.test(prompt)) return 'bugfix';
  if (/\b(refactor|cleanup|restructure|rearchitecture)\b/i.test(prompt)) return 'refactor';
  if (/\b(investigate|diagnose|analy[sz]e|review|audit)\b/i.test(prompt)) return 'investigation';
  if (/\b(test|coverage|spec)\b/i.test(prompt) && !/\b(add|build|create|implement)\b/i.test(prompt)) return 'test';
  if (/\b(document|docs|readme)\b/i.test(prompt)) return 'documentation';
  return 'feature';
}

function classifyComplexity(prompt) {
  const words = String(prompt || '').trim().split(/\s+/).filter(Boolean).length;
  const breadth = (String(prompt || '').match(/\b(?:and|across|plus|also|then)\b/gi) || []).length;
  if (words >= 120 || breadth >= 5) return 'large';
  if (words >= 35 || breadth >= 2) return 'medium';
  return 'small';
}

function objectiveMetadata(prompt, privacySalt) {
  const value = String(prompt || '');
  const actionMatch = value.match(/\b(add|build|change|configure|create|debug|delete|deploy|design|document|explain|fix|implement|improve|install|investigate|migrate|optimi[sz]e|refactor|remove|review|rewrite|test|update|write)\b/i);
  const targets = [
    ['api', /\b(?:api|endpoint|route|controller)\b/i],
    ['authentication', /\b(?:auth|authentication|oauth|login|session|token)\b/i],
    ['database', /\b(?:database|schema|query|sql|migration|postgres|mysql|sqlite)\b/i],
    ['ui', /\b(?:ui|screen|page|view|component|modal|dialog|layout)\b/i],
    ['test', /\b(?:test|tests|coverage|spec|fixture)\b/i],
    ['configuration', /\b(?:config|configuration|setting|policy|yaml|toml)\b/i],
    ['documentation', /\b(?:docs|documentation|readme|guide)\b/i],
    ['dependency', /\b(?:dependency|package|library|sdk)\b/i],
    ['module', /\b(?:module|class|function|service|worker|job)\b/i]
  ];
  const target = targets.find(([, pattern]) => pattern.test(value))?.[0] || 'general_code';
  const extensions = [...new Set((value.match(/\.[a-z0-9]{1,8}\b/gi) || []).map((item) => item.toLowerCase()))].slice(0, 12);
  const references = [...new Set((value.match(/\b[A-Z]{2,10}-\d{1,12}\b/g) || []).map((item) => `ref_${privateHash(privacySalt, item)}`))].slice(0, 8);
  return {
    action: actionMatch ? actionMatch[1].toLowerCase().replace('optimise', 'optimize') : 'unspecified',
    target_kind: target,
    referenced_file_extensions: extensions,
    issue_reference_hashes: references,
    objective_fingerprint: `objective_${privateHash(privacySalt, value.toLowerCase().replace(/\s+/g, ' ').trim())}`
  };
}

function classifyFollowup(prompt) {
  const value = String(prompt || '').trim();
  if (/\b(?:wrong|incorrect|not what|you missed|should have|instead|regression|broke|failed)\b/i.test(value)) return 'correction';
  if (/^(?:retry|try again|redo|start over|fix that)\b/i.test(value)) return 'retry_request';
  if (/\b(?:clarify|to clarify|what i mean|specifically|in other words)\b/i.test(value)) return 'clarification';
  if (/\b(?:change scope|scope change|instead of|new direction|different approach)\b/i.test(value)) return 'scope_change';
  if (/\b(?:run|verify|validate|test|tests|lint|typecheck)\b/i.test(value)) return 'validation_request';
  if (/\b(?:also|additionally|one more|extend|while you are)\b/i.test(value)) return 'extension';
  if (/\b(?:new requirement|must now|needs to also)\b/i.test(value)) return 'new_requirement';
  if (/^(?:yes|approved|looks good|ship it|merge it|go ahead|proceed)\b/i.test(value)) return 'approval';
  if (/\?$/.test(value)) return 'question';
  return 'unknown';
}

function followupSignalMetadata(prompt, overlap) {
  const value = String(prompt || '').trim();
  return {
    correction_language: /\b(?:wrong|incorrect|not what|you missed|should have|instead|regression|broke|failed)\b/i.test(value),
    explicit_retry: /^(?:retry|try again|redo|start over|fix that)\b/i.test(value),
    clarification_language: /\b(?:clarify|to clarify|what i mean|specifically|in other words)\b/i.test(value),
    scope_change_language: /\b(?:change scope|scope change|instead of|new direction|different approach)\b/i.test(value),
    validation_language: /\b(?:run|verify|validate|test|tests|lint|typecheck)\b/i.test(value),
    extension_language: /\b(?:also|additionally|one more|extend|while you are)\b/i.test(value),
    new_requirement_language: /\b(?:new requirement|must now|needs to also)\b/i.test(value),
    approval_language: /^(?:yes|approved|looks good|ship it|merge it|go ahead|proceed)\b/i.test(value),
    question_form: /\?$/.test(value),
    material_change_request: /\b(?:fix|correct|redo|rewrite|repair|reimplement|change|update|replace|restore|try again|start over)\b/i.test(value),
    explanation_only: /^(?:can|could|would|will)\s+you\s+(?:explain|describe|tell me|show me why)\b/i.test(value)
      || /\b(?:explain why|why did|why is|what caused)\b/i.test(value),
    prior_task_term_overlap: typeof overlap === 'number' ? Number(overlap.toFixed(4)) : null
  };
}

function materialRequestMetadata(prompt, followup, isNewTask) {
  const value = String(prompt || '').trim();
  const signals = followupSignalMetadata(value, null);
  const implementationAction = /\b(?:add|build|change|configure|create|debug|delete|deploy|fix|implement|improve|install|migrate|optimi[sz]e|refactor|remove|rewrite|test|update|write)\b/i.test(value);
  const corrective = ['correction', 'retry_request'].includes(followup)
    && (signals.material_change_request || signals.explicit_retry)
    && !signals.explanation_only;
  return {
    requested: isNewTask ? implementationAction : corrective,
    corrective,
    confidence: corrective || (isNewTask && implementationAction) ? 0.9 : 0.35,
    trigger: corrective
      ? (followup === 'retry_request' ? 'explicit_retry_request' : 'developer_correction')
      : implementationAction ? 'developer_implementation_request' : 'non_material_request'
  };
}

function promptMetadata(prompt) {
  const value = String(prompt || '');
  const fileReferences = promptFileReferences(value);
  const metadata = {
    prompt_length_chars: Array.from(value).length,
    prompt_length_tokens_estimate: Math.ceil(Array.from(value).length / 4),
    contains_file_reference: fileReferences.length > 0,
    referenced_file_count: fileReferences.length,
    contains_acceptance_criteria: /\b(?:acceptance|done when|definition of done|success criteria|expected result|completed when|must be able to)\b/i.test(value),
    contains_constraints: /\b(?:must|should|do not|don't|without|compatible|keep|avoid|only|limit|required|out of scope)\b/i.test(value),
    contains_validation_request: /\b(?:test|tests|pytest|npm test|build|lint|typecheck|validate|check|verify|run)\b/i.test(value)
  };
  if (captureRawContent()) metadata.raw_prompt = redactRawContent(value);
  return metadata;
}

function promptFileReferences(prompt) {
  return [...String(prompt || '').matchAll(/(?:^|[\s`])([^\s`]+\.(?:ts|tsx|js|jsx|cjs|mjs|py|go|rs|java|json|md|css|html|ya?ml|toml|sql))\b/gi)]
    .map((match) => match[1]);
}

function contextContribution(eventName, payload) {
  let value;
  if (/UserPrompt/i.test(eventName)) value = getValue(payload, 'prompt', 'transformedPrompt', 'transformed_prompt');
  else if (/ToolUse/i.test(eventName)) value = getValue(payload, 'tool_response', 'tool_result', 'toolResult', 'error');
  else if (/Stop/i.test(eventName)) value = getValue(payload, 'last_assistant_message', 'response');
  if (value === undefined || value === null) return 0;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(Array.from(text).length / 4);
  } catch {
    return 0;
  }
}

function contextSnapshotPayload(session, checkpoint, extras = {}) {
  return {
    checkpoint,
    estimated_context_tokens: session.context_tokens_estimate || null,
    conversation_turns: session.conversation_turns,
    files_in_context: session.context_file_hashes?.length || null,
    previous_task_context_estimate: null,
    compaction_count: session.compaction_count,
    fresh_session: Boolean(extras.fresh_session),
    curated_handoff: Boolean(extras.curated_handoff),
    ...extras
  };
}

function latestLegacyObservations(logPath, sessionId) {
  if (!logPath) return { outcome: null, context: null };
  const records = readJsonlTail(logPath).filter((record) => record.sessionId === sessionId);
  return {
    outcome: [...records].reverse().find((record) => record.recordType === 'turn.outcome') || null,
    context: [...records].reverse().find((record) => record.recordType === 'context.load_snapshot') || null
  };
}

function taskContext(state, prompt, sessionId, context, emit) {
  const explicitTaskId = asString(getValue(context.raw_payload, 'task_id', 'taskId'));
  const terms = promptTerms(prompt);
  const followup = classifyFollowup(prompt);
  const controlPrompt = CONTROL_PROMPT.test(prompt) || TASK_ABANDON_PROMPT.test(prompt);
  const session = sessionState(state, sessionId);
  let active = taskForSession(state, sessionId) || state.active_task;
  const sessionOwnsActive = Boolean(active && session.task_id === active.task_id);
  let newTask = !active || (['completed', 'abandoned', 'superseded'].includes(active.state) && !controlPrompt);
  let confidence = active ? 0.8 : 1;
  let reasons = active ? ['active_task'] : ['no_active_task'];
  let overlap = active ? termOverlap(active.prompt_terms || [], terms) : null;

  if (active && explicitTaskId && explicitTaskId !== active.task_id) {
    newTask = true;
    confidence = 1;
    reasons = ['explicit_task_id'];
  } else if (active && ['completed', 'abandoned', 'superseded'].includes(active.state) && !controlPrompt) {
    newTask = true;
    confidence = 0.95;
    reasons = [`previous_task_${active.state}`];
  } else if (active && !controlPrompt && !CONTINUATION_PROMPT.test(prompt)
    && !['clarification', 'correction', 'retry_request', 'validation_request', 'approval', 'extension'].includes(followup)) {
    if ((active.prompt_terms || []).length >= 2 && terms.length >= 2 && overlap < 0.2) {
      newTask = true;
      confidence = overlap < 0.1 ? 0.9 : 0.75;
      reasons = ['low_semantic_overlap'];
    } else {
      confidence = Math.max(0.55, overlap);
      reasons = ['semantic_similarity'];
    }
  } else if (active) {
    newTask = false;
    confidence = 0.95;
    reasons = [controlPrompt ? 'control_reply' : 'explicit_continuation_or_followup'];
  }
  if (active?.branch && context.environment?.branch) {
    reasons.push(active.branch === context.environment.branch ? 'same_branch' : 'branch_changed');
  }
  if (active?.repository_id && active.repository_id === context.environment?.repository_id) reasons.push('same_repository');

  if (newTask) {
    if (active && sessionOwnsActive && !['completed', 'abandoned', 'superseded'].includes(active.state)) {
      emit('task_state_changed', { from: active.state, to: 'superseded', reason: 'new_objective_detected' }, {
        task_id: active.task_id
      });
      active.state = 'superseded';
    }
    active = {
      task_id: explicitTaskId || newId('task'),
      state: 'active',
      task_type: classifyTaskType(prompt),
      initial_complexity: classifyComplexity(prompt),
      objective: objectiveMetadata(prompt, state.privacy_salt),
      branch: context.environment?.branch || null,
      repository_id: context.environment?.repository_id || null,
      prompt_terms: terms,
      last_session_id: sessionId,
      created_at: context.timestamp
    };
    state.tasks[active.task_id] = active;
    state.active_task = active;
    session.task_id = active.task_id;
    emit('task_created', {
      task_type: active.task_type,
      initial_complexity: active.initial_complexity,
      fresh_session: session.interaction_count === 1,
      session_interaction_index: session.interaction_count,
      objective: active.objective,
      task_detection: {
        method: explicitTaskId ? 'explicit' : 'automatic',
        confidence,
        reason: reasons
      }
    }, { task_id: active.task_id });
    emit('task_state_changed', {
      from: 'created',
      to: 'active',
      reason: 'initial_prompt_submitted'
    }, { task_id: active.task_id });
    return { task: active, is_new: true, followup, term_overlap: overlap, match_confidence: confidence };
  }

  if (active.state === 'paused') {
    emit('task_state_changed', { from: 'paused', to: 'active', reason: 'developer_followup' }, {
      task_id: active.task_id
    });
    active.state = 'active';
  }
  emit('task_continued', { task_match_confidence: confidence, match_reason: reasons }, {
    task_id: active.task_id
  });
  const sessionChanged = Boolean(active.last_session_id && active.last_session_id !== sessionId);
  if (sessionChanged) {
    emit('session_changed', {
      previous_session_id: active.last_session_id,
      new_session_id: sessionId,
      transition_type: 'fresh_session',
      handoff_used: /code-buddy-handoff:/i.test(prompt)
    }, { task_id: active.task_id });
  }
  active.last_session_id = sessionId;
  active.branch = context.environment?.branch || active.branch || null;
  active.prompt_terms = [...new Set([...(active.prompt_terms || []), ...terms])].slice(-80);
  state.tasks[active.task_id] = active;
  state.active_task = active;
  session.task_id = active.task_id;
  return { task: active, is_new: false, followup, session_changed: sessionChanged, term_overlap: overlap, match_confidence: confidence };
}

function unwrapToolResult(value) {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      try { return unwrapToolResult(JSON.parse(value)); } catch { return null; }
    }
    return null;
  }
  if (value.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent;
  if (value.result && typeof value.result === 'object') {
    const nested = unwrapToolResult(value.result);
    if (nested) return nested;
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item && typeof item.text === 'string') {
        try { return unwrapToolResult(JSON.parse(item.text)); } catch { /* inspect the next item */ }
      }
    }
  }
  return value;
}

function normalizeToolName(value) {
  return asString(value).toLowerCase().replaceAll(/[^a-z0-9_-]/g, '');
}

function ratio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number((value > 1 ? value / 100 : value).toFixed(4));
}

function thresholdNumber(name, fallback) {
  const value = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(value) ? value : fallback;
}

function configuredThreshold(context, key, environmentName, fallback) {
  const explicit = context.thresholds?.[key];
  return typeof explicit === 'number' && Number.isFinite(explicit)
    ? explicit
    : thresholdNumber(environmentName, fallback);
}

function recommendationKey(taskId, recommendationType) {
  return `${taskId || 'unknown'}:${recommendationType}`;
}

function showRecommendation(state, context, emit, type, details) {
  const key = recommendationKey(context.task_id, type);
  const existing = state.recommendations[key];
  if (existing && existing.interaction_id === context.interaction_id) return existing;
  const recommendation = {
    recommendation_id: newId('rec'),
    recommendation_type: type,
    interaction_id: context.interaction_id,
    task_id: context.task_id
  };
  state.recommendations[key] = recommendation;
  emit('recommendation_shown', {
    recommendation_id: recommendation.recommendation_id,
    recommendation_type: type,
    reason: details.reason || null,
    source_check: details.source_check || null,
    source_score: details.source_score ?? null,
    suggested_action: details.suggested_action || type
  });
  return recommendation;
}

function applyAcceptedRecommendation(state, context, emit, type, evidence) {
  const recommendation = state.recommendations[recommendationKey(context.task_id, type)];
  if (!recommendation || recommendation.decision !== 'accepted' || recommendation.applied) return false;
  emit('recommendation_applied', {
    recommendation_id: recommendation.recommendation_id,
    recommendation_type: type,
    application_status: 'applied',
    evidence
  });
  recommendation.applied = true;
  return true;
}

function handlePreflightTool(state, context, emit, toolName, toolResult) {
  if (!context.interaction_id || !toolResult) return;
  const preflight = state.preflights[context.interaction_id] ||= { emitted: false };
  const normalized = normalizeToolName(toolName);
  if (/review_prompt|reviewprompt|promptreviewer/.test(normalized)) {
    const score = ratio(toolResult.score);
    const threshold = ratio(configuredThreshold(context, 'prompt_quality', 'TOKEN_LENS_PROMPT_REVIEW_THRESHOLD', 75));
    const intervene = Boolean(toolResult.interventionRecommended) || (score !== null && score < threshold);
    preflight.prompt_quality = { score, threshold, decision: intervene ? 'intervene' : 'continue' };
    if (intervene) showRecommendation(state, context, emit, 'enhance_prompt', {
      source_check: 'prompt_quality', source_score: score, reason: toolResult.issues?.[0]?.reason || 'prompt_quality_below_threshold'
    });
  } else if (/decompose_task|decomposetask|taskdecomposer/.test(normalized)) {
    const score = ratio(toolResult.complexityScore);
    const threshold = ratio(configuredThreshold(context, 'task_decomposition', 'TOKEN_LENS_TASK_DECOMPOSITION_THRESHOLD', 65));
    const intervene = Boolean(toolResult.decompositionRecommended) || (score !== null && score >= threshold);
    preflight.task_decomposition = { score, threshold, decision: intervene ? 'recommend_decomposition' : 'continue' };
    if (intervene) showRecommendation(state, context, emit, 'decompose_task', {
      source_check: 'task_decomposition', source_score: score, reason: toolResult.reasons?.[0] || 'task_complexity_above_threshold'
    });
  } else if (/measure_context|measurecontext|contextmeasurement/.test(normalized)) {
    const score = ratio(toolResult.measurement?.utilization);
    const threshold = configuredThreshold(context, 'context_pressure', 'TOKEN_LENS_CONTEXT_WARNING_THRESHOLD', 0.70);
    const intervene = toolResult.recommendation === 'curate_or_start_fresh' || (score !== null && score >= threshold);
    preflight.context_pressure = { score, threshold, decision: intervene ? 'recommend_context_reduction' : 'continue' };
    const measurement = toolResult.measurement || {};
    const session = sessionState(state, context.session_id);
    if (measurement.unit === 'estimated_tokens' && typeof measurement.value === 'number') {
      session.context_tokens_estimate = measurement.value;
    }
    emit('context_snapshot', contextSnapshotPayload(session, 'preflight_measurement', {
      estimated_context_tokens: measurement.unit === 'estimated_tokens' && typeof measurement.value === 'number'
        ? measurement.value
        : null,
      actual_context_tokens: measurement.unit === 'tokens' && typeof measurement.value === 'number'
        ? measurement.value
        : null,
      measurement_method: measurement.method || null,
      measurement_confidence: measurement.confidence || null,
      measurement_terminology: measurement.terminology || null,
      measurement_timestamp: measurement.measurementTimestamp || null,
      measurement_provider_id: measurement.providerId || null,
      model_context_window_tokens: typeof measurement.capacity === 'number' ? measurement.capacity : null,
      context_utilization: typeof measurement.utilization === 'number' ? measurement.utilization : null,
      cached_input_tokens: typeof measurement.cachedInputTokens === 'number' ? measurement.cachedInputTokens : null,
      cache_write_input_tokens: typeof measurement.cacheWriteInputTokens === 'number' ? measurement.cacheWriteInputTokens : null,
      output_tokens: typeof measurement.outputTokens === 'number' ? measurement.outputTokens : null,
      reasoning_tokens: typeof measurement.reasoningTokens === 'number' ? measurement.reasoningTokens : null,
      total_tokens: typeof measurement.totalTokens === 'number' ? measurement.totalTokens : null,
      cumulative_usage: measurement.cumulativeUsage && typeof measurement.cumulativeUsage === 'object'
        ? measurement.cumulativeUsage
        : null
    }));
    if (intervene) showRecommendation(state, context, emit, 'reduce_context', {
      source_check: 'context_pressure', source_score: score, reason: toolResult.measurement?.thresholdState || 'context_pressure_above_threshold'
    });
  } else if (/assess_session_fit|assesssessionfit|sessionfit/.test(normalized)) {
    const score = ratio(toolResult.newTaskLikelihood);
    const threshold = ratio(configuredThreshold(context, 'session_fit', 'TOKEN_LENS_SESSION_FIT_THRESHOLD', 75));
    const intervene = Boolean(toolResult.freshTaskRecommended) || (score !== null && score >= threshold);
    preflight.session_fit = { score, threshold, decision: intervene ? 'recommend_new_session' : 'continue' };
    if (intervene) showRecommendation(state, context, emit, 'start_fresh_session', {
      source_check: 'session_fit', source_score: score, reason: toolResult.reason || 'session_fit_above_threshold'
    });
  } else {
    return;
  }
  if (!preflight.emitted && preflight.prompt_quality && preflight.task_decomposition
    && preflight.context_pressure && preflight.session_fit) {
    preflight.emitted = true;
    emit('preflight_completed', {
      prompt_quality: preflight.prompt_quality,
      task_decomposition: preflight.task_decomposition,
      context_pressure: preflight.context_pressure,
      session_fit: preflight.session_fit
    });
  }
}

function mapDecisionEvent(eventType, data) {
  const type = String(eventType || '');
  let recommendationType = null;
  if (/prompt\.review_choice/.test(type)) recommendationType = 'enhance_prompt';
  else if (/task\.decomposition_choice/.test(type)) recommendationType = 'decompose_task';
  else if (/session\.(?:fit|boundary)_choice/.test(type)) recommendationType = 'start_fresh_session';
  else if (/context\.(?:curation|handoff)_choice/.test(type)) recommendationType = 'create_handoff';
  if (!recommendationType) return null;
  const explicit = asString(data?.decision).toLowerCase();
  if (RECOMMENDATION_DECISIONS.has(explicit)) return { recommendationType, decision: explicit };
  const selected = asString(data?.selectedOptionId || data?.strategyId || data?.selectedAction).toLowerCase();
  if (/original|continue unchanged|without prior context|reject/.test(selected)) return { recommendationType, decision: 'rejected' };
  if (/modified/.test(selected)) return { recommendationType, decision: 'modified' };
  if (/dismiss|cancel/.test(selected)) return { recommendationType, decision: 'dismissed' };
  return { recommendationType, decision: selected || data?.developerConfirmed === true ? 'accepted' : 'unknown' };
}

function handleRecommendationDecision(state, context, emit, toolName, toolInput) {
  if (!/record_intervention|recordintervention/.test(normalizeToolName(toolName)) || !toolInput || typeof toolInput !== 'object') return;
  const mapped = mapDecisionEvent(toolInput.eventType, toolInput.data || {});
  if (!mapped) return;
  let recommendation = state.recommendations[recommendationKey(context.task_id, mapped.recommendationType)];
  if (!recommendation) {
    recommendation = showRecommendation(state, context, emit, mapped.recommendationType, {
      reason: 'external_recommendation_decision', suggested_action: mapped.recommendationType
    });
  }
  const selectionId = asString(toolInput.data?.selectedOptionId || toolInput.data?.strategyId
    || toolInput.data?.selectedAction || toolInput.data?.selectedStepId || toolInput.data?.stepId) || null;
  emit('recommendation_decision', {
    recommendation_id: recommendation.recommendation_id,
    recommendation_type: mapped.recommendationType,
    decision: mapped.decision,
    selection_id: selectionId,
    application_status: mapped.decision === 'accepted' ? 'pending_or_not_observable' : 'not_applied'
  });
  recommendation.decision = mapped.decision;
  recommendation.selection_id = selectionId;
  const active = taskById(state, context.task_id);
  if (active && mapped.recommendationType === 'decompose_task' && mapped.decision === 'accepted') {
    active.pending_decomposition = {
      recommendation_id: recommendation.recommendation_id,
      strategy_id: asString(toolInput.data?.strategyId || toolInput.data?.selectedStrategyId || selectionId) || null,
      step_id: asString(toolInput.data?.stepId || toolInput.data?.selectedStepId) || null
    };
  }
}

function findUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  const number = (...keys) => {
    for (const key of keys) if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
    return null;
  };
  const usage = {
    input_tokens: number('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'),
    cached_input_tokens: number('cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens'),
    output_tokens: number('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'),
    reasoning_tokens: number('reasoning_tokens', 'reasoningTokens'),
    ai_credits: number('ai_credits', 'aiCredits'),
    estimated_cost: null
  };
  if (Object.entries(usage).some(([key, item]) => key !== 'estimated_cost' && item !== null)) return usage;
  for (const child of Object.values(value)) {
    const nested = findUsage(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function extractCommand(input) {
  if (!input || typeof input !== 'object') return '';
  const command = getValue(input, 'cmd', 'command', 'script', 'shellCommand');
  if (typeof command === 'string') return command;
  for (const value of Object.values(input)) {
    if (value && typeof value === 'object') {
      const nested = extractCommand(value);
      if (nested) return nested;
    }
  }
  return '';
}

function resultText(value) {
  if (typeof value === 'string') return value.slice(0, 250_000);
  try { return JSON.stringify(value).slice(0, 250_000); } catch { return ''; }
}

function toolSucceeded(eventName, result) {
  if (/Failure/i.test(eventName)) return false;
  if (!result || typeof result !== 'object') return true;
  const exitCode = getValue(result, 'exit_code', 'exitCode', 'statusCode');
  if (typeof exitCode === 'number') return exitCode === 0;
  const explicit = getValue(result, 'success', 'ok');
  if (typeof explicit === 'boolean') return explicit;
  if (result.isError === true) return false;
  if (result.result && typeof result.result === 'object') return toolSucceeded(eventName, result.result);
  return true;
}

function parseTestResult(text, success, duration, command = '') {
  const number = (pattern) => {
    const match = text.match(pattern);
    return match ? Number.parseInt(match[1], 10) : null;
  };
  let passed = number(/(?:^|[,\s])([0-9]+)\s+passed\b/i) ?? number(/#\s*pass\s+([0-9]+)/i);
  let failed = number(/(?:^|[,\s])([0-9]+)\s+failed\b/i) ?? number(/#\s*fail\s+([0-9]+)/i);
  let skipped = number(/(?:^|[,\s])([0-9]+)\s+(?:skipped|pending)\b/i) ?? number(/#\s*skipped\s+([0-9]+)/i);
  const testsRun = number(/#\s*tests\s+([0-9]+)/i)
    ?? number(/Tests:\s+(?:[0-9]+\s+failed,\s*)?(?:[0-9]+\s+passed,\s*)?([0-9]+)\s+total/i)
    ?? ([passed, failed, skipped].some((item) => item !== null) ? (passed || 0) + (failed || 0) + (skipped || 0) : null);
  if (passed === null && testsRun !== null && success && (failed === null || failed === 0)) passed = testsRun;
  if (failed === null && success) failed = 0;
  if (skipped === null && testsRun !== null) skipped = 0;
  const evidence = `${command}\n${text}`;
  const framework = /pytest|py\.test/i.test(evidence) ? 'pytest'
    : /vitest/i.test(evidence) ? 'vitest'
      : /jest/i.test(evidence) ? 'jest'
        : /cargo\s+test/i.test(evidence) ? 'cargo-test'
          : /go\s+test/i.test(evidence) ? 'go-test'
            : /TAP version|#\s*tests|node\s+--test/i.test(evidence) ? 'node-test'
              : /npm|pnpm|yarn/i.test(command) ? 'package-script' : null;
  return { framework, tests_run: testsRun, passed, failed, skipped, duration_ms: duration };
}

function fileCandidates(input, found = []) {
  if (!input) return found;
  if (typeof input === 'string') {
    for (const match of input.matchAll(/^\*\*\*\s+(Add|Update|Delete) File:\s+(.+)$/gmi)) {
      found.push({ operation: match[1].toLowerCase() === 'add' ? 'created' : match[1].toLowerCase() === 'delete' ? 'deleted' : 'modified', path: match[2].trim() });
    }
    return found;
  }
  if (Array.isArray(input)) {
    for (const item of input) fileCandidates(item, found);
    return found;
  }
  if (typeof input !== 'object') return found;
  for (const key of ['path', 'file', 'filePath', 'filepath', 'target']) {
    if (typeof input[key] === 'string' && input[key].length < 4096) {
      found.push({ operation: null, path: input[key] });
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (!['path', 'file', 'filePath', 'filepath', 'target'].includes(key)) fileCandidates(value, found);
  }
  return found;
}

function toolType(toolName) {
  if (TERMINAL_TOOL.test(toolName)) return 'terminal';
  if (FILE_TOOL.test(toolName)) return 'file';
  if (/search|find|grep|read|open|list/.test(toolName)) return 'observation';
  if (/code.?buddy/.test(toolName)) return 'code_buddy';
  return 'other';
}

function operationFor(toolName, command) {
  if (TEST_COMMAND.test(command)) return 'test';
  if (BUILD_COMMAND.test(command)) return 'build';
  if (/\bgit\s+commit\b/i.test(command)) return 'git_commit';
  if (/\bgit\s+(?:switch|checkout)\b/i.test(command)) return 'git_branch_change';
  if (/\bgit\s+merge\b/i.test(command)) return 'git_merge';
  if (/\bgit\s+revert\b/i.test(command)) return 'git_revert';
  if (FILE_TOOL.test(toolName)) return 'file_change';
  return toolType(toolName) === 'terminal' ? 'command' : 'invoke';
}

function durationFrom(payload) {
  const value = getValue(payload, 'duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs');
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

function completeTask(state, context, emit, method, confidence) {
  const active = taskById(state, context.task_id);
  if (!active || active.state === 'completed') return;
  emit('task_completed', { completion_method: method, completion_confidence: confidence });
  emit('task_state_changed', { from: active.state, to: 'completed', reason: method });
  active.state = 'completed';
}

function handleEngineeringActivity(state, context, emit, toolName, toolInput, toolResult, success, payload) {
  const normalized = normalizeToolName(toolName);
  const command = extractCommand(toolInput);
  const operation = operationFor(normalized, command);
  const duration = durationFrom(payload);
  emit('tool_activity', { tool_type: toolType(normalized), operation, success, duration_ms: duration });

  const session = sessionState(state, context.session_id);
  const active = taskById(state, context.task_id);
  if (session.activity) {
    session.activity.tools_invoked = (session.activity.tools_invoked || 0) + 1;
    session.activity.files_read ||= 0;
    session.activity.read_file_hashes ||= [];
    session.activity.material_evidence ||= [];
    if (success && operation === 'file_change' && !session.activity.material_evidence.includes('successful_file_change')) {
      session.activity.material_evidence.push('successful_file_change');
    }
  }
  const toolFiles = fileCandidates(toolInput);
  for (const candidate of toolFiles) {
    if (!candidate.path) continue;
    const fileHash = `file_${privateHash(state.privacy_salt, path.normalize(candidate.path))}`;
    session.context_file_hashes ||= [];
    if (!session.context_file_hashes.includes(fileHash)) session.context_file_hashes.push(fileHash);
    if (session.activity && toolType(normalized) === 'observation'
      && !session.activity.read_file_hashes.includes(fileHash)) {
      session.activity.read_file_hashes.push(fileHash);
      session.activity.files_read += 1;
    }
  }

  if (FILE_TOOL.test(normalized)) {
    const candidates = toolFiles;
    const observedFiles = candidates.length ? candidates : [{ operation: null, path: '' }];
    const seen = new Set();
    for (const candidate of observedFiles) {
      const normalizedPath = candidate.path ? path.normalize(candidate.path) : '';
      if (normalizedPath && seen.has(normalizedPath)) continue;
      if (normalizedPath) seen.add(normalizedPath);
      const extension = normalizedPath ? path.extname(normalizedPath).toLowerCase() || null : null;
      const fileHash = normalizedPath ? `file_${privateHash(state.privacy_salt, normalizedPath)}` : null;
      emit('file_activity', {
        operation: candidate.operation || (/delete/.test(normalized) ? 'deleted' : /create|write/.test(normalized) ? 'created' : 'modified'),
        file_hash: fileHash,
        file_extension: extension,
        lines_added: null,
        lines_removed: null
      });
      if (session.activity && success) {
        session.activity.file_hashes ||= [];
        if (!fileHash || !session.activity.file_hashes.includes(fileHash)) {
          session.activity.files_modified = (session.activity.files_modified || 0) + 1;
        }
        if (fileHash && !session.activity.file_hashes.includes(fileHash)) session.activity.file_hashes.push(fileHash);
      }
    }
  }

  const text = resultText(toolResult);
  if (TEST_COMMAND.test(command)) {
    const testResult = parseTestResult(text, success, duration, command);
    emit('test_run', testResult);
    if (active) {
      if (active.last_test_failed === true && testResult.failed === 0 && testResult.passed !== null && session.activity) {
        if (!session.activity.material_evidence.includes('failed_test_repaired')) {
          session.activity.material_evidence.push('failed_test_repaired');
        }
      }
      if (typeof testResult.failed === 'number') active.last_test_failed = testResult.failed > 0;
    }
  }
  if (BUILD_COMMAND.test(command)) {
    const errorCount = (text.match(/(?:^|\s)error(?:\s|:|\[)/gi) || []).length;
    const buildResult = success ? 'passed' : 'failed';
    emit('build_run', { result: buildResult, duration_ms: duration, error_count: errorCount || (success ? 0 : null) });
    if (active) {
      if (active.last_build_failed === true && buildResult === 'passed' && session.activity
        && !session.activity.material_evidence.includes('failed_build_repaired')) {
        session.activity.material_evidence.push('failed_build_repaired');
      }
      active.last_build_failed = buildResult === 'failed';
    }
  }

  let gitEventType = null;
  if (/\bgit\s+commit\b/i.test(command)) gitEventType = /--amend\b/i.test(command) ? 'commit_amended' : 'commit_created';
  else if (/\bgit\s+revert\b/i.test(command)) gitEventType = 'commit_reverted';
  else if (/\bgit\s+(?:switch|checkout)\b/i.test(command)) gitEventType = 'branch_changed';
  else if (/\bgit\s+merge\b/i.test(command)) gitEventType = 'merge';
  if (gitEventType && success) {
    const workspace = context.workspace;
    emit('git_event', {
      git_event_type: gitEventType,
      commit_hash: /commit/.test(gitEventType) ? runGit(workspace, ['rev-parse', '--short=12', 'HEAD']) || null : null,
      files_changed: null,
      lines_added: null,
      lines_removed: null
    });
    if (session.activity && /commit/.test(gitEventType)
      && !session.activity.material_evidence.includes('successful_commit')) {
      session.activity.material_evidence.push('successful_commit');
    }
    if (gitEventType === 'commit_created' || gitEventType === 'commit_amended') completeTask(state, context, emit, 'commit_detected', 0.9);
    if (gitEventType === 'branch_changed') {
      const branch = runGit(workspace, ['branch', '--show-current']);
      if (branch) context.environment.branch = branch;
    }
  }
}

function abandonOrCompleteFromPrompt(state, context, emit, prompt) {
  const active = taskById(state, context.task_id);
  if (!active) return;
  if (TASK_ABANDON_PROMPT.test(prompt)
    || /\b(?:task no longer needed|never mind this task)\b/i.test(prompt)) {
    emit('task_abandoned', { reason: 'task_no_longer_needed' });
    emit('task_state_changed', { from: active.state, to: 'abandoned', reason: 'developer_declared' });
    active.state = 'abandoned';
  } else if (/^(?:done|approved|looks good|ship it|task complete|task is complete|all good)(?:[,!.\s]|$)/i.test(prompt)) {
    completeTask(state, context, emit, 'developer_confirmed', 1);
  }
}

function observeImplementationAttempt(state, context, emit, session, responseObserved) {
  const active = taskById(state, context.task_id);
  const activity = session.activity;
  if (!active || !activity) return null;
  const evidence = [...new Set(activity.material_evidence || [])];
  const strong = evidence.length > 0;
  if (responseObserved && activity.material_request?.requested) evidence.push('agent_response');
  if (!evidence.length) return null;
  const confidence = strong ? 0.95 : Math.min(0.8, activity.material_request.confidence || 0.75);
  active.material_attempt_count = (active.material_attempt_count || 0) + 1;
  const attempt = {
    attempt_id: newId('attempt'),
    attempt_number: active.material_attempt_count,
    attempt_kind: activity.pending_retry?.eligible ? 'human_retry' : active.material_attempt_count === 1 ? 'initial' : 'followup',
    evidence,
    confidence,
    detector_version: HUMAN_RETRY_DETECTOR_VERSION
  };
  emit('implementation_attempt_observed', attempt);

  const pending = activity.pending_retry;
  if (pending?.eligible && pending.prior_attempt_id) {
    active.human_retry_count = (active.human_retry_count || 0) + 1;
    emit('human_retry_detected', {
      human_retry_id: newId('human_retry'),
      source_followup_event_id: pending.source_followup_event_id,
      attempt_id: attempt.attempt_id,
      prior_attempt_id: pending.prior_attempt_id,
      human_retry_number: active.human_retry_count,
      implementation_attempt_number: attempt.attempt_number,
      classification: pending.classification,
      classification_confidence: pending.classification_confidence,
      task_match_confidence: pending.task_match_confidence,
      material_attempt_confidence: confidence,
      trigger: pending.trigger,
      detector_version: HUMAN_RETRY_DETECTOR_VERSION
    });
  }

  if (active.pending_decomposition) {
    applyAcceptedRecommendation(state, context, emit, 'decompose_task', {
      strategy_id: active.pending_decomposition.strategy_id,
      step_id: active.pending_decomposition.step_id,
      attempt_id: attempt.attempt_id
    });
    active.pending_decomposition = null;
  }
  active.last_material_attempt_id = attempt.attempt_id;
  active.last_material_attempt_interaction_id = context.interaction_id;
  return attempt;
}

function captureHookEvent(payload, options = {}) {
  let releaseLock = () => {};
  try {
    const level = telemetryLevel();
    if (level === 'off') return { captured: false, reason: 'disabled' };
    const workspace = workspaceFrom(payload);
    const root = telemetryRoot(workspace);
    releaseLock = acquireTelemetryLock(root);
    const state = loadState(root);
    const eventName = asString(getValue(payload, 'hook_event_name', 'hookEventName')) || 'unknown';
    const sessionId = asString(getValue(payload, 'session_id', 'sessionId')) || 'unknown';
    const timestamp = isoTimestamp(getValue(payload, 'timestamp'));
    const session = sessionState(state, sessionId);
    const hookKey = hookDeduplicationKey(payload, eventName, sessionId);
    if (state.seen_hook_events.includes(hookKey)) {
      return { captured: true, duplicate: true, root, emitted: [] };
    }
    state.seen_hook_events.push(hookKey);
    if (state.seen_hook_events.length > 5000) state.seen_hook_events = state.seen_hook_events.slice(-5000);
    const context = {
      workspace,
      raw_payload: payload,
      timestamp,
      session_id: sessionId,
      task_id: taskForSession(state, sessionId)?.task_id || state.active_task?.task_id || null,
      interaction_id: session.current_interaction_id,
      developer_id: developerId(state),
      platform: options.platform || 'unknown',
      thresholds: options.thresholds || null,
      environment: environmentFor(workspace, state, {
        ...options,
        refreshBranch: /^(?:SessionStart|sessionStart|UserPromptSubmit|userPromptSubmitted)$/.test(eventName)
      })
    };
    const observedModel = asString(getValue(payload, 'model', 'model_name', 'modelName'));
    if (observedModel) session.model = observedModel;
    const emitted = [];
    const emit = (type, eventPayload, overrides = {}) => {
      const record = appendEvent(root, state, context, type, eventPayload, overrides);
      if (record) emitted.push(record);
      return record;
    };

    session.context_tokens_estimate += contextContribution(eventName, payload);

    if (/^(?:SessionStart|sessionStart)$/.test(eventName)) {
      emit('context_snapshot', contextSnapshotPayload(session, 'session_start', { fresh_session: true }), {
        task_id: context.task_id,
        interaction_id: null
      });
    } else if (/^(?:UserPromptSubmit|userPromptSubmitted)$/.test(eventName)) {
      const prompt = asString(getValue(payload, 'prompt'));
      if (!prompt) {
        saveState(root, state);
        return { captured: true, emitted };
      }
      const hasTask = Boolean(taskForSession(state, sessionId) || state.active_task);
      session.interaction_count += 1;
      session.conversation_turns += 1;
      session.current_interaction_id = newId('interaction');
      context.interaction_id = session.current_interaction_id;
      const taskMatch = taskContext(state, prompt, sessionId, context, emit);
      context.task_id = taskMatch.task.task_id;
      const materialRequest = materialRequestMetadata(prompt, taskMatch.followup, taskMatch.is_new);
      if (taskMatch.session_changed) {
        applyAcceptedRecommendation(state, context, emit, 'start_fresh_session', {
          transition: 'fresh_session',
          curated_handoff: /code-buddy-handoff:/i.test(prompt)
        });
      }
      session.activity = {
        started_at: timestamp,
        tools_invoked: 0,
        files_modified: 0,
        file_hashes: [],
        files_read: 0,
        read_file_hashes: [],
        material_evidence: [],
        material_request: materialRequest,
        pending_retry: null
      };
      session.context_file_hashes ||= [];
      for (const reference of promptFileReferences(prompt)) {
        const fileHash = `file_${privateHash(state.privacy_salt, path.normalize(reference))}`;
        if (!session.context_file_hashes.includes(fileHash)) session.context_file_hashes.push(fileHash);
      }
      emit('prompt_submitted', promptMetadata(prompt));
      if (!taskMatch.is_new && hasTask) {
        const followupRecord = emit('developer_followup', {
          classification: FOLLOWUP_CLASSIFICATIONS.has(taskMatch.followup) ? taskMatch.followup : 'unknown',
          classification_confidence: taskMatch.followup === 'unknown' ? 0.4 : 0.85,
          prompt_length_tokens_estimate: Math.ceil(Array.from(prompt).length / 4),
          objective_relation: ['correction', 'retry_request', 'clarification', 'validation_request', 'approval'].includes(taskMatch.followup)
            ? 'same_objective'
            : ['extension', 'new_requirement'].includes(taskMatch.followup) ? 'expanded_objective'
              : taskMatch.followup === 'scope_change' ? 'changed_objective' : 'uncertain',
          material_change_requested: materialRequest.requested,
          task_match_confidence: taskMatch.match_confidence,
          classifier_version: HUMAN_RETRY_DETECTOR_VERSION,
          signals: followupSignalMetadata(prompt, taskMatch.term_overlap)
        });
        if (taskMatch.followup === 'correction' || taskMatch.followup === 'retry_request') {
          emit('retry_detected', {
            retry_type: taskMatch.followup === 'correction' ? 'implementation_retry' : 'approach_retry',
            confidence: 0.85,
            trigger: taskMatch.followup === 'correction' ? 'developer_correction' : 'explicit_retry_request'
          });
          session.activity.pending_retry = {
            eligible: materialRequest.corrective && taskMatch.match_confidence >= 0.75,
            source_followup_event_id: followupRecord?.event_id || null,
            prior_attempt_id: taskMatch.task.last_material_attempt_id || null,
            classification: taskMatch.followup,
            classification_confidence: taskMatch.followup === 'unknown' ? 0.4 : 0.85,
            task_match_confidence: taskMatch.match_confidence,
            trigger: materialRequest.trigger
          };
        }
        if (['scope_change', 'extension', 'new_requirement'].includes(taskMatch.followup)) {
          emit('scope_changed', {
            direction: taskMatch.followup === 'scope_change' ? 'changed' : 'expanded',
            estimated_previous_scope: taskMatch.task.initial_complexity,
            estimated_new_scope: taskMatch.followup === 'scope_change' ? 'unknown' : 'large'
          });
        }
      }
      emit('context_snapshot', contextSnapshotPayload(session, taskMatch.is_new ? 'task_start' : 'before_agent_execution', {
        fresh_session: Boolean(taskMatch.session_changed),
        curated_handoff: /code-buddy-handoff:/i.test(prompt)
      }));
      abandonOrCompleteFromPrompt(state, context, emit, prompt);
    } else if (/^(?:UserPromptTransformed|userPromptTransformed)$/.test(eventName)) {
      context.task_id = taskForSession(state, sessionId)?.task_id || context.task_id;
      context.interaction_id = session.current_interaction_id;
      applyAcceptedRecommendation(state, context, emit, 'enhance_prompt', {
        transformation_observed: true
      });
    } else if (/^(?:PostToolUse|postToolUse|PostToolUseFailure|postToolUseFailure)$/.test(eventName)) {
      context.task_id = taskForSession(state, sessionId)?.task_id || context.task_id;
      context.interaction_id = session.current_interaction_id;
      const toolName = getValue(payload, 'tool_name', 'toolName');
      const toolInput = getValue(payload, 'tool_input', 'toolArgs') || {};
      const explicitToolTaskId = asString(getValue(toolInput, 'taskId', 'task_id'));
      if (taskById(state, explicitToolTaskId)) context.task_id = explicitToolTaskId;
      const rawResult = getValue(payload, 'tool_response', 'tool_result', 'toolResult');
      const success = toolSucceeded(eventName, rawResult);
      const toolResult = unwrapToolResult(rawResult);
      handlePreflightTool(state, context, emit, toolName, toolResult);
      handleRecommendationDecision(state, context, emit, toolName, toolInput);
      handleEngineeringActivity(state, context, emit, toolName, toolInput, rawResult, success, payload);
      if (/curate_context|curatecontext|contextcurator/.test(normalizeToolName(toolName)) && toolResult) {
        const source = toolResult.sourceContextTokensEstimate ?? session.context_tokens_estimate;
        const handoff = toolResult.handoffTokensEstimate ?? null;
        emit('handoff_created', {
          source_context_tokens_estimate: source || null,
          handoff_tokens_estimate: handoff,
          compression_ratio: source && handoff !== null ? Number((handoff / source).toFixed(4)) : null
        });
        applyAcceptedRecommendation(state, context, emit, 'create_handoff', {
          handoff_observed: true,
          mode: toolInput.mode || null
        });
      }
    } else if (/^(?:PreCompact|preCompact)$/.test(eventName)) {
      session.pending_compaction = {
        before: session.context_tokens_estimate || null,
        timestamp,
        task_id: context.task_id,
        interaction_id: context.interaction_id
      };
      emit('context_snapshot', contextSnapshotPayload(session, 'before_compaction'));
    } else if (/^(?:PostCompact|postCompact)$/.test(eventName)) {
      session.compaction_count += 1;
      const afterValue = getValue(payload, 'context_after_tokens_estimate', 'contextAfterTokensEstimate', 'context_tokens', 'contextTokens');
      const after = typeof afterValue === 'number' ? afterValue : null;
      if (after !== null) session.context_tokens_estimate = after;
      emit('conversation_compacted', {
        context_before_tokens_estimate: session.pending_compaction?.before ?? null,
        context_after_tokens_estimate: after,
        compaction_number: session.compaction_count
      });
      emit('context_snapshot', contextSnapshotPayload(session, 'after_compaction'));
      session.pending_compaction = null;
    } else if (/^(?:Stop|agentStop)$/.test(eventName)) {
      context.task_id = taskForSession(state, sessionId)?.task_id || context.task_id;
      context.interaction_id = session.current_interaction_id;
      const legacy = latestLegacyObservations(options.legacyLogPath, sessionId);
      const isNewOutcome = Boolean(legacy.outcome?.eventId && legacy.outcome.eventId !== session.last_outcome_event_id);
      const outcomeMetrics = isNewOutcome ? legacy.outcome?.data?.metrics : null;
      if (isNewOutcome) {
        session.last_outcome_event_id = legacy.outcome.eventId;
        if (typeof outcomeMetrics?.filesChanged === 'number' && outcomeMetrics.filesChanged > 0 && session.activity
          && !session.activity.material_evidence.includes('observed_worktree_delta')) {
          session.activity.material_evidence.push('observed_worktree_delta');
        }
        for (const file of outcomeMetrics?.changedFiles || []) {
          const relativePath = asString(file.path);
          emit('file_activity', {
            operation: file.change === 'added' ? 'created' : file.change === 'deleted' ? 'deleted' : 'modified',
            file_hash: relativePath ? `file_${privateHash(state.privacy_salt, path.normalize(relativePath))}` : null,
            file_extension: relativePath ? path.extname(relativePath).toLowerCase() || null : null,
            lines_added: typeof file.linesAdded === 'number' ? file.linesAdded : null,
            lines_removed: typeof file.linesDeleted === 'number' ? file.linesDeleted : null,
            source: 'observed_worktree_delta'
          });
        }
      }
      const contextEstimate = legacy.context?.data?.estimatedContextPressure?.value;
      if (typeof contextEstimate === 'number' && Number.isFinite(contextEstimate)) {
        session.context_tokens_estimate = contextEstimate;
      }
      const started = session.activity?.started_at ? new Date(session.activity.started_at).getTime() : NaN;
      const ended = new Date(timestamp).getTime();
      const rawResponse = getValue(payload, 'last_assistant_message', 'response');
      emit('agent_response', {
        response_tokens: (() => {
          return rawResponse ? Math.ceil(Array.from(String(rawResponse)).length / 4) : null;
        })(),
        model: getValue(payload, 'model') || session.model || null,
        tools_invoked: session.activity?.tools_invoked ?? null,
        files_read: session.activity?.files_read ?? null,
        files_modified: typeof outcomeMetrics?.filesChanged === 'number'
          ? outcomeMetrics.filesChanged
          : session.activity?.files_modified ?? null,
        execution_duration_ms: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null
      });
      observeImplementationAttempt(state, context, emit, session, Boolean(rawResponse));
      emit('context_snapshot', contextSnapshotPayload(session, 'after_agent_response'));
      session.activity = null;
    } else if (/^(?:SessionEnd|sessionEnd)$/.test(eventName)) {
      const active = taskForSession(state, sessionId);
      if (active && active.last_session_id === sessionId && active.state === 'active') {
        context.task_id = active.task_id;
        emit('task_state_changed', { from: 'active', to: 'paused', reason: 'session_ended' }, { interaction_id: null });
        active.state = 'paused';
      }
    }

    const usage = findUsage(payload);
    if (usage) {
      context.task_id = taskForSession(state, sessionId)?.task_id || context.task_id;
      context.interaction_id = session.current_interaction_id;
      emit('ai_usage', { model: getValue(payload, 'model') || session.model || null, ...usage });
    }

    saveState(root, state);
    return { captured: true, root, emitted };
  } catch (error) {
    return { captured: false, reason: 'telemetry_failure', error: error instanceof Error ? error.message : String(error) };
  } finally {
    releaseLock();
  }
}

function telemetryFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return [resolved];
  const candidates = [
    path.join(resolved, 'raw'),
    path.join(resolved, '.code-buddy', 'telemetry', 'raw'),
    resolved
  ];
  const directory = candidates.find((candidate) => fs.existsSync(candidate)
    && fs.statSync(candidate).isDirectory()
    && fs.readdirSync(candidate).some((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)));
  if (!directory) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function validateTelemetryEvent(value) {
  const errors = [];
  if (!value || typeof value !== 'object') return ['event must be an object'];
  if (!SUPPORTED_TELEMETRY_SCHEMA_VERSIONS.has(value.schema_version)) errors.push('unsupported schema_version');
  for (const field of ['event_id', 'event_type', 'timestamp', 'developer_id', 'platform']) {
    if (typeof value[field] !== 'string' || !value[field]) errors.push(`${field} must be a non-empty string`);
  }
  if (!Number.isInteger(value.session_sequence) || value.session_sequence < 1) errors.push('session_sequence must be a positive integer');
  if (!EVENT_TYPES.has(value.event_type)) errors.push('event_type is not part of a supported telemetry schema');
  if (value.schema_version === '1.0'
    && ['implementation_attempt_observed', 'human_retry_detected', 'recommendation_applied'].includes(value.event_type)) {
    errors.push('event_type requires telemetry schema 1.1');
  }
  for (const field of ['session_id', 'task_id', 'interaction_id']) {
    if (!(field in value) || (value[field] !== null && typeof value[field] !== 'string')) {
      errors.push(`${field} must be a string or null`);
    }
  }
  if (typeof value.timestamp === 'string' && Number.isNaN(new Date(value.timestamp).getTime())) errors.push('timestamp must be ISO-8601');
  if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)) errors.push('environment must be an object');
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) errors.push('payload must be an object');
  if (value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) {
    for (const field of REQUIRED_PAYLOAD_FIELDS[value.event_type] || []) {
      if (!Object.hasOwn(value.payload, field)) errors.push(`payload.${field} is required for ${value.event_type}`);
    }
    if (value.event_type === 'task_state_changed') {
      if (!TASK_STATES.has(value.payload.from)) errors.push('payload.from is not a task state');
      if (!TASK_STATES.has(value.payload.to)) errors.push('payload.to is not a task state');
    }
    if (value.event_type === 'recommendation_decision' && !RECOMMENDATION_DECISIONS.has(value.payload.decision)) {
      errors.push('payload.decision is not a recommendation decision');
    }
    if (value.event_type === 'developer_followup' && !FOLLOWUP_CLASSIFICATIONS.has(value.payload.classification)) {
      errors.push('payload.classification is not a follow-up classification');
    }
  }
  return errors;
}

function readTelemetryEvents(inputPath) {
  const events = [];
  const invalid = [];
  for (const filePath of telemetryFiles(inputPath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    lines.forEach((line, index) => {
      try {
        const event = JSON.parse(line);
        const errors = validateTelemetryEvent(event);
        if (errors.length) invalid.push({ file: filePath, line: index + 1, errors });
        else events.push(event);
      } catch (error) {
        invalid.push({ file: filePath, line: index + 1, errors: [error instanceof Error ? error.message : String(error)] });
      }
    });
  }
  events.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || String(left.session_id).localeCompare(String(right.session_id))
    || left.session_sequence - right.session_sequence);
  return { events, invalid };
}

function legacyHumanRetryInteractions(taskEvents, explicitInteractions) {
  const evidenceTypes = new Set(['agent_response', 'file_activity', 'test_run', 'build_run', 'git_event']);
  const interactionsWithAttemptEvidence = new Set(taskEvents
    .filter((event) => event.interaction_id && evidenceTypes.has(event.event_type))
    .map((event) => event.interaction_id));
  const orderedInteractions = [...new Set(taskEvents.map((event) => event.interaction_id).filter(Boolean))];
  const confirmed = new Set();
  for (const event of taskEvents) {
    if (event.schema_version !== '1.0' || event.event_type !== 'retry_detected' || !event.interaction_id) continue;
    if (explicitInteractions.has(event.interaction_id) || !interactionsWithAttemptEvidence.has(event.interaction_id)) continue;
    const index = orderedInteractions.indexOf(event.interaction_id);
    if (index <= 0) continue;
    const priorAttemptObserved = orderedInteractions.slice(0, index)
      .some((interactionId) => interactionsWithAttemptEvidence.has(interactionId));
    if (priorAttemptObserved) confirmed.add(event.interaction_id);
  }
  return confirmed;
}

function aggregateTask(events, taskId) {
  const taskEvents = events.filter((event) => event.task_id === taskId).sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
      || String(left.session_id).localeCompare(String(right.session_id))
      || left.session_sequence - right.session_sequence);
  if (!taskEvents.length) return null;
  const sessions = new Set(taskEvents.map((event) => event.session_id).filter(Boolean));
  const interactions = new Set(taskEvents.map((event) => event.interaction_id).filter(Boolean));
  const initialPreflight = taskEvents.find((event) => event.event_type === 'preflight_completed')?.payload || {};
  const initialPrompt = taskEvents.find((event) => event.event_type === 'prompt_submitted')?.payload || {};
  const recommendationsShown = taskEvents.filter((event) => event.event_type === 'recommendation_shown');
  const recommendationDecisions = taskEvents.filter((event) => event.event_type === 'recommendation_decision');
  const recommendationsApplied = taskEvents.filter((event) => event.event_type === 'recommendation_applied');
  const testRuns = taskEvents.filter((event) => event.event_type === 'test_run');
  const buildRuns = taskEvents.filter((event) => event.event_type === 'build_run');
  const contextSnapshots = taskEvents.filter((event) => event.event_type === 'context_snapshot');
  const maxEstimatedContext = contextSnapshots.reduce((maximum, event) => Math.max(maximum, event.payload.estimated_context_tokens || 0), 0) || null;
  const maxActualContext = contextSnapshots.reduce((maximum, event) => Math.max(maximum, event.payload.actual_context_tokens || 0), 0) || null;
  const measuredUtilizations = contextSnapshots.map((event) => event.payload.context_utilization)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const maxContextUtilization = measuredUtilizations.length ? Math.max(...measuredUtilizations) : null;
  const usage = taskEvents.filter((event) => event.event_type === 'ai_usage');
  const fileHashes = new Set(taskEvents.filter((event) => event.event_type === 'file_activity').map((event) => event.payload.file_hash).filter(Boolean));
  const models = [...new Set(taskEvents
    .filter((event) => event.event_type === 'agent_response' || event.event_type === 'ai_usage')
    .map((event) => event.payload.model)
    .filter(Boolean))];
  const observedFileEvents = taskEvents.filter((event) => event.event_type === 'file_activity'
    && event.payload.source === 'observed_worktree_delta');
  const observedLinesAdded = observedFileEvents.map((event) => event.payload.lines_added).filter((value) => typeof value === 'number');
  const observedLinesRemoved = observedFileEvents.map((event) => event.payload.lines_removed).filter((value) => typeof value === 'number');
  const linesAdded = observedLinesAdded.length ? observedLinesAdded.reduce((total, value) => total + value, 0) : null;
  const linesRemoved = observedLinesRemoved.length ? observedLinesRemoved.reduce((total, value) => total + value, 0) : null;
  const sumNullable = (field) => {
    const values = usage.map((event) => event.payload[field]).filter((value) => typeof value === 'number');
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const taskCreated = taskEvents.find((event) => event.event_type === 'task_created');
  const taskCompleted = [...taskEvents].reverse().find((event) => event.event_type === 'task_completed');
  const finalState = [...taskEvents].reverse().find((event) => event.event_type === 'task_state_changed')?.payload.to
    || (taskEvents.some((event) => event.event_type === 'task_completed') ? 'completed' : 'active');
  const retryCount = taskEvents.filter((event) => event.event_type === 'retry_detected').length;
  const retryCandidates = new Set(taskEvents.filter((event) => event.event_type === 'retry_detected')
    .map((event) => event.interaction_id || event.event_id));
  const humanRetryEvents = taskEvents.filter((event) => event.event_type === 'human_retry_detected');
  const humanRetryInteractions = new Set(humanRetryEvents.map((event) => event.interaction_id || event.event_id));
  const legacyHumanRetryInteractionsSet = legacyHumanRetryInteractions(taskEvents, humanRetryInteractions);
  const allHumanRetryInteractions = new Set([...humanRetryInteractions, ...legacyHumanRetryInteractionsSet]);
  const materialAttempts = taskEvents.filter((event) => event.event_type === 'implementation_attempt_observed');
  const exactHumanRetryDetectorAvailable = taskEvents.some((event) => event.schema_version === '1.1');
  const includesLegacyHumanRetryCapture = taskEvents.some((event) => event.schema_version === '1.0');
  const appliedTypes = new Set(recommendationsApplied.filter((event) => event.payload.application_status === 'applied')
    .map((event) => event.payload.recommendation_type));
  const recommendationById = new Map(recommendationsShown.map((event) => [event.payload.recommendation_id, event.payload.recommendation_type]));
  const recommendationTypes = [...new Set([
    ...recommendationsShown.map((event) => event.payload.recommendation_type),
    ...recommendationDecisions.map((event) => event.payload.recommendation_type || recommendationById.get(event.payload.recommendation_id)),
    ...recommendationsApplied.map((event) => event.payload.recommendation_type)
  ].filter(Boolean))];
  const recommendationEvidence = Object.fromEntries(recommendationTypes.map((type) => {
    const decisions = recommendationDecisions.filter((event) =>
      (event.payload.recommendation_type || recommendationById.get(event.payload.recommendation_id)) === type);
    return [type, {
      shown: recommendationsShown.filter((event) => event.payload.recommendation_type === type).length,
      accepted: decisions.filter((event) => event.payload.decision === 'accepted').length,
      rejected: decisions.filter((event) => event.payload.decision === 'rejected').length,
      dismissed: decisions.filter((event) => event.payload.decision === 'dismissed').length,
      modified: decisions.filter((event) => event.payload.decision === 'modified').length,
      applied: recommendationsApplied.filter((event) => event.payload.recommendation_type === type
        && event.payload.application_status === 'applied').length
    }];
  }));
  const decompositionDecisions = recommendationDecisions.filter((event) =>
    (event.payload.recommendation_type || recommendationById.get(event.payload.recommendation_id)) === 'decompose_task');
  const initialContextSnapshot = taskEvents.find((event) => event.event_type === 'context_snapshot'
    && event.payload.checkpoint === 'preflight_measurement')
    || taskEvents.find((event) => event.event_type === 'context_snapshot'
      && ['task_start', 'before_agent_execution'].includes(event.payload.checkpoint));
  const sessionMisfit = initialPreflight.session_fit?.score ?? null;
  const completed = finalState === 'completed';
  const firstTimestamp = new Date(taskEvents[0].timestamp).getTime();
  const lastTimestamp = new Date(taskEvents.at(-1).timestamp).getTime();
  const totalCredits = sumNullable('ai_credits');
  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    dataset_schema_version: HUMAN_RETRY_DATASET_VERSION,
    task_id: taskId,
    timestamp: taskCreated?.timestamp || taskEvents[0].timestamp,
    task_type: taskCreated?.payload.task_type || null,
    initial_complexity: taskCreated?.payload.initial_complexity || null,
    task_objective: taskCreated?.payload.objective || null,
    task_state: finalState,
    sessions_used: sessions.size,
    interactions: interactions.size,
    initial_prompt_quality: initialPreflight.prompt_quality?.score ?? null,
    prompt_clarity_score: initialPreflight.prompt_quality?.score ?? null,
    initial_task_size: initialPreflight.task_decomposition?.score ?? null,
    task_decomposition_score: initialPreflight.task_decomposition?.score ?? null,
    decomposition_recommended: initialPreflight.task_decomposition?.decision === 'recommend_decomposition',
    decomposition_accepted: decompositionDecisions.some((event) => event.payload.decision === 'accepted'),
    task_was_decomposed: appliedTypes.has('decompose_task') ? true
      : decompositionDecisions.some((event) => ['rejected', 'dismissed'].includes(event.payload.decision)) ? false : null,
    initial_context_pressure: initialPreflight.context_pressure?.score ?? null,
    context_pressure_score: initialPreflight.context_pressure?.score ?? null,
    initial_session_fit: initialPreflight.session_fit?.score ?? null,
    session_misfit_score: sessionMisfit,
    session_fit_score: typeof sessionMisfit === 'number' ? Number((1 - sessionMisfit).toFixed(4)) : null,
    acceptance_criteria_present: Object.hasOwn(initialPrompt, 'contains_acceptance_criteria')
      ? Boolean(initialPrompt.contains_acceptance_criteria) : null,
    fresh_session: Object.hasOwn(taskCreated?.payload || {}, 'fresh_session') ? Boolean(taskCreated.payload.fresh_session) : null,
    curated_handoff_used: taskEvents.some((event) => (event.event_type === 'context_snapshot' && event.payload.curated_handoff)
      || (event.event_type === 'session_changed' && event.payload.handoff_used)),
    initial_estimated_context_tokens: initialContextSnapshot?.payload.estimated_context_tokens ?? null,
    initial_actual_context_tokens: initialContextSnapshot?.payload.actual_context_tokens ?? null,
    initial_context_tokens: initialContextSnapshot?.payload.actual_context_tokens
      ?? initialContextSnapshot?.payload.estimated_context_tokens ?? null,
    initial_model_context_window_tokens: initialContextSnapshot?.payload.model_context_window_tokens ?? null,
    initial_context_utilization: initialContextSnapshot?.payload.context_utilization ?? null,
    context_measurement_method: initialContextSnapshot?.payload.measurement_method ?? null,
    context_measurement_confidence: initialContextSnapshot?.payload.measurement_confidence ?? null,
    recommendations: Object.fromEntries([...new Set(recommendationsShown.map((event) => event.payload.recommendation_type))].map((type) => [type, true])),
    recommendation_evidence: recommendationEvidence,
    recommendation_shown: recommendationsShown.length > 0,
    recommendation_accepted: recommendationDecisions.some((event) => event.payload.decision === 'accepted'),
    recommendation_applied: recommendationsApplied.some((event) => event.payload.application_status === 'applied'),
    recommendations_accepted: recommendationDecisions.filter((event) => event.payload.decision === 'accepted').length,
    recommendations_applied: recommendationsApplied.filter((event) => event.payload.application_status === 'applied').length,
    corrective_turns: taskEvents.filter((event) => event.event_type === 'developer_followup' && event.payload.classification === 'correction').length,
    retries: retryCount,
    implementation_attempts: 1 + retryCount,
    human_retry_count: allHumanRetryInteractions.size,
    human_retry_derivation_source: humanRetryInteractions.size && legacyHumanRetryInteractionsSet.size
      ? 'mixed_detected_and_legacy_reprocessed'
      : humanRetryInteractions.size ? 'detected_v1_1'
        : legacyHumanRetryInteractionsSet.size ? 'legacy_v1_0_reprocessed' : 'none_confirmed',
    human_retry_candidate_count: retryCandidates.size,
    human_retries_unconfirmed: Math.max(0, retryCandidates.size - allHumanRetryInteractions.size),
    human_retry_observation_confidence: exactHumanRetryDetectorAvailable && !includesLegacyHumanRetryCapture ? 1
      : exactHumanRetryDetectorAvailable ? 0.75
      : retryCandidates.size ? Number((allHumanRetryInteractions.size / retryCandidates.size).toFixed(4)) : 0.5,
    material_implementation_attempt_count: materialAttempts.length || (legacyHumanRetryInteractionsSet.size ? 1 + legacyHumanRetryInteractionsSet.size : 0),
    material_attempt_derivation_source: materialAttempts.length ? 'detected_v1_1'
      : legacyHumanRetryInteractionsSet.size ? 'legacy_v1_0_reprocessed' : 'none_observed',
    retries_before_completion: completed ? retryCount : null,
    context_compactions: taskEvents.filter((event) => event.event_type === 'conversation_compacted').length,
    max_context_tokens: maxActualContext ?? maxEstimatedContext,
    max_estimated_context_tokens: maxEstimatedContext,
    max_actual_context_tokens: maxActualContext,
    max_context_utilization: maxContextUtilization,
    total_input_tokens: sumNullable('input_tokens'),
    total_cached_input_tokens: sumNullable('cached_input_tokens'),
    total_output_tokens: sumNullable('output_tokens'),
    ai_credits: totalCredits,
    ai_credits_per_completed_task: completed ? totalCredits : null,
    tests_initially_passed: testRuns.length ? (testRuns[0].payload.failed === 0 && testRuns[0].payload.passed !== null) : null,
    tests_finally_passed: testRuns.length ? (testRuns.at(-1).payload.failed === 0 && testRuns.at(-1).payload.passed !== null) : null,
    test_runs: testRuns.length,
    builds_observed: buildRuns.length > 0,
    builds_finally_passed: buildRuns.length ? buildRuns.at(-1).payload.result === 'passed' : null,
    build_runs: buildRuns.length,
    files_modified: fileHashes.size || taskEvents.filter((event) => event.event_type === 'file_activity').length,
    tool_calls: taskEvents.filter((event) => event.event_type === 'tool_activity').length,
    models,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    code_churn: linesAdded !== null && linesRemoved !== null && linesAdded + linesRemoved > 0
      ? Number((linesRemoved / (linesAdded + linesRemoved)).toFixed(4))
      : null,
    commit_created: taskEvents.some((event) => event.event_type === 'git_event' && ['commit_created', 'commit_amended'].includes(event.payload.git_event_type)),
    total_agent_turns: taskEvents.filter((event) => event.event_type === 'agent_response').length,
    total_developer_turns: interactions.size,
    elapsed_task_time_ms: Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp)
      ? Math.max(0, lastTimestamp - firstTimestamp)
      : null,
    first_pass_success: completed && retryCount === 0 && (!testRuns.length || (testRuns[0].payload.failed === 0 && testRuns[0].payload.passed !== null)),
    completed_without_retry: completed && retryCount === 0,
    human_first_pass_success: completed && allHumanRetryInteractions.size === 0
      && (!testRuns.length || (testRuns[0].payload.failed === 0 && testRuns[0].payload.passed !== null)),
    completed_without_human_retry: completed && allHumanRetryInteractions.size === 0,
    quality_guardrail_observed: testRuns.length > 0 || buildRuns.length > 0,
    quality_guardrail_passed: testRuns.length || buildRuns.length
      ? (!testRuns.length || (testRuns.at(-1).payload.failed === 0 && testRuns.at(-1).payload.passed !== null))
        && (!buildRuns.length || buildRuns.at(-1).payload.result === 'passed')
      : null,
    completed_in_original_session: completed && sessions.size === 1,
    completed,
    task_completed: completed,
    completion_method: taskCompleted?.payload.completion_method || null,
    completion_confidence: taskCompleted?.payload.completion_confidence ?? null,
    analysis_eligible: ['completed', 'abandoned', 'superseded'].includes(finalState),
    analysis_exclusion_reasons: ['completed', 'abandoned', 'superseded'].includes(finalState) ? [] : ['task_not_terminal'],
    abandoned: finalState === 'abandoned'
  };
}

function humanRetryPolicy(options = {}) {
  const number = (key, environmentName, fallback, minimum, maximum) => {
    const direct = options[key];
    const candidate = typeof direct === 'number' ? direct : Number.parseFloat(process.env[environmentName] || '');
    return Number.isFinite(candidate) ? Math.min(maximum, Math.max(minimum, candidate)) : fallback;
  };
  return {
    minimumComparableTasks: Math.round(number('minimumComparableTasks', 'TOKEN_LENS_HUMAN_RETRY_MIN_TASKS', 8, 2, 10000)),
    minimumTasksPerFactor: Math.round(number('minimumTasksPerFactor', 'TOKEN_LENS_HUMAN_RETRY_MIN_FACTOR_TASKS', 5, 3, 10000)),
    reliabilityThreshold: number('reliabilityThreshold', 'TOKEN_LENS_HUMAN_RETRY_RELIABILITY_THRESHOLD', 0.6, 0, 1),
    minimumEffectSize: number('minimumEffectSize', 'TOKEN_LENS_HUMAN_RETRY_MIN_EFFECT', 0.15, 0, 10),
    overdispersionThreshold: number('overdispersionThreshold', 'TOKEN_LENS_HUMAN_RETRY_OVERDISPERSION_THRESHOLD', 1.5, 1, 100)
  };
}

const HUMAN_RETRY_FACTORS = [
  { key: 'prompt_clarity_score', label: 'higher prompt clarity', recommendation: 'Clarify the task before implementation.', expected: 'negative' },
  { key: 'task_decomposition_score', label: 'higher task complexity', recommendation: 'Split the task into smaller implementation steps.', expected: 'positive' },
  { key: 'task_was_decomposed', label: 'using a decomposition plan', recommendation: 'Use the proposed decomposition before implementation.', expected: 'negative', binary: true },
  { key: 'context_pressure_score', label: 'higher context pressure', recommendation: 'Reduce stale context or use a curated fresh-session handoff.', expected: 'positive' },
  { key: 'session_fit_score', label: 'better session fit', recommendation: 'Move materially different work to a fresh session with a curated handoff.', expected: 'negative' },
  { key: 'acceptance_criteria_present', label: 'explicit acceptance criteria', recommendation: 'Add explicit acceptance criteria before implementation.', expected: 'negative', binary: true }
];

function taskRecords(events) {
  return [...new Set(events.map((event) => event.task_id).filter(Boolean))]
    .map((taskId) => aggregateTask(events, taskId))
    .filter(Boolean);
}

function buildHumanRetryDataset(events) {
  const records = taskRecords(events);
  return {
    dataset_schema_version: HUMAN_RETRY_DATASET_VERSION,
    derivation_version: HUMAN_RETRY_DETECTOR_VERSION,
    generated_at: new Date().toISOString(),
    source_schema_versions: [...new Set(events.map((event) => event.schema_version).filter(Boolean))].sort(),
    task_count: records.length,
    records
  };
}

function solveWeightedLine(x, z, weights) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let t0 = 0;
  let t1 = 0;
  for (let index = 0; index < x.length; index += 1) {
    const weight = weights[index];
    s0 += weight;
    s1 += weight * x[index];
    s2 += weight * x[index] * x[index];
    t0 += weight * z[index];
    t1 += weight * x[index] * z[index];
  }
  const determinant = s0 * s2 - s1 * s1;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return {
    beta: [(t0 * s2 - t1 * s1) / determinant, (s0 * t1 - s1 * t0) / determinant],
    inverse: [[s2 / determinant, -s1 / determinant], [-s1 / determinant, s0 / determinant]]
  };
}

function fitUnivariateCountModel(rawX, y, policy) {
  const mean = rawX.reduce((total, value) => total + value, 0) / rawX.length;
  const variance = rawX.reduce((total, value) => total + ((value - mean) ** 2), 0) / rawX.length;
  if (variance < 1e-12) return null;
  const deviation = Math.sqrt(variance);
  const x = rawX.map((value) => (value - mean) / deviation);
  const iterate = (alpha = 0) => {
    let beta = [Math.log(Math.max(0.01, y.reduce((total, value) => total + value, 0) / y.length)), 0];
    let solved = null;
    let converged = false;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const eta = x.map((value) => Math.max(-20, Math.min(20, beta[0] + beta[1] * value)));
      const mu = eta.map((value) => Math.max(1e-8, Math.exp(value)));
      const z = eta.map((value, index) => value + ((y[index] - mu[index]) / mu[index]));
      const weights = mu.map((value) => value / (1 + alpha * value));
      solved = solveWeightedLine(x, z, weights);
      if (!solved) return null;
      const difference = Math.max(Math.abs(solved.beta[0] - beta[0]), Math.abs(solved.beta[1] - beta[1]));
      beta = solved.beta;
      if (difference < 1e-8) {
        converged = true;
        break;
      }
    }
    if (!solved) return null;
    const mu = x.map((value) => Math.exp(Math.max(-20, Math.min(20, beta[0] + beta[1] * value))));
    return { beta, inverse: solved.inverse, mu, converged };
  };
  const poisson = iterate(0);
  if (!poisson) return null;
  const degrees = Math.max(1, y.length - 2);
  const dispersion = y.reduce((total, value, index) => total + (((value - poisson.mu[index]) ** 2) / Math.max(poisson.mu[index], 1e-8)), 0) / degrees;
  let fit = poisson;
  let model = 'poisson';
  let alpha = 0;
  if (dispersion > policy.overdispersionThreshold) {
    const numerator = y.reduce((total, value, index) => total + (((value - poisson.mu[index]) ** 2) - value), 0);
    const denominator = poisson.mu.reduce((total, value) => total + (value ** 2), 0);
    alpha = Math.max(1e-6, numerator / Math.max(denominator, 1e-8));
    const negativeBinomial = iterate(alpha);
    if (negativeBinomial?.converged) {
      fit = negativeBinomial;
      model = 'negative_binomial';
    }
  }
  const standardError = Math.sqrt(Math.max(0, fit.inverse[1][1]));
  const coefficient = fit.beta[1];
  return {
    model,
    converged: fit.converged,
    observations: y.length,
    coefficient,
    incident_rate_ratio: Math.exp(coefficient),
    confidence_interval_95: [Math.exp(coefficient - (1.96 * standardError)), Math.exp(coefficient + (1.96 * standardError))],
    dispersion,
    alpha,
    standardization: { mean, deviation }
  };
}

function comparableCompletedTasks(records, currentTask) {
  const completed = records.filter((record) => record.completed);
  if (!currentTask) return completed;
  const exact = completed.filter((record) => record.task_id !== currentTask.task_id
    && record.task_type === currentTask.task_type
    && record.initial_complexity === currentTask.initial_complexity);
  return exact;
}

function analyzeHumanRetries(events, options = {}) {
  const policy = humanRetryPolicy(options.policy || options);
  const records = taskRecords(events);
  const latestPrompt = [...events].reverse().find((event) => event.event_type === 'prompt_submitted' && event.task_id);
  const currentTaskId = options.currentTaskId || latestPrompt?.task_id || null;
  const currentTask = currentTaskId ? records.find((record) => record.task_id === currentTaskId) || null : null;
  const comparable = comparableCompletedTasks(records, currentTask);
  const candidateTotal = comparable.reduce((total, record) => total + record.human_retry_candidate_count, 0);
  const confirmedTotal = comparable.reduce((total, record) => total + record.human_retry_count, 0);
  const retryCounts = comparable.map((record) => record.human_retry_count).sort((left, right) => left - right);
  const retryMean = retryCounts.length ? confirmedTotal / retryCounts.length : null;
  const retryVariance = retryCounts.length
    ? retryCounts.reduce((total, value) => total + ((value - retryMean) ** 2), 0) / retryCounts.length : null;
  const retryMedian = retryCounts.length
    ? retryCounts.length % 2
      ? retryCounts[Math.floor(retryCounts.length / 2)]
      : (retryCounts[(retryCounts.length / 2) - 1] + retryCounts[retryCounts.length / 2]) / 2
    : null;
  const outcomeConfidence = comparable.length
    ? comparable.reduce((total, record) => total + (record.human_retry_observation_confidence ?? 0), 0) / comparable.length
    : 0;
  const featureCells = comparable.length * HUMAN_RETRY_FACTORS.length;
  const observedFeatureCells = comparable.reduce((total, record) => total + HUMAN_RETRY_FACTORS
    .filter((factor) => typeof record[factor.key] === 'number' || typeof record[factor.key] === 'boolean').length, 0);
  const featureCompleteness = featureCells ? observedFeatureCells / featureCells : 0;
  const sampleScore = Math.min(1, comparable.length / policy.minimumComparableTasks);
  const qualityGuardrailCoverage = comparable.length
    ? comparable.filter((record) => record.quality_guardrail_observed).length / comparable.length : 0;
  const associations = [];
  for (const factor of HUMAN_RETRY_FACTORS) {
    const rows = comparable.filter((record) => (typeof record[factor.key] === 'number' || typeof record[factor.key] === 'boolean')
      && typeof record.human_retry_count === 'number');
    if (rows.length < policy.minimumTasksPerFactor) continue;
    const x = rows.map((record) => typeof record[factor.key] === 'boolean' ? Number(record[factor.key]) : record[factor.key]);
    const y = rows.map((record) => record.human_retry_count);
    const fit = fitUnivariateCountModel(x, y, policy);
    if (!fit) continue;
    const sortedValues = [...x].sort((left, right) => left - right);
    const splitPoint = factor.binary ? 0.5 : sortedValues[Math.floor(sortedValues.length / 2)];
    const lowRows = rows.filter((record) => Number(record[factor.key]) < splitPoint);
    const highRows = rows.filter((record) => Number(record[factor.key]) >= splitPoint);
    const retryAverage = (group) => group.length
      ? group.reduce((total, record) => total + record.human_retry_count, 0) / group.length : null;
    const [lower, upper] = fit.confidence_interval_95;
    const expectedDirection = factor.expected === 'negative'
      ? fit.coefficient < 0 && upper < 1
      : fit.coefficient > 0 && lower > 1;
    const qualityRows = rows.filter((record) => typeof record.quality_guardrail_passed === 'boolean');
    const highQualityGroup = qualityRows.filter((record) => Number(record[factor.key]) >= splitPoint);
    const lowQualityGroup = qualityRows.filter((record) => Number(record[factor.key]) < splitPoint);
    const recommendedQualityGroup = factor.expected === 'negative' ? highQualityGroup : lowQualityGroup;
    const comparisonQualityGroup = factor.expected === 'negative' ? lowQualityGroup : highQualityGroup;
    const passRate = (group) => group.length
      ? group.filter((record) => record.quality_guardrail_passed).length / group.length : null;
    const recommendedPassRate = passRate(recommendedQualityGroup);
    const comparisonPassRate = passRate(comparisonQualityGroup);
    const qualityEvaluable = qualityRows.length >= policy.minimumTasksPerFactor
      && recommendedQualityGroup.length >= 2 && comparisonQualityGroup.length >= 2;
    associations.push({
      factor: factor.key,
      label: factor.label,
      recommendation: factor.recommendation,
      expected_direction: factor.expected,
      direction_matches_hypothesis: expectedDirection,
      effect_size: Math.abs(fit.coefficient),
      descriptive_comparison: {
        split_point: splitPoint,
        lower_group_tasks: lowRows.length,
        lower_group_mean_retries: retryAverage(lowRows),
        upper_group_tasks: highRows.length,
        upper_group_mean_retries: retryAverage(highRows)
      },
      quality_guardrail: {
        evaluable: qualityEvaluable,
        observations: qualityRows.length,
        recommended_group_pass_rate: recommendedPassRate,
        comparison_group_pass_rate: comparisonPassRate,
        no_observed_regression: qualityEvaluable
          ? recommendedPassRate >= comparisonPassRate - 0.05 : null
      },
      ...fit
    });
  }
  const modelCoverage = associations.length / HUMAN_RETRY_FACTORS.length;
  const reliabilityScore = Number(Math.min(1,
    (0.4 * sampleScore) + (0.2 * featureCompleteness) + (0.2 * outcomeConfidence)
      + (0.1 * modelCoverage) + (0.1 * qualityGuardrailCoverage)
  ).toFixed(4));
  const reliableAssociations = associations.filter((association) => association.converged
    && association.direction_matches_hypothesis
    && association.effect_size >= policy.minimumEffectSize
    && association.quality_guardrail.no_observed_regression !== false);
  const strongest = [...reliableAssociations].sort((left, right) => right.effect_size - left.effect_size)[0] || null;
  const enoughData = comparable.length >= policy.minimumComparableTasks;
  const reliable = enoughData && reliabilityScore >= policy.reliabilityThreshold && Boolean(strongest);
  const evidenceStrength = !enoughData ? 'insufficient'
    : reliabilityScore < policy.reliabilityThreshold ? 'emerging'
      : reliable ? 'strong' : 'moderate';
  let feedback;
  if (!enoughData) {
    feedback = `Personalized recommendation — Not enough data yet (${comparable.length}/${policy.minimumComparableTasks} comparable completed tasks).`;
  } else if (reliabilityScore < policy.reliabilityThreshold) {
    feedback = `Personalized recommendation — Not enough reliable data yet (model reliability ${(reliabilityScore * 100).toFixed(0)}%; threshold ${(policy.reliabilityThreshold * 100).toFixed(0)}%).`;
  } else if (!strongest) {
    feedback = `Personalized recommendation — No reliable recommendation yet; ${comparable.length} comparable completed tasks do not show a stable association.`;
  } else {
    const [lower, upper] = strongest.confidence_interval_95;
    const guardrail = strongest.quality_guardrail.evaluable
      ? ` Observed final test/build pass rates were ${(strongest.quality_guardrail.recommended_group_pass_rate * 100).toFixed(0)}% versus ${(strongest.quality_guardrail.comparison_group_pass_rate * 100).toFixed(0)}% in the comparison group.`
      : '';
    feedback = `Personalized recommendation — ${strongest.recommendation} Across ${strongest.observations} comparable completed tasks, ${strongest.label} was associated with a retry rate ratio of ${strongest.incident_rate_ratio.toFixed(2)} (95% CI ${lower.toFixed(2)}–${upper.toFixed(2)}).${guardrail} This is observational, not causal.`;
  }
  return {
    analysis_schema_version: HUMAN_RETRY_ANALYSIS_VERSION,
    generated_at: new Date().toISOString(),
    current_task_id: currentTaskId,
    cohort: {
      task_type: currentTask?.task_type || null,
      initial_complexity: currentTask?.initial_complexity || null,
      comparable_completed_tasks: comparable.length
    },
    descriptive: {
      confirmed_human_retries: confirmedTotal,
      retry_candidates: candidateTotal,
      tasks_with_human_retry: retryCounts.filter((value) => value > 0).length,
      tasks_with_human_retry_rate: retryCounts.length
        ? Number((retryCounts.filter((value) => value > 0).length / retryCounts.length).toFixed(4)) : null,
      mean_human_retries: retryMean === null ? null : Number(retryMean.toFixed(4)),
      median_human_retries: retryMedian,
      variance_human_retries: retryVariance === null ? null : Number(retryVariance.toFixed(4)),
      distribution: Object.fromEntries([...new Set(retryCounts)].map((value) => [String(value), retryCounts.filter((item) => item === value).length]))
    },
    policy,
    reliability: {
      score: reliabilityScore,
      threshold: policy.reliabilityThreshold,
      strength: evidenceStrength,
      enough_data: enoughData,
      reliable,
      feature_completeness: Number(featureCompleteness.toFixed(4)),
      outcome_confidence: Number(outcomeConfidence.toFixed(4)),
      quality_guardrail_coverage: Number(qualityGuardrailCoverage.toFixed(4))
    },
    associations,
    candidate_association: strongest,
    recommendation: reliable ? strongest : null,
    feedback
  };
}

function getPersonalizedRecommendation(inputPath, options = {}) {
  try {
    const { events, invalid } = readTelemetryEvents(inputPath);
    if (invalid.length && !events.length) throw new Error('no valid telemetry events');
    return analyzeHumanRetries(events, options);
  } catch (error) {
    const policy = humanRetryPolicy(options.policy || options);
    return {
      analysis_schema_version: HUMAN_RETRY_ANALYSIS_VERSION,
      generated_at: new Date().toISOString(),
      current_task_id: null,
      cohort: { task_type: null, initial_complexity: null, comparable_completed_tasks: 0 },
      descriptive: { confirmed_human_retries: 0, retry_candidates: 0, tasks_with_human_retry: 0, tasks_with_human_retry_rate: null, mean_human_retries: null, median_human_retries: null, variance_human_retries: null, distribution: {} },
      policy,
      reliability: { score: 0, threshold: policy.reliabilityThreshold, strength: 'insufficient', enough_data: false, reliable: false, feature_completeness: 0, outcome_confidence: 0, quality_guardrail_coverage: 0 },
      associations: [],
      candidate_association: null,
      recommendation: null,
      feedback: 'Personalized recommendation — Not enough data yet (telemetry evidence is unavailable).',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function renderHumanRetryReport(analysis) {
  const lines = [
    '# Code Buddy Human Retry Evidence',
    '',
    `Updated: ${analysis.generated_at}`,
    '',
    `> ${analysis.feedback}`,
    '',
    '## Descriptive cohort',
    '',
    '| Measure | Value |',
    '|---|---:|',
    `| Confirmed human retries | ${analysis.descriptive.confirmed_human_retries} |`,
    `| Tasks with a human retry | ${analysis.descriptive.tasks_with_human_retry} |`,
    `| Mean retries per task | ${analysis.descriptive.mean_human_retries ?? '—'} |`,
    `| Median retries per task | ${analysis.descriptive.median_human_retries ?? '—'} |`,
    `| Retry-count variance | ${analysis.descriptive.variance_human_retries ?? '—'} |`,
    '',
    '## Reliability',
    '',
    '| Measure | Value |',
    '|---|---:|',
    `| Comparable completed tasks | ${analysis.cohort.comparable_completed_tasks} |`,
    `| Model reliability | ${(analysis.reliability.score * 100).toFixed(0)}% |`,
    `| Evidence strength | ${analysis.reliability.strength} |`,
    `| Recommendation threshold | ${(analysis.reliability.threshold * 100).toFixed(0)}% |`,
    `| Feature completeness | ${(analysis.reliability.feature_completeness * 100).toFixed(0)}% |`,
    `| Retry detector coverage | ${(analysis.reliability.outcome_confidence * 100).toFixed(0)}% |`,
    `| Test/build guardrail coverage | ${(analysis.reliability.quality_guardrail_coverage * 100).toFixed(0)}% |`,
    '',
    '## Associations',
    '',
    '| Factor | Model | N | Lower mean | Upper mean | Rate ratio | 95% CI |',
    '|---|---|---:|---:|---:|---:|---|'
  ];
  for (const association of analysis.associations) {
    lines.push(`| ${association.label} | ${association.model} | ${association.observations} | ${association.descriptive_comparison.lower_group_mean_retries?.toFixed(2) ?? '—'} | ${association.descriptive_comparison.upper_group_mean_retries?.toFixed(2) ?? '—'} | ${association.incident_rate_ratio.toFixed(2)} | ${association.confidence_interval_95.map((value) => value.toFixed(2)).join('–')} |`);
  }
  if (!analysis.associations.length) lines.push('| — | Not enough complete observations | — | — | — | — | — |');
  lines.push('', '## Interpretation', '', '- Associations are observational and do not establish causation.', '- A missing test or build observation remains unknown, not failed.', '- Personalized recommendations remain suppressed until the configured reliability threshold is met.', '');
  return lines.join('\n');
}

function replayLabel(event) {
  const payload = event.payload || {};
  switch (event.event_type) {
    case 'task_created': return `Task created (${payload.task_type || 'unknown'}, ${payload.initial_complexity || 'unknown'}; ${payload.objective?.action || 'unspecified'} ${payload.objective?.target_kind || 'general_code'})`;
    case 'prompt_submitted': return `Prompt submitted (${payload.prompt_length_tokens_estimate ?? '?'} estimated tokens)`;
    case 'preflight_completed': return `Preflight completed (prompt ${payload.prompt_quality?.score ?? '?'}, task ${payload.task_decomposition?.score ?? '?'}, context ${payload.context_pressure?.score ?? '?'}, session ${payload.session_fit?.score ?? '?'})`;
    case 'recommendation_shown': return `${payload.recommendation_type || 'Recommendation'} recommended`;
    case 'recommendation_decision': return `Recommendation ${payload.decision || 'unknown'}`;
    case 'developer_followup': return `Developer ${payload.classification || 'follow-up'}`;
    case 'retry_detected': return `Retry detected (${payload.retry_type || 'unknown'})`;
    case 'implementation_attempt_observed': return `Material implementation attempt #${payload.attempt_number || '?'}`;
    case 'human_retry_detected': return `Human-requested retry #${payload.human_retry_number || '?'}`;
    case 'recommendation_applied': return `${payload.recommendation_type || 'Recommendation'} ${payload.application_status || 'observed'}`;
    case 'test_run': return `Tests ${payload.failed === 0 ? 'passed' : payload.failed > 0 ? 'failed' : 'observed'} (${payload.passed ?? '?'} passed, ${payload.failed ?? '?'} failed)`;
    case 'build_run': return `Build ${payload.result || 'observed'}`;
    case 'git_event': return `Git ${payload.git_event_type || 'event'}`;
    case 'conversation_compacted': return `Conversation compacted (#${payload.compaction_number || '?'})`;
    case 'session_changed': return `Session changed (${payload.transition_type || 'unknown'})`;
    case 'handoff_created': return 'Curated handoff created';
    case 'task_completed': return `Task completed (${payload.completion_method || 'unknown'})`;
    case 'task_abandoned': return `Task abandoned (${payload.reason || 'unknown'})`;
    case 'task_state_changed': return `Task state ${payload.from || '?'} → ${payload.to || '?'}`;
    default: return null;
  }
}

function renderTaskReplay(events, taskId) {
  const taskEvents = events.filter((event) => event.task_id === taskId);
  if (!taskEvents.length) return `Task ${taskId} was not found.`;
  const lines = [`Task ${taskId}`, ''];
  for (const event of taskEvents) {
    const label = replayLabel(event);
    if (!label) continue;
    const time = new Date(event.timestamp).toISOString().slice(11, 19);
    lines.push(`${time} ${label}`);
  }
  const aggregate = aggregateTask(taskEvents, taskId);
  lines.push('', 'Summary', JSON.stringify(aggregate, null, 2));
  return lines.join('\n');
}

class TaskAggregator {
  constructor(events = []) {
    this.events = [];
    for (const event of events) this.ingest(event);
  }

  ingest(event) {
    const errors = validateTelemetryEvent(event);
    if (errors.length) throw new Error(`invalid telemetry event: ${errors.join('; ')}`);
    this.events.push(event);
    return this;
  }

  getTask(taskId) {
    return aggregateTask(this.events, taskId);
  }

  finalizeTask(taskId) {
    return this.getTask(taskId);
  }

  rebuildTask(taskId, events = this.events) {
    return aggregateTask(events, taskId);
  }
}

function cli(argv) {
  const [command, input = process.cwd(), taskId] = argv;
  if (command === 'native-context') {
    process.stdout.write(`${JSON.stringify(readCodexNativeContext({ workspace: input, sessionId: taskId }), null, 2)}\n`);
    return 0;
  }
  const { events, invalid } = readTelemetryEvents(input);
  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify({ valid_events: events.length, invalid_events: invalid.length, invalid }, null, 2)}\n`);
    return invalid.length ? 1 : 0;
  }
  const ids = [...new Set(events.map((event) => event.task_id).filter(Boolean))];
  if (command === 'list') {
    process.stdout.write(`${ids.join('\n')}${ids.length ? '\n' : ''}`);
    return 0;
  }
  if (command === 'dataset') {
    process.stdout.write(`${JSON.stringify(buildHumanRetryDataset(events), null, 2)}\n`);
    return invalid.length ? 1 : 0;
  }
  if (command === 'analyze') {
    process.stdout.write(`${JSON.stringify(analyzeHumanRetries(events, { currentTaskId: taskId }), null, 2)}\n`);
    return invalid.length ? 1 : 0;
  }
  if (command === 'recommendation') {
    process.stdout.write(`${analyzeHumanRetries(events, { currentTaskId: taskId }).feedback}\n`);
    return invalid.length ? 1 : 0;
  }
  if (command === 'report') {
    process.stdout.write(`${renderHumanRetryReport(analyzeHumanRetries(events, { currentTaskId: taskId }))}\n`);
    return invalid.length ? 1 : 0;
  }
  if (!taskId) {
    process.stderr.write('Usage: node telemetry.cjs <native-context|list|validate|dataset|analyze|recommendation|report|replay|aggregate> <workspace-or-telemetry-path> [task_or_session_id]\n');
    return 2;
  }
  if (command === 'aggregate') {
    const result = aggregateTask(events, taskId);
    if (!result) return 1;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === 'replay') {
    const result = renderTaskReplay(events, taskId);
    process.stdout.write(`${result}\n`);
    return result.includes('was not found') ? 1 : 0;
  }
  process.stderr.write(`Unknown command: ${command || '(missing)'}\n`);
  return 2;
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  SUPPORTED_TELEMETRY_SCHEMA_VERSIONS,
  HUMAN_RETRY_DATASET_VERSION,
  HUMAN_RETRY_ANALYSIS_VERSION,
  TASK_STATES,
  captureHookEvent,
  validateTelemetryEvent,
  readTelemetryEvents,
  aggregateTask,
  buildHumanRetryDataset,
  analyzeHumanRetries,
  getPersonalizedRecommendation,
  renderHumanRetryReport,
  renderTaskReplay,
  readCodexNativeContext,
  TaskAggregator,
  telemetryRoot
};

if (require.main === module) {
  process.exitCode = cli(process.argv.slice(2));
}
