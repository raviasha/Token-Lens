import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InterventionEvent } from './contracts';
import { redactValue } from './redaction';
import { stableId } from './policyEngine';

export interface EventAppendInput {
  eventType: string;
  sessionId?: string;
  taskId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export class JsonlInterventionStore {
  public constructor(private readonly filePath: string, private readonly redactSensitiveData = true) {}

  public async append(input: EventAppendInput): Promise<InterventionEvent> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const data = (this.redactSensitiveData ? redactValue(input.data ?? {}) : input.data ?? {}) as Record<string, unknown>;
    const event: InterventionEvent = {
      schemaVersion: 1,
      eventId: stableId('intervention', { ...input, data, timestamp }),
      timestamp,
      eventType: input.eventType,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      data
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }

  public async read(): Promise<InterventionEvent[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as InterventionEvent;
        return parsed.schemaVersion === 1 ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }
}
