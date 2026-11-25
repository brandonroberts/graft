import { kody, packageStorage } from 'kody:runtime';
import { policyRequiresExecutionContext, syncForkInCloud } from './cloud-sync.ts';
import { defaultPolicy, deleteForkPolicy, getForkPolicy, getSyncRun, listForkPolicies, listSyncRuns, upsertForkPolicy } from './storage.ts';
import { syncForkFromUpstreamEvent } from './sync.ts';
import type { CommunityForkUpstreamUpdatedEvent, ForkPolicy, SyncExecutionTarget, SyncPushMode, SyncRunRecord } from './types.ts';

export type { CommunityForkUpstreamUpdatedEvent, ForkPolicy, SyncExecutionTarget, SyncPushMode, SyncRunRecord } from './types.ts';

/**
 * Configure how Graft syncs a specific forked Kody package.
 *
 * Defaults to `mode: "branch"` running natively in Kody Cloud (`execution: "cloud"`).
 * Set `mode: "push"` to push to the default branch, or `mode: "publish"` to also call
 * `packagePublishExternalPush` after pushing. Setting `testCommand`, `agentCommand`, or
 * `execution: "context"` routes syncs for this fork to an Execution Context via `./sync-on-context`.
 */
export async function setPolicy(input: {
  forkKodyId: string;
  mode?: SyncPushMode;
  execution?: SyncExecutionTarget;
  executionContext?: string;
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
    ...(input.execution !== undefined ? { execution: input.execution } : {}),
    ...(input.executionContext !== undefined ? { executionContext: input.executionContext } : {}),
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

/** Remove the saved sync policy for one forked package (reverts it to the default `branch` cloud mode). */
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
 *
 * Runs natively in Kody Cloud (`workerd`) by default. When the fork's saved policy sets
 * `testCommand`, `agentCommand`, or `execution: "context"` (or when `execution: "context"` is
 * passed), runs via `kody.command.run` on an Execution Context.
 */
export async function syncFork(input: {
  forkKodyId: string;
  upstreamKodyId: string;
  toCommit: string;
  fromCommit?: string;
  packageVersion?: string | null;
  packageId?: string;
  execution?: SyncExecutionTarget;
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
  const storage = packageStorage();
  const policy = (await getForkPolicy(storage, input.forkKodyId)) ?? defaultPolicy(input.forkKodyId);
  const useContext = input.execution === 'context' || (input.execution !== 'cloud' && policyRequiresExecutionContext(policy));
  if (useContext) {
    if (typeof kody.command?.run !== 'function') {
      throw new Error(
        `Manual syncFork for "${input.forkKodyId}" requires an Execution Context (policy sets testCommand/agentCommand or execution: "context"), but host commands are not available in Kody Cloud`,
      );
    }
    return syncForkFromUpstreamEvent(syntheticEvent, {
      command: kody.command,
      storage,
      resolvePackageName: async (packageId) => (await kody.packageGet({ package_id: packageId })).name,
      publisher: {
        publish: (pubInput) => kody.packagePublishExternalPush(pubInput),
      },
    });
  }
  return syncForkInCloud(syntheticEvent, {
    gitRemote: {
      getGitRemote: (remoteInput) => kody.packageGetGitRemote(remoteInput),
    },
    storage,
    resolvePackageName: async (packageId) => (await kody.packageGet({ package_id: packageId })).name,
    publisher: {
      publish: (pubInput) => kody.packagePublishExternalPush(pubInput),
    },
  });
}
