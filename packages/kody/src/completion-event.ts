import type { SyncRunRecord } from './types.ts';

export const COMPLETION_TOPIC = '@brandontroberts/graft.sync.completed';

export interface CompletionEventInput {
  topic: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export function buildCompletionEvent(record: SyncRunRecord): CompletionEventInput {
  return {
    topic: COMPLETION_TOPIC,
    idempotencyKey: `graft-sync:${record.forkKodyId}:${record.toCommit}:${record.id}`,
    payload: {
      runId: record.id,
      fork: record.forkKodyId,
      upstream: record.upstreamKodyId,
      fromCommit: record.fromCommit,
      toCommit: record.toCommit,
      outcome: record.outcome,
      ...(record.branch ? { branch: record.branch } : {}),
      conflicts: record.conflicts,
      ...(record.agentRan ? { agentRan: true } : {}),
      ...(record.publishStatus ? { publishStatus: record.publishStatus } : {}),
      ...(record.approvalUrl ? { approvalUrl: record.approvalUrl } : {}),
    },
  };
}

/** Extract the package UUID from `packageStorage().id` (`"package:<encodedId>"`). */
export function packageIdFromStorageId(storageId?: string): string | undefined {
  if (!storageId || !storageId.startsWith('package:')) return undefined;
  const raw = storageId.slice('package:'.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface CloudWorkflowInput {
  packageId: string;
  exportName: string;
  execution: { context: 'cloud' };
  idempotencyKey: string;
  params: Record<string, unknown>;
}

export async function emitCompletionOrScheduleCloud(
  record: SyncRunRecord,
  deps: {
    dispatch?: (input: CompletionEventInput) => Promise<unknown>;
    scheduleWorkflow?: (input: CloudWorkflowInput) => Promise<unknown>;
    storageId?: string;
  },
): Promise<'dispatched' | 'scheduled'> {
  const event = buildCompletionEvent(record);
  if (deps.dispatch) {
    try {
      await deps.dispatch(event);
      return 'dispatched';
    } catch (dispatchErr) {
      const packageId = packageIdFromStorageId(deps.storageId);
      if (!deps.scheduleWorkflow || !packageId) throw dispatchErr;
      await deps.scheduleWorkflow({
        packageId,
        exportName: './emit-sync-completed',
        execution: { context: 'cloud' },
        idempotencyKey: `graft-sync-emit:${record.id}`,
        params: { runId: record.id },
      });
      return 'scheduled';
    }
  }
  const packageId = packageIdFromStorageId(deps.storageId);
  if (!deps.scheduleWorkflow || !packageId) {
    throw new Error('Neither events.dispatch nor cloud workflow scheduling is available');
  }
  await deps.scheduleWorkflow({
    packageId,
    exportName: './emit-sync-completed',
    execution: { context: 'cloud' },
    idempotencyKey: `graft-sync-emit:${record.id}`,
    params: { runId: record.id },
  });
  return 'scheduled';
}
