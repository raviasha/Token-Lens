# Live Task Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface an expanded, current-session Task Card at the start of every Codex task while retaining explicit refresh, generation, and historical-card workflows.

**Architecture:** A capture-only Codex hook emits one idempotent instruction for the active agent to open a session-scoped card. The card engine resolves one live card per Codex session and reports evidence freshness; the MCP API and embedded UI render that card with temporary minimize state and an optional History view.

**Tech Stack:** Node.js CommonJS hook/card engine/UI resource, Python 3 stdlib MCP server, Node built-in test runner.

**Spec:** [Live Task Card design](../specs/2026-09-19-live-task-card-design.md)

## Global Constraints

- Scope the live card only to the explicit active Codex session; do not use telemetry task IDs or automatic multi-session grouping.
- Keep raw telemetry immutable, local, and governed by the existing capture settings.
- Minimize state is DOM-only and must not be saved as a card field, evidence record, or preference.
- Refresh must not create a model request or save a revision; only Generate/Update may request agent-authored card content.
- Keep `task_card_open` compatible with existing `cardId`, developer-selected `scope`, and no-scope history-list calls.
- Failure to open the panel must never block an ordinary coding task.
- Retain optimistic revision conflicts and correction validation unchanged.

## Review Focus

- A `SessionStart` for a previously used session must clear its bridge marker so the next meaningful prompt asks to open an expanded card again; Task 3 tests it.
- A short acknowledgement such as `yes` must not trigger the live-card bridge; Task 3 tests it.
- A missing or blank live session ID must return an MCP validation error without creating a card; Task 2 tests it.
- Refresh after new telemetry arrives must report changed evidence but leave the card revision unchanged; Task 1 tests it.
- Opening a historical card must not overwrite the live card's session scope or make History the default panel; Task 2 tests the returned card and static UI transition.

---

## File structure

- `codex-plugin/plugins/code-buddy/task-cards/card.cjs` — live-card lookup/creation and evidence-freshness metadata, alongside existing immutable revision operations.
- `codex-plugin/plugins/code-buddy/task-cards/cli.cjs` — exposes the live-card engine through the local Node CLI called by the Python MCP server.
- `codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py` — accepts `liveSessionId` on the existing `task_card_open` tool and returns the UI metadata.
- `codex-plugin/plugins/code-buddy/task-cards/view.html` — renders Current task, History, refresh, and temporary minimize state without persisting UI state.
- `codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs` — tracks the per-session bridge marker and emits one capture-only task-start instruction.
- `codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs` — covers live-card MCP contracts and the embedded UI source contract.
- `codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs` — covers capture-only task-start bridge lifecycle behavior.
- `codex-plugin/plugins/code-buddy/README.md` and `codex-plugin/plugins/code-buddy/skills/code-buddy/SKILL.md` — explain live current-session behavior, explicit generation, and optional history.

### Task 1: Implement live-card resolution and freshness metadata

**Files:**
- Modify: `codex-plugin/plugins/code-buddy/task-cards/card.cjs`
- Modify: `codex-plugin/plugins/code-buddy/task-cards/cli.cjs`
- Test: `codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

**Interfaces:**
- Consumes: `readEvidence(workspace, scope, options)` and existing card-directory revision files.
- Produces: `loadOrCreateLiveCard(workspace, sessionId): { card, liveSessionId, evidence: { total, changedSinceRevision, warnings }, history }` and CLI command `live <sessionId>`.

- [ ] **Step 1: Write failing engine-level assertions through the CLI fixture**

Extend the task-card MCP test fixture with a second record for session `s1`, then add assertions for the live-open response:

```js
const live = run([{ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
  name: 'task_card_open', arguments: { workspace, liveSessionId: 's1' }
} }])[0].result.structuredContent;
assert.equal(live.liveSessionId, 's1');
assert.deepEqual(live.card.scope.sessions, [{ platform: 'codex', sessionId: 's1' }]);
assert.equal(live.evidence.changedSinceRevision, true);

const reopened = run([{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
  name: 'task_card_open', arguments: { workspace, liveSessionId: 's1' }
} }])[0].result.structuredContent;
assert.equal(reopened.cardId, live.cardId);
```

- [ ] **Step 2: Run the focused test to verify the new contract fails**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

Expected: FAIL because `task_card_open` does not yet accept or return `liveSessionId` metadata.

- [ ] **Step 3: Add the card-engine functions and CLI command**

In `card.cjs`, define and export these functions:

```js
function liveScope(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('live sessionId is required');
  return { sessions: [{ platform: 'codex', sessionId: sessionId.trim() }], liveSessionId: sessionId.trim() };
}

function loadOrCreateLiveCard(workspace, sessionId) {
  const scope = liveScope(sessionId);
  const existing = listCards(workspace).find(item => item.scope.liveSessionId === scope.liveSessionId);
  const card = existing ? loadCard(workspace, existing.id) : { ...createCard(workspace, scope), claims: [], corrections: [] };
  const evidence = readEvidence(workspace, card.scope, { limit: 1 });
  const previous = new Map((card.evidenceSnapshot || []).map(item => [item.source, item.snapshotHash]));
  return {
    card,
    liveSessionId: scope.liveSessionId,
    evidence: { total: evidence.total, warnings: evidence.coverage.warnings,
      changedSinceRevision: card.revision === 0 || evidence.coverage.snapshots.some(item => previous.get(item.source) !== item.snapshotHash) },
    history: listCards(workspace).filter(item => item.id !== card.id)
  };
}
```

Preserve existing `createCard`, `loadCard`, and generic `listCards` semantics. Add `if (command === 'live') return loadOrCreateLiveCard(workspace, args[0]);` to `cli.cjs` and import the new function there.

- [ ] **Step 4: Prove live-card reuse and freshness behavior**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

Expected: PASS; repeated live opens return the same `cardId`, a new live card has revision `0`, and freshness is reported without creating a revision.

- [ ] **Step 5: Commit the engine change**

```bash
git add codex-plugin/plugins/code-buddy/task-cards/card.cjs \
  codex-plugin/plugins/code-buddy/task-cards/cli.cjs \
  codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs
git commit -m "feat: resolve live task cards by Codex session"
```

### Task 2: Expose live cards through MCP and render the live/history UI

**Files:**
- Modify: `codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py`
- Modify: `codex-plugin/plugins/code-buddy/task-cards/view.html`
- Modify: `codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

**Interfaces:**
- Consumes: CLI `live <sessionId>` from Task 1 and existing `task_card_open` response shape.
- Produces: `task_card_open({ workspace, liveSessionId })` plus UI state fields `liveSessionId`, `evidence`, and `history`.

- [ ] **Step 1: Write failing MCP and UI-contract tests**

Add explicit validation and static UI assertions:

```js
const invalid = run([{ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
  name: 'task_card_open', arguments: { workspace, liveSessionId: '   ' }
} }])[0];
assert.equal(invalid.result.isError, true);
assert.match(invalid.result.content[0].text, /live sessionId is required/);

assert.match(resource.result.contents[0].text, /Current task/);
assert.match(resource.result.contents[0].text, /History/);
assert.match(resource.result.contents[0].text, /open\(\{liveSessionId:state\.liveSessionId\}\)/);
assert.doesNotMatch(resource.result.contents[0].text, /localStorage|sessionStorage/);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

Expected: FAIL because the MCP schema rejects `liveSessionId` and the UI has no Current task or History controls.

- [ ] **Step 3: Extend the MCP API without changing historical workflows**

Update `task_card_open` to select the live CLI branch before generic `cardId`/`scope` handling:

```python
live_session_id = as_string(arguments.get("liveSessionId"))
if "liveSessionId" in arguments:
    if not live_session_id:
        raise ValueError("live sessionId is required")
    result = card_cli("live", arguments, live_session_id)
    return {"workspace": str(workspace_path(arguments)), "cardId": result["card"]["id"], **result}
```

Add `"liveSessionId": {"type": "string", "description": "Current Codex session for the expanded live Task Card."}` to the `task_card_open` schema. Keep the `cardId`, `scope`, and no-scope paths unchanged.

- [ ] **Step 4: Implement the live and History UI states**

In `view.html`, add a `History` button and a `historyMode` boolean. Render the card heading as `Current task` when `state.liveSessionId` exists. Implement these transitions:

```js
document.getElementById('refresh').onclick = () => state?.liveSessionId
  ? open({ liveSessionId: state.liveSessionId }).catch(showError)
  : state?.cardId && open({ cardId: state.cardId }).catch(showError);

document.getElementById('history').onclick = () => { historyMode = true; render(); };
document.getElementById('back-to-live').onclick = () => {
  historyMode = false;
  open({ liveSessionId: state.liveSessionId }).catch(showError);
};
```

History buttons call `open({ cardId: historical.id })` only after the developer chooses one; they must not mutate `state.liveSessionId`. Retain the existing Minimize/Restore DOM-only handlers unchanged and do not introduce browser storage.

- [ ] **Step 5: Run the MCP/UI focused test**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

Expected: PASS; blank session IDs fail safely, live responses expose freshness/history, and the resource contains the required live/History controls with no persisted minimize state.

- [ ] **Step 6: Commit the MCP/UI change**

```bash
git add codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py \
  codex-plugin/plugins/code-buddy/task-cards/view.html \
  codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs
git commit -m "feat: show live task card and optional history"
```

### Task 3: Add the capture-only task-start bridge

**Files:**
- Modify: `codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs`
- Modify: `codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs`

**Interfaces:**
- Consumes: `SessionStart`, `UserPromptSubmit`, `isMeaningfulPrompt`, `getWorkspace`, and `getSessionId`.
- Produces: capture-only hook `additionalContext` instructing one non-blocking `mcp__code_buddy__task_card_open` call with `{ workspace, liveSessionId }`.

- [ ] **Step 1: Write failing capture-only lifecycle tests**

Add a helper invocation with `CODE_BUDDY_LEGACY_GOVERNANCE: 'false'`, then test one task lifecycle:

```js
const first = runPluginHook({ hook_event_name: 'UserPromptSubmit', session_id: 'live-s1', cwd: workspace,
  prompt: 'Implement the live Task Card panel and its tests.' }, workspace, { CODE_BUDDY_LEGACY_GOVERNANCE: 'false' });
assert.match(first.output?.hookSpecificOutput?.additionalContext || '', /mcp__code_buddy__task_card_open/);
assert.match(first.output?.hookSpecificOutput?.additionalContext || '', /liveSessionId.*live-s1/);
assert.doesNotMatch(first.output?.hookSpecificOutput?.additionalContext || '', /Generate\/Update/);

const duplicate = runPluginHook({ hook_event_name: 'UserPromptSubmit', session_id: 'live-s1', cwd: workspace,
  prompt: 'Add the focused tests now.' }, workspace, { CODE_BUDDY_LEGACY_GOVERNANCE: 'false' });
assert.equal(duplicate.output, null);
```

Then send `SessionStart` for `live-s1`, submit another meaningful prompt, and assert that the open instruction returns again. Add a separate `prompt: 'yes'` assertion proving that no marker or output is produced.

- [ ] **Step 2: Run the focused hook test to verify it fails**

Run: `node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs`

Expected: FAIL because capture-only currently returns `null` for every hook event.

- [ ] **Step 3: Implement idempotent marker management and bridge output**

Near the existing state-path helpers, add a `live-card` state directory and exact helpers:

```js
function liveCardStatePath(logPath, sessionId) {
  const base = process.env.TOKEN_LENS_STATE_DIR || path.join(path.dirname(logPath), '.state');
  return path.join(base, 'live-card', `${safeStatePart(sessionId)}.json`);
}
function clearLiveCardOpenState(logPath, sessionId) {
  try { fs.unlinkSync(liveCardStatePath(logPath, sessionId)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
function liveCardOpenOutput(logPath, payload, event, sessionId) {
  if (!(event === 'UserPromptSubmit' || event === 'userPromptSubmitted') || !sessionId || !isMeaningfulPrompt(getValue(payload, 'prompt'))) return null;
  const marker = liveCardStatePath(logPath, sessionId);
  if (fs.existsSync(marker)) return null;
  writeJsonAtomic(marker, { schemaVersion: 1, sessionId, openedAt: new Date().toISOString() });
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
    `Open the expanded live Task Card before substantive work by calling mcp__code_buddy__task_card_open with {"workspace":${JSON.stringify(getWorkspace(payload))},"liveSessionId":${JSON.stringify(sessionId)}}. This is non-blocking: do not generate or update the card.` } };
}
```

In the capture-only branch of `main`, clear the marker on `SessionStart`/`sessionStart`, run the existing telemetry bookkeeping, then return `liveCardOpenOutput(logPath, payload, event, sessionId)`. Do not call this bridge in legacy governance mode and do not deny tools if it fails.

- [ ] **Step 4: Run focused lifecycle tests**

Run: `node --test codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs`

Expected: PASS; the bridge appears once for a meaningful capture-only prompt, is suppressed until `SessionStart`, and does not appear for acknowledgements.

- [ ] **Step 5: Commit the hook bridge**

```bash
git add codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs \
  codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs
git commit -m "feat: request live card at capture-only task start"
```

### Task 4: Document live-card behavior and run regression verification

**Files:**
- Modify: `codex-plugin/plugins/code-buddy/README.md`
- Modify: `codex-plugin/plugins/code-buddy/skills/code-buddy/SKILL.md`
- Test: `codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`
- Test: `codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs`

**Interfaces:**
- Consumes: completed live-card MCP/UI/bridge behavior from Tasks 1–3.
- Produces: accurate agent and developer guidance that distinguishes automatic panel-opening attempts from explicit card generation.

- [ ] **Step 1: Add documentation assertions before changing copy**

In `task_card_mcp.test.cjs`, read the plugin skill and assert the intended contract is stated:

```js
const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'code-buddy', 'SKILL.md'), 'utf8');
assert.match(skill, /live Task Card/i);
assert.match(skill, /Generate\/Update/);
assert.match(skill, /History/);
```

- [ ] **Step 2: Run the focused test to verify the documentation contract fails**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs`

Expected: FAIL because the skill describes only an on-demand Task Card.

- [ ] **Step 3: Update developer and agent instructions**

Replace the on-demand-only description in the plugin README and skill with these operational rules:

```markdown
For a capture-only Codex task, Code Buddy requests an expanded live Task Card for the active session on the first meaningful prompt. This request is best-effort and never blocks coding. Minimize lasts only for the displayed panel; reopening the task starts expanded again. Refresh reloads evidence and the saved revision. Generate/Update is the developer action that asks the active agent to create a new cited revision. History is optional and opens only developer-selected older cards or sessions.
```

Retain the existing privacy, immutable-capture, correction, and citation instructions.

- [ ] **Step 4: Run all plugin-level tests**

Run: `node --test codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_hook.test.cjs codex-plugin/plugins/code-buddy/tests/code_buddy_mcp.test.cjs`

Expected: PASS; both new live-card tests and legacy regression coverage pass.

- [ ] **Step 5: Run the repository test suite**

Run: `npm test`

Expected: PASS; TypeScript build and all repository tests complete without modifying existing raw telemetry or generated reports.

- [ ] **Step 6: Commit documentation and verification-facing tests**

```bash
git add codex-plugin/plugins/code-buddy/README.md \
  codex-plugin/plugins/code-buddy/skills/code-buddy/SKILL.md \
  codex-plugin/plugins/code-buddy/tests/task_card_mcp.test.cjs
git commit -m "docs: explain live Codex task cards"
```

## Self-review

- Spec coverage: Task 1 delivers session-only live card data and evidence freshness; Task 2 preserves generic history while adding the live UI; Task 3 provides the non-blocking task-start bridge and restart behavior; Task 4 documents and regression-tests capture-only, privacy, and explicit-generation boundaries.
- No-placeholder scan: this plan contains concrete function names, arguments, assertions, commands, and commit paths for every task.
- Type consistency: `liveSessionId` is the MCP and UI property; `loadOrCreateLiveCard(workspace, sessionId)` is the Node engine contract; its `card`, `evidence`, and `history` result is consumed unchanged by the Python MCP server and UI.
- Review focus coverage: SessionStart reset and acknowledgement filtering are Task 3 tests; blank-ID safety and history isolation are Task 2 tests; evidence freshness without revision creation is Task 1.
