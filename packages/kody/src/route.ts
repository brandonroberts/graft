// Pure routing helper deciding between Kody Cloud sync and Execution Context delegation.
import { policyRequiresExecutionContext, syncForkInCloud, type CloudSyncDependencies } from './cloud-sync.ts';
import { packageIdFromStorageId } from './completion-event.ts';
import { defaultPolicy, getForkPolicy, saveSyncRun } from './storage.ts';
import { syncForkFromUpstreamEvent } from './sync.ts';
import type {
  CommandRunner,
  CommunityForkUpstreamUpdatedEvent,
  ExternalPublisher,
  GitRemoteProvider,
  StorageBucket,
  SyncEventEmitter,
  SyncRunRecord,
} from './types.ts';

const KODY_ID_RE = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;

export interface ContextWorkflowInput {
  packageId: string;
  exportName: string;
  execution: {
    context?: string;
    requires?: string[];
    whenOffline: 'queue';
    queueMinutes: number;
  };
  idempotencyKey: string;
  params: Record<string, unknown>;
}

export type RoutedSyncResult = SyncRunRecord | { delegated: true; workflowId: string; forkKodyId: string; target: string };

export interface RouteDependencies {
  storage: StorageBucket;
  storageId?: string;
  gitRemote?: GitRemoteProvider;
  command?: CommandRunner;
  publisher?: ExternalPublisher;
  emitter?: SyncEventEmitter;
  resolvePackageName?: (packageId: string) => Promise<string | undefined>;
  scheduleContextWorkflow?: (input: ContextWorkflowInput) => Promise<{ id: string; status?: string }>;
  fetch?: CloudSyncDependencies['fetch'];
  upstreamGitUrl?: string;
  now?: () => Date;
}

/**
 * Route an incoming `community.fork.upstream_updated` event:
 * - Default (`cloud` policy, no `testCommand`/`agentCommand`): run natively in Kody Cloud (`syncForkInCloud`).
 * - Host policy (`testCommand`, `agentCommand`, or `execution: 'context'`):
 *   - If already running on an Execution Context (`deps.command` present and no cloud delegation requested),
 *     run `syncForkFromUpstreamEvent` directly.
 *   - Otherwise, delegate to `./sync-on-context` via `workflows.create` (failing loudly if scheduling fails,
 *     never silently skipping `testCommand` or `agentCommand`).
 */
export async function routeUpstreamUpdatedEvent(
  event: CommunityForkUpstreamUpdatedEvent,
  deps: RouteDependencies,
): Promise<RoutedSyncResult> {
  let forkKodyId = event.fork.kody_id;
  if (!KODY_ID_RE.test(forkKodyId) && event.fork.package_id && deps.resolvePackageName) {
    const resolved = await deps.resolvePackageName(event.fork.package_id);
    if (resolved) forkKodyId = resolved;
  }

  const policy = (KODY_ID_RE.test(forkKodyId) ? await getForkPolicy(deps.storage, forkKodyId) : undefined) ?? defaultPolicy(forkKodyId);
  const needsContext = policyRequiresExecutionContext(policy);

  if (!needsContext && deps.gitRemote) {
    return syncForkInCloud(event, {
      gitRemote: deps.gitRemote,
      storage: deps.storage,
      publisher: deps.publisher,
      emitter: deps.emitter,
      resolvePackageName: deps.resolvePackageName,
      policy,
      fetch: deps.fetch,
      upstreamGitUrl: deps.upstreamGitUrl,
      now: deps.now,
    });
  }

  if (needsContext && deps.command) {
    return syncForkFromUpstreamEvent(event, {
      command: deps.command,
      storage: deps.storage,
      publisher: deps.publisher,
      emitter: deps.emitter,
      resolvePackageName: deps.resolvePackageName,
      policy,
      now: deps.now,
    });
  }

  // Policy requires an Execution Context, and we're running in Kody Cloud -> delegate via workflow.
  const packageId = packageIdFromStorageId(deps.storageId);
  const toCommit = event.current.pinned_commit || 'unknown';
  const shortSha = toCommit.slice(0, 12);
  const now = (deps.now ?? (() => new Date()))();
  if (deps.scheduleContextWorkflow && packageId) {
    try {
      const execution = policy.executionContext
        ? { context: policy.executionContext, whenOffline: 'queue' as const, queueMinutes: 1440 }
        : { requires: ['fs'], whenOffline: 'queue' as const, queueMinutes: 1440 };
      const wf = await deps.scheduleContextWorkflow({
        packageId,
        exportName: './sync-on-context',
        execution,
        idempotencyKey: `sync-fork-ctx:${forkKodyId}:${toCommit}:${event.event_id || now.getTime()}`,
        params: { event },
      });
      return {
        delegated: true,
        workflowId: wf.id,
        forkKodyId,
        target: policy.executionContext ?? 'requires:fs',
      };
    } catch (err) {
      const record: SyncRunRecord = {
        id: `${event.event_id || 'manual'}-${shortSha}-${now.getTime()}`,
        eventId: event.event_id,
        forkKodyId,
        upstreamKodyId: event.listing.name || event.listing.kody_id,
        fromCommit: event.fork.origin_commit || event.previous.pinned_commit || '',
        toCommit,
        targetVersion: `${event.current.package_version ?? '0.0.0'}+${toCommit}`,
        outcome: 'error',
        mode: policy.mode,
        conflicts: [],
        reasons: [`Failed to schedule Execution Context workflow ./sync-on-context: ${(err as Error).message}`],
        warnings: [],
        createdAt: now.toISOString(),
      };
      await saveSyncRun(deps.storage, record);
      if (deps.emitter) {
        try {
          await deps.emitter.emit(record);
        } catch {
          // Best effort on delegation error.
        }
      }
      return record;
    }
  }

  // Fallback failure (neither cloud gitRemote nor context scheduling available).
  const record: SyncRunRecord = {
    id: `${event.event_id || 'manual'}-${shortSha}-${now.getTime()}`,
    eventId: event.event_id,
    forkKodyId,
    upstreamKodyId: event.listing.name || event.listing.kody_id,
    fromCommit: event.fork.origin_commit || event.previous.pinned_commit || '',
    toCommit,
    targetVersion: `${event.current.package_version ?? '0.0.0'}+${toCommit}`,
    outcome: 'error',
    mode: policy.mode,
    conflicts: [],
    reasons: [
      needsContext
        ? 'Fork policy requires an Execution Context (testCommand, agentCommand, or execution: "context"), but neither kody.command nor workflow scheduling is available'
        : 'Kody Cloud sync requires packageGetGitRemote capability',
    ],
    warnings: [],
    createdAt: now.toISOString(),
  };
  await saveSyncRun(deps.storage, record);
  if (deps.emitter) {
    try {
      await deps.emitter.emit(record);
    } catch {
      // Best effort.
    }
  }
  return record;
}
