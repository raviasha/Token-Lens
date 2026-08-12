#!/usr/bin/env python3
"""Generate deterministic Code Buddy feedback from Token Lens JSONL records."""

import datetime as dt
import difflib
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path


DEFAULT_IGNORED_DIRECTORIES = {
    ".git",
    ".token-lens",
    ".code-buddy",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    ".next",
    ".cache",
}
REPORT_NAMES = {"Code Buddy.md", "Code Buddy Analytics.md"}
CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN = 4
CONTEXT_ESTIMATOR_VERSION = "code_buddy_context_estimator_v2"
ACTION_WORDS = {
    "add",
    "build",
    "change",
    "configure",
    "create",
    "debug",
    "delete",
    "deploy",
    "design",
    "document",
    "explain",
    "fix",
    "implement",
    "improve",
    "install",
    "investigate",
    "migrate",
    "optimize",
    "refactor",
    "remove",
    "review",
    "rewrite",
    "test",
    "update",
    "write",
}
RUBRIC = [
    ("goal", "Clear goal/action", 20, r"\b(add|build|change|configure|create|debug|delete|deploy|design|document|explain|fix|implement|improve|install|investigate|migrate|optimi[sz]e|refactor|remove|review|rewrite|test|update|write)\b"),
    ("scope", "Files or scope", 20, r"(\b(file|files|folder|directory|module|component|class|function|endpoint|route|workspace|extension|service|package)\b|(?:^|[\s`])[^\s`]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|css|html|yaml|yml)\b)"),
    ("context", "Problem/context", 15, r"\b(because|currently|error|fails?|failing|when|using|existing|background|context|problem|bug|need|issue|behavior)\b"),
    ("constraints", "Constraints", 15, r"\b(must|should|do not|don't|without|compatible|keep|avoid|only|limit|constraint|prefer|required)\b"),
    ("acceptance", "Acceptance criteria", 20, r"(acceptance|done when|expected|should pass|success|criteria|result|completed when|works when)"),
    ("validation", "Validation command", 10, r"\b(test|tests|pytest|unittest|npm test|build|lint|typecheck|validate|check|verify|run)\b"),
]


def env_bool(name, default=True):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() not in {"0", "false", "no", "off"}


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def parse_timestamp(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def timestamp_key(record):
    parsed = parse_timestamp(record.get("localTimestamp")) or parse_timestamp(record.get("timestamp")) or parse_timestamp(record.get("recordedAt"))
    return parsed or dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def display_timestamp(record):
    value = record.get("localTimestamp") or record.get("timestamp") or record.get("recordedAt") or ""
    parsed = parse_timestamp(value)
    if parsed:
        return parsed.astimezone().isoformat(timespec="seconds")
    return str(value)


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9._-]", "_", str(value or "unknown"))


def get_paths():
    log_path = Path(os.environ.get("TOKEN_LENS_LOG_FILE", ""))
    workspace = Path(os.environ.get("TOKEN_LENS_WORKSPACE", "") or os.getcwd()).resolve()
    feedback = Path(os.environ.get("TOKEN_LENS_FEEDBACK_FILE", workspace / "Code Buddy.md"))
    analytics = Path(os.environ.get("TOKEN_LENS_ANALYTICS_FILE", workspace / "Code Buddy Analytics.md"))
    state_dir = Path(os.environ.get("TOKEN_LENS_STATE_DIR", log_path.parent / ".state"))
    return log_path, workspace, feedback, analytics, state_dir


def append_record(log_path, record):
    if not log_path:
        return
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    try:
        log_path.chmod(0o600)
    except OSError:
        pass


def load_records(log_path):
    if not log_path or not log_path.exists():
        return []
    records = []
    try:
        lines = log_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return records
    for line in lines:
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict) and record.get("schemaVersion") == 2:
            records.append(record)
    return sorted(records, key=timestamp_key)


def load_intervention_records():
    intervention_path = Path(os.environ.get("TOKEN_LENS_INTERVENTION_LOG_FILE", ""))
    if not intervention_path or not intervention_path.exists():
        return []
    records = []
    try:
        lines = intervention_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict) and record.get("schemaVersion") == 1:
            records.append(record)
    return records


def is_probably_text(sample):
    if not sample:
        return True
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def count_lines(text):
    if not text:
        return 0
    return len(text.splitlines())


def read_file_metadata(file_path, max_bytes):
    digest = hashlib.sha256()
    size = 0
    sample = b""
    content = None
    line_count = None
    line_count_complete = False
    try:
        with file_path.open("rb") as handle:
            first = handle.read(max_bytes + 1)
            sample = first[:8192]
            size = len(first)
            digest.update(first)
            if len(first) <= max_bytes:
                content_bytes = first
                remaining = b""
                content = content_bytes.decode("utf-8") if is_probably_text(sample) else None
                if content is not None:
                    line_count = count_lines(content)
                    line_count_complete = True
            else:
                remaining = handle.read(1024 * 1024)
                newline_count = first.count(b"\n")
                last_byte = first[-1:] if first else b""
                while remaining:
                    digest.update(remaining)
                    size += len(remaining)
                    newline_count += remaining.count(b"\n")
                    last_byte = remaining[-1:]
                    remaining = handle.read(1024 * 1024)
                if is_probably_text(sample):
                    line_count = newline_count + (1 if size and last_byte != b"\n" else 0)
                    line_count_complete = True
    except (OSError, UnicodeDecodeError):
        return None
    return {
        "bytes": size,
        "sha256": digest.hexdigest(),
        "kind": "text" if is_probably_text(sample) else "binary",
        "lineCount": line_count,
        "lineCountComplete": line_count_complete,
        "content": content,
    }


def should_skip(relative_path, directory_names):
    if relative_path.name in REPORT_NAMES:
        return True
    return any(part in directory_names for part in relative_path.parts)


def capture_snapshot(workspace, max_bytes):
    files = {}
    truncated = False
    max_files = 5000
    for root, directories, filenames in os.walk(workspace, followlinks=False):
        directories[:] = [name for name in directories if name not in DEFAULT_IGNORED_DIRECTORIES]
        for filename in filenames:
            file_path = Path(root) / filename
            relative_path = file_path.relative_to(workspace)
            if should_skip(relative_path, DEFAULT_IGNORED_DIRECTORIES):
                continue
            if len(files) >= max_files:
                truncated = True
                break
            metadata = read_file_metadata(file_path, max_bytes)
            if metadata is not None:
                metadata.pop("content", None) if metadata.get("kind") == "binary" else None
                files[relative_path.as_posix()] = metadata
        if truncated:
            break
    return {"files": files, "truncated": truncated, "capturedAt": now_iso()}


def snapshot_path(state_dir, session_id):
    return state_dir / "worktree" / (safe_name(session_id) + ".json")


def save_snapshot(state_dir, session_id, prompt_event_id, workspace, snapshot):
    state_path = snapshot_path(state_dir, session_id)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "sessionId": session_id,
        "promptEventId": prompt_event_id,
        "promptEventIds": [prompt_event_id] if prompt_event_id else [],
        "lastPromptEventId": prompt_event_id,
        "workspace": str(workspace),
        "snapshot": snapshot,
    }
    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def load_snapshot(state_dir, session_id):
    state_path = snapshot_path(state_dir, session_id)
    try:
        return state_path, json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return state_path, None


def line_delta(before, after):
    if before is None or after is None:
        return None, None
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    added = 0
    deleted = 0
    for tag, before_start, before_end, after_start, after_end in difflib.SequenceMatcher(None, before_lines, after_lines).get_opcodes():
        if tag in {"replace", "delete"}:
            deleted += before_end - before_start
        if tag in {"replace", "insert"}:
            added += after_end - after_start
    return added, deleted


def compare_snapshots(before, after):
    before_files = before.get("files", {}) if before else {}
    after_files = after.get("files", {}) if after else {}
    changed = []
    for relative_path in sorted(set(before_files) | set(after_files)):
        old = before_files.get(relative_path)
        new = after_files.get(relative_path)
        if old and new and old.get("sha256") == new.get("sha256"):
            continue
        if old is None:
            change = "added"
        elif new is None:
            change = "deleted"
        else:
            change = "modified"
        added, deleted = line_delta(old.get("content") if old else None, new.get("content") if new else None)
        exact = added is not None and deleted is not None
        if added is None and change == "added" and new:
            added = new.get("lineCount") if new.get("lineCountComplete") else None
            exact = added is not None
            deleted = 0
        if deleted is None and change == "deleted" and old:
            deleted = old.get("lineCount") if old.get("lineCountComplete") else None
            exact = deleted is not None
            added = 0
        old_lines = old.get("lineCount") if old else 0
        new_lines = new.get("lineCount") if new else 0
        line_delta_value = (
            new_lines - old_lines
            if old_lines is not None
            and new_lines is not None
            and (not old or old.get("lineCountComplete"))
            and (not new or new.get("lineCountComplete"))
            else None
        )
        changed.append({
            "path": relative_path,
            "change": change,
            "beforeBytes": old.get("bytes") if old else 0,
            "afterBytes": new.get("bytes") if new else 0,
            "linesAdded": added,
            "linesDeleted": deleted,
            "lineDelta": line_delta_value,
            "lineCountExact": exact,
            "kind": (new or old).get("kind"),
        })
    known_added = [item["linesAdded"] for item in changed if item["linesAdded"] is not None]
    known_deleted = [item["linesDeleted"] for item in changed if item["linesDeleted"] is not None]
    complete = len(known_added) == len(changed) and len(known_deleted) == len(changed)
    lines_added = sum(known_added) if complete else None
    lines_deleted = sum(known_deleted) if complete else None
    return {
        "filesAdded": sum(item["change"] == "added" for item in changed),
        "filesModified": sum(item["change"] == "modified" for item in changed),
        "filesDeleted": sum(item["change"] == "deleted" for item in changed),
        "filesChanged": len(changed),
        "linesAdded": lines_added,
        "linesDeleted": lines_deleted,
        "linesNet": lines_added - lines_deleted if lines_added is not None and lines_deleted is not None else None,
        "lineCountsComplete": complete,
        "snapshotTruncated": bool((before or {}).get("truncated") or (after or {}).get("truncated")),
        "changedFiles": changed[:200],
    }


def hash_value(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]


def append_outcome(log_path, session_id, workspace, prompt_event_id, prompt_event_ids, event_id, metrics, available):
    record = {
        "schemaVersion": 2,
        "eventId": "analytics_" + hash_value({"sessionId": session_id, "promptEventId": prompt_event_id, "eventId": event_id, "metrics": metrics}),
        "recordType": "turn.outcome",
        "source": "analytics",
        "sourceEventType": "worktree.delta",
        "sessionId": session_id,
        "turnId": None,
        "parentId": prompt_event_id,
        "timestamp": now_iso(),
        "localTimestamp": now_iso(),
        "recordedAt": now_iso(),
        "workspace": str(workspace),
        "data": {
            "promptEventId": prompt_event_id,
            "promptEventIds": prompt_event_ids,
            "lastPromptEventId": prompt_event_ids[-1] if prompt_event_ids else None,
            "worktreeTrackingAvailable": available,
            "attribution": "observed_worktree_delta",
            "metrics": metrics,
        },
    }
    append_record(log_path, record)


def text_from_record(record):
    record_type = record.get("recordType")
    data = record.get("data")
    if record_type == "user.prompt" and isinstance(data, dict):
        return str(data.get("prompt") or "")
    if record_type == "prompt.transformed" and isinstance(data, dict):
        return str(data.get("transformedPrompt") or data.get("prompt") or "")
    if record_type == "assistant.message" and isinstance(data, dict):
        return json.dumps({"content": data.get("content"), "toolRequests": data.get("toolRequests")}, ensure_ascii=False)
    if record_type in {"tool.started", "tool.completed", "tool.failed", "error.occurred"}:
        return json.dumps(data, ensure_ascii=False) if data is not None else ""
    if record_type == "transcript.event" and isinstance(data, dict):
        values = {
            key: data.get(key)
            for key in ("content", "prompt", "result", "text", "output", "error", "toolRequests", "attachments")
            if data.get(key) is not None
        }
        return json.dumps(values, ensure_ascii=False)
    return ""


def text_character_count(value):
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value)
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    except (TypeError, ValueError):
        return 0


def provider_usage(record):
    data = record.get("data")
    usage = data.get("providerUsage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return {}
    fields = ("inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "totalTokens")
    return {field: usage[field] for field in fields if isinstance(usage.get(field), (int, float))}


def record_context(record):
    data = record.get("data")
    context = data.get("context") if isinstance(data, dict) else None
    if isinstance(context, dict) and isinstance(context.get("observedChars"), (int, float)):
        components = context.get("components") if isinstance(context.get("components"), dict) else {}
        return {
            "observedChars": max(0, int(context.get("observedChars", 0))),
            "modelFacingChars": max(0, int(context.get("modelFacingChars", context.get("observedChars", 0)))),
            "components": {
                str(key): max(0, int(value))
                for key, value in components.items()
                if isinstance(value, (int, float))
            },
            "measurement": str(context.get("measurement") or "observed_text_estimate"),
        }

    text = text_from_record(record)
    if not text:
        return {"observedChars": 0, "modelFacingChars": 0, "components": {}, "measurement": "unavailable"}
    record_type = record.get("recordType") or "unknown"
    component = {
        "user.prompt": "prompt",
        "prompt.transformed": "transformedPrompt",
        "assistant.message": "assistant",
        "tool.started": "toolInput",
        "tool.completed": "toolResult",
        "tool.failed": "toolError",
        "error.occurred": "error",
    }.get(record_type, "transcript")
    characters = text_character_count(text)
    return {
        "observedChars": characters,
        "modelFacingChars": characters,
        "components": {component: characters},
        "measurement": "observed_text_estimate",
    }


def observed_context(records):
    observed_chars = 0
    model_facing_chars = 0
    components = {}
    reported_usage = {}
    has_provider_usage = False
    for record in records:
        record_type = record.get("recordType")
        if record_type in {"transcript.snapshot", "turn.outcome", "context.load_snapshot"}:
            continue
        context = record_context(record)
        observed_chars += context["observedChars"]
        model_facing_chars += context["modelFacingChars"]
        for key, value in context["components"].items():
            components[key] = components.get(key, 0) + value
        usage = provider_usage(record)
        if usage:
            has_provider_usage = True
            for key, value in usage.items():
                reported_usage[key] = reported_usage.get(key, 0) + value

    return {
        "measurement": "provider_reported" if has_provider_usage else "observed_text_estimate",
        "tokenEstimateMethod": "provider_usage_or_characters_div_4",
        "observedChars": observed_chars,
        "estimatedTokens": math.ceil(observed_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if observed_chars else 0,
        "modelFacingChars": model_facing_chars,
        "modelFacingTokensEstimate": math.ceil(model_facing_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if model_facing_chars else 0,
        "components": components,
        "providerUsage": reported_usage,
    }


def prompt_effective_characters(records):
    prompt_records = [record for record in records if record.get("recordType") in {"user.prompt", "prompt.transformed"}]
    transformed = [record for record in prompt_records if record.get("recordType") == "prompt.transformed"]
    selected = transformed[-1:] if transformed else [record for record in prompt_records if record.get("recordType") == "user.prompt"]
    return sum(record_context(record)["observedChars"] for record in selected)


def context_warning(exposure_tokens, previous_exposures):
    capacity = max(1_000, env_int("TOKEN_LENS_CONTEXT_CAPACITY_TOKENS", 40_000))
    warning_threshold = min(1.0, max(0.0, env_float("TOKEN_LENS_CONTEXT_WARNING_THRESHOLD", 0.70)))
    critical_threshold = min(1.0, max(warning_threshold, env_float("TOKEN_LENS_CONTEXT_CRITICAL_THRESHOLD", 0.85)))
    utilization = exposure_tokens / capacity
    baseline = None
    ratio = None
    if previous_exposures:
        baseline = int(round(sorted(previous_exposures)[len(previous_exposures) // 2]))
        if baseline > 0:
            ratio = exposure_tokens / baseline
    if utilization >= critical_threshold or (ratio is not None and ratio >= 2):
        level = "high"
    elif utilization >= warning_threshold or (ratio is not None and ratio >= 1.5):
        level = "medium"
    else:
        level = "normal"
    return {
        "level": level,
        "thresholdState": "critical" if level == "high" else "warning" if level == "medium" else "normal",
        "baselineTokens": baseline,
        "ratio": round(ratio, 2) if ratio is not None else None,
        "utilization": round(utilization, 4),
        "capacityTokens": capacity,
        "warningThreshold": warning_threshold,
        "criticalThreshold": critical_threshold,
    }


def context_turns(records):
    prompt_positions = [index for index, record in enumerate(records) if record.get("recordType") == "user.prompt"]
    if not prompt_positions:
        return []
    prior_visible_chars = observed_context(records[:prompt_positions[0]])["observedChars"]
    previous_exposures = []
    turns = []
    for prompt_number, prompt_index in enumerate(prompt_positions, 1):
        next_prompt_index = prompt_positions[prompt_number] if prompt_number < len(prompt_positions) else len(records)
        segment = records[prompt_index:next_prompt_index]
        raw_segment_chars = observed_context(segment)["observedChars"]
        raw_prompt_chars = sum(
            record_context(record)["observedChars"]
            for record in segment
            if record.get("recordType") in {"user.prompt", "prompt.transformed"}
        )
        effective_prompt_chars = prompt_effective_characters(segment)
        non_prompt_chars = max(0, raw_segment_chars - raw_prompt_chars)
        turn_observed_chars = non_prompt_chars + effective_prompt_chars
        model_interactions_estimate = max(
            1,
            1 + sum(record.get("recordType") in {"tool.completed", "tool.failed"} for record in segment)
        )
        repeated_prior_context_chars = prior_visible_chars * model_interactions_estimate
        exposure_chars = repeated_prior_context_chars + effective_prompt_chars + non_prompt_chars
        exposure_tokens = math.ceil(exposure_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if exposure_chars else 0
        segment_context = observed_context(segment)
        usage = segment_context["providerUsage"]
        warning = context_warning(exposure_tokens, previous_exposures)
        turns.append({
            "promptNumber": prompt_number,
            "promptEventId": records[prompt_index].get("eventId"),
            "timestamp": records[prompt_index].get("localTimestamp") or records[prompt_index].get("timestamp"),
            "promptChars": effective_prompt_chars,
            "promptTokensEstimate": math.ceil(effective_prompt_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if effective_prompt_chars else 0,
            "priorSessionChars": prior_visible_chars,
            "priorSessionTokensEstimate": math.ceil(prior_visible_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if prior_visible_chars else 0,
            "turnObservedChars": turn_observed_chars,
            "turnObservedTokensEstimate": math.ceil(turn_observed_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if turn_observed_chars else 0,
            "contextExposureChars": exposure_chars,
            "contextExposureTokensEstimate": exposure_tokens,
            "modelInteractionsEstimate": model_interactions_estimate,
            "repeatedPriorContextChars": repeated_prior_context_chars,
            "repeatedPriorContextTokensEstimate": math.ceil(repeated_prior_context_chars / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) if repeated_prior_context_chars else 0,
            "measurement": segment_context["measurement"],
            "providerUsage": usage,
            "warning": warning,
        })
        previous_exposures.append(exposure_tokens)
        prior_visible_chars += turn_observed_chars
    return turns


def latest_context_turn(records, prompt_event_id=None):
    turns = context_turns(records)
    if prompt_event_id:
        matching = [turn for turn in turns if turn.get("promptEventId") == prompt_event_id]
        if matching:
            return matching[-1]
    return turns[-1] if turns else None


def prompt_quality(prompt):
    prompt = (prompt or "").strip()
    checks = []
    score = 0
    for key, label, points, pattern in RUBRIC:
        present = bool(re.search(pattern, prompt, re.IGNORECASE))
        checks.append({"key": key, "label": label, "points": points, "present": present})
        if present:
            score += points
    if len(prompt.split()) < 4:
        score = max(0, score - 10)
    return {"score": score, "checks": checks, "wordCount": len(prompt.split())}


def task_decomposition(prompt):
    cleaned = (prompt or "").strip()
    raw_parts = re.split(r"\n+|(?<=[.!?])\s+|;", cleaned)
    parts = []
    for part in raw_parts:
        part = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", part).strip()
        if part:
            parts.append(part)
    action_matches = re.findall(r"\b(?:" + "|".join(sorted(ACTION_WORDS)) + r")\b", cleaned.lower())
    if len(parts) == 1 and len(action_matches) > 1:
        parts = [parts[0]]
    explicit = bool(re.search(r"(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+", cleaned))
    if not parts:
        parts = ["Clarify the intended goal and expected result."]
    steps = parts[:8]
    if len(parts) > 8:
        steps.append("Additional prompt detail omitted from this short summary.")
    if not cleaned:
        steps = ["No prompt text was captured."]
    return {
        "steps": steps,
        "explicit": explicit,
        "actionCount": len(action_matches),
        "score": 100 if explicit and len(steps) > 1 else 60 if len(steps) > 1 or len(action_matches) > 1 else 30 if action_matches else 0,
    }


def observed_size(metrics):
    if not metrics or not metrics.get("worktreeTrackingAvailable"):
        return "not measured"
    data = metrics.get("metrics", metrics)
    files = data.get("filesChanged", 0) or 0
    added = data.get("linesAdded")
    deleted = data.get("linesDeleted")
    lines = (added or 0) + (deleted or 0)
    if files <= 3 and lines <= 80:
        return "small"
    if files <= 8 and lines <= 300:
        return "medium"
    return "large"


def format_number(value):
    return "not available" if value is None else f"{value:,}"


def format_duration(records):
    if len(records) < 2:
        return "not available"
    duration = (timestamp_key(records[-1]) - timestamp_key(records[0])).total_seconds()
    if duration < 0:
        return "not available"
    minutes, seconds = divmod(int(duration), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def duration_seconds(records):
    if len(records) < 2:
        return 0
    duration = (timestamp_key(records[-1]) - timestamp_key(records[0])).total_seconds()
    return max(0, int(duration))


def session_records(records, session_id):
    if session_id:
        selected = [record for record in records if record.get("sessionId") == session_id]
        if selected:
            return selected
    latest = records[-1].get("sessionId") if records else None
    return [record for record in records if record.get("sessionId") == latest] if latest else records


def latest_outcome(records, prompt_event_id=None):
    outcomes = [record for record in records if record.get("recordType") == "turn.outcome"]
    if prompt_event_id:
        matching = [
            record for record in outcomes
            if (record.get("data") or {}).get("promptEventId") == prompt_event_id
            or prompt_event_id in ((record.get("data") or {}).get("promptEventIds") or [])
        ]
        if matching:
            return matching[-1]
    return outcomes[-1] if outcomes else None


def latest_prompt(records):
    prompts = [record for record in records if record.get("recordType") == "user.prompt"]
    return prompts[-1] if prompts else None


def session_metrics(records):
    counts = {}
    for record in records:
        record_type = record.get("recordType", "unknown")
        counts[record_type] = counts.get(record_type, 0) + 1
    outcomes = [record for record in records if record.get("recordType") == "turn.outcome"]
    outcome_data = [(record.get("data") or {}).get("metrics") or {} for record in outcomes]
    def sum_known(key):
        values = [item.get(key) for item in outcome_data]
        return sum(values) if values and all(value is not None for value in values) else None
    context = observed_context(records)
    prompt_chars = context["components"].get("prompt", 0)
    transformed_prompt_chars = context["components"].get("transformedPrompt", 0)
    assistant_chars = context["components"].get("assistant", 0)
    referenced_files = set()
    file_pattern = re.compile(r"[a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|css|html|ya?ml)\b")
    for record in records:
        referenced_files.update(file_pattern.findall(text_from_record(record)))
    return {
        "prompts": counts.get("user.prompt", 0),
        "turns": counts.get("turn.ended", 0) or counts.get("agent.stopped", 0),
        "assistantMessages": counts.get("assistant.message", 0),
        "toolStarts": counts.get("tool.started", 0),
        "toolCompletions": counts.get("tool.completed", 0),
        "toolFailures": counts.get("tool.failed", 0),
        "filesReferenced": len(referenced_files),
        "errors": counts.get("error.occurred", 0),
        "outcomes": len(outcomes),
        "filesChanged": sum((item.get("filesChanged") or 0) for item in outcome_data),
        "linesAdded": sum_known("linesAdded"),
        "linesDeleted": sum_known("linesDeleted"),
        "observedChars": context["observedChars"],
        "promptChars": prompt_chars,
        "transformedPromptChars": transformed_prompt_chars,
        "assistantChars": assistant_chars,
        "estimatedTokens": context["estimatedTokens"],
        "contextMeasurement": context["measurement"],
        "providerUsage": context["providerUsage"],
        "durationSeconds": duration_seconds(records),
    }


def append_context_snapshot(log_path, session_id, workspace, prompt_event_id, event_id):
    records = session_records(load_records(log_path), session_id)
    context_turn = latest_context_turn(records, prompt_event_id)
    if not context_turn:
        return
    session = session_metrics(records)
    timestamp = now_iso()
    threshold_state = context_turn["warning"]["thresholdState"]
    record = {
        "schemaVersion": 2,
        "eventId": "context_" + hash_value({
            "sessionId": session_id,
            "promptEventId": prompt_event_id,
            "eventId": event_id,
            "value": context_turn["contextExposureTokensEstimate"],
            "estimatorVersion": CONTEXT_ESTIMATOR_VERSION,
        }),
        "recordType": "context.load_snapshot",
        "source": "analytics",
        "sourceEventType": "estimated_context_pressure",
        "sessionId": session_id,
        "turnId": None,
        "parentId": prompt_event_id,
        "timestamp": timestamp,
        "localTimestamp": timestamp,
        "recordedAt": timestamp,
        "workspace": str(workspace),
        "data": {
            "estimatedContextPressure": {
                "value": context_turn["contextExposureTokensEstimate"],
                "unit": "estimated_tokens",
                "utilization": context_turn["warning"]["utilization"],
                "measurementMethod": "estimate",
                "estimateMethod": "observable_text_and_model_interactions",
                "confidence": "low",
                "thresholdState": threshold_state,
                "terminology": "Estimated Context Pressure",
                "estimatorVersion": CONTEXT_ESTIMATOR_VERSION,
            },
            "observableSignals": {
                "turns": session["prompts"],
                "promptCharacters": session["promptChars"],
                "responseCharacters": session["assistantChars"],
                "observedCharacters": session["observedChars"],
                "toolCalls": session["toolStarts"],
                "toolFailures": session["toolFailures"] + session["errors"],
                "filesReferenced": session["filesReferenced"],
                "filesChanged": session["filesChanged"],
                "linesAdded": session["linesAdded"],
                "linesDeleted": session["linesDeleted"],
                "durationSeconds": session["durationSeconds"],
            },
            "providerUsageObserved": bool(session["providerUsage"]),
            "providerUsageLimitation": "Per-event usage does not prove complete active-context utilization.",
        },
    }
    append_record(log_path, record)


def intervention_metrics(session_id):
    records = [
        record for record in load_intervention_records()
        if not record.get("sessionId") or not session_id or record.get("sessionId") == session_id
    ]
    counts = {}
    for record in records:
        event_type = str(record.get("eventType") or "unknown")
        counts[event_type] = counts.get(event_type, 0) + 1
    choices = [record.get("data") or {} for record in records if record.get("eventType", "").endswith("choice")]
    latest_health = next((record.get("data") or {} for record in reversed(records)
                          if record.get("eventType") in {"health.check_completed", "health.check_limited"}), {})
    return {
        "records": records,
        "counts": counts,
        "choices": choices,
        "promptReviews": counts.get("prompt.reviewed", 0),
        "decompositionEvaluations": counts.get("task.decomposition_evaluated", 0),
        "sessionFitEvaluations": counts.get("session.fit_evaluated", 0),
        "contextWarnings": counts.get("context.warning", 0),
        "curationCompleted": counts.get("context.curation_completed", 0),
        "preflightStarted": counts.get("preflight.started", 0),
        "preflightCompleted": counts.get("preflight.completed", 0),
        "preflightGateDenials": counts.get("preflight.gate_denied", 0),
        "preflightFallbackRequests": counts.get("preflight.fallback_requested", 0),
        "preflightBypasses": counts.get("preflight.bypassed", 0),
        "toolFailures": counts.get("tool.failed", 0) + counts.get("preflight.tool_failed", 0),
        "originalRetained": sum(
            bool((record.get("data") or {}).get("originalPromptRetained") or (record.get("data") or {}).get("originalTaskRetained"))
            for record in records
        ),
        "curationAccepted": sum(
            bool((record.get("data") or {}).get("accepted"))
            for record in records if record.get("eventType") == "context.curation_completed"
        ),
        "healthCategories": latest_health.get("categories") if isinstance(latest_health.get("categories"), dict) else {},
    }


def health_status(interventions, category, event_type, detail=None):
    categories = interventions.get("healthCategories") or {}
    if category in categories:
        return str(categories[category])
    for record in reversed(interventions.get("records") or []):
        data = record.get("data") or {}
        if record.get("eventType") == "tool.failed" and detail and data.get("toolName") == detail:
            return "checked — limited evidence"
        if record.get("eventType") == event_type:
            return "satisfactory"
    return "not recorded"


def recommendation(prompt, quality, decomposition, outcome, records, context_turn=None):
    metrics = (outcome.get("data") or {}).get("metrics") if outcome else None
    failures = sum(record.get("recordType") in {"tool.failed", "error.occurred"} for record in records)
    missing = {item["key"] for item in quality["checks"] if not item["present"]}
    observed = observed_size((outcome or {}).get("data"))
    template = "Implement [goal] in [files or scope]. Context: [relevant problem]. Constraints: [constraints]. Done when: [acceptance criteria]. Validate with: [command]."
    if context_turn and context_turn["warning"]["level"] == "high":
        title = "Start fresh with a compact handoff"
        why = "This turn reached high Estimated Context Pressure, so continuing the same session may resend a large amount of prior context."
        priority = "high"
        bullets = [
            f"Estimated Context Pressure: approximately {format_number(context_turn['contextExposureTokensEstimate'])} estimated tokens across {context_turn['modelInteractionsEstimate']} estimated model interaction(s).",
            "First ask Copilot for a handoff summary of the current state, decisions, unresolved issues, relevant files, and next action in 300 words or fewer; do not edit files.",
            "Start a new Copilot session and include only that summary plus the relevant files. Avoid `continue` or re-pasting the full transcript."
        ]
        template = "Summarize the current state, decisions, unresolved issues, relevant files, and next action in 300 words or fewer. Do not modify files."
    elif "goal" in missing:
        title = "State the goal as an action"
        why = "The prompt does not clearly identify the change or outcome you want."
        priority = "high"
        bullets = ["Start with a verb such as implement, fix, explain, or test."]
    elif "acceptance" in missing:
        title = "Define what done means"
        why = "A measurable done condition makes the agent’s result easier to review."
        priority = "high"
        bullets = ["Add one or two observable acceptance criteria."]
    elif ("scope" in missing and observed == "large") or observed == "large":
        title = "Constrain the scope and split the task"
        why = "The observed worktree change is large enough that smaller phases should be easier to review."
        priority = "high"
        bullets = ["Name the files or module to change.", "Ask for one coherent phase at a time."]
    elif context_turn and context_turn["warning"]["level"] == "medium":
        title = "Keep the next context focused"
        why = "Estimated Context Pressure is growing relative to this session or the configured threshold."
        priority = "medium"
        bullets = [
            "Start the next prompt with a short summary rather than repeating the conversation.",
            "Name only the files and constraints needed for the next step.",
            "If the session keeps growing, request a handoff summary and start a fresh session."
        ]
        template = "Using this concise context: [summary], implement [goal] only in [files or scope]. Done when: [acceptance criteria]. Validate with: [command]."
    elif "scope" in missing:
        title = "Name the files or scope"
        why = "A concrete scope reduces unrelated edits and makes the change easier to review."
        priority = "medium"
        bullets = ["Mention the target files, module, or boundary."]
    elif "validation" in missing or failures:
        title = "Add a validation command"
        why = "The next turn should make verification explicit rather than leaving quality implicit."
        priority = "medium"
        bullets = ["Specify the test, build, lint, or check command to run."]
    elif decomposition["score"] < 60:
        title = "Break the request into explicit steps"
        why = "The prompt contains little visible task decomposition."
        priority = "medium"
        bullets = ["Use a short numbered list for multi-part work."]
    else:
        title = "Keep the structure and add a measurable check"
        why = "The prompt already contains the core ingredients for an efficient turn."
        priority = "low"
        bullets = ["Continue naming scope, outcome, and validation together."]
    return {"priority": priority, "title": title, "why": why, "bullets": bullets, "template": template}


def short_summary(record):
    record_type = record.get("recordType", "unknown")
    data = record.get("data") or {}
    if record_type == "user.prompt":
        return str(data.get("prompt") or "")[:120].replace("\n", " ")
    if record_type == "assistant.message":
        return str(data.get("content") or "")[:120].replace("\n", " ")
    if record_type.startswith("tool."):
        return str(data.get("toolName") or data.get("error") or "tool event")[:120]
    if record_type == "turn.outcome":
        metrics = data.get("metrics") or {}
        return f"{metrics.get('filesChanged', 0)} files changed; {format_number(metrics.get('linesAdded'))} lines added"
    if record_type == "error.occurred":
        return str(data.get("error") or "error")[:120]
    return record_type


def markdown_escape(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def build_feedback(records, session_id):
    selected = session_records(records, session_id)
    prompt_record = latest_prompt(selected)
    prompt = str((prompt_record or {}).get("data", {}).get("prompt") or "")
    quality = prompt_quality(prompt)
    decomposition = task_decomposition(prompt)
    outcome = latest_outcome(selected, (prompt_record or {}).get("eventId"))
    outcome_data = (outcome or {}).get("data") or {}
    metrics = outcome_data.get("metrics") or {}
    context_turn = latest_context_turn(selected, (prompt_record or {}).get("eventId"))
    recommendation_data = recommendation(prompt, quality, decomposition, outcome, selected, context_turn)
    observed = observed_size(outcome_data)
    session = session_metrics(selected)
    interventions = intervention_metrics(session_id)
    prompt_status = health_status(interventions, "promptReviewer", "prompt.reviewed", "mcp__code_buddy__review_prompt")
    scope_status = health_status(interventions, "taskDecomposer", "task.decomposition_evaluated", "mcp__code_buddy__decompose_task")
    context_status = health_status(interventions, "contextMeasurement", "context.measured", "mcp__code_buddy__measure_context")
    session_fit_status = health_status(interventions, "sessionFit", "session.fit_evaluated", "mcp__code_buddy__assess_session_fit")
    updated = now_iso()
    lines = [
        "# Code Buddy",
        "",
        f"Updated: {updated}  ",
        f"Session: `{markdown_escape(session_id or 'unknown')}`",
        "",
        "## Recommendation",
        f"**{recommendation_data['priority'].title()} priority — {recommendation_data['title']}**",
        "",
        recommendation_data["why"],
        "",
    ]
    lines.extend(f"- {bullet}" for bullet in recommendation_data["bullets"])
    lines.extend([
        "",
        "## Your Performance",
        f"- Prompt quality: **{quality['score']}/100** ({prompt_status})",
        f"- Task decomposition: **{decomposition['score']}/100** ({len(decomposition['steps'])} detected step(s); {scope_status})",
        f"- Observed turn size: **{observed}**",
        f"- Worktree delta: **{metrics.get('filesChanged', 0)} file(s)**, **{format_number(metrics.get('linesAdded'))} added / {format_number(metrics.get('linesDeleted'))} deleted lines**",
        f"- Estimated Context Pressure: **~{format_number(context_turn['contextExposureTokensEstimate'])} estimated tokens** ({context_turn['warning']['thresholdState']}; {context_status})" if context_turn else f"- Estimated Context Pressure: **not measured** ({context_status})",
        f"- Session fit: **{session_fit_status}**",
        "",
        "## Suggested Next Prompt",
        f"> {recommendation_data['template']}",
        "",
        "_Detailed metrics are in `Code Buddy Analytics.md`. Provider usage is used when present; otherwise context numbers are deterministic observed-text estimates._",
        "",
    ])
    return "\n".join(lines)


def build_analytics(records, session_id):
    selected = session_records(records, session_id)
    session_id = session_id or (selected[-1].get("sessionId") if selected else "unknown")
    prompt_record = latest_prompt(selected)
    prompt = str((prompt_record or {}).get("data", {}).get("prompt") or "")
    quality = prompt_quality(prompt)
    decomposition = task_decomposition(prompt)
    outcome = latest_outcome(selected, (prompt_record or {}).get("eventId"))
    outcome_data = (outcome or {}).get("data") or {}
    metrics = outcome_data.get("metrics") or {}
    session = session_metrics(selected)
    context_turn = latest_context_turn(selected, (prompt_record or {}).get("eventId"))
    recommendation_data = recommendation(prompt, quality, decomposition, outcome, selected, context_turn)
    interventions = intervention_metrics(session_id)
    lines = [
        "# Code Buddy Analytics",
        "",
        f"Updated: {now_iso()}  ",
        f"Session: `{markdown_escape(session_id)}`",
        "",
        "## Session Summary",
        "| Metric | Value |",
        "|---|---:|",
        f"| Duration | {format_duration(selected)} |",
        f"| Prompts | {session['prompts']} |",
        f"| Completed turns | {session['turns']} |",
        f"| Assistant messages | {session['assistantMessages']} |",
        f"| Tool calls started / completed / failed | {session['toolStarts']} / {session['toolCompletions']} / {session['toolFailures']} |",
        f"| Hook errors | {session['errors']} |",
        f"| Observed files changed | {session['filesChanged']} |",
        f"| Observed lines added / deleted | {format_number(session['linesAdded'])} / {format_number(session['linesDeleted'])} |",
        "",
        "## Estimated Context Pressure",
        "| Measure | Characters | Estimated tokens* |",
        "|---|---:|---:|",
        f"| User prompts | {format_number(session['promptChars'])} | {math.ceil(session['promptChars'] / 4) if session['promptChars'] else 0:,} |",
        f"| Transformed prompts | {format_number(session['transformedPromptChars'])} | {math.ceil(session['transformedPromptChars'] / 4) if session['transformedPromptChars'] else 0:,} |",
        f"| Assistant messages | {format_number(session['assistantChars'])} | {math.ceil(session['assistantChars'] / 4) if session['assistantChars'] else 0:,} |",
        f"| Observed textual events | {format_number(session['observedChars'])} | {session['estimatedTokens']:,} |",
        f"| Measurement | — | `{session['contextMeasurement']}` |",
        f"| Provider input / cached / output tokens | — | {format_number(session['providerUsage'].get('inputTokens'))} / {format_number(session['providerUsage'].get('cachedInputTokens'))} / {format_number(session['providerUsage'].get('outputTokens'))} |",
        "",
        "## Latest Turn Context",
        "| Measure | Value |",
        "|---|---:|",
        f"| Measurement | `{context_turn['measurement']}` |" if context_turn else "| Measurement | not available |",
        f"| Prompt tokens (estimate) | {format_number(context_turn['promptTokensEstimate'])} |" if context_turn else "| Prompt tokens (estimate) | not available |",
        f"| Prior session tokens (estimate) | {format_number(context_turn['priorSessionTokensEstimate'])} |" if context_turn else "| Prior session tokens (estimate) | not available |",
        f"| Turn observed tokens (estimate) | {format_number(context_turn['turnObservedTokensEstimate'])} |" if context_turn else "| Turn observed tokens (estimate) | not available |",
        f"| Model interactions (estimate) | {format_number(context_turn['modelInteractionsEstimate'])} |" if context_turn else "| Model interactions (estimate) | not available |",
        f"| Repeated prior context (estimate) | {format_number(context_turn['repeatedPriorContextTokensEstimate'])} |" if context_turn else "| Repeated prior context (estimate) | not available |",
        f"| Estimated Context Pressure | {format_number(context_turn['contextExposureTokensEstimate'])} estimated tokens |" if context_turn else "| Estimated Context Pressure | not available |",
        f"| Baseline ratio | {context_turn['warning']['ratio'] if context_turn and context_turn['warning']['ratio'] is not None else 'not available'} |" if context_turn else "| Baseline ratio | not available |",
        f"| Warning level | {context_turn['warning']['level']} |" if context_turn else "| Warning level | not available |",
        f"| Estimated utilization | {context_turn['warning']['utilization']:.1%} |" if context_turn else "| Estimated utilization | not available |",
        f"| Estimator version | `{CONTEXT_ESTIMATOR_VERSION}` |",
        "",
        "## Context By Turn",
        "| Turn | Time | Prompt tokens | Model calls | Estimated Context Pressure | Estimate evidence | Warning |",
        "|---:|---|---:|---:|---:|---|---|",
    ]
    for turn in context_turns(selected)[-20:]:
        lines.append(
            f"| {turn['promptNumber']} | {markdown_escape(turn.get('timestamp') or '')} | "
            f"{format_number(turn['promptTokensEstimate'])} | {format_number(turn['modelInteractionsEstimate'])} | {format_number(turn['contextExposureTokensEstimate'])} | "
            f"`{turn['measurement']}` | {turn['warning']['level']} |"
        )
    lines.extend([
        "",
        "## Code Buddy Interventions",
        "| Metric | Value |",
        "|---|---:|",
        f"| Prompt reviews | {interventions['promptReviews']} |",
        f"| Task-decomposition evaluations | {interventions['decompositionEvaluations']} |",
        f"| Session-fit evaluations | {interventions['sessionFitEvaluations']} |",
        f"| Preflights started / completed | {interventions['preflightStarted']} / {interventions['preflightCompleted']} |",
        f"| Implementation tools denied pending preflight | {interventions['preflightGateDenials']} |",
        f"| Controlled fallback requested / used | {interventions['preflightFallbackRequests']} / {interventions['preflightBypasses']} |",
        f"| Context warnings | {interventions['contextWarnings']} |",
        f"| Context curations completed | {interventions['curationCompleted']} |",
        f"| Curations accepted | {interventions['curationAccepted']} |",
        f"| Original prompt/task retained | {interventions['originalRetained']} |",
        f"| Optional AI tool failures | {interventions['toolFailures']} |",
        "",
        "",
        "## Latest Prompt",
        f"**Prompt:** {markdown_escape(prompt or 'No prompt captured yet.')}",
        "",
        f"**Quality score:** {quality['score']}/100  ",
        f"**Decomposition score:** {decomposition['score']}/100  ",
        f"**Recommended focus:** {recommendation_data['title']}",
        "",
        "### Rubric",
        "| Dimension | Result | Points |",
        "|---|---|---:|",
    ])
    for item in quality["checks"]:
        lines.append(f"| {item['label']} | {'present' if item['present'] else 'missing'} | {item['points']} |")
    lines.extend(["", "### Detected Task Steps"])
    lines.extend(f"{index}. {markdown_escape(step)}" for index, step in enumerate(decomposition["steps"], 1))
    lines.extend([
        "",
        "## Latest Turn Outcome",
        "| Metric | Value |",
        "|---|---:|",
        f"| Worktree tracking | {'available' if outcome_data.get('worktreeTrackingAvailable') else 'not available'} |",
        f"| Files added / modified / deleted | {metrics.get('filesAdded', 0)} / {metrics.get('filesModified', 0)} / {metrics.get('filesDeleted', 0)} |",
        f"| Lines added / deleted / net | {format_number(metrics.get('linesAdded'))} / {format_number(metrics.get('linesDeleted'))} / {format_number(metrics.get('linesNet'))} |",
        f"| Line counts complete | {'yes' if metrics.get('lineCountsComplete') else 'no or not measured'} |",
        "",
        "### Changed Files",
        "| Change | File | Added | Deleted |",
        "|---|---|---:|---:|",
    ])
    changed_files = metrics.get("changedFiles") or []
    if changed_files:
        for item in changed_files:
            lines.append(f"| {item.get('change')} | `{markdown_escape(item.get('path'))}` | {format_number(item.get('linesAdded'))} | {format_number(item.get('linesDeleted'))} |")
    else:
        lines.append("| — | No worktree changes observed for the latest completed turn. | — | — |")
    lines.extend(["", "## Recent Activity", "| Time | Record | Summary |", "|---|---|---|"])
    for record in selected[-20:]:
        timestamp = display_timestamp(record).replace("T", " ")
        lines.append(f"| {markdown_escape(timestamp)} | `{markdown_escape(record.get('recordType', 'unknown'))}` | {markdown_escape(short_summary(record))} |")
    lines.extend([
        "",
        "## Interpretation Rules",
        "- The prompt-quality rubric and detected steps in this retrospective report are deterministic heuristics retained for backward compatibility; live prompt review and decomposition use structured semantic tools.",
        "- File and line metrics are the before/after worktree delta around a prompt. They can include edits made outside Copilot during that interval.",
        "- Estimated Context Pressure approximates visible context carried across the session and repeated around tool calls; it is neither actual active-context utilization nor a billing statement.",
        "- Provider-reported per-event usage is recorded when present but does not establish complete active-context utilization; fallback estimates use approximately four characters per token.",
        "- Hidden system prompts, selected file context, caching, compaction, and internal model calls may make real usage different.",
        "",
    ])
    return "\n".join(lines)


def write_atomic(file_path, content):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(file_path.name + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, file_path)


def refresh_reports(log_path, feedback_path, analytics_path, session_id):
    records = load_records(log_path)
    if not records:
        return
    write_atomic(feedback_path, build_feedback(records, session_id))
    write_atomic(analytics_path, build_analytics(records, session_id))


def start_turn():
    log_path, workspace, _, _, state_dir = get_paths()
    session_id = os.environ.get("TOKEN_LENS_SESSION_ID") or "unknown"
    prompt_event_id = os.environ.get("TOKEN_LENS_EVENT_ID")
    if not env_bool("TOKEN_LENS_TRACK_WORKTREE_CHANGES", True):
        return
    state_path, existing_state = load_snapshot(state_dir, session_id)
    if existing_state and existing_state.get("snapshot"):
        prompt_event_ids = existing_state.get("promptEventIds") or []
        if prompt_event_id and prompt_event_id not in prompt_event_ids:
            prompt_event_ids.append(prompt_event_id)
        existing_state["promptEventIds"] = prompt_event_ids
        existing_state["lastPromptEventId"] = prompt_event_id
        state_path.write_text(json.dumps(existing_state, ensure_ascii=False), encoding="utf-8")
        return
    snapshot = capture_snapshot(workspace, max(10000, env_int("TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES", 1000000)))
    save_snapshot(state_dir, session_id, prompt_event_id, workspace, snapshot)


def end_turn():
    log_path, workspace, feedback_path, analytics_path, state_dir = get_paths()
    session_id = os.environ.get("TOKEN_LENS_SESSION_ID") or "unknown"
    event_id = os.environ.get("TOKEN_LENS_EVENT_ID")
    state_path, state = load_snapshot(state_dir, session_id)
    available = bool(state and env_bool("TOKEN_LENS_TRACK_WORKTREE_CHANGES", True))
    prompt_event_id = (state or {}).get("promptEventId")
    prompt_event_ids = (state or {}).get("promptEventIds") or ([prompt_event_id] if prompt_event_id else [])
    if available:
        max_bytes = max(10000, env_int("TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES", 1000000))
        before = state.get("snapshot")
        after = capture_snapshot(workspace, max_bytes)
        metrics = compare_snapshots(before, after)
        state_path.unlink(missing_ok=True)
    else:
        metrics = {
            "filesAdded": 0,
            "filesModified": 0,
            "filesDeleted": 0,
            "filesChanged": 0,
            "linesAdded": None,
            "linesDeleted": None,
            "linesNet": None,
            "lineCountsComplete": False,
            "snapshotTruncated": False,
            "changedFiles": [],
        }
    append_outcome(log_path, session_id, workspace, prompt_event_id, prompt_event_ids, event_id, metrics, available)
    append_context_snapshot(log_path, session_id, workspace, prompt_event_id, event_id)
    refresh_reports(log_path, feedback_path, analytics_path, session_id)


def main():
    action = os.environ.get("TOKEN_LENS_ANALYTICS_ACTION")
    if not os.environ.get("TOKEN_LENS_LOG_FILE"):
        return 0
    if action == "start_turn":
        start_turn()
    elif action == "end_turn":
        end_turn()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write(f"Code Buddy analytics error: {error}\n")
        sys.exit(0)
