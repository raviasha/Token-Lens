const sensitiveKeyPattern = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const secretPatterns = [
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]+/gi,
  /sk-[a-z0-9_-]+/gi,
  /AKIA[0-9A-Z]{16}/g
];

function redactString(value: string): string {
  return secretPatterns.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value);
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKeyPattern.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }
  return value;
}
