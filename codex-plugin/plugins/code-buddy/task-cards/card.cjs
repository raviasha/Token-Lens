const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listSessions, readEvidence } = require('./evidence.cjs');

function cardDir(workspace, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid card id');
  return path.join(workspace, '.code-buddy', 'task-cards', id);
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, file);
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function createCard(workspace, scope) {
  readEvidence(workspace, scope, { limit: 1 });
  const id = crypto.randomUUID(); const dir = cardDir(workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  atomic(path.join(dir, 'scope.json'), JSON.stringify(scope, null, 2));
  atomic(path.join(dir, 'meta.json'), JSON.stringify({ id, revision: 0, createdAt: new Date().toISOString() }, null, 2));
  return { id, revision: 0, scope };
}
function loadCard(workspace, id) {
  const dir = cardDir(workspace, id); const meta = json(path.join(dir, 'meta.json'));
  const scope = json(path.join(dir, 'scope.json'));
  const current = meta.revision ? json(path.join(dir, `revision-${meta.revision}.json`)) : {};
  const corrections = fs.existsSync(path.join(dir, 'corrections.jsonl')) ? fs.readFileSync(path.join(dir, 'corrections.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const claims = (current.claims || []).map(claim => {
    const correction = corrections.filter(x => x.claimId === claim.id).at(-1);
    return correction ? { ...claim, text: correction.text, basis: 'developer_correction' } : claim;
  });
  return { ...meta, ...current, id, revision: meta.revision, scope, claims, corrections };
}
function prepareGeneration(workspace, id, expectedRevision) {
  const card = loadCard(workspace, id);
  if (card.revision !== expectedRevision) throw new Error('revision conflict');
  const snapshot = readEvidence(workspace, card.scope, { limit: 1 }).coverage.snapshots;
  const sourceLimits = Object.fromEntries(snapshot.filter(x => x.snapshotHash).map(x => [x.source, { bytes: x.bytes, hash: x.snapshotHash }]));
  atomic(path.join(cardDir(workspace, id), 'generation.json'), JSON.stringify({ expectedRevision, scope: { ...card.scope, sourceLimits }, preparedAt: new Date().toISOString() }, null, 2));
  return { sourceLimits };
}
function generationScope(workspace, id) {
  const file = path.join(cardDir(workspace, id), 'generation.json');
  return fs.existsSync(file) ? json(file).scope : loadCard(workspace, id).scope;
}
function selectedEvidence(workspace, scope) {
  const page = readEvidence(workspace, scope, { limit: 500 });
  const items = [...page.items];
  for (let offset = page.nextOffset; offset !== null;) {
    const next = readEvidence(workspace, scope, { offset, limit: 500 });
    items.push(...next.items);
    offset = next.nextOffset;
  }
  return { ...page, items };
}
function selectedEvidenceFingerprint(items) {
  return crypto.createHash('sha256').update(items.map(item => item.id).join('\0')).digest('hex');
}
function validateRevision(revision, ids) {
  if (!revision || typeof revision.title !== 'string' || !revision.title.trim()) throw new Error('title is required');
  if (!['in_progress', 'blocked', 'completed', 'unknown'].includes(revision.status)) throw new Error('invalid status');
  if (!Array.isArray(revision.claims) || !revision.claims.length) throw new Error('claims are required');
  const claimIds = new Set();
  for (const claim of revision.claims) {
    if (!claim.id || claimIds.has(claim.id) || !claim.text || !['observed', 'assistant_assertion', 'inferred', 'developer_correction'].includes(claim.basis)) throw new Error('invalid claim');
    claimIds.add(claim.id);
    if (!Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length || claim.evidenceIds.some(id => !ids.has(id))) throw new Error('invalid evidence reference');
  }
  for (const section of ['goal', 'constraints', 'acceptance_criteria', 'agreement', 'requirement_changes', 'progress', 'outcomes', 'reflection']) {
    if (!revision.claims.some(claim => claim.section === section)) throw new Error(`missing section: ${section}`);
  }
  if (!revision.nextAction || typeof revision.nextAction.text !== 'string' || !revision.nextAction.text.trim() || !Array.isArray(revision.nextAction.evidenceIds) || !revision.nextAction.evidenceIds.length || revision.nextAction.evidenceIds.some(id => !ids.has(id))) throw new Error('invalid next action evidence');
  if (revision.status === 'completed' && !revision.claims.some(c => c.section === 'acceptance' && ['observed', 'developer_correction'].includes(c.basis))) throw new Error('completion requires observed acceptance evidence');
}
function saveRevision(workspace, id, revision, expectedRevision) {
  const dir = cardDir(workspace, id); const current = loadCard(workspace, id);
  if (current.revision !== expectedRevision) throw new Error('revision conflict');
  const scope = generationScope(workspace, id);
  const page = selectedEvidence(workspace, scope);
  const ids = new Set(page.items.map(x => x.id));
  validateRevision(revision, ids);
  const revisedIds = new Set(revision.claims.map(claim => claim.id));
  for (const correction of current.corrections) {
    if (!revisedIds.has(correction.claimId)) throw new Error(`corrected claim must retain its id: ${correction.claimId}`);
  }
  const number = current.revision + 1;
  const saved = { ...revision, savedAt: new Date().toISOString(), evidenceSnapshot: page.coverage.snapshots, selectedEvidenceFingerprint: selectedEvidenceFingerprint(page.items) };
  const target = path.join(dir, `revision-${number}.json`);
  fs.writeFileSync(target, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
  const meta = { id, revision: number, createdAt: current.createdAt, updatedAt: saved.savedAt };
  atomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  atomic(path.join(dir, 'card.md'), renderMarkdown(loadCard(workspace, id)));
  const generationFile = path.join(dir, 'generation.json');
  if (fs.existsSync(generationFile)) fs.unlinkSync(generationFile);
  return loadCard(workspace, id);
}
function correctClaim(workspace, id, claimId, text) {
  const current = loadCard(workspace, id);
  if (!current.claims.some(x => x.id === claimId)) throw new Error('unknown claim');
  if (typeof text !== 'string' || !text.trim()) throw new Error('correction text is required');
  fs.appendFileSync(path.join(cardDir(workspace, id), 'corrections.jsonl'), JSON.stringify({ claimId, text: text.trim(), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const updated = loadCard(workspace, id);
  atomic(path.join(cardDir(workspace, id), 'card.md'), renderMarkdown(updated));
  return updated;
}
function renderMarkdown(card) {
  const lines = [`# ${card.title || 'Task Card'}`, '', `Status: ${card.status || 'not generated'}`, `Revision: ${card.revision}`, ''];
  for (const claim of card.claims || []) lines.push(`## ${claim.section || 'Observation'}`, '', claim.text, '', `Evidence: ${claim.evidenceIds.join(', ')} · ${claim.basis}`, '');
  if (card.nextAction) lines.push('## Next action', '', card.nextAction.text, '', `Evidence: ${card.nextAction.evidenceIds.join(', ')}`, '');
  return lines.join('\n');
}
function listCards(workspace) {
  const root = path.join(workspace, '.code-buddy', 'task-cards');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => /^[0-9a-f-]{36}$/.test(name)).map(id => {
    try { const card = loadCard(workspace, id); return { id, title: card.title || 'New card', revision: card.revision, updatedAt: card.updatedAt || card.createdAt, scope: card.scope }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
function liveScope(workspace, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('live sessionId is required');
  const normalizedSessionId = sessionId.trim();
  if (!listSessions(workspace).some(session => session.platform === 'codex' && session.sessionId === normalizedSessionId)) throw new Error('unknown live sessionId');
  return { sessions: [{ platform: 'codex', sessionId: normalizedSessionId }], liveSessionId: normalizedSessionId };
}
function loadOrCreateLiveCard(workspace, sessionId) {
  const scope = liveScope(workspace, sessionId);
  const existing = listCards(workspace).find(item => item.scope.liveSessionId === scope.liveSessionId);
  const card = existing ? loadCard(workspace, existing.id) : { ...createCard(workspace, scope), claims: [], corrections: [] };
  const evidence = selectedEvidence(workspace, card.scope);
  return {
    card,
    liveSessionId: scope.liveSessionId,
    evidence: {
      total: evidence.total,
      warnings: evidence.coverage.warnings,
      changedSinceRevision: card.revision === 0 || card.selectedEvidenceFingerprint !== selectedEvidenceFingerprint(evidence.items)
    },
    history: listCards(workspace).filter(item => item.id !== card.id)
  };
}
module.exports = { createCard, saveRevision, loadCard, correctClaim, renderMarkdown, listCards, prepareGeneration, generationScope, loadOrCreateLiveCard };
