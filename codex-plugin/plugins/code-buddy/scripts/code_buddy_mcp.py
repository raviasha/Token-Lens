#!/usr/bin/env python3
"""A dependency-free local MCP server for the Code Buddy Codex plugin.

The server deliberately keeps data inside the selected workspace. Codex hooks
record lifecycle events; these tools provide the structured, developer-facing
workflow and write decision records to the same local intervention log.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any
from project_policy import load_project_policy


SERVER_NAME = "code-buddy"
SERVER_VERSION = "0.8.2"
CONTRACT_VERSION = "1.0"
DEFAULT_CAPACITY = 40_000
WARNING_THRESHOLD = 0.70
CRITICAL_THRESHOLD = 0.85

SENSITIVE_KEY = re.compile(r"token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key", re.I)
SECRET_PATTERNS = [
    re.compile(r"(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+", re.I),
    re.compile(r"bearer\s+[a-z0-9._~+/=-]+", re.I),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]+", re.I),
    re.compile(r"sk-[a-z0-9_-]+", re.I),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]
ACTION_RE = re.compile(r"\b(add|build|change|configure|create|debug|delete|deploy|design|document|explain|fix|implement|improve|install|investigate|migrate|optimi[sz]e|refactor|remove|review|rewrite|test|update|write)\b", re.I)
SCOPE_RE = re.compile(r"\b(file|files|folder|directory|module|component|class|function|endpoint|route|workspace|extension|service|package)\b|(?:^|[\s`])[^\s`]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|css|html|yaml|yml)\b", re.I)
CONTEXT_RE = re.compile(r"\b(because|currently|error|fails?|failing|when|using|existing|background|context|problem|bug|need|issue|behavior)\b", re.I)
CONSTRAINT_RE = re.compile(r"\b(must|should|do not|don't|without|compatible|keep|avoid|only|limit|constraint|prefer|required)\b", re.I)
ACCEPTANCE_RE = re.compile(r"\b(acceptance|done when|expected|should pass|success|criteria|result|completed when|works when)\b", re.I)
VALIDATION_RE = re.compile(r"\b(test|tests|pytest|unittest|npm test|build|lint|typecheck|validate|check|verify|run)\b", re.I)


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def stable_id(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def as_string(value: Any, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def strings(value: Any, limit: int = 60) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()][:limit]


def redact(value: Any, key: str | None = None) -> Any:
    if key and SENSITIVE_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, str):
        for pattern in SECRET_PATTERNS:
            value = pattern.sub("[REDACTED]", value)
        return value
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {str(item_key): redact(item_value, str(item_key)) for item_key, item_value in value.items()}
    return value


def workspace_path(arguments: dict[str, Any]) -> Path:
    raw = as_string(arguments.get("workspace")) or as_string(os.environ.get("CODE_BUDDY_WORKSPACE"))
    if not raw:
        raise ValueError("workspace is required so Code Buddy can keep its local logs with the project.")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ValueError("workspace must be an absolute path.")
    return candidate.resolve()


def paths(arguments: dict[str, Any]) -> tuple[Path, Path, Path, Path]:
    workspace = workspace_path(arguments)
    state = workspace / ".code-buddy"
    return workspace, state / "codex-session.jsonl", state / "interventions.jsonl", state


def policy_for(arguments: dict[str, Any]) -> dict[str, Any]:
    return load_project_policy(workspace_path(arguments))["policy"]


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def append_intervention(arguments: dict[str, Any], event_type: str, data: dict[str, Any]) -> None:
    workspace, _, intervention_path, _ = paths(arguments)
    session_id = as_string(arguments.get("sessionId")) or "unknown"
    timestamp = now()
    safe_data = redact(data)
    append_jsonl(intervention_path, {
        "schemaVersion": 1,
        "eventId": stable_id("intervention", {"event": event_type, "session": session_id, "time": timestamp, "data": safe_data}),
        "timestamp": timestamp,
        "eventType": event_type,
        "sessionId": session_id,
        "taskId": as_string(arguments.get("taskId")) or None,
        "workspace": str(workspace),
        "data": safe_data,
    })


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        temporary.replace(path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def create_pending_handoff(arguments: dict[str, Any], target_task: str) -> dict[str, Any]:
    _, _, _, state_directory = paths(arguments)
    handoff_id = str(uuid.uuid4())
    pending = {
        "schemaVersion": 1,
        "handoffId": handoff_id,
        "sourceSessionId": as_string(arguments.get("sessionId")) or "unknown",
        "targetTask": target_task,
        "createdAt": now(),
    }
    write_json_atomic(state_directory / ".state" / "pending-fresh-handoff.json", pending)
    append_intervention(arguments, "context.handoff_pending", {
        "handoffId": handoff_id,
        "targetTask": target_task,
        "sourceSessionId": pending["sourceSessionId"],
    })
    return pending


def attach_pending_handoff(arguments: dict[str, Any], target_task: str, mode: str, result: dict[str, Any]) -> None:
    if mode != "fresh_task" or arguments.get("developerConfirmed") is not True:
        return
    pending = create_pending_handoff(arguments, target_task)
    result["handoffId"] = pending["handoffId"]
    result["handoffMarker"] = f"<!-- code-buddy-handoff:{pending['handoffId']} -->"


def load_records(log_path: Path, session_id: str = "") -> list[dict[str, Any]]:
    if not log_path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        lines = log_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and item.get("schemaVersion") == 2 and (not session_id or item.get("sessionId") == session_id):
            records.append(item)
    return records


def assessment(name: str, present: bool, strong_reason: str, weak_reason: str) -> dict[str, str]:
    return {
        "dimension": name,
        "assessment": "strong" if present else "weak",
        "reason": strong_reason if present else weak_reason,
    }


PROMPT_DIMENSIONS = {"goalClarity", "scope", "relevantContext", "constraints", "acceptanceCriteria", "validation", "ambiguity", "breadth"}
CURATION_SECTIONS = {"background", "decision", "constraint", "file", "implementation_state", "completed_work", "remaining_work", "issue", "validation", "open_question", "excluded_history"}


def normalize_model_prompt_review(candidate: Any, prompt: str, threshold: float) -> dict[str, Any] | None:
    if not isinstance(candidate, dict) or not isinstance(candidate.get("score"), (int, float)):
        return None
    score = max(0, min(100, round(candidate["score"])))
    dimensions = []
    for item in candidate.get("dimensions", []):
        if not isinstance(item, dict):
            continue
        dimension, grade, reason = item.get("dimension"), item.get("assessment"), as_string(item.get("reason"))
        if dimension in PROMPT_DIMENSIONS and grade in {"strong", "adequate", "weak", "not_applicable"} and reason:
            dimensions.append({"dimension": dimension, "assessment": grade, "reason": reason})
    if not dimensions:
        return None
    issues = []
    for item in candidate.get("issues", []):
        if isinstance(item, dict) and item.get("dimension") in PROMPT_DIMENSIONS and item.get("severity") in {"low", "medium", "high"} and as_string(item.get("reason")):
            issues.append({"dimension": item["dimension"], "severity": item["severity"], "reason": as_string(item["reason"])})
    options = [{"id": "original", "label": "Continue with my original prompt", "prompt": prompt, "preservesOriginalIntent": True}]
    for index, item in enumerate(candidate.get("options", []), 1):
        if isinstance(item, dict) and as_string(item.get("label")) and as_string(item.get("prompt")):
            option_id = as_string(item.get("id")) or f"enhanced_{index}"
            if option_id != "original":
                options.append({"id": option_id, "label": as_string(item["label"]), "prompt": as_string(item["prompt"]), "preservesOriginalIntent": item.get("preservesOriginalIntent") is not False})
    return {
        "contractVersion": CONTRACT_VERSION,
        "kind": "prompt_review",
        "status": "ok",
        "score": score,
        "dimensions": dimensions,
        "reasons": strings(candidate.get("reasons")),
        "issues": issues,
        "interventionRecommended": bool(candidate.get("interventionRecommended")) or score < threshold,
        "suggestions": strings(candidate.get("suggestions")),
        "options": options[:4],
        "selectedOptionId": "original" if not (bool(candidate.get("interventionRecommended")) or score < threshold) else None,
        "originalPromptRetained": True,
        "assessmentSource": "codex_model",
    }


def review_prompt(arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = as_string(arguments.get("prompt"))
    if not prompt:
        raise ValueError("prompt is required.")
    threshold = policy_for(arguments)["thresholds"]["promptQuality"]["enhanceBelow"]
    model_result = normalize_model_prompt_review(arguments.get("modelAssessment"), prompt, threshold)
    if model_result is not None:
        append_intervention(arguments, "prompt.reviewed", {"originalPrompt": prompt, "score": model_result["score"], "interventionRecommended": model_result["interventionRecommended"], "originalPromptRetained": True, "assessmentSource": "codex_model"})
        return model_result
    relevant_context = strings(arguments.get("relevantContext"))
    signals = {
        "goalClarity": bool(ACTION_RE.search(prompt)),
        "scope": bool(SCOPE_RE.search(prompt)),
        "relevantContext": bool(relevant_context) or bool(CONTEXT_RE.search(prompt)),
        "constraints": bool(CONSTRAINT_RE.search(prompt)),
        "acceptanceCriteria": bool(ACCEPTANCE_RE.search(prompt)),
        "validation": bool(VALIDATION_RE.search(prompt)),
    }
    dimensions = [
        assessment("goalClarity", signals["goalClarity"], "The request states an action.", "State the intended action or outcome."),
        assessment("scope", signals["scope"], "The request identifies a scope cue.", "Name the affected module, files, or behavior when known."),
        assessment("relevantContext", signals["relevantContext"], "The request includes relevant context.", "Give the current behavior, failure, or relevant prior decision."),
        assessment("constraints", signals["constraints"], "The request includes a constraint or compatibility cue.", "State constraints such as compatibility, exclusions, or boundaries."),
        assessment("acceptanceCriteria", signals["acceptanceCriteria"], "The request describes a success condition.", "State what must be true when the work is complete."),
        assessment("validation", signals["validation"], "The request includes a validation cue.", "Name the desired test, build, lint, or verification step."),
        assessment("ambiguity", len(prompt.split()) >= 8, "The request has enough detail to begin discovery.", "Clarify ambiguous nouns or the desired behavior before implementation."),
        assessment("breadth", len(re.findall(r"\b(and|across|plus|also)\b", prompt, re.I)) < 3, "The request appears cohesive.", "The request may contain several independent outcomes; consider sequencing them."),
    ]
    weights = {"goalClarity": 20, "scope": 20, "relevantContext": 15, "constraints": 15, "acceptanceCriteria": 20, "validation": 10}
    score = sum(weights[key] for key, value in signals.items() if value)
    if len(prompt.split()) < 4:
        score = max(0, score - 10)
    score = max(0, min(100, score))
    missing = [name for name, value in signals.items() if not value]
    issues = [{"dimension": name, "severity": "high" if name in {"goalClarity", "acceptanceCriteria"} else "medium", "reason": next(item["reason"] for item in dimensions if item["dimension"] == name)} for name in missing]
    suggestions = [next(item["reason"] for item in dimensions if item["dimension"] == name) for name in missing][:4]
    options = [{"id": "original", "label": "Continue with my original prompt", "prompt": prompt, "preservesOriginalIntent": True}]
    if missing:
        additions = " ".join(f"[{item}]" for item in suggestions)
        options.append({
            "id": "clarified",
            "label": "Add only the missing details",
            "prompt": f"{prompt}\n\nClarify before implementing: {additions}",
            "preservesOriginalIntent": True,
        })
    result = {
        "contractVersion": CONTRACT_VERSION,
        "kind": "prompt_review",
        "status": "ok",
        "score": score,
        "dimensions": dimensions,
        "reasons": ["This is a local deterministic review. It never changes the original prompt.", *(suggestions[:2] or ["The prompt contains the main cues needed for a focused implementation."])],
        "issues": issues,
        "interventionRecommended": score < threshold,
        "suggestions": suggestions,
        "options": options,
        "selectedOptionId": "original" if score >= threshold else None,
        "originalPromptRetained": True,
        "assessmentSource": "deterministic_fallback",
    }
    append_intervention(arguments, "prompt.reviewed", {"originalPrompt": prompt, "score": score, "interventionRecommended": result["interventionRecommended"], "originalPromptRetained": True})
    return result


def normalize_model_decomposition(candidate: Any, task: str, threshold: float) -> dict[str, Any] | None:
    if not isinstance(candidate, dict) or not isinstance(candidate.get("complexityScore"), (int, float)):
        return None
    complexity = max(0, min(100, round(candidate["complexityScore"])))
    strategies = []
    for strategy_index, strategy in enumerate(candidate.get("strategies", []), 1):
        if not isinstance(strategy, dict) or not as_string(strategy.get("label")) or not as_string(strategy.get("rationale")):
            continue
        steps = []
        for step_index, step in enumerate(strategy.get("steps", []), 1):
            if not isinstance(step, dict) or not as_string(step.get("title")) or not as_string(step.get("objective")):
                continue
            steps.append({"id": as_string(step.get("id")) or f"step_{step_index}", "title": as_string(step["title"]), "objective": as_string(step["objective"]), "dependsOn": strings(step.get("dependsOn"), 10), **({"suggestedValidation": as_string(step["suggestedValidation"])} if as_string(step.get("suggestedValidation")) else {})})
        if steps:
            strategies.append({"id": as_string(strategy.get("id")) or f"strategy_{strategy_index}", "label": as_string(strategy["label"]), "rationale": as_string(strategy["rationale"]), "steps": steps})
    recommended = bool(candidate.get("decompositionRecommended")) or complexity >= threshold
    if recommended and not strategies:
        return None
    return {
        "contractVersion": CONTRACT_VERSION,
        "kind": "task_decomposition",
        "status": "ok",
        "complexityScore": complexity,
        "reasons": strings(candidate.get("reasons")),
        "decompositionRecommended": recommended,
        "strategies": strategies[:3],
        "originalTaskOption": {"id": "original", "label": "Continue with the original task", "task": task},
        "originalTaskRetained": True,
        "assessmentSource": "codex_model",
    }


def decompose_task(arguments: dict[str, Any]) -> dict[str, Any]:
    task = as_string(arguments.get("task"))
    if not task:
        raise ValueError("task is required.")
    threshold = policy_for(arguments)["thresholds"]["taskScope"]["decomposeAtOrAbove"]
    model_result = normalize_model_decomposition(arguments.get("modelAssessment"), task, threshold)
    if model_result is not None:
        append_intervention(arguments, "task.decomposition_evaluated", {"task": task, "complexityScore": model_result["complexityScore"], "decompositionRecommended": model_result["decompositionRecommended"], "originalTaskRetained": True, "assessmentSource": "codex_model"})
        return model_result
    actions = ACTION_RE.findall(task)
    pieces = [part.strip(" -•\t") for part in re.split(r"\n+|;|(?<=[.!?])\s+", task) if part.strip(" -•\t")]
    cross_cutting = bool(re.search(r"\b(across|migrate|architecture|refactor|integration|multiple|end.to.end)\b", task, re.I))
    complexity = 25 + min(25, len(actions) * 12) + (20 if len(pieces) > 1 else 0) + (20 if cross_cutting else 0) + (10 if len(task.split()) > 80 else 0)
    complexity = min(100, complexity)
    recommended = complexity >= threshold
    strategy_steps = [
        {"id": "inspect", "title": "Inspect the current implementation", "objective": "Identify the relevant code paths, constraints, and existing validation before changing anything.", "dependsOn": []},
        {"id": "implement", "title": "Implement the requested change", "objective": task, "dependsOn": ["inspect"]},
        {"id": "validate", "title": "Validate the result", "objective": "Run the smallest relevant checks and review the diff against the original task.", "dependsOn": ["implement"], "suggestedValidation": "Run the repository's relevant tests, build, lint, or type checks."},
    ]
    strategies = [{
        "id": "focused-phases",
        "label": "Inspect, implement, validate",
        "rationale": "Keeps discovery, changes, and verification reviewable while retaining the original task.",
        "steps": strategy_steps,
    }] if recommended else []
    result = {
        "contractVersion": CONTRACT_VERSION,
        "kind": "task_decomposition",
        "status": "ok",
        "complexityScore": complexity,
        "reasons": [
            f"Detected {len(actions)} action cue(s), {len(pieces)} task segment(s), and {'cross-cutting' if cross_cutting else 'contained'} scope.",
            "Decomposition is offered only when it is likely to improve execution and remains optional.",
        ],
        "decompositionRecommended": recommended,
        "strategies": strategies,
        "originalTaskOption": {"id": "original", "label": "Continue with the original task", "task": task},
        "originalTaskRetained": True,
        "assessmentSource": "deterministic_fallback",
    }
    append_intervention(arguments, "task.decomposition_evaluated", {"task": task, "complexityScore": complexity, "decompositionRecommended": recommended, "originalTaskRetained": True})
    return result


def estimate_context(arguments: dict[str, Any]) -> dict[str, Any]:
    thresholds = policy_for(arguments)["thresholds"]["estimatedContextPressure"]
    capacity_tokens = thresholds["capacityTokens"]
    warning_at = thresholds["warningAt"]
    critical_at = thresholds["criticalAt"]
    native = arguments.get("nativeMeasurement")
    if isinstance(native, dict) and isinstance(native.get("value"), (int, float)) and native.get("value", 0) >= 0:
        value = int(native["value"])
        capacity = max(1, int(native.get("capacity") or capacity_tokens))
        utilization = value / capacity
        result = {
            "contractVersion": CONTRACT_VERSION,
            "kind": "context_measurement",
            "status": "ok",
            "measurement": {"method": "api", "value": value, "unit": "tokens", "utilization": round(utilization, 4), "confidence": native.get("confidence", "high"), "providerId": native.get("providerId", "user-supplied"), "terminology": "Actual Context Utilization"},
            "recommendation": "curate_or_start_fresh" if utilization >= warning_at else "continue",
        }
        append_intervention(arguments, "context.measured", result)
        return result
    _, log_path, _, _ = paths(arguments)
    session_id = as_string(arguments.get("sessionId"))
    records = load_records(log_path, session_id)
    latest_snapshot = next((item for item in reversed(records) if item.get("recordType") == "context.load_snapshot"), None)
    estimated = ((latest_snapshot or {}).get("data") or {}).get("estimatedContextPressure") or {}
    if isinstance(estimated.get("value"), (int, float)):
        value = int(estimated["value"])
        utilization = float(estimated.get("utilization") or value / capacity_tokens)
        confidence = estimated.get("confidence", "low")
    else:
        observed_chars = 0
        for record in records:
            context = ((record.get("data") or {}).get("context") or {})
            observed_chars += int(context.get("observedChars") or 0)
        value = (observed_chars + 3) // 4
        utilization = value / capacity_tokens
        confidence = "low"
    threshold = "critical" if utilization >= critical_at else "warning" if utilization >= warning_at else "normal"
    result = {
        "contractVersion": CONTRACT_VERSION,
        "kind": "context_measurement",
        "status": "ok" if records else "fallback",
        "measurement": {"method": "estimate", "value": value, "unit": "estimated_tokens", "utilization": round(utilization, 4), "confidence": confidence, "providerId": "code-buddy-local-log", "terminology": "Estimated Context Pressure", "thresholdState": threshold, "estimatorVersion": "code_buddy_context_estimator_v2"},
        "recommendation": "curate_or_start_fresh" if threshold in {"warning", "critical"} else "continue",
        "limitation": "Codex does not expose complete active-context usage to this plugin. This is an estimate from observable local events, not a billing value.",
    }
    append_intervention(arguments, "context.measured", result)
    return result


def task_terms(prompt: str) -> set[str]:
    ignored = {"about", "after", "again", "also", "and", "before", "code", "continue", "current", "existing", "for", "from", "have", "into", "make", "more", "please", "should", "task", "that", "the", "then", "this", "with", "work"}
    return {term for term in re.findall(r"[a-z0-9_./-]{3,}", prompt.lower()) if term not in ignored}


def assess_session_fit(arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = as_string(arguments.get("prompt"))
    if not prompt:
        raise ValueError("prompt is required.")
    policy = policy_for(arguments)
    threshold = policy["thresholds"]["sessionFit"]["recommendFreshTaskAtOrAbove"]
    candidate = arguments.get("modelAssessment")
    if isinstance(candidate, dict) and isinstance(candidate.get("newTaskLikelihood"), (int, float)) and candidate.get("confidence") in {"high", "medium", "low"} and as_string(candidate.get("reason")):
        likelihood = max(0, min(100, round(candidate["newTaskLikelihood"])))
        result = {
            "contractVersion": CONTRACT_VERSION,
            "kind": "session_fit",
            "status": "ok",
            "newTaskLikelihood": likelihood,
            "confidence": candidate["confidence"],
            "reason": as_string(candidate["reason"]),
            "freshTaskRecommended": likelihood >= threshold,
            "assessmentSource": "codex_model",
        }
    else:
        previous = as_string(arguments.get("previousPrompt"))
        if not previous:
            likelihood, confidence, reason = 0, "low", "No prior meaningful task to compare."
        elif re.match(r"^(continue|next|now|also|then|build on|following up|same task)\b", prompt, re.I):
            likelihood, confidence, reason = 0, "high", "The prompt explicitly continues prior work."
        else:
            prior_terms, current_terms = task_terms(previous), task_terms(prompt)
            overlap = len(prior_terms & current_terms) / max(1, min(len(prior_terms), len(current_terms)))
            is_new = len(prior_terms) >= 2 and len(current_terms) >= 2 and overlap < policy["thresholds"]["sessionFit"]["fallbackLexicalOverlapBelow"]
            likelihood = 80 if is_new else 0
            confidence = "high" if overlap < 0.1 else "medium" if overlap < 0.3 else "low"
            reason = "The prompt has little task-specific overlap with the prior prompt." if is_new else "The prompts retain task-specific overlap."
        result = {
            "contractVersion": CONTRACT_VERSION,
            "kind": "session_fit",
            "status": "fallback",
            "newTaskLikelihood": likelihood,
            "confidence": confidence,
            "reason": reason,
            "freshTaskRecommended": likelihood >= threshold,
            "assessmentSource": "lexical_fallback",
        }
    append_intervention(arguments, "session.fit_evaluated", result)
    return result


def normalize_model_curation(candidate: Any, target: str, pinned: set[str]) -> dict[str, Any] | None:
    if not isinstance(candidate, dict) or not as_string(candidate.get("taskObjective")) or not as_string(candidate.get("suggestedStartingInstruction")):
        return None
    items = []
    for index, item in enumerate(candidate.get("items", []), 1):
        if not isinstance(item, dict) or item.get("section") not in CURATION_SECTIONS or not as_string(item.get("content")):
            continue
        content = as_string(item["content"])
        items.append({"id": as_string(item.get("id")) or stable_id("context", {"index": index, "content": content}), "section": item["section"], "content": content, "pinned": bool(item.get("pinned")) or content in pinned})
    if not items:
        return None
    return {"contractVersion": CONTRACT_VERSION, "kind": "context_curation", "status": "ok", "taskObjective": as_string(candidate["taskObjective"]), "items": items[:60], "suggestedStartingInstruction": as_string(candidate["suggestedStartingInstruction"]), "excludedHistory": strings(candidate.get("excludedHistory")), "accepted": False, "curationSource": "codex_model"}


def curate_context(arguments: dict[str, Any]) -> dict[str, Any]:
    target = as_string(arguments.get("targetTask"))
    mode = as_string(arguments.get("mode"))
    if not target or mode not in {"fresh_task", "continue_current"}:
        raise ValueError("targetTask and mode (fresh_task or continue_current) are required.")
    pinned = set(strings(arguments.get("pinnedItems")))
    model_result = normalize_model_curation(arguments.get("modelBundle"), target, pinned)
    if model_result is not None:
        attach_pending_handoff(arguments, target, mode, model_result)
        append_intervention(arguments, "context.curation_completed", {"targetTask": target, "mode": mode, "itemCount": len(model_result["items"]), "pinnedItemCount": sum(item["pinned"] for item in model_result["items"]), "accepted": arguments.get("developerConfirmed") is True, "curationSource": "codex_model", "handoffId": model_result.get("handoffId")})
        return model_result
    sources = [
        ("background", strings(arguments.get("conversationHistory"))),
        ("decision", strings(arguments.get("knownDecisions"))),
        ("file", strings(arguments.get("relevantFiles"))),
        ("constraint", strings(arguments.get("constraints"))),
        ("implementation_state", strings(arguments.get("implementationState"))),
        ("completed_work", strings(arguments.get("completedWork"))),
        ("remaining_work", strings(arguments.get("remainingWork"))),
        ("issue", strings(arguments.get("knownIssues"))),
        ("validation", strings(arguments.get("validation"))),
        ("open_question", strings(arguments.get("openQuestions"))),
    ]
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for section, values in sources:
        for content in values:
            if content in seen:
                continue
            seen.add(content)
            items.append({"id": stable_id("context", {"section": section, "content": content}), "section": section, "content": content, "pinned": content in pinned})
    for content in pinned:
        if content not in seen:
            items.append({"id": stable_id("context", {"section": "constraint", "content": content}), "section": "constraint", "content": content, "pinned": True})
    if not items:
        items.append({"id": stable_id("context", target), "section": "background", "content": target, "pinned": False})
    result = {
        "contractVersion": CONTRACT_VERSION,
        "kind": "context_curation",
        "status": "ok",
        "taskObjective": target,
        "items": items[:60],
        "suggestedStartingInstruction": target,
        "excludedHistory": strings(arguments.get("excludedHistory")),
        "accepted": False,
        "curationSource": "deterministic_fallback",
    }
    attach_pending_handoff(arguments, target, mode, result)
    append_intervention(arguments, "context.curation_completed", {"targetTask": target, "mode": mode, "itemCount": len(result["items"]), "pinnedItemCount": sum(item["pinned"] for item in result["items"]), "accepted": arguments.get("developerConfirmed") is True, "handoffId": result.get("handoffId")})
    return result


def session_status(arguments: dict[str, Any]) -> dict[str, Any]:
    workspace, log_path, intervention_path, state_path = paths(arguments)
    session_id = as_string(arguments.get("sessionId"))
    records = load_records(log_path, session_id)
    result = {
        "workspace": str(workspace),
        "sessionId": session_id or None,
        "sessionLog": str(log_path),
        "interventionLog": str(intervention_path),
        "feedbackReport": str(workspace / "Code Buddy.md"),
        "analyticsReport": str(workspace / "Code Buddy Analytics.md"),
        "stateDirectory": str(state_path / ".state"),
        "recordCount": len(records),
        "latestRecordType": records[-1].get("recordType") if records else None,
    }
    return result


def record_intervention(arguments: dict[str, Any]) -> dict[str, Any]:
    event_type = as_string(arguments.get("eventType"))
    data = arguments.get("data")
    if not event_type or not isinstance(data, dict):
        raise ValueError("eventType and object data are required.")
    append_intervention(arguments, event_type, data)
    return {"status": "recorded", "eventType": event_type}


def tool(name: str, description: str, required: list[str], properties: dict[str, Any], readonly: bool = False) -> dict[str, Any]:
    return {
        "name": name,
        "title": "Code Buddy " + name.replace("_", " ").title(),
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
        "annotations": {"readOnlyHint": readonly, "destructiveHint": False, "openWorldHint": False},
    }


WORKSPACE = {"type": "string", "description": "Absolute workspace path. Code Buddy stores only local logs under this project."}
SESSION = {"type": "string", "description": "Optional Codex session/thread id when available."}
TOOLS = [
    tool("review_prompt", "Evaluate a meaningful coding prompt before implementation. Pass an optional modelAssessment when you have prepared a semantic assessment; Code Buddy validates it, preserves the original prompt, and falls back safely when absent.", ["workspace", "prompt"], {"workspace": WORKSPACE, "sessionId": SESSION, "taskId": {"type": "string"}, "prompt": {"type": "string"}, "relevantContext": {"type": "array", "items": {"type": "string"}}, "modelAssessment": {"type": "object", "description": "Optional Codex semantic review with score, dimensions, reasons, issues, interventionRecommended, suggestions, and options."}}),
    tool("decompose_task", "Assess task complexity and provide an optional, dependency-ordered strategy while preserving the original task option. Pass modelAssessment when a Codex semantic assessment has been prepared.", ["workspace", "task"], {"workspace": WORKSPACE, "sessionId": SESSION, "taskId": {"type": "string"}, "task": {"type": "string"}, "relevantContext": {"type": "array", "items": {"type": "string"}}, "modelAssessment": {"type": "object", "description": "Optional Codex semantic assessment with complexityScore, reasons, decompositionRecommended, and strategies."}}),
    tool("measure_context", "Measure supplied native context usage or honestly estimate pressure from Code Buddy's local Codex event log.", ["workspace"], {"workspace": WORKSPACE, "sessionId": SESSION, "nativeMeasurement": {"type": "object", "properties": {"value": {"type": "number", "minimum": 0}, "capacity": {"type": "number", "minimum": 1}, "confidence": {"type": "string"}, "providerId": {"type": "string"}}, "required": ["value"]}}),
    tool("assess_session_fit", "Assess whether the current meaningful coding request belongs in this task or merits a developer-controlled fresh-task handoff. It never creates a task automatically.", ["workspace", "prompt"], {"workspace": WORKSPACE, "sessionId": SESSION, "taskId": {"type": "string"}, "prompt": {"type": "string"}, "previousPrompt": {"type": "string"}, "relevantContext": {"type": "array", "items": {"type": "string"}}, "modelAssessment": {"type": "object", "description": "Optional Codex semantic assessment with newTaskLikelihood, confidence, and reason."}}),
    tool("curate_context", "Create a previewable minimum-sufficient handoff only after the developer chooses curation. Set developerConfirmed to true only after the developer chose fresh-task curation; that creates a marked handoff that must be pasted into the fresh task. Pass modelBundle when a Codex semantic curation has been prepared.", ["workspace", "targetTask", "mode"], {"workspace": WORKSPACE, "sessionId": SESSION, "targetTask": {"type": "string"}, "mode": {"type": "string", "enum": ["fresh_task", "continue_current"]}, "developerConfirmed": {"type": "boolean", "description": "True only after the developer explicitly chose fresh-task curation."}, "conversationHistory": {"type": "array", "items": {"type": "string"}}, "knownDecisions": {"type": "array", "items": {"type": "string"}}, "relevantFiles": {"type": "array", "items": {"type": "string"}}, "constraints": {"type": "array", "items": {"type": "string"}}, "implementationState": {"type": "array", "items": {"type": "string"}}, "completedWork": {"type": "array", "items": {"type": "string"}}, "remainingWork": {"type": "array", "items": {"type": "string"}}, "knownIssues": {"type": "array", "items": {"type": "string"}}, "validation": {"type": "array", "items": {"type": "string"}}, "openQuestions": {"type": "array", "items": {"type": "string"}}, "pinnedItems": {"type": "array", "items": {"type": "string"}}, "excludedHistory": {"type": "array", "items": {"type": "string"}}, "modelBundle": {"type": "object", "description": "Optional Codex semantic curation with taskObjective, items, suggestedStartingInstruction, and excludedHistory."}}),
    tool("session_status", "Return local Code Buddy log and report paths for the current workspace.", ["workspace"], {"workspace": WORKSPACE, "sessionId": SESSION}, True),
    tool("record_intervention", "Record the developer's explicit choice or a controlled fallback in the local intervention log.", ["workspace", "eventType", "data"], {"workspace": WORKSPACE, "sessionId": SESSION, "taskId": {"type": "string"}, "eventType": {"type": "string"}, "data": {"type": "object"}}),
]


HANDLERS = {
    "review_prompt": review_prompt,
    "decompose_task": decompose_task,
    "measure_context": estimate_context,
    "assess_session_fit": assess_session_fit,
    "curate_context": curate_context,
    "session_status": session_status,
    "record_intervention": record_intervention,
}


def result_message(identifier: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {"jsonrpc": "2.0", "id": identifier}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return response


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    identifier = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if method == "notifications/initialized" or (isinstance(method, str) and method.startswith("notifications/")):
        return None
    if method == "initialize":
        return result_message(identifier, {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": "For each meaningful coding task, call review_prompt, decompose_task, measure_context, and assess_session_fit before implementation. Begin substantive work with the four-part Code Buddy health line, preserve the original option, ask before using any alternative or curation, and pass the absolute workspace path.",
        })
    if method == "ping":
        return result_message(identifier, {})
    if method == "tools/list":
        return result_message(identifier, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        handler = HANDLERS.get(name)
        if handler is None:
            return result_message(identifier, error={"code": -32602, "message": f"Unknown Code Buddy tool: {name}"})
        try:
            output = handler(arguments)
            text = json.dumps(output, ensure_ascii=False)
            return result_message(identifier, {"content": [{"type": "text", "text": text}], "structuredContent": output, "isError": False})
        except (ValueError, TypeError) as error:
            return result_message(identifier, {"content": [{"type": "text", "text": str(error)}], "isError": True})
        except Exception as error:  # Keep optional governance tools fail-open.
            return result_message(identifier, {"content": [{"type": "text", "text": f"Code Buddy tool failed safely: {error}"}], "isError": True})
    return result_message(identifier, error={"code": -32601, "message": f"Method not found: {method}"})


def main() -> int:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                continue
            response = handle(message)
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                sys.stdout.flush()
        except json.JSONDecodeError:
            continue
    return 0


if __name__ == "__main__":
    sys.exit(main())
