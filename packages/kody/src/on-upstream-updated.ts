import { events, kody, packageStorage, workflows } from 'kody:runtime';
import { emitCompletionOrScheduleCloud } from './completion-event.ts';
import { routeUpstreamUpdatedEvent, type RoutedSyncResult } from './route.ts';
import type { CommunityForkUpstreamUpdatedEvent } from './types.ts';

/**
 * Subscription handler for `community.fork.upstream_updated`.
 *
 * Runs natively in Kody Cloud (`workerd`) by default over Git Smart HTTP v1 using
 * `kody.packageGetGitRemote` — no Execution Context required — and dispatches
 * `@brandontroberts/sync-fork.completed` directly. When a fork's policy opts into host shell
 * commands (`testCommand`, `agentCommand`, or `execution: 'context'`), automatically delegates
 * to `./sync-on-context` on an Execution Context.
 */
export default async function onUpstreamUpdated(params?: Record<string, unknown>): Promise<RoutedSyncResult> {
  if (!params || typeof params !== 'object') {
    throw new Error('community.fork.upstream_updated handler requires an event payload');
  }
  const event = params as unknown as CommunityForkUpstreamUpdatedEvent;
  const storage = packageStorage();
  const hasHostCommand = typeof kody.command?.run === 'function';
  return routeUpstreamUpdatedEvent(event, {
    storage,
    storageId: storage.id,
    gitRemote: {
      getGitRemote: (input) => kody.packageGetGitRemote(input),
    },
    ...(hasHostCommand ? { command: kody.command } : {}),
    resolvePackageName: async (packageId) => (await kody.packageGet({ package_id: packageId })).name,
    publisher: {
      publish: (input) => kody.packagePublishExternalPush(input),
    },
    scheduleContextWorkflow: workflows?.create ? (input) => workflows.create(input) : undefined,
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
