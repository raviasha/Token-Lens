import * as fs from 'node:fs/promises';
import {
  CodeBuddyPolicy,
  ContextEstimate,
  ObservableSignals,
  SessionContextSnapshot
} from '../core/contracts';
import { estimateContext, isMeaningfulPrompt } from '../core/policyEngine';

export interface HookRecord {
  schemaVersion?: number;
  eventId?: string;
  recordType?: string;
  sessionId?: string | null;
  timestamp?: string | null;
  localTimestamp?: string | null;
  recordedAt?: string | null;
  data?: Record<string, unknown>;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function readHookRecords(logPath: string): Promise<HookRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const record = JSON.parse(line) as HookRecord;
      return record.schemaVersion === 2 ? [record] : [];
    } catch {
      return [];
    }
  });
}

function recordCharacters(record: HookRecord): { observed: number; prompt: number; response: number } {
  const context = object(record.data?.context);
  if (context) {
    const observed = number(context.observedChars);
    const role = String(context.role ?? '');
    return {
      observed,
      prompt: /prompt/.test(role) ? observed : 0,
      response: /assistant/.test(role) ? observed : 0
    };
  }
  const data = record.data ?? {};
  const prompt = typeof data.prompt === 'string' ? data.prompt.length : 0;
  const response = typeof data.content === 'string' ? data.content.length : 0;
  return { observed: prompt + response, prompt, response };
}

function latestSnapshot(records: HookRecord[]): SessionContextSnapshot | undefined {
  const record = [...records].reverse().find((item) => item.recordType === 'context.load_snapshot');
  const data = object(record?.data);
  const actual = object(data?.actualContextUtilization);
  const estimated = object(data?.estimatedContextPressure);
  const load = actual ?? estimated;
  const signals = object(data?.observableSignals);
  if (!record || !load || !signals || typeof load.value !== 'number') {
    return undefined;
  }
  const estimate: ContextEstimate = {
    value: load.value,
    unit: actual ? 'tokens' : 'estimated_tokens',
    utilization: typeof load.utilization === 'number' ? load.utilization : undefined,
    capacityTokens: typeof load.capacityTokens === 'number' ? load.capacityTokens : undefined,
    method: actual ? 'api' : 'estimate',
    confidence: load.confidence === 'medium' ? 'medium' : load.confidence === 'high' ? 'high' : 'low',
    thresholdState: load.thresholdState === 'critical' ? 'critical' : load.thresholdState === 'warning' ? 'warning' : load.thresholdState === 'unavailable' ? 'unavailable' : 'normal',
    estimatorVersion: typeof load.estimatorVersion === 'string' ? load.estimatorVersion : undefined,
    providerId: typeof load.measurementProviderId === 'string' ? load.measurementProviderId : undefined,
    measurementTimestamp: typeof load.measurementTimestamp === 'string' ? load.measurementTimestamp : undefined,
    cachedInputTokens: typeof load.cachedInputTokens === 'number' ? load.cachedInputTokens : undefined,
    cacheWriteInputTokens: typeof load.cacheWriteInputTokens === 'number' ? load.cacheWriteInputTokens : undefined,
    outputTokens: typeof load.outputTokens === 'number' ? load.outputTokens : undefined,
    reasoningTokens: typeof load.reasoningTokens === 'number' ? load.reasoningTokens : undefined,
    totalTokens: typeof load.totalTokens === 'number' ? load.totalTokens : undefined,
    terminology: actual ? 'Actual Context Utilization' : 'Estimated Context Pressure'
  };
  return {
    sessionId: String(record.sessionId ?? 'unknown'),
    timestamp: String(record.localTimestamp ?? record.timestamp ?? record.recordedAt ?? ''),
    signals: {
      turns: number(signals.turns),
      promptCharacters: number(signals.promptCharacters),
      responseCharacters: number(signals.responseCharacters),
      observedCharacters: number(signals.observedCharacters),
      toolCalls: number(signals.toolCalls),
      toolFailures: number(signals.toolFailures),
      filesReferenced: number(signals.filesReferenced),
      filesChanged: number(signals.filesChanged),
      linesAdded: typeof signals.linesAdded === 'number' ? signals.linesAdded : null,
      linesDeleted: typeof signals.linesDeleted === 'number' ? signals.linesDeleted : null,
      durationSeconds: number(signals.durationSeconds),
      estimatedTokens: actual ? 0 : load.value
    },
    estimate
  };
}

export function observeSession(records: HookRecord[], policy: CodeBuddyPolicy): SessionContextSnapshot | undefined {
  if (!records.length) {
    return undefined;
  }
  const sessionId = String(records.at(-1)?.sessionId ?? 'unknown');
  const selected = records.filter((record) => String(record.sessionId ?? 'unknown') === sessionId);
  const emitted = latestSnapshot(selected);
  if (emitted) {
    return emitted;
  }
  const characterCounts = selected
    .filter((record) => !['transcript.snapshot', 'turn.outcome', 'context.load_snapshot'].includes(String(record.recordType)))
    .map(recordCharacters);
  const outcomes = selected.filter((record) => record.recordType === 'turn.outcome');
  const outcomeMetrics = outcomes.map((record) => object(record.data?.metrics) ?? {});
  const referencedFiles = new Set(
    selected.flatMap((record) => JSON.stringify(record.data ?? {}).match(/[a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|css|html|ya?ml)/g) ?? [])
  );
  const timestamps = selected
    .map((record) => Date.parse(String(record.localTimestamp ?? record.timestamp ?? record.recordedAt ?? '')))
    .filter(Number.isFinite);
  const signals: ObservableSignals = {
    turns: selected.filter((record) => record.recordType === 'user.prompt').length,
    promptCharacters: characterCounts.reduce((total, item) => total + item.prompt, 0),
    responseCharacters: characterCounts.reduce((total, item) => total + item.response, 0),
    observedCharacters: characterCounts.reduce((total, item) => total + item.observed, 0),
    toolCalls: selected.filter((record) => record.recordType === 'tool.started').length,
    toolFailures: selected.filter((record) => record.recordType === 'tool.failed' || record.recordType === 'error.occurred').length,
    filesReferenced: referencedFiles.size,
    filesChanged: outcomeMetrics.reduce((total, item) => total + number(item.filesChanged), 0),
    linesAdded: outcomeMetrics.every((item) => typeof item.linesAdded === 'number')
      ? outcomeMetrics.reduce((total, item) => total + number(item.linesAdded), 0)
      : null,
    linesDeleted: outcomeMetrics.every((item) => typeof item.linesDeleted === 'number')
      ? outcomeMetrics.reduce((total, item) => total + number(item.linesDeleted), 0)
      : null,
    durationSeconds: timestamps.length >= 2 ? Math.max(0, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000)) : 0,
    estimatedTokens: Math.ceil(characterCounts.reduce((total, item) => total + item.observed, 0) / 4)
  };
  const timestamp = String(selected.at(-1)?.localTimestamp ?? selected.at(-1)?.timestamp ?? selected.at(-1)?.recordedAt ?? new Date().toISOString());
  return estimateContext(signals, sessionId, timestamp, policy);
}

export function latestPrompts(records: HookRecord[], limit = 2): Array<{ eventId: string; sessionId: string; prompt: string }> {
  return records.filter((record) => record.recordType === 'user.prompt'
      && typeof record.data?.prompt === 'string'
      && isMeaningfulPrompt(record.data.prompt))
    .slice(-limit)
    .map((record) => ({
      eventId: String(record.eventId ?? ''),
      sessionId: String(record.sessionId ?? 'unknown'),
      prompt: String(record.data?.prompt ?? '')
    }));
}

export function buildCurationSource(records: HookRecord[], maximumItems = 80): string[] {
  const selected = records.filter((record) => !['transcript.snapshot', 'context.load_snapshot'].includes(String(record.recordType))).slice(-maximumItems);
  return selected.flatMap((record) => {
    const data = record.data ?? {};
    if (record.recordType === 'user.prompt' && typeof data.prompt === 'string') {
      return [`User prompt: ${data.prompt}`];
    }
    if (record.recordType === 'assistant.message' && typeof data.content === 'string') {
      return [`Assistant result: ${data.content}`];
    }
    if (record.recordType === 'tool.failed' || record.recordType === 'error.occurred') {
      return [`Failure: ${JSON.stringify(data)}`];
    }
    if (record.recordType === 'turn.outcome') {
      const metrics = object(data.metrics);
      const files = Array.isArray(metrics?.changedFiles)
        ? metrics.changedFiles.map((item) => object(item)?.path).filter((item): item is string => typeof item === 'string')
        : [];
      return files.length ? [`Changed files: ${files.join(', ')}`] : [];
    }
    return [];
  });
}
