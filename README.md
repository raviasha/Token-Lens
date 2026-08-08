# Code Buddy

Code Buddy is a VS Code extension prototype that records GitHub Copilot agent lifecycle events as structured JSONL on the local machine and produces deterministic, workspace-local coding feedback.

It uses GitHub Copilot hooks because the public VS Code extension API does not expose a general listener for the first-party Copilot Chat transcript. The extension installs a repository-level hook configuration only after you invoke the install command.

## What it captures

- Session start and end
- Submitted and transformed prompts
- Tool calls and tool results
- Tool failures
- Main-agent and subagent stop events
- Errors and context compaction events
- Transcript file snapshots when Copilot provides a readable transcript path

Each line in the log is a schema-v2 JSON object with `eventId`, `recordType`, `sessionId`, `turnId`, `parentId`, timestamps, workspace, normalized `data`, and a redacted `rawPayload`. Stable event IDs make repeated transcript reads safe to deduplicate downstream.

Canonical record types include `session.started`, `session.ended`, `user.prompt`, `prompt.transformed`, `turn.started`, `assistant.message`, `turn.ended`, `turn.outcome`, `tool.started`, `tool.completed`, `tool.failed`, `subagent.started`, `subagent.completed`, `error.occurred`, and `context.compacted`. Events that do not match a known transcript type use `transcript.event` with the original type in `sourceEventType`. Full transcript text remains available in `transcript.snapshot` records.

## Run it

1. Install dependencies with `npm install`.
2. Build with `npm run build`.
3. Open this folder in VS Code.
4. Press `F5` to launch an Extension Development Host.
5. Run `Code Buddy: Install Copilot Hooks` from the Command Palette.
6. Start or resume a supported GitHub Copilot agent session.
7. Inspect `.code-buddy/copilot-session.jsonl`, or run `Code Buddy: Open Session Log`.
8. Run `Code Buddy: Open Feedback` for concise next-prompt guidance, or `Code Buddy: Open Analytics` for the detailed report.

Use `Code Buddy: Remove Copilot Hooks` to remove only the hook file created by the extension. Existing logs are preserved.

## Pilot installation

1. In VS Code, open **Extensions → Install from VSIX** and select `code-buddy-0.6.2.vsix`.
2. Ensure Python 3 is installed as `python3` or `python`.
3. Open the workspace where Code Buddy will be used.
4. Run **Code Buddy: Install Copilot Hooks** once in that workspace.
5. Use GitHub Copilot normally and complete a prompt/turn.

The extension is installed once in VS Code. When switching to another workspace, do not reinstall the extension; run **Code Buddy: Install Copilot Hooks** once in the new workspace. Code Buddy creates or updates `Code Buddy.md`, `Code Buddy Analytics.md`, and `.code-buddy/copilot-session.jsonl` inside the active workspace.

Use **Code Buddy: Open Feedback** for the concise next-prompt recommendation, **Code Buddy: Open Analytics** for detailed metrics, and **Code Buddy: Open Session Log** for the structured JSONL records. Logs remain local to each workspace and sensitive values are redacted by default. New timestamps use the computer's local timezone with an explicit offset; the original Copilot event timestamp is retained separately for traceability.

The extension writes all three outputs to the active workspace folder by default:

- `.code-buddy/copilot-session.jsonl` — machine-readable source records.
- `Code Buddy.md` — a short recommendation refreshed after each completed main-agent turn.
- `Code Buddy Analytics.md` — session metrics, context estimates, prompt rubric, task decomposition, and worktree changes.

Code Buddy is bundled in the extension as `code_buddy.py` and uses only the Python standard library. The host must have `python3` or `python` available; configure `tokenLens.pythonCommand` when the executable has a different name. If Python is unavailable, structured session logging continues and the Markdown reports are skipped.

The visible extension name is Code Buddy. The internal `tokenLens` settings namespace and `TOKEN_LENS_*` hook environment variables remain unchanged so existing workspaces can upgrade without losing their configuration. When the default path is in use, reinstalling the hooks migrates `.token-lens/copilot-session.jsonl` to `.code-buddy/copilot-session.jsonl`.

## Configuration

- `tokenLens.logFile` defaults to `.code-buddy/copilot-session.jsonl` and resolves relative to the workspace folder containing the active editor. If no editor is active, the first workspace folder is used.
- `tokenLens.redactSensitiveData` defaults to `true` and redacts common secret-looking keys and token formats.
- `tokenLens.captureTranscripts` defaults to `true` and can be disabled for large or sensitive transcripts.
- `tokenLens.hookTimeoutSeconds` controls the hook timeout between 1 and 30 seconds.
- `tokenLens.feedbackFile` defaults to `Code Buddy.md`.
- `tokenLens.analyticsFile` defaults to `Code Buddy Analytics.md`.
- `tokenLens.trackWorktreeChanges` defaults to `true` and compares the workspace before and after each prompt.
- `tokenLens.snapshotMaxFileSizeBytes` defaults to 1,000,000 bytes for exact text-file line diffs.
- `tokenLens.pythonCommand` optionally selects the Python executable used by the bundled analyzer.

The prompt rubric awards points for a clear goal, scope, context, constraints, acceptance criteria, and validation command. Decomposition uses explicit numbered/bulleted steps, sentence boundaries, and action verbs. Worktree metrics include added, modified, and deleted files plus line counts when the files are within the snapshot size limit. These are deterministic heuristics, not model judgments.

Do not commit local logs. The generated `.gitignore` in this project ignores `.code-buddy/`; add the same rule to any target repository where you install the hooks.

## Important limitations

GitHub documents hooks for Copilot CLI and Copilot cloud agent. Hook support and transcript availability can vary by Copilot surface and rollout. Cloud-agent files are ephemeral, so a local workspace log is only useful when the hook runs in the same environment as the extension. This extension cannot capture hidden system prompts, model-internal reasoning, or data that Copilot never supplies to a hook.

The default redaction is intentionally conservative. Disable it only when the log location and contents are acceptable for your security and privacy requirements.

Exact model context-window usage and token counts are not exposed by the hook. Code Buddy therefore reports observed textual event volume and estimates tokens at approximately four characters per token. Worktree deltas can include edits made outside Copilot between the prompt snapshot and the stop event, so the reports label them as observed rather than agent-attributed.

## Development

```sh
npm run build
npm test
```
