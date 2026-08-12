# Code Buddy global activation for Codex

## Purpose

Give a developer one persistent, native Codex choice: Code Buddy is either
enabled for every new task or absent from every new task. When enabled, its
preflight must run for every meaningful coding request without requiring the
developer to mention Code Buddy or use another workflow such as Superpowers.

## Scope

- Use Codex's existing **Plugins → Code Buddy → Enable/Disable** control as
  the only master setting. Do not add a competing plugin-specific preference.
- Make the trusted Code Buddy `UserPromptSubmit` hook inject the mandatory
  preflight instruction for meaningful coding prompts.
- Preserve the existing `PreToolUse` gate as the deterministic backstop if the
  agent reaches a code-changing tool before both evaluations finish.
- Keep routine automatic checks silent. Show the developer options only when
  prompt review or task decomposition recommends an intervention.
- Preserve the original prompt/task option and never silently rewrite, submit,
  curate, or discard developer context.

## Non-goals

- Bypassing Codex's one-time hook-trust confirmation. Codex owns that safety
  boundary and the plugin must not attempt to automate it.
- Retroactively changing capabilities in an already-open task. Native Codex
  plugin availability is fixed when a task starts; the persistent switch takes
  effect for newly created tasks.
- Adding a separate global state file or a per-workspace enable flag.

## Architecture and flow

1. The developer enables or disables Code Buddy in Codex's Plugins UI. Codex
   persists the enabled state in its plugin configuration.
2. A new task receives no Code Buddy skill, MCP server, or lifecycle hook when
   the plugin is disabled. It receives all of them when enabled and the hook
   has been trusted once.
3. For an enabled plugin, `UserPromptSubmit` classifies the prompt. A small
   control reply is recorded but does not start preflight. A meaningful coding
   request creates prompt-specific preflight state and supplies developer
   context requiring `review_prompt` and `decompose_task` before substantive
   implementation.
4. The agent calls the Code Buddy MCP tools, retaining the original request.
   No visible response is required unless a result recommends an intervention.
5. `PreToolUse` allows read-only discovery and Code Buddy MCP calls. It denies
   an implementation tool until both preflight completion markers exist. The
   existing developer-controlled fallback remains available after its configured
   number of denials.
6. `PostToolUse` records each evaluation completion and releases the gate when
   both results are available. Existing reporting continues at turn completion.

## Error handling

- If deferred MCP tools are not yet available, the injected context directs the
  agent to load them through normal tool discovery; the gate permits that
  discovery.
- If an evaluation tool fails, the existing safe-fallback path records the
  failure while preserving the original request.
- If hook execution is not trusted or the plugin is disabled, Code Buddy must
  perform no activity. The native Plugins UI is the remediation point; the
  plugin will not impersonate a trust prompt.

## Verification

- Add focused hook tests that prove a meaningful `UserPromptSubmit` event
  returns automatic-preflight context and records state.
- Prove small control replies do not inject preflight context.
- Prove `PreToolUse` continues to deny code-changing tools before completion
  and allows them after both Code Buddy MCP completions.
- Validate the plugin manifest and hook syntax, cache-bust and reinstall the
  local plugin, then confirm the installed copy matches the source.
- Create a fresh Codex task with Code Buddy enabled and trusted; verify its
  local session log contains the prompt/preflight events and both MCP calls.
- Disable Code Buddy, create another fresh task, and verify no Code Buddy
  session log is created or updated.
