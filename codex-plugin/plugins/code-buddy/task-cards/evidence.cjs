const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCES = [
  ['codex', '.code-buddy/codex-session.jsonl'],
  ['github-copilot', '.code-buddy/copilot-session.jsonl'],
];
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function selected(scope, platform, sessionId, turnId) {
  return scope.sessions.some(s => s.platform === platform && s.sessionId === sessionId &&
    (!Array.isArray(s.turnIds) || !s.turnIds.length || s.turnIds.includes(turnId)));
}
function safeText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(x => x && typeof x.text === 'string').map(x => x.text).join('\n') || null;
  return null;
}
function taskName(row) {
  const data = row.data || {};
  const kind = row.recordType || row.event_type || 'unknown';
  const role = data.role || (kind === 'user.prompt' || kind === 'user.message' || row.sourceEventType === 'user.message' ? 'user' : null);
  if (role !== 'user') return null;
  const text = kind === 'user.prompt' ? safeText(data.prompt) : safeText(data.content) || safeText(data.prompt);
  const normalized = text?.replace(/<(?:recommended_plugins|environment_context|app-context|skills_instructions|permissions_instructions|apps_instructions|plugins_instructions)>[\s\S]*?<\/(?:recommended_plugins|environment_context|app-context|skills_instructions|permissions_instructions|apps_instructions|plugins_instructions)>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || /^(?:yes|no|ok|okay|continue|approved|go ahead|do it|thanks|thank you)[.!]*$/i.test(normalized)) return null;
  if (/^# overview generate \d+ to \d+ hyperpersonalized suggestions\b/i.test(normalized)) return null;
  return normalized.length > 96 ? `${normalized.slice(0, 93).trimEnd()}…` : normalized;
}
function readRows(file, warnings, bound) {
  if (!fs.existsSync(file)) { warnings.push(`unavailable source: ${path.basename(file)}`); return { rows: [], size: 0, hash: null }; }
  const size = fs.statSync(file).size;
  const buffer = Buffer.alloc(Math.min(size, MAX_SOURCE_BYTES, bound?.bytes ?? MAX_SOURCE_BYTES));
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
  if (size > buffer.length && !bound) warnings.push(`truncated source: ${path.basename(file)} at ${buffer.length} bytes`);
  if (bound && size < bound.bytes) warnings.push(`source shortened after snapshot: ${path.basename(file)}`);
  if (bound && digest(buffer) !== bound.hash) warnings.push(`source changed after snapshot: ${path.basename(file)}`);
  const content = buffer.toString('utf8');
  const lines = content.split('\n');
  if (lines[lines.length - 1]) warnings.push(`partial trailing row: ${path.basename(file)}`);
  const rows = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim()) continue;
    try { rows.push({ line: i + 1, raw: lines[i], row: JSON.parse(lines[i]) }); }
    catch { warnings.push(`invalid row: ${path.basename(file)}:${i + 1}`); }
  }
  return { rows, size, hash: digest(buffer) };
}
function normalize(platform, relative, entry) {
  const { row, raw, line } = entry;
  const data = row.data || {};
  const kind = row.recordType || row.event_type || 'unknown';
  // Hook snapshots and native snapshots can include private or redundant material.
  if (kind === 'transcript.snapshot' || kind === 'provider.usage_snapshot' || kind === 'context.load_snapshot') return null;
  const role = data.role || (kind === 'user.prompt' || kind === 'user.message' || row.sourceEventType === 'user.message' ? 'user' :
    kind === 'assistant.message' ? 'assistant' : null);
  let text = role ? safeText(data.content) || safeText(data.prompt) : null;
  if (kind === 'user.prompt') text = safeText(data.prompt);
  if (kind === 'assistant.message' && !text) text = safeText(data.content);
  if (kind === 'tool.completed') text = safeText(data.toolResult ?? data.output);
  if (kind === 'tool_activity') text = safeText(row.payload?.result);
  const usage = kind === 'provider.usage' ? {
    scope: row.usageScope || 'unknown', request: data.usage || null,
    cumulative: data.thread_token_usage || null, responseId: data.response_id || row.sourceResponseId || null,
  } : null;
  const sourceId = row.sourceEventId || row.source_event_id || null;
  return {
    id: `ev_${digest(`${relative}\0${line}\0${raw}`).slice(0, 32)}`,
    platform, source: relative, sourceLine: line, sourceHash: digest(raw),
    sessionId: row.sessionId || row.session_id || null,
    turnId: row.turnId || row.source_turn_id || null,
    messageId: sourceId, callId: row.sourceCallId || data.toolCallId || row.payload?.tool_call_id || null,
    parentId: row.parentId || row.source_parent_id || null,
    timestamp: row.timestamp || null, kind, role, phase: data.phase || null,
    text, toolName: data.toolName || row.payload?.tool_name || null,
    usage, captureStatus: row.capture_status || row.payload?.content_capture_status || 'source_observation',
  };
}
function sourceFiles(workspace) {
  const files = SOURCES.map(([platform, relative]) => ({ platform, relative, file: path.join(workspace, relative) }));
  const raw = path.join(workspace, '.code-buddy/telemetry/raw');
  if (fs.existsSync(raw)) for (const name of fs.readdirSync(raw).filter(x => /^events-.*\.jsonl$/.test(x)).sort())
    files.push({ platform: null, relative: `.code-buddy/telemetry/raw/${name}`, file: path.join(raw, name) });
  return files;
}
function listSessions(workspace) {
  const sessions = new Map();
  for (const source of sourceFiles(workspace)) {
    const { rows } = readRows(source.file, []);
    for (const { row } of rows) {
      const platform = source.platform || row.platform; const sessionId = row.sessionId || row.session_id;
      if (!platform || !sessionId) continue;
      const key = `${platform}\0${sessionId}`;
      const before = sessions.get(key) || { platform, sessionId, timestamp: null, taskName: null, taskNameTimestamp: null };
      const timestamp = row.timestamp || null;
      if (timestamp && timestamp > (before.timestamp || '')) before.timestamp = timestamp;
      const derivedName = taskName(row);
      if (derivedName && (!before.taskName || (timestamp && before.taskNameTimestamp && timestamp < before.taskNameTimestamp))) {
        before.taskName = derivedName;
        before.taskNameTimestamp = timestamp;
      }
      sessions.set(key, before);
    }
  }
  return [...sessions.values()].map(({ taskNameTimestamp, ...session }) => session).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
}
function readEvidence(workspace, scope, options = {}) {
  if (!scope || !Array.isArray(scope.sessions) || !scope.sessions.length) throw new Error('scope.sessions is required');
  const warnings = []; const all = []; const snapshots = [];
  for (const source of sourceFiles(workspace)) {
    if (source.platform && !scope.sessions.some(s => s.platform === source.platform)) continue;
    if (scope.sourceLimits && !scope.sourceLimits[source.relative]) continue;
    const result = readRows(source.file, warnings, scope.sourceLimits?.[source.relative]);
    snapshots.push({ source: source.relative, bytes: result.size, snapshotHash: result.hash });
    for (const entry of result.rows) {
      const platform = source.platform || entry.row.platform;
      const sessionId = entry.row.sessionId || entry.row.session_id;
      if (!selected(scope, platform, sessionId, entry.row.turnId || entry.row.source_turn_id || null)) continue;
      const item = normalize(platform, source.relative, entry);
      if (item) all.push(item);
    }
  }
  all.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '') || a.source.localeCompare(b.source) || a.sourceLine - b.sourceLine);
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 200));
  return { items: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null,
    total: all.length, coverage: { complete: warnings.length === 0 && offset + limit >= all.length, warnings, snapshots } };
}
module.exports = { listSessions, readEvidence };
