import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PendingFreshHandoff {
  schemaVersion: 1;
  handoffId: string;
  sourceSessionId: string;
  targetTask: string;
  createdAt: string;
}

export function handoffMarker(handoffId: string): string {
  return `<!-- code-buddy-handoff:${handoffId} -->`;
}

export function pendingHandoffPath(stateDirectory: string): string {
  return path.join(stateDirectory, 'pending-fresh-handoff.json');
}

export async function createPendingFreshHandoff(
  stateDirectory: string,
  sourceSessionId: string,
  targetTask: string
): Promise<PendingFreshHandoff> {
  const pending: PendingFreshHandoff = {
    schemaVersion: 1,
    handoffId: randomUUID(),
    sourceSessionId: sourceSessionId || 'unknown',
    targetTask,
    createdAt: new Date().toISOString()
  };
  await fs.mkdir(stateDirectory, { recursive: true });
  const destination = pendingHandoffPath(stateDirectory);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(pending), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return pending;
}
