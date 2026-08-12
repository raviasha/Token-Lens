# Code Buddy Global Activation and Curated Handoff Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Code Buddy automatic for enabled Codex tasks and require accepted fresh-task curated context to be pasted or explicitly bypassed before either the VS Code extension or Codex plugin advances that task.

**Architecture:** A local `pending-fresh-handoff.json` record and an ID marker embedded in the copied handoff form a small, cross-platform protocol. Each runtime’s hook owns its gate; each runtime’s curation producer creates the record only after accepted fresh-task curation. Codex’s enabled plugin hook also injects its mandatory prompt-review and task-decomposition context, with `PreToolUse` retaining enforcement.

**Tech Stack:** TypeScript VS Code extension, Node.js CommonJS hooks and tests, Python standard-library MCP server, local Codex plugin marketplace.

## Global Constraints

- Codex **Plugins → Code Buddy → Enable/Disable** remains the only global Code Buddy setting.
- Only a developer-confirmed `fresh_task` curation creates a pending handoff; the source session and `continue_current` curation are never gated.
- The handoff marker is exactly `<!-- code-buddy-handoff:<handoff-id> -->` and the explicit bypass prompt is exactly `Code Buddy: continue without curated context`.
- A pending target session may not use discovery, implementation, or command tools; it may only ask the developer to paste the bundle or use the explicit bypass prompt.
- Neither integration silently pastes content, opens a task, switches the developer’s task, rewrites a request, or bypasses Codex hook trust.
- A malformed marker record must fail open after recording the observation, rather than leave ordinary coding blocked forever.

---

## File structure

- `src/runtime/pendingHandoff.ts` defines the VS Code producer-side JSON contract and atomic persistence.
- `src/runtime/workflow.ts` creates the VS Code pending record only after accepted fresh-task curation and copies a marked bundle.
- `src/ai/tools.ts` creates the same pending record after its own accepted fresh-task curation and renders the shared marker at the beginning of every extension-created handoff.
- `hook.cjs` consumes the shared record and enforces the VS Code fresh-task gate before preflight.
- `test/hook.test.js` verifies VS Code hook pending, pasted, bypassed, source-session, and existing preflight states.
- `/Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy_mcp.py` produces the same record and marker for Codex fresh-task curation.
- `/Users/rampetaravishankar/plugins/code-buddy/hooks/code_buddy_hook.cjs` consumes the record, gates target tasks, and injects automatic Code Buddy preflight.
- `/Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_hook.test.cjs` and `tests/code_buddy_mcp.test.cjs` test the installed-plugin contracts.
- `README.md`, `/Users/rampetaravishankar/plugins/code-buddy/README.md`, and `/Users/rampetaravishankar/plugins/code-buddy/skills/code-buddy/SKILL.md` describe the persistent setting and fresh-task handoff behavior.

### Task 1: Add the VS Code fresh-handoff producer contract

**Files:**

- Create: `src/runtime/pendingHandoff.ts`
- Modify: `src/runtime/workflow.ts:1-8,126-183`
- Modify: `src/extension.ts:71-104`
- Modify: `src/ai/tools.ts:11-29,184-240`
- Create: `test/pending_handoff.test.js`

**Interfaces:**

- Produces `PendingFreshHandoff` with `schemaVersion: 1`, `handoffId`, `sourceSessionId`, `targetTask`, and `createdAt`.
- Produces `createPendingFreshHandoff(stateDirectory, sourceSessionId, targetTask)` and `handoffMarker(handoffId)`.
- `CodeBuddyWorkflow` and `CodeBuddyToolDependencies` receive `currentLogPath(): string`; their existing `currentSnapshot()` and curation inputs provide the source session ID.
- `renderHandoffPayload(bundle, marker?)` prepends the marker only when a fresh-task record exists.

- [ ] **Step 1: Write failing persistence and rendering tests**

Create `test/pending_handoff.test.js` to load the compiled runtime module and assert the shared JSON and marker contract:

```js
test('creates an atomic pending fresh handoff with a paste marker', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-buddy-handoff-'));
  const pending = await createPendingFreshHandoff(
    stateDirectory,
    'source-session',
    'Implement the requested command.'
  );

  assert.match(pending.handoffId, /^[a-f0-9-]{36}$/);
  assert.equal(pending.sourceSessionId, 'source-session');
  assert.equal(handoffMarker(pending.handoffId), `<!-- code-buddy-handoff:${pending.handoffId} -->`);
  const stored = JSON.parse(await fs.readFile(path.join(stateDirectory, 'pending-fresh-handoff.json'), 'utf8'));
  assert.deepEqual(stored, pending);
});

test('prepends a pending handoff marker to the copied payload', () => {
  const payload = renderHandoffPayload(bundle, '<!-- code-buddy-handoff:handoff-1 -->');
  assert.ok(payload.startsWith('<!-- code-buddy-handoff:handoff-1 -->\n[CONTEXT HANDOFF]'));
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build && node --test test/pending_handoff.test.js
```

Expected: FAIL because `pendingHandoff` is absent and `renderHandoffPayload` accepts no marker argument.

- [ ] **Step 3: Implement the minimum producer**

Implement `src/runtime/pendingHandoff.ts` with `randomUUID`, a 0600 temporary file, and atomic rename:

```ts
export interface PendingFreshHandoff {
  schemaVersion: 1;
  handoffId: string;
  sourceSessionId: string;
  targetTask: string;
  createdAt: string;
}

export function handoffMarker(handoffId: string): string {
  return `<!-- code-buddy-handoff:${handoffId} -->`;
}
```

Extend `WorkflowDependencies` and `CodeBuddyToolDependencies` with `currentLogPath`. Add one shared helper in `pendingHandoff.ts` that receives `{ bundle, mode, sourceSessionId, stateDirectory }`, creates a record only when `bundle.accepted && mode === 'fresh_task'`, and returns the marker to copy. Call it from both `CodeBuddyWorkflow.curate` and `ContextCuratorTool.invoke`; use `path.join(path.dirname(currentLogPath()), '.state')`, pass the marker to `renderHandoffPayload`, and append `context.handoff_pending` with the handoff ID and source session but not the full bundle. Leave `continue_current` on the existing unmarked clipboard path.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
npm run build && node --test test/pending_handoff.test.js
```

Expected: PASS; the stored JSON uses the required fields and the copied payload begins with the marker.

- [ ] **Step 5: Wire the workflow construction and run extension regressions**

Pass `currentLogPath: getCurrentLogPath` in `src/extension.ts` and run:

```bash
npm test
```

Expected: all existing VS Code extension tests and the new pending-handoff test pass.

### Task 2: Gate pending fresh handoffs in the VS Code hook

**Files:**

- Modify: `hook.cjs:357-530,552-700`
- Modify: `test/hook.test.js`
- Modify: `README.md:190-250,407-430`

**Interfaces:**

- Consumes `TOKEN_LENS_STATE_DIR/pending-fresh-handoff.json` in the format from Task 1.
- Produces local hook and intervention events `context.handoff_waiting`, `context.handoff_pasted`, and `context.handoff_bypassed`.
- Produces a `UserPromptSubmit` `additionalContext` response while the target session waits and a `PreToolUse` deny response for every task tool while it waits.

- [ ] **Step 1: Write failing target-session hook tests**

Add three isolated tests to `test/hook.test.js`; write a pending JSON file in the test state directory before each test:

```js
test('blocks every target-session tool until the marked handoff is pasted', () => {
  writePendingHandoff(stateDirectory, { handoffId: 'handoff-1', sourceSessionId: 'source-session', targetTask: 'Add a command' });
  const submitted = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'target-session', prompt: 'Add a command.' }, environment, directory);
  assert.match(submitted.output.hookSpecificOutput.additionalContext, /paste.*handoff|continue without curated context/i);
  const deniedRead = runHook({ hook_event_name: 'PreToolUse', session_id: 'target-session', tool_name: 'read_file' }, environment, directory);
  assert.equal(deniedRead.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('releases a target session after the marked handoff is pasted', () => {
  // Submit `<!-- code-buddy-handoff:handoff-1 -->` with the curated bundle.
  // Assert the pending file is gone, context.handoff_pasted exists, and preflight starts.
});

test('releases a target session only after the explicit no-context continuation', () => {
  // Submit exactly `Code Buddy: continue without curated context`.
  // Assert context.handoff_bypassed exists and a later code-changing tool reaches normal preflight.
});
```

Also assert that a `source-session` prompt and `continue_current` (no pending file) are not blocked.

- [ ] **Step 2: Run the hook test to verify it fails**

Run:

```bash
node --test test/hook.test.js
```

Expected: FAIL because the current hook neither loads a pending-handoff record nor gates read-only tools.

- [ ] **Step 3: Implement the hook state machine before preflight**

Add helpers alongside the existing atomic preflight helpers:

```js
function pendingHandoffPath(logPath) {
  const stateDirectory = process.env.TOKEN_LENS_STATE_DIR || path.join(path.dirname(logPath), '.state');
  return path.join(stateDirectory, 'pending-fresh-handoff.json');
}

function isHandoffBypassPrompt(prompt) {
  return /^\s*Code Buddy: continue without curated context\s*[.!]?\s*$/i.test(String(prompt || ''));
}
```

Validate `schemaVersion`, nonempty `handoffId`, and nonempty `sourceSessionId` when loading. On a different target session, clear the record and write the pasted/bypassed event only for a matching marker or exact bypass prompt. On any other target prompt, return `additionalContext` instructing the agent to reply only with the two developer choices. In `PreToolUse`, check this state before the existing observational/preflight allowances and return `permissionDecision: 'deny'` for every tool. Merge the handoff response with ordinary preflight output so a successful paste proceeds directly into normal preflight.

- [ ] **Step 4: Run hook tests to verify the gate passes**

Run:

```bash
node --test test/hook.test.js
```

Expected: PASS; source sessions and same-task curation continue normally, while target sessions wait, paste, or explicitly bypass exactly as specified.

- [ ] **Step 5: Document VS Code behavior**

Update `README.md` to state that accepted fresh handoffs include an internal marker; a fresh chat will wait for the marked bundle or `Code Buddy: continue without curated context`; the source chat and current-task curation are unaffected. Then run:

```bash
npm test
```

Expected: all VS Code tests pass after documentation and hook changes.

### Task 3: Implement Codex automatic preflight and the shared handoff gate

**Files:**

- Modify: `/Users/rampetaravishankar/plugins/code-buddy/hooks/code_buddy_hook.cjs:395-705,769-850`
- Modify: `/Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy_mcp.py:42-90,388-430`
- Create: `/Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_hook.test.cjs`
- Create: `/Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_mcp.test.cjs`
- Modify: `/Users/rampetaravishankar/plugins/code-buddy/skills/code-buddy/SKILL.md`
- Create: `/Users/rampetaravishankar/plugins/code-buddy/README.md`

**Interfaces:**

- `curate_context(... mode: 'fresh_task')` returns `handoffId` and `handoffMarker` and atomically writes the shared pending JSON record. `continue_current` returns neither and writes no pending record.
- The Codex hook consumes the same marker, record fields, bypass phrase, target-session tool gate, and audit event names as Task 2.
- `automaticPreflightContext(state)` names `mcp__code_buddy__review_prompt` and `mcp__code_buddy__decompose_task` for meaningful enabled requests.

- [ ] **Step 1: Write failing plugin hook and MCP protocol tests**

Create `tests/code_buddy_hook.test.cjs` using a temporary workspace and stdin JSON hook events:

```js
test('injects automatic Code Buddy preflight for a meaningful request', () => {
  const { output } = runPluginHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'enabled-session',
    cwd: workspace,
    prompt: 'Create a Cursor plugin with a command and tests.'
  }, workspace);
  assert.match(output.hookSpecificOutput.additionalContext, /mcp__code_buddy__review_prompt/);
  assert.match(output.hookSpecificOutput.additionalContext, /mcp__code_buddy__decompose_task/);
});

test('denies all target-session tools while a curated handoff waits', () => {
  writePendingHandoff(workspace, { handoffId: 'handoff-1', sourceSessionId: 'source-session', targetTask: 'Create a command' });
  runPluginHook({ hook_event_name: 'UserPromptSubmit', session_id: 'target-session', cwd: workspace, prompt: 'Create the command.' }, workspace);
  const denied = runPluginHook({ hook_event_name: 'PreToolUse', session_id: 'target-session', cwd: workspace, tool_name: 'read_file' }, workspace);
  assert.equal(denied.output.hookSpecificOutput.permissionDecision, 'deny');
});
```

Create `tests/code_buddy_mcp.test.cjs` that sends `initialize` then `tools/call` JSON-RPC requests to the Python process. For `curate_context` with `mode: 'fresh_task'` and `developerConfirmed: true`, assert that the structured result contains an `handoffMarker` and the pending JSON exists; for `developerConfirmed: false` and `continue_current`, assert the pending JSON is absent.

- [ ] **Step 2: Run plugin tests to verify they fail**

Run:

```bash
node --test /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_hook.test.cjs /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
```

Expected: FAIL because the hook returns no automatic preflight context and the curator creates no marker/state.

- [ ] **Step 3: Implement the Codex curator producer**

Add `pending_handoff_path`, `write_json_atomic`, and `create_pending_handoff` to the Python MCP server. Use `uuid.uuid4()` and write:

```python
{
    "schemaVersion": 1,
    "handoffId": handoff_id,
    "sourceSessionId": session_id,
    "targetTask": target,
    "createdAt": now(),
}
```

Add an optional `developerConfirmed` boolean to the Codex `curate_context` input schema. The hook and skill direct the agent to supply `true` only after the developer selected fresh-task curation. Only when `mode == 'fresh_task'`, `developerConfirmed is True`, and curation succeeds, include this result data:

```python
result["handoffId"] = handoff_id
result["handoffMarker"] = f"<!-- code-buddy-handoff:{handoff_id} -->"
```

Record `context.handoff_pending`. Do not create a record for `continue_current`, an unconfirmed request, or a failed curation.

- [ ] **Step 4: Implement Codex hook activation and handoff gate**

Port the validated Task 2 record parser and target-session state machine, replacing VS Code tool names with the Codex names. Return automatic preflight context from a meaningful `UserPromptSubmit` after the pending-handoff gate has resolved:

```js
function automaticPreflightContext(state) {
  const required = missingPreflightRequirements(state).map(preflightToolLabel);
  return [
    'Code Buddy is enabled for this task.',
    `Invoke ${required.join(' and ')} before substantive implementation.`,
    'If either tool is deferred, use tool_search to load it.',
    'Pass the unchanged user request and a concise semantic modelAssessment to each tool.',
    'Continue silently unless an evaluation recommends choices for the developer.'
  ].join(' ');
}
```

While a target handoff waits, do not initialize preflight and deny every `PreToolUse` request. When a paste or explicit bypass resolves it, clear the pending record, write its audit event, then initialize preflight and return automatic context.

- [ ] **Step 5: Run plugin tests and source validation**

Run:

```bash
node --check /Users/rampetaravishankar/plugins/code-buddy/hooks/code_buddy_hook.cjs
python3 -m py_compile /Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy.py /Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy_mcp.py
node --test /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_hook.test.cjs /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
```

Expected: all commands exit zero. Tests prove automatic preflight, waiting, paste, bypass, source-session exemption, `continue_current` exemption, and release to normal preflight.

- [ ] **Step 6: Document the Codex behavior**

Update the plugin skill and README to say that an enabled and trusted plugin runs automatic preflight for meaningful requests; fresh-task curation returns a marker that must be included unchanged in the pasted bundle; a waiting task accepts only the marked bundle or `Code Buddy: continue without curated context`.

### Task 4: Publish and accept the two integrations

**Files:**

- Modify through cachebuster script only: `/Users/rampetaravishankar/plugins/code-buddy/.codex-plugin/plugin.json`
- Modify through cachebuster script only if required: `/Users/rampetaravishankar/.agents/plugins/marketplace.json`

**Interfaces:**

- Consumes the local personal marketplace and Codex plugin installation.
- Produces a cache-busted, installed Code Buddy plugin with source-to-installed parity.

- [ ] **Step 1: Run complete local verification**

Run:

```bash
npm test
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py /Users/rampetaravishankar/plugins/code-buddy
node --check /Users/rampetaravishankar/plugins/code-buddy/hooks/code_buddy_hook.cjs
python3 -m py_compile /Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy.py /Users/rampetaravishankar/plugins/code-buddy/scripts/code_buddy_mcp.py
node --test /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_hook.test.cjs /Users/rampetaravishankar/plugins/code-buddy/tests/code_buddy_mcp.test.cjs
```

Expected: all commands pass.

- [ ] **Step 2: Cache-bust and reinstall the local Codex plugin**

Run:

```bash
python3 /Users/rampetaravishankar/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py /Users/rampetaravishankar/plugins/code-buddy
codex plugin install code-buddy@personal
codex plugin list
```

Expected: the output shows `code-buddy@personal` enabled at its new cache-busted version.

- [ ] **Step 3: Verify installed parity**

Run:

```bash
installed=$(find /Users/rampetaravishankar/.codex/plugins/cache/personal/code-buddy -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
diff -ru /Users/rampetaravishankar/plugins/code-buddy "$installed"
codex mcp list
```

Expected: no `diff` output and an enabled `code_buddy` MCP server.

- [ ] **Step 4: Perform fresh-task acceptance checks**

1. In VS Code, accept a fresh-task curation, then use a different chat. Confirm the first unrelated prompt receives the waiting message and no tool runs until the marked clipboard bundle is pasted or the exact bypass phrase is sent.
2. In Codex, enable and trust Code Buddy, accept fresh-task curation, then start a new task. Confirm the task likewise waits for the marked bundle or bypass phrase.
3. In both products, verify the source session remains usable and a `continue_current` curation has no waiting state.
4. Disable Code Buddy in Codex Plugins, create a fresh task, and verify it has no Code Buddy hooks, MCP tools, logs, or interventions.

Expected: both runtimes enforce the same developer-controlled fresh-handoff contract while the native Codex plugin toggle remains the master setting.
