import { events, kody, packageStorage } from 'kody:runtime';
import { syncForkFromUpstreamEvent } from './sync.js';
import type { CommunityForkUpstreamUpdatedEvent, SyncRunRecord } from './types.js';

const COMPLETION_TOPIC = '@brandonroberts/graft.sync.completed';

/**
 * Subscription handler for `community.fork.upstream_updated`.
 *
 * Runs on your Kody Execution Context, executes `graft sync --json` against the upstream listing's
 * new `pinned_commit`, persists the result in `packageStorage()`, and emits
 * `@brandonroberts/graft.sync.completed` for downstream notifier packages.
 */
export default async function onUpstreamUpdated(event: CommunityForkUpstreamUpdatedEvent): Promise<SyncRunRecord> {
  return syncForkFromUpstreamEvent(event, {
    command: kody.command,
    storage: packageStorage(),
    publisher: {
      publish: (input) => kody.packagePublishExternalPush(input),
    },
    emitter: {
      async emit(record) {
        await events.dispatch({
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
        });
      },
    },
  });
}
