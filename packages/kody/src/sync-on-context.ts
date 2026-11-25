import { events, kody, packageStorage, workflows } from 'kody:runtime';
import { emitCompletionOrScheduleCloud } from './completion-event.ts';
import { syncForkFromUpstreamEvent } from './sync.ts';
import type { CommunityForkUpstreamUpdatedEvent, SyncRunRecord } from './types.ts';

/**
 * Execution Context workflow export scheduled by `./on-upstream-updated` when a fork's policy
 * configures host-only commands (`testCommand`, `agentCommand`, or `execution: 'context'`).
 *
 * Runs `graft sync` + host commands via `kody.command.run`, persists the result in
 * `packageStorage()`, and schedules `./emit-sync-completed` on Kody Cloud.
 */
export default async function syncOnContext(params?: Record<string, unknown>): Promise<SyncRunRecord> {
  const rawEvent = params && typeof params === 'object' && 'event' in params ? params.event : params;
  if (!rawEvent || typeof rawEvent !== 'object') {
    throw new Error('syncOnContext requires an event payload');
  }
  if (typeof kody.command?.run !== 'function') {
    throw new Error('syncOnContext must execute on a Kody Execution Context with host commands enabled (`kody context commands on`)');
  }
  const event = rawEvent as CommunityForkUpstreamUpdatedEvent;
  const storage = packageStorage();
  return syncForkFromUpstreamEvent(event, {
    command: kody.command,
    storage,
    resolvePackageName: async (packageId) => (await kody.packageGet({ package_id: packageId })).name,
    publisher: {
      publish: (input) => kody.packagePublishExternalPush(input),
    },
    emitter: {
      async emit(record) {
        await emitCompletionOrScheduleCloud(record, {
          dispatch: events?.dispatch ? (input) => events.dispatch(input) : undefined,
          scheduleWorkflow: workflows?.create ? (input) => workflows.create(input) : undefined,
          storageId: storage.id,
        });
      },
    },
  });
}
