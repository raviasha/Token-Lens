# Code Buddy technical architecture

Code Buddy is a local Codex plugin and VS Code extension that provides developer-controlled preflight, prompt/task evaluation, context governance, and local analytics. It does not use a separate Code Buddy cloud model or require source code to leave the workspace.

## Runtime components

The Codex distribution is a plugin package with four important parts:

1. `.codex-plugin/plugin.json` declares the plugin, its skill directory, and its MCP server.
2. `skills/code-buddy/SKILL.md` gives Codex the behavioral workflow and safety rules.
3. `.mcp.json` starts `scripts/code_buddy_mcp.py`, a local JSON-RPC MCP server.
4. `hooks/hooks.json` registers `hooks/code_buddy_hook.cjs` for Codex lifecycle events.

The VS Code extension has the same conceptual layers: `src/agentInstructions.ts` manages workspace instructions, `src/ai/tools.ts` exposes VS Code language-model tools, `src/runtime/` contains preflight and handoff state, and `src/hookInstaller.ts` installs workspace Copilot hooks.

## A normal Codex turn

```text
UserPromptSubmit
  -> create preflight state and local event record
  -> inject Code Buddy instructions
  -> Codex invokes four MCP tools
  -> PostToolUse marks each requirement complete
  -> PreToolUse permits implementation only after preflight
  -> Stop captures the outcome and refreshes reports
```

### 1. Prompt submission

The hook receives a JSON event on stdin. It resolves the workspace from `cwd`, then uses `.code-buddy/codex-session.jsonl` as the default event log. For a meaningful prompt it creates per-session state under `.code-buddy/.state/preflight/` with four pending requirements:

- `promptReviewer`
- `taskDecomposer`
- `contextMeasurement`
- `sessionFit`

Small control replies such as `yes`, `continue`, `run it`, and `cancel` are intentionally excluded from semantic preflight.

The hook returns `hookSpecificOutput.additionalContext`. That context tells Codex which checks to call, to pass the unchanged request, and to begin the substantive response with the four-part Code Buddy health line.

### 2. MCP evaluation tools

Codex calls the local MCP server through the plugin's `python3 ./scripts/code_buddy_mcp.py` command. The server exposes:

- `review_prompt`: scores goal clarity, scope, context, constraints, acceptance criteria, and validation. It always retains an explicit original-prompt option.
- `decompose_task`: evaluates complexity and can return dependency-ordered strategies. The original task remains an option.
- `measure_context`: prefers a complete native measurement when supplied; otherwise returns an explicitly labelled Estimated Context Pressure fallback based on locally observed records.
- `assess_session_fit`: estimates whether the prompt continues the current task or merits a developer-controlled fresh task.
- `curate_context`: creates a minimum-sufficient handoff containing decisions, constraints, files, implementation state, completed/remaining work, issues, and validation.
- `session_status`: reports local log, report, and state paths.
- `record_intervention`: records explicit developer choices.

The MCP server validates optional Codex-provided `modelAssessment` objects. If one is missing or invalid, deterministic local fallbacks keep the workflow usable. Every intervention is redacted before being appended to `.code-buddy/interventions.jsonl`.

### 3. Deterministic enforcement

`PreToolUse` is the enforcement boundary. Read/search/list/open/screenshot operations and Code Buddy tools remain available while preflight is incomplete. An implementation tool is denied with a reason naming the missing evaluations.

After the configured denial count, the hook offers a controlled fail-open path. The developer must explicitly submit exactly `Code Buddy: continue without preflight`; the hook records the approval and allows the pending implementation call to proceed. The hook never opens an approval dialog itself.

`PostToolUse` and `PostToolUseFailure` identify Code Buddy tools by normalized tool name and update the matching requirement. Successful completion or safe failure of all four checks produces `preflight.completed` and a health record. Optional tool failures are represented as limited/safe fallback states rather than permanent blocking.

### 4. Visible developer choices

Tool output can appear in a collapsed Thinking section, so the skill, MCP server instructions, VS Code managed instructions, and tool descriptions explicitly require the agent to repeat every actionable option in the normal user-visible response. Code Buddy must not ask the developer to choose while leaving the choices only in tool output or hidden reasoning.

### 5. Context handoffs

When context pressure is warning/critical or session fit identifies a likely new task, Code Buddy offers choices; it never switches tasks automatically. If the developer chooses a fresh-task handoff, `curate_context` writes a pending handoff record containing a marker and the selected context. The target task is held until the marker is pasted or the developer submits exactly `Code Buddy: continue without curated context`. The source task remains usable.

## Local data and reports

All generated data is workspace-local:

```text
.code-buddy/
├── codex-session.jsonl
├── interventions.jsonl
└── .state/
    ├── preflight/
    └── pending-fresh-handoff.json

Code Buddy.md
Code Buddy Analytics.md
```

At `Stop`, the hook captures available transcript context and invokes `scripts/code_buddy.py end_turn`. The analytics script derives worktree deltas, turn outcomes, transcript/context snapshots, intervention counts, and conservative Estimated Context Pressure, then atomically refreshes both Markdown reports.

## Policy resolution

`code-buddy.yaml` is optional. The parser accepts only the documented two-space mappings, booleans, numbers, and comments. Each invalid field falls back independently to defaults:

```yaml
version: 1
healthCheck:
  showOnEveryMeaningfulCodingTask: true
thresholds:
  promptQuality:
    enhanceBelow: 75
  taskScope:
    decomposeAtOrAbove: 65
  estimatedContextPressure:
    capacityTokens: 40000
    warningAt: 0.70
    criticalAt: 0.85
  sessionFit:
    recommendFreshTaskAtOrAbove: 75
    fallbackLexicalOverlapBelow: 0.20
```

## Security and privacy boundaries

- Logs are written locally and common secrets are redacted.
- No source code, prompts, handoffs, or model responses are uploaded to a Code Buddy service.
- Provider-reported usage is not treated as complete active-context utilization unless the provider says it is complete.
- Estimated Context Pressure is clearly labelled as an estimate, not billing data.
- Original prompts/tasks are preserved; Code Buddy never silently rewrites or submits them.

## Source map

- Codex manifest: `codex-plugin/plugins/code-buddy/.codex-plugin/plugin.json`
- MCP configuration: `codex-plugin/plugins/code-buddy/.mcp.json`
- Codex skill: `codex-plugin/plugins/code-buddy/skills/code-buddy/SKILL.md`
- Codex hook: `codex-plugin/plugins/code-buddy/hooks/code_buddy_hook.cjs`
- MCP server: `codex-plugin/plugins/code-buddy/scripts/code_buddy_mcp.py`
- Analytics: `codex-plugin/plugins/code-buddy/scripts/code_buddy.py`
- Shared policy parser: `codex-plugin/plugins/code-buddy/scripts/project_policy.py`
- VS Code language-model tools: `src/ai/tools.ts`
- VS Code managed instructions: `src/agentInstructions.ts`
