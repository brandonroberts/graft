import { events, kody, packageStorage, workflows } from 'kody:runtime';
import { emitCompletionOrScheduleCloud } from './completion-event.ts';
import { syncForkFromUpstreamEvent } from './sync.ts';
import type { CommunityForkUpstreamUpdatedEvent, SyncRunRecord } from './types.ts';

/**
 * Subscription handler for `community.fork.upstream_updated`.
 *
 * Runs on your Kody Execution Context, executes `graft sync --json` against the upstream listing's
 * new `pinned_commit`, persists the result in `packageStorage()`, and emits
 * `@brandontroberts/graft.sync.completed` (directly on cloud, or via a cloud workflow running
 * `./emit-sync-completed` when executed on a local Execution Context).
 */
export default async function onUpstreamUpdated(params?: Record<string, unknown>): Promise<SyncRunRecord> {
  if (!params || typeof params !== 'object') {
    throw new Error('community.fork.upstream_updated handler requires an event payload');
  }
  const event = params as unknown as CommunityForkUpstreamUpdatedEvent;
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
