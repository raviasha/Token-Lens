#!/usr/bin/env node
const fs = require('node:fs');
const { listSessions, readEvidence } = require('./evidence.cjs');
const { createCard, saveRevision, loadCard, correctClaim, listCards, prepareGeneration, generationScope, loadOrCreateLiveCard } = require('./card.cjs');
const { buildGenerationPrompt } = require('./prompt.cjs');

function main(argv) {
  const [command, workspace, ...args] = argv;
  if (!workspace) throw new Error('absolute workspace is required');
  if (command === 'sessions') return listSessions(workspace);
  if (command === 'cards') return listCards(workspace);
  if (command === 'evidence') return readEvidence(workspace, JSON.parse(args[0]), { offset: Number(args[1] || 0), limit: Number(args[2] || 200) });
  if (command === 'evidence-card') return readEvidence(workspace, generationScope(workspace, args[0]), { offset: Number(args[1] || 0), limit: Number(args[2] || 200) });
  if (command === 'create') return createCard(workspace, JSON.parse(args[0]));
  if (command === 'live') return loadOrCreateLiveCard(workspace, args[0]);
  if (command === 'load') return loadCard(workspace, args[0]);
  if (command === 'save') return saveRevision(workspace, args[0], JSON.parse(fs.readFileSync(args[2], 'utf8')), Number(args[1]));
  if (command === 'correct') return correctClaim(workspace, args[0], args[1], args[2]);
  if (command === 'prompt') { prepareGeneration(workspace, args[0], Number(args[1])); return buildGenerationPrompt(workspace, args[0], Number(args[1]), __filename); }
  throw new Error('unknown task-card command');
}
try { const result = main(process.argv.slice(2)); process.stdout.write(JSON.stringify(result) + '\n'); }
catch (error) { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }
