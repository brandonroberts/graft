// Workerd-native Kody Cloud sync engine: runs repo-mode Graft fork sync in memory over Git Smart HTTP v1.
import semver from 'semver';
import { evaluateRepoModeGraftInCloud, loadRepoModeGraftFromTree } from './cloud-graft.ts';
import { createGitHttpClient, parseExtraHeader, type FetchLike } from './git-http.ts';
import { buildTreeFromFlatMap, GitObjectStore, walkCommitTree } from './git-objects.ts';
import { defaultPolicy, getForkPolicy, saveSyncRun } from './storage.ts';
import type {
  CommunityForkUpstreamUpdatedEvent,
  ExternalPublisher,
  ForkPolicy,
  GitRemoteProvider,
  StorageBucket,
  SyncEventEmitter,
  SyncRunRecord,
} from './types.ts';

const KODY_ID_RE = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_KODY_ORIGIN = 'https://kody.codes';
const MAX_REPORT_CHARS = 64_000;

export interface CloudSyncDependencies {
  gitRemote: GitRemoteProvider;
  storage?: StorageBucket;
  publisher?: ExternalPublisher;
  emitter?: SyncEventEmitter;
  /** Resolve a package UUID to its scoped `@owner/leaf` name when `event.fork.kody_id` is a bare leaf. */
  resolvePackageName?: (packageId: string) => Promise<string | undefined>;
  /** Override policy instead of reading from `storage`. */
  policy?: ForkPolicy;
  /** Override upstream git HTTP URL (useful for tests). */
  upstreamGitUrl?: string;
  /** Optional extra headers when fetching the upstream git remote. */
  upstreamHeaders?: Record<string, string>;
  /** Injectable Web Fetch implementation (defaults to global `fetch`). */
  fetch?: FetchLike;
  /** Override timestamp generator (for deterministic tests). */
  now?: () => Date;
}

/** True when a fork's policy requires a host Execution Context (shell commands or explicit opt-in). */
export function policyRequiresExecutionContext(policy: ForkPolicy): boolean {
  return Boolean(policy.testCommand || policy.agentCommand || policy.execution === 'context');
}

function resolveUpstreamUrl(graftUpstream: string, upstreamKodyId: string, kodyOrigin: string): string {
  if (/^https?:\/\//i.test(graftUpstream)) return graftUpstream;
  const origin = kodyOrigin.replace(/\/+$/, '');
  if (KODY_ID_RE.test(upstreamKodyId)) return `${origin}/${upstreamKodyId}.git`;
  throw new Error(`Cannot fetch non-HTTP upstream "${graftUpstream}" in Kody Cloud; use an https:// upstream URL in graft.md`);
}

/**
 * Run a deterministic repo-mode Graft sync natively in Kody Cloud (`workerd`) over Git Smart HTTP v1.
 * Requires no Execution Context, no local filesystem, and no host commands.
 */
export async function syncForkInCloud(event: CommunityForkUpstreamUpdatedEvent, deps: CloudSyncDependencies): Promise<SyncRunRecord> {
  const now = (deps.now ?? (() => new Date()))();
  let forkKodyId = event.fork.kody_id;
  if (!KODY_ID_RE.test(forkKodyId) && event.fork.package_id && deps.resolvePackageName) {
    const resolved = await deps.resolvePackageName(event.fork.package_id);
    if (resolved) forkKodyId = resolved;
  }
  const upstreamKodyId = event.listing.name || event.listing.kody_id;
  const toCommit = event.current.pinned_commit;
  const fromCommit = event.fork.origin_commit || event.previous.pinned_commit || '';

  if (!KODY_ID_RE.test(forkKodyId)) throw new Error(`Invalid fork kody_id: "${forkKodyId}"`);
  if (!COMMIT_SHA_RE.test(toCommit)) throw new Error(`Invalid upstream pinned_commit: "${toCommit}"`);

  const shortSha = toCommit.slice(0, 12);
  const baseVer = semver.valid(event.current.package_version ?? '') ?? '0.0.0';
  const targetVersion = `${baseVer}+${toCommit}`;

  const policy = deps.policy ?? (deps.storage ? await getForkPolicy(deps.storage, forkKodyId) : undefined) ?? defaultPolicy(forkKodyId);

  const runId = `${event.event_id || 'manual'}-${shortSha}-${now.getTime()}`;
  const record: SyncRunRecord = {
    id: runId,
    eventId: event.event_id,
    forkKodyId,
    upstreamKodyId,
    fromCommit,
    toCommit,
    targetVersion,
    outcome: 'error',
    mode: policy.mode,
    conflicts: [],
    reasons: [],
    warnings: [],
    createdAt: now.toISOString(),
  };

  const finalize = async (): Promise<SyncRunRecord> => {
    if (deps.storage) await saveSyncRun(deps.storage, record);
    if (deps.emitter) {
      try {
        await deps.emitter.emit(record);
      } catch (err) {
        record.warnings.push(`downstream event emission failed: ${(err as Error).message}`);
        if (deps.storage) await saveSyncRun(deps.storage, record);
      }
    }
    return record;
  };

  try {
    if (policy.testCommand || policy.agentCommand) {
      const configured = [policy.testCommand ? 'testCommand' : '', policy.agentCommand ? 'agentCommand' : ''].filter(Boolean).join(' and ');
      throw new Error(
        `Fork "${forkKodyId}" configures ${configured}, which cannot run in Kody Cloud; run via an Execution Context (or unset ${configured} for cloud-only sync)`,
      );
    }

    const gitHttp = createGitHttpClient(deps.fetch);
    const store = new GitObjectStore();

    const remoteInput = event.fork.package_id
      ? { package_id: event.fork.package_id, scope: 'write' as const }
      : { name: forkKodyId, scope: 'write' as const };
    const remoteInfo = await deps.gitRemote.getGitRemote(remoteInput);
    const forkHeaders = parseExtraHeader(remoteInfo.git_extra_header);

    const forkFetch = await gitHttp.fetchIntoStore(remoteInfo.remote, store, { headers: forkHeaders });
    const defaultBranch = forkFetch.discovery.defaultBranch;
    const forkHead = forkFetch.discovery.refs.get('HEAD') ?? forkFetch.discovery.refs.get(`refs/heads/${defaultBranch}`);
    if (!forkHead) {
      throw new Error(`Fork remote for ${forkKodyId} has no HEAD or refs/heads/${defaultBranch}`);
    }
    const forkCommit = store.peelToCommit(forkHead);
    if (!forkCommit) {
      throw new Error(`Fork HEAD ${forkHead} could not be resolved to a commit`);
    }

    const forkFiles = walkCommitTree(store, forkCommit);
    const graft = loadRepoModeGraftFromTree(store, forkFiles, targetVersion);
    if (!graft) {
      record.outcome = 'skipped-no-graft';
      record.reasons.push('fork does not contain .grafts/; skipping');
      return finalize();
    }

    const upstreamUrl =
      deps.upstreamGitUrl ?? resolveUpstreamUrl(graft.forkConfig.upstream, upstreamKodyId, policy.kodyOrigin ?? DEFAULT_KODY_ORIGIN);
    const upstreamFetch = await gitHttp.fetchIntoStore(upstreamUrl, store, {
      headers: deps.upstreamHeaders,
      extraWants: [toCommit],
    });

    const evalRes = await evaluateRepoModeGraftInCloud({
      store,
      graft,
      forkHead: forkCommit,
      forkRefs: forkFetch.discovery.refs,
      upstreamRefs: upstreamFetch.discovery.refs,
      targetVersion,
      allowZeroConflictPackageJson: policy.allowZeroConflictPackageJson === true,
      now,
    });

    if (evalRes.reportMd) record.reportMd = evalRes.reportMd.slice(0, MAX_REPORT_CHARS);
    if (evalRes.warnings.length) record.warnings.push(...evalRes.warnings);

    const author = {
      name: remoteInfo.git_author?.name ?? 'graft',
      email: remoteInfo.git_author?.email ?? 'graft@localhost',
      timestamp: Math.floor(now.getTime() / 1000),
    };

    if (evalRes.outcome === 'green' && evalRes.resultFiles && evalRes.targetCommitOid) {
      const treeOid = await buildTreeFromFlatMap(store, evalRes.resultFiles);
      const commitOid = await store.writeCommit({
        tree: treeOid,
        parents: [forkCommit, evalRes.targetCommitOid],
        author,
        message: `chore(graft): sync ${upstreamKodyId} to ${shortSha}`,
      });

      const targetBranch = policy.mode === 'branch' ? `graft/sync-${shortSha}` : defaultBranch;
      await gitHttp.pushRef(remoteInfo.remote, store, {
        ref: `refs/heads/${targetBranch}`,
        ...(policy.mode === 'branch' ? {} : { oldOid: forkCommit }),
        newOid: commitOid,
        remoteHaveOids: forkFetch.fetchedOids,
        headers: forkHeaders,
      });

      record.outcome = 'green';
      record.branch = targetBranch;
      record.commit = commitOid;

      if (policy.mode === 'publish') {
        if (!deps.publisher) {
          record.warnings.push('policy mode is "publish" but no publisher was provided; commit was pushed without publishing');
        } else {
          const pubInput = event.fork.package_id ? { package_id: event.fork.package_id } : { kody_id: forkKodyId };
          const pub = await deps.publisher.publish(pubInput);
          record.publishStatus = pub.status;
          if (pub.approval_url) record.approvalUrl = pub.approval_url;
          if (pub.status !== 'published' && pub.status !== 'already_published' && pub.status !== 'dispatched') {
            record.warnings.push(`publish returned status "${pub.status}"${pub.error ? `: ${pub.error}` : ''}`);
          }
        }
      }
      return finalize();
    }

    if (evalRes.outcome === 'needs-agent') {
      record.outcome = 'needs-agent';
      record.conflicts = evalRes.conflicts;
      record.reasons = evalRes.reasons;

      if (policy.pushAgentBranch !== false && evalRes.resultFiles && evalRes.targetCommitOid) {
        const agentBranch = `graft/agent-${shortSha}`;
        const agentTreeOid = await buildTreeFromFlatMap(store, evalRes.resultFiles);
        const conflictBody = evalRes.conflicts.length
          ? `\n\nConflicts (git markers left in place):\n${evalRes.conflicts.map((f) => `- ${f}`).join('\n')}\n`
          : '';
        const agentCommitOid = await store.writeCommit({
          tree: agentTreeOid,
          parents: [evalRes.targetCommitOid],
          author,
          message: `${graft.id}: merged onto commit ${shortSha} for an agent${conflictBody}`,
        });
        await gitHttp.pushRef(remoteInfo.remote, store, {
          ref: `refs/heads/${agentBranch}`,
          newOid: agentCommitOid,
          remoteHaveOids: forkFetch.fetchedOids,
          headers: forkHeaders,
        });
        record.branch = agentBranch;
      }
      return finalize();
    }

    record.outcome = 'error';
    record.reasons.push(...(evalRes.reasons.length ? evalRes.reasons : ['unexpected cloud graft evaluation result']));
    return finalize();
  } catch (err) {
    record.outcome = 'error';
    record.reasons.push((err as Error).message);
    return finalize();
  }
}
