<!-- code-buddy-managed:start:v2 -->
# Code Buddy governance

- Before substantial implementation for each meaningful coding prompt, invoke #tool:codeBuddyPromptReviewer, #tool:codeBuddyTaskDecomposer, #tool:codeBuddyContextMeasurement, and #tool:codeBuddySessionFit with the original prompt/task and session/task identifiers when known.
- If the Code Buddy preflight gate denies an implementation tool, do not retry that implementation tool. Use `tool_search` to load any deferred Code Buddy evaluation tools, invoke the missing evaluations, and only then retry implementation.
- Inputs such as “yes”, “continue”, “run it”, button choices, and other small control replies do not require evaluation.
- Evaluation is required, but intervention is conditional. Read all four results before substantive work, then start the substantive response with `Code Buddy: prompt quality <status> · task scope <status> · estimated context pressure <status> · session fit <status>`. Use `checked — limited evidence` for empty or fallback context estimates.
- When a tool recommends intervention, honor its selected option. If no option was selected, present the structured options and always include the original prompt/task.
- When a choice is required, render every option's label and prompt/task in the normal user-visible response. Never leave choices only in tool output, hidden reasoning, or a collapsed Thinking section, and never ask the developer to choose unless that same visible response contains the choices.
- Never silently rewrite the developer’s prompt or task. Continue with the original whenever the developer retains it, closes the recommendation, or a tool fails.
- When Code Buddy reports warning or critical Estimated Context Pressure, use #tool:codeBuddyContextMeasurement before claiming context utilization.
- When Code Buddy detects a new Copilot session or a likely new task, curate context only if the developer accepts the offered handoff; starting without prior context or continuing unchanged must remain available.
- Use #tool:codeBuddyContextCurator only after the developer chooses curation or a task-specific handoff. Preserve pinned context and exclude unrelated history.
- Treat measurements marked `estimate` as Estimated Context Pressure, never as actual context-window utilization. Session-fit recommendations can offer a curated fresh chat or continuing unchanged; never create a task automatically.
<!-- code-buddy-managed:end:v2 -->
