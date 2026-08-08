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


def append_outcome(log_path, session_id, workspace, prompt_event_id, event_id, metrics, available):
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
        return str(data.get("content") or "")
    if record_type in {"tool.completed", "tool.failed", "error.occurred"}:
        return json.dumps(data, ensure_ascii=False) if data is not None else ""
    return ""


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
        matching = [record for record in outcomes if (record.get("data") or {}).get("promptEventId") == prompt_event_id]
        if matching:
            return matching[-1]
    return outcomes[-1] if outcomes else None


def latest_prompt(records):
    prompts = [record for record in records if record.get("recordType") == "user.prompt"]
    return prompts[-1] if prompts else None


def session_metrics(records):
    counts = {}
    observed_chars = 0
    prompt_chars = 0
    assistant_chars = 0
    for record in records:
        record_type = record.get("recordType", "unknown")
        counts[record_type] = counts.get(record_type, 0) + 1
        text = text_from_record(record)
        observed_chars += len(text)
        if record_type == "user.prompt":
            prompt_chars += len(text)
        if record_type == "assistant.message":
            assistant_chars += len(text)
    outcomes = [record for record in records if record.get("recordType") == "turn.outcome"]
    outcome_data = [(record.get("data") or {}).get("metrics") or {} for record in outcomes]
    def sum_known(key):
        values = [item.get(key) for item in outcome_data]
        return sum(values) if values and all(value is not None for value in values) else None
    return {
        "prompts": counts.get("user.prompt", 0),
        "turns": counts.get("turn.ended", 0) or counts.get("agent.stopped", 0),
        "assistantMessages": counts.get("assistant.message", 0),
        "toolStarts": counts.get("tool.started", 0),
        "toolCompletions": counts.get("tool.completed", 0),
        "toolFailures": counts.get("tool.failed", 0),
        "errors": counts.get("error.occurred", 0),
        "outcomes": len(outcomes),
        "filesChanged": sum((item.get("filesChanged") or 0) for item in outcome_data),
        "linesAdded": sum_known("linesAdded"),
        "linesDeleted": sum_known("linesDeleted"),
        "observedChars": observed_chars,
        "promptChars": prompt_chars,
        "assistantChars": assistant_chars,
        "estimatedTokens": math.ceil(observed_chars / 4) if observed_chars else 0,
    }


def recommendation(prompt, quality, decomposition, outcome, records):
    metrics = (outcome.get("data") or {}).get("metrics") if outcome else None
    failures = sum(record.get("recordType") in {"tool.failed", "error.occurred"} for record in records)
    missing = {item["key"] for item in quality["checks"] if not item["present"]}
    observed = observed_size((outcome or {}).get("data"))
    if "goal" in missing:
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
    template = "Implement [goal] in [files or scope]. Context: [relevant problem]. Constraints: [constraints]. Done when: [acceptance criteria]. Validate with: [command]."
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
    recommendation_data = recommendation(prompt, quality, decomposition, outcome, selected)
    observed = observed_size(outcome_data)
    session = session_metrics(selected)
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
        f"- Prompt quality: **{quality['score']}/100**",
        f"- Task decomposition: **{decomposition['score']}/100** ({len(decomposition['steps'])} detected step(s))",
        f"- Observed turn size: **{observed}**",
        f"- Worktree delta: **{metrics.get('filesChanged', 0)} file(s)**, **{format_number(metrics.get('linesAdded'))} added / {format_number(metrics.get('linesDeleted'))} deleted lines**",
        "",
        "## Suggested Next Prompt",
        f"> {recommendation_data['template']}",
        "",
        "_Detailed metrics are in `Code Buddy Analytics.md`. Exact model token usage is not exposed by the hook; context numbers are deterministic observed-text estimates._",
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
    recommendation_data = recommendation(prompt, quality, decomposition, outcome, selected)
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
        "## Context Estimate",
        "| Measure | Characters | Estimated tokens* |",
        "|---|---:|---:|",
        f"| User prompts | {format_number(session['promptChars'])} | {math.ceil(session['promptChars'] / 4) if session['promptChars'] else 0:,} |",
        f"| Assistant messages | {format_number(session['assistantChars'])} | {math.ceil(session['assistantChars'] / 4) if session['assistantChars'] else 0:,} |",
        f"| Observed textual events | {format_number(session['observedChars'])} | {session['estimatedTokens']:,} |",
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
    ]
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
        "- Prompt quality is a deterministic rubric for goal, scope, context, constraints, acceptance criteria, and validation.",
        "- Task decomposition uses numbered/bulleted lines, sentence boundaries, and action verbs; it does not infer hidden intent.",
        "- File and line metrics are the before/after worktree delta around a prompt. They can include edits made outside Copilot during that interval.",
        "- Exact model context/token usage and hidden system prompts are not exposed by the hook. Token values are observed-text estimates using approximately four characters per token.",
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
    snapshot = capture_snapshot(workspace, max(10000, env_int("TOKEN_LENS_SNAPSHOT_MAX_FILE_BYTES", 1000000)))
    save_snapshot(state_dir, session_id, prompt_event_id, workspace, snapshot)


def end_turn():
    log_path, workspace, feedback_path, analytics_path, state_dir = get_paths()
    session_id = os.environ.get("TOKEN_LENS_SESSION_ID") or "unknown"
    event_id = os.environ.get("TOKEN_LENS_EVENT_ID")
    state_path, state = load_snapshot(state_dir, session_id)
    available = bool(state and env_bool("TOKEN_LENS_TRACK_WORKTREE_CHANGES", True))
    prompt_event_id = (state or {}).get("promptEventId")
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
    append_outcome(log_path, session_id, workspace, prompt_event_id, event_id, metrics, available)
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
