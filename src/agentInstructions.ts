export const codeBuddyInstructionsMarker = '<!-- code-buddy-managed:v1 -->';
export const codeBuddyInstructionsStartMarker = '<!-- code-buddy-managed:start:v2 -->';
export const codeBuddyInstructionsEndMarker = '<!-- code-buddy-managed:end:v2 -->';

function instructionBody(): string[] {
  return [
    '# Code Buddy governance',
    '',
    '- Before substantial implementation for each meaningful coding prompt, invoke #tool:codeBuddyPromptReviewer, #tool:codeBuddyTaskDecomposer, #tool:codeBuddyContextMeasurement, and #tool:codeBuddySessionFit with the original prompt/task and session/task identifiers when known.',
    '- If the Code Buddy preflight gate denies an implementation tool, do not retry that implementation tool. Use `tool_search` to load any deferred Code Buddy evaluation tools, invoke the missing evaluations, and only then retry implementation.',
    '- Inputs such as “yes”, “continue”, “run it”, button choices, and other small control replies do not require evaluation.',
    '- Evaluation is required, but intervention is conditional. Read all four results before substantive work, then start the substantive response with `Code Buddy: prompt quality <status> · task scope <status> · context utilization <status> · session fit <status>`. Use `checked — limited evidence` when native token data and a useful fallback are unavailable.',
    '- When a tool recommends intervention, honor its selected option. If no option was selected, present the structured options and always include the original prompt/task.',
    '- When a choice is required, render every option\'s label and prompt/task in the normal user-visible response. Never leave choices only in tool output, hidden reasoning, or a collapsed Thinking section, and never ask the developer to choose unless that same visible response contains the choices.',
    '- Never silently rewrite the developer’s prompt or task. Continue with the original whenever the developer retains it, closes the recommendation, or a tool fails.',
    '- When Code Buddy reports warning or critical context pressure, use #tool:codeBuddyContextMeasurement before claiming context utilization. Prefer the latest native Codex input-token count divided by its reported model context window; never use cumulative total usage as the numerator.',
    '- When Code Buddy detects a new Copilot session or a likely new task, curate context only if the developer accepts the offered handoff; starting without prior context or continuing unchanged must remain available.',
    '- Use #tool:codeBuddyContextCurator only after the developer chooses curation or a task-specific handoff. Preserve pinned context and exclude unrelated history.',
    '- Treat measurements marked `estimate` as Estimated Context Pressure, never as actual context-window utilization. If actual input tokens are available without a model window, show the token count and say the percentage is unavailable. Session-fit recommendations can offer a curated fresh chat or continuing unchanged; never create a task automatically.'
  ];
}

export function buildCodeBuddyAgentInstructions(): string {
  return [
    codeBuddyInstructionsStartMarker,
    ...instructionBody(),
    codeBuddyInstructionsEndMarker,
    ''
  ].join('\n');
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

export function mergeCodeBuddyAgentInstructions(existing: string | undefined): string {
  const current = normalizeNewlines(existing ?? '');
  const managedBlock = buildCodeBuddyAgentInstructions().trimEnd();
  const start = current.indexOf(codeBuddyInstructionsStartMarker);
  const end = current.indexOf(codeBuddyInstructionsEndMarker);

  if (start >= 0 && end >= start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + codeBuddyInstructionsEndMarker.length).trim();
    return [before, managedBlock, after].filter(Boolean).join('\n\n') + '\n';
  }

  // A v1 marker identifies an older file that was entirely managed by Code Buddy.
  if (current.includes(codeBuddyInstructionsMarker)) {
    return `${managedBlock}\n`;
  }

  const userInstructions = current.trimEnd();
  return userInstructions ? `${userInstructions}\n\n${managedBlock}\n` : `${managedBlock}\n`;
}

export function removeCodeBuddyAgentInstructions(existing: string): string {
  const current = normalizeNewlines(existing);
  const start = current.indexOf(codeBuddyInstructionsStartMarker);
  const end = current.indexOf(codeBuddyInstructionsEndMarker);

  if (start >= 0 && end >= start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + codeBuddyInstructionsEndMarker.length).trim();
    const remaining = [before, after].filter(Boolean).join('\n\n');
    return remaining ? `${remaining}\n` : '';
  }

  return current.includes(codeBuddyInstructionsMarker) ? '' : existing;
}
