import { events, packageStorage } from 'kody:runtime';
import { buildCompletionEvent } from './completion-event.ts';
import { getSyncRun } from './storage.ts';

/**
 * Cloud-side completion event emitter scheduled via `workflows.create` when `onUpstreamUpdated`
 * runs on an Execution Context (where Kody disables `events.dispatch`). Reads the persisted
 * `SyncRunRecord` from `packageStorage()` and dispatches `@brandontroberts/graft.sync.completed`.
 */
export default async function emitSyncCompleted(params?: Record<string, unknown>): Promise<{ runId: string; topic: string }> {
  const runId = typeof params?.runId === 'string' ? params.runId.trim() : '';
  if (!runId) {
    throw new Error('emitSyncCompleted requires a non-empty string runId');
  }
  const record = await getSyncRun(packageStorage(), runId);
  if (!record) {
    throw new Error(`Sync run "${runId}" not found in packageStorage`);
  }
  const event = buildCompletionEvent(record);
  await events.dispatch(event);
  return { runId: record.id, topic: event.topic };
}
