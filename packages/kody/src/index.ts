import { kody, packageStorage } from 'kody:runtime';
import { deleteForkPolicy, getForkPolicy, listForkPolicies, listSyncRuns, getSyncRun, upsertForkPolicy } from './storage.ts';
import { syncForkFromUpstreamEvent } from './sync.ts';
import type { CommunityForkUpstreamUpdatedEvent, ForkPolicy, SyncPushMode, SyncRunRecord } from './types.ts';

export type { CommunityForkUpstreamUpdatedEvent, ForkPolicy, SyncPushMode, SyncRunRecord } from './types.ts';

/**
 * Configure how Graft syncs a specific forked Kody package.
 *
 * Defaults to `mode: "branch"` (pushes green merges to `graft/sync-<sha>` without touching your
 * default branch). Set `mode: "push"` to push to the default branch, or `mode: "publish"` to also
 * call `packagePublishExternalPush` after pushing.
 */
export async function setPolicy(input: {
  forkKodyId: string;
  mode?: SyncPushMode;
  testCommand?: string;
  agentCommand?: string;
  graftCommand?: string[];
  workspaceRoot?: string;
  kodyOrigin?: string;
  pushAgentBranch?: boolean;
  allowZeroConflictPackageJson?: boolean;
}): Promise<ForkPolicy> {
  return upsertForkPolicy(packageStorage(), {
    forkKodyId: input.forkKodyId,
    mode: input.mode ?? 'branch',
    ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
    ...(input.agentCommand !== undefined ? { agentCommand: input.agentCommand } : {}),
    ...(input.graftCommand !== undefined ? { graftCommand: input.graftCommand } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.kodyOrigin !== undefined ? { kodyOrigin: input.kodyOrigin } : {}),
    ...(input.pushAgentBranch !== undefined ? { pushAgentBranch: input.pushAgentBranch } : {}),
    ...(input.allowZeroConflictPackageJson !== undefined ? { allowZeroConflictPackageJson: input.allowZeroConflictPackageJson } : {}),
  });
}

/** Read the saved sync policy for one forked package, if any. */
export async function getPolicy(input: { forkKodyId: string }): Promise<ForkPolicy | undefined> {
  return getForkPolicy(packageStorage(), input.forkKodyId);
}

/** List every configured fork sync policy in this account. */
export async function listPolicies(): Promise<ForkPolicy[]> {
  return listForkPolicies(packageStorage());
}

/** Remove the saved sync policy for one forked package (reverts it to the default `branch` mode). */
export async function deletePolicy(input: { forkKodyId: string }): Promise<{ deleted: boolean }> {
  return { deleted: await deleteForkPolicy(packageStorage(), input.forkKodyId) };
}

/** List recent Graft sync runs (optionally filtered to one fork). */
export async function listRuns(input: { forkKodyId?: string; limit?: number } = {}): Promise<SyncRunRecord[]> {
  return listSyncRuns(packageStorage(), input);
}

/** Fetch one Graft sync run record by id, including its `.grafts/.report/sync.md` markdown report. */
export async function getRun(input: { id: string }): Promise<SyncRunRecord | undefined> {
  return getSyncRun(packageStorage(), input.id);
}

/**
 * Trigger a manual Graft sync for a forked package against a specific upstream commit SHA.
 * Must be executed on an Execution Context with host commands enabled.
 */
export async function syncFork(input: {
  forkKodyId: string;
  upstreamKodyId: string;
  toCommit: string;
  fromCommit?: string;
  packageVersion?: string | null;
  packageId?: string;
}): Promise<SyncRunRecord> {
  const now = new Date().toISOString();
  const syntheticEvent: CommunityForkUpstreamUpdatedEvent = {
    event: 'community.fork.upstream_updated',
    event_id: `manual-${Date.now()}`,
    listing: {
      id: 'manual',
      name: input.upstreamKodyId,
      kody_id: input.upstreamKodyId,
      public_url: `https://kody.codes/${input.upstreamKodyId}`,
    },
    publisher: { username: input.upstreamKodyId.split('/')[0]?.replace(/^@/, '') ?? null },
    fork: {
      id: 'manual',
      package_id: input.packageId ?? '',
      kody_id: input.forkKodyId,
      origin_commit: input.fromCommit ?? '',
      forked_at: now,
    },
    previous: { pinned_commit: input.fromCommit ?? '', package_version: null },
    current: { pinned_commit: input.toCommit, package_version: input.packageVersion ?? null },
    published_at: now,
  };
  return syncForkFromUpstreamEvent(syntheticEvent, {
    command: kody.command,
    storage: packageStorage(),
    resolvePackageName: async (packageId) => (await kody.packageGet({ package_id: packageId })).name,
    publisher: {
      publish: (pubInput) => kody.packagePublishExternalPush(pubInput),
    },
  });
}
