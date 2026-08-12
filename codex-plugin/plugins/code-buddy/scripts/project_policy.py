#!/usr/bin/env python3
"""Strict dependency-free project policy loader shared by Code Buddy's Codex parts."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_POLICY = {
    "healthCheck": {"showOnEveryMeaningfulCodingTask": True},
    "thresholds": {
        "promptQuality": {"enhanceBelow": 75},
        "taskScope": {"decomposeAtOrAbove": 65},
        "estimatedContextPressure": {"capacityTokens": 40000, "warningAt": 0.70, "criticalAt": 0.85},
        "sessionFit": {"recommendFreshTaskAtOrAbove": 75, "fallbackLexicalOverlapBelow": 0.20},
    },
}


def add(diagnostics: list[dict[str, str]], code: str, path: str, message: str) -> None:
    diagnostics.append({"code": code, "path": path, "message": message})


def scalar(value: str) -> bool | float | int | None:
    if value == "true":
        return True
    if value == "false":
        return False
    if re.fullmatch(r"-?(?:\d+|\d*\.\d+)", value):
        return float(value) if "." in value else int(value)
    return None


def parse(contents: str, diagnostics: list[dict[str, str]]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any], str]] = [(-2, root, "")]
    for index, source in enumerate(contents.splitlines(), 1):
        line = re.sub(r"\s+#.*$", "", source).rstrip()
        if not line.strip():
            continue
        if "\t" in source:
            add(diagnostics, "unsupported_syntax", f"line.{index}", "Tabs are not supported in code-buddy.yaml.")
            continue
        indent = len(line) - len(line.lstrip(" "))
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?", line.strip())
        if indent % 2 or not match:
            add(diagnostics, "unsupported_syntax", f"line.{index}", "Only two-space simple mappings are supported.")
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent_indent, parent, parent_path = stack[-1]
        if indent != parent_indent + 2:
            add(diagnostics, "unsupported_syntax", f"line.{index}", "Mappings must be nested by exactly two spaces.")
            continue
        key, raw = match.group(1), match.group(2) or ""
        key_path = f"{parent_path}.{key}" if parent_path else key
        if key in parent:
            add(diagnostics, "unsupported_syntax", key_path, "Duplicate keys are not supported.")
            continue
        if not raw:
            nested: dict[str, Any] = {}
            parent[key] = nested
            stack.append((indent, nested, key_path))
            continue
        value = scalar(raw)
        if value is None or re.search(r"[\[\]{}&*!|>]", raw):
            add(diagnostics, "unsupported_syntax", key_path, "Only boolean and numeric scalar values are supported.")
            continue
        parent[key] = value
    return root


def mapping(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def number(value: Any, fallback: float | int, path: str, diagnostics: list[dict[str, str]], minimum: float, maximum: float, integer: bool = False) -> float | int:
    if value is None:
        return fallback
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < minimum or value > maximum or (integer and int(value) != value):
        add(diagnostics, "invalid_value", path, f"Expected a {'whole ' if integer else ''}number from {minimum} to {maximum}.")
        return fallback
    return int(value) if integer else value


def unknown(value: dict[str, Any] | None, allowed: list[str], prefix: str, diagnostics: list[dict[str, str]]) -> None:
    for key in (value or {}):
        if key not in allowed:
            add(diagnostics, "unknown_key", f"{prefix}.{key}" if prefix else key, "This key is not supported by code-buddy.yaml.")


def load_project_policy(workspace: str | Path | None) -> dict[str, Any]:
    policy = copy.deepcopy(DEFAULT_POLICY)
    diagnostics: list[dict[str, str]] = []
    if not workspace:
        return {"policy": policy, "diagnostics": diagnostics}
    file_path = Path(workspace) / "code-buddy.yaml"
    if not file_path.exists():
        return {"policy": policy, "diagnostics": diagnostics}
    try:
        parsed = parse(file_path.read_text(encoding="utf-8"), diagnostics)
    except OSError as error:
        add(diagnostics, "invalid_value", "code-buddy.yaml", str(error))
        return {"policy": policy, "diagnostics": diagnostics}
    unknown(parsed, ["version", "healthCheck", "thresholds"], "", diagnostics)
    if parsed.get("version") is not None and parsed.get("version") != 1:
        add(diagnostics, "invalid_value", "version", "Only policy version 1 is supported.")
    health = mapping(parsed.get("healthCheck"))
    if health:
        unknown(health, ["showOnEveryMeaningfulCodingTask"], "healthCheck", diagnostics)
        visible = health.get("showOnEveryMeaningfulCodingTask")
        if visible is not None:
            if not isinstance(visible, bool):
                add(diagnostics, "invalid_value", "healthCheck.showOnEveryMeaningfulCodingTask", "Expected true or false.")
            else:
                policy["healthCheck"]["showOnEveryMeaningfulCodingTask"] = visible
    thresholds = mapping(parsed.get("thresholds"))
    if not thresholds:
        return {"policy": policy, "diagnostics": diagnostics}
    unknown(thresholds, ["promptQuality", "taskScope", "estimatedContextPressure", "sessionFit"], "thresholds", diagnostics)
    prompt = mapping(thresholds.get("promptQuality"))
    if prompt:
        policy["thresholds"]["promptQuality"]["enhanceBelow"] = number(prompt.get("enhanceBelow"), policy["thresholds"]["promptQuality"]["enhanceBelow"], "thresholds.promptQuality.enhanceBelow", diagnostics, 0, 100)
    scope = mapping(thresholds.get("taskScope"))
    if scope:
        policy["thresholds"]["taskScope"]["decomposeAtOrAbove"] = number(scope.get("decomposeAtOrAbove"), policy["thresholds"]["taskScope"]["decomposeAtOrAbove"], "thresholds.taskScope.decomposeAtOrAbove", diagnostics, 0, 100)
    context = mapping(thresholds.get("estimatedContextPressure"))
    if context:
        selected = policy["thresholds"]["estimatedContextPressure"]
        selected["capacityTokens"] = number(context.get("capacityTokens"), selected["capacityTokens"], "thresholds.estimatedContextPressure.capacityTokens", diagnostics, 1000, 9007199254740991, True)
        selected["warningAt"] = number(context.get("warningAt"), selected["warningAt"], "thresholds.estimatedContextPressure.warningAt", diagnostics, 0, 1)
        critical = number(context.get("criticalAt"), selected["criticalAt"], "thresholds.estimatedContextPressure.criticalAt", diagnostics, 0, 1)
        if critical < selected["warningAt"]:
            add(diagnostics, "invalid_value", "thresholds.estimatedContextPressure.criticalAt", "criticalAt must be greater than or equal to warningAt.")
        else:
            selected["criticalAt"] = critical
    fit = mapping(thresholds.get("sessionFit"))
    if fit:
        selected = policy["thresholds"]["sessionFit"]
        selected["recommendFreshTaskAtOrAbove"] = number(fit.get("recommendFreshTaskAtOrAbove"), selected["recommendFreshTaskAtOrAbove"], "thresholds.sessionFit.recommendFreshTaskAtOrAbove", diagnostics, 0, 100)
        selected["fallbackLexicalOverlapBelow"] = number(fit.get("fallbackLexicalOverlapBelow"), selected["fallbackLexicalOverlapBelow"], "thresholds.sessionFit.fallbackLexicalOverlapBelow", diagnostics, 0, 1)
    return {"policy": policy, "diagnostics": diagnostics}


if __name__ == "__main__":
    print(json.dumps(load_project_policy(sys.argv[1] if len(sys.argv) > 1 else None), separators=(",", ":")))
