import type { ForkPolicy, StorageBucket, SyncPushMode, SyncRunOutcome, SyncRunRecord } from './types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fork_policies (
  fork_kody_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  test_command TEXT,
  graft_command_json TEXT,
  workspace_root TEXT,
  kody_origin TEXT,
  push_agent_branch INTEGER NOT NULL DEFAULT 1,
  allow_zero_conflict_package_json INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  fork_kody_id TEXT NOT NULL,
  upstream_kody_id TEXT NOT NULL,
  from_commit TEXT NOT NULL,
  to_commit TEXT NOT NULL,
  target_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  mode TEXT NOT NULL,
  branch TEXT,
  commit_sha TEXT,
  conflicts_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  report_md TEXT,
  publish_status TEXT,
  approval_url TEXT,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_fork_created
  ON sync_runs (fork_kody_id, created_at DESC);
`;

interface PolicyRow {
  fork_kody_id: string;
  mode: string;
  test_command: string | null;
  graft_command_json: string | null;
  workspace_root: string | null;
  kody_origin: string | null;
  push_agent_branch: number;
  allow_zero_conflict_package_json: number;
  updated_at: string;
}

interface RunRow {
  id: string;
  event_id: string;
  fork_kody_id: string;
  upstream_kody_id: string;
  from_commit: string;
  to_commit: string;
  target_version: string;
  outcome: string;
  mode: string;
  branch: string | null;
  commit_sha: string | null;
  conflicts_json: string;
  reasons_json: string;
  report_md: string | null;
  publish_status: string | null;
  approval_url: string | null;
  warnings_json: string;
  created_at: string;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToPolicy(row: PolicyRow): ForkPolicy {
  const graftCommand = parseJsonArray(row.graft_command_json);
  return {
    forkKodyId: row.fork_kody_id,
    mode: (row.mode === 'push' || row.mode === 'publish' ? row.mode : 'branch') as SyncPushMode,
    ...(row.test_command ? { testCommand: row.test_command } : {}),
    ...(graftCommand.length ? { graftCommand } : {}),
    ...(row.workspace_root ? { workspaceRoot: row.workspace_root } : {}),
    ...(row.kody_origin ? { kodyOrigin: row.kody_origin } : {}),
    pushAgentBranch: row.push_agent_branch !== 0,
    allowZeroConflictPackageJson: row.allow_zero_conflict_package_json === 1,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: RunRow): SyncRunRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    forkKodyId: row.fork_kody_id,
    upstreamKodyId: row.upstream_kody_id,
    fromCommit: row.from_commit,
    toCommit: row.to_commit,
    targetVersion: row.target_version,
    outcome: row.outcome as SyncRunOutcome,
    mode: (row.mode === 'push' || row.mode === 'publish' ? row.mode : 'branch') as SyncPushMode,
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.commit_sha ? { commit: row.commit_sha } : {}),
    conflicts: parseJsonArray(row.conflicts_json),
    reasons: parseJsonArray(row.reasons_json),
    ...(row.report_md ? { reportMd: row.report_md } : {}),
    ...(row.publish_status ? { publishStatus: row.publish_status } : {}),
    ...(row.approval_url ? { approvalUrl: row.approval_url } : {}),
    warnings: parseJsonArray(row.warnings_json),
    createdAt: row.created_at,
  };
}

/** Ensure the package SQLite tables exist before reading or writing. */
export async function ensureSchema(bucket: StorageBucket): Promise<void> {
  await bucket.sql(SCHEMA_SQL);
}

/** Default policy used when a fork has no saved row in `fork_policies`. */
export function defaultPolicy(forkKodyId: string): ForkPolicy {
  return {
    forkKodyId,
    mode: 'branch',
    pushAgentBranch: true,
    allowZeroConflictPackageJson: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function getForkPolicy(bucket: StorageBucket, forkKodyId: string): Promise<ForkPolicy | undefined> {
  await ensureSchema(bucket);
  const res = await bucket.sql<PolicyRow>('SELECT * FROM fork_policies WHERE fork_kody_id = ? LIMIT 1', [forkKodyId]);
  const row = res.rows[0];
  return row ? rowToPolicy(row) : undefined;
}

export async function listForkPolicies(bucket: StorageBucket): Promise<ForkPolicy[]> {
  await ensureSchema(bucket);
  const res = await bucket.sql<PolicyRow>('SELECT * FROM fork_policies ORDER BY fork_kody_id ASC LIMIT 500');
  return res.rows.map(rowToPolicy);
}

export async function upsertForkPolicy(
  bucket: StorageBucket,
  input: Omit<ForkPolicy, 'updatedAt'> & { updatedAt?: string },
): Promise<ForkPolicy> {
  await ensureSchema(bucket);
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const mode: SyncPushMode = input.mode ?? 'branch';
  if (mode !== 'branch' && mode !== 'push' && mode !== 'publish') {
    throw new Error(`Invalid sync mode "${String(mode)}" (expected "branch", "push", or "publish")`);
  }
  await bucket.sql(
    `INSERT INTO fork_policies (
      fork_kody_id, mode, test_command, graft_command_json, workspace_root, kody_origin,
      push_agent_branch, allow_zero_conflict_package_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fork_kody_id) DO UPDATE SET
      mode = excluded.mode,
      test_command = excluded.test_command,
      graft_command_json = excluded.graft_command_json,
      workspace_root = excluded.workspace_root,
      kody_origin = excluded.kody_origin,
      push_agent_branch = excluded.push_agent_branch,
      allow_zero_conflict_package_json = excluded.allow_zero_conflict_package_json,
      updated_at = excluded.updated_at`,
    [
      input.forkKodyId,
      mode,
      input.testCommand ?? null,
      input.graftCommand?.length ? JSON.stringify(input.graftCommand) : null,
      input.workspaceRoot ?? null,
      input.kodyOrigin ?? null,
      input.pushAgentBranch === false ? 0 : 1,
      input.allowZeroConflictPackageJson === true ? 1 : 0,
      updatedAt,
    ],
  );
  return {
    forkKodyId: input.forkKodyId,
    mode,
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.graftCommand?.length ? { graftCommand: input.graftCommand } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.kodyOrigin ? { kodyOrigin: input.kodyOrigin } : {}),
    pushAgentBranch: input.pushAgentBranch !== false,
    allowZeroConflictPackageJson: input.allowZeroConflictPackageJson === true,
    updatedAt,
  };
}

export async function deleteForkPolicy(bucket: StorageBucket, forkKodyId: string): Promise<boolean> {
  await ensureSchema(bucket);
  const res = await bucket.sql('DELETE FROM fork_policies WHERE fork_kody_id = ?', [forkKodyId]);
  return res.rowCount > 0;
}

export async function saveSyncRun(bucket: StorageBucket, run: SyncRunRecord): Promise<void> {
  await ensureSchema(bucket);
  await bucket.sql(
    `INSERT OR REPLACE INTO sync_runs (
      id, event_id, fork_kody_id, upstream_kody_id, from_commit, to_commit, target_version,
      outcome, mode, branch, commit_sha, conflicts_json, reasons_json, report_md,
      publish_status, approval_url, warnings_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.eventId,
      run.forkKodyId,
      run.upstreamKodyId,
      run.fromCommit,
      run.toCommit,
      run.targetVersion,
      run.outcome,
      run.mode,
      run.branch ?? null,
      run.commit ?? null,
      JSON.stringify(run.conflicts),
      JSON.stringify(run.reasons),
      run.reportMd ?? null,
      run.publishStatus ?? null,
      run.approvalUrl ?? null,
      JSON.stringify(run.warnings),
      run.createdAt,
    ],
  );
}

export async function listSyncRuns(bucket: StorageBucket, options: { forkKodyId?: string; limit?: number } = {}): Promise<SyncRunRecord[]> {
  await ensureSchema(bucket);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));
  const res = options.forkKodyId
    ? await bucket.sql<RunRow>('SELECT * FROM sync_runs WHERE fork_kody_id = ? ORDER BY created_at DESC LIMIT ?', [
        options.forkKodyId,
        limit,
      ])
    : await bucket.sql<RunRow>('SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT ?', [limit]);
  return res.rows.map(rowToRun);
}

export async function getSyncRun(bucket: StorageBucket, id: string): Promise<SyncRunRecord | undefined> {
  await ensureSchema(bucket);
  const res = await bucket.sql<RunRow>('SELECT * FROM sync_runs WHERE id = ? LIMIT 1', [id]);
  const row = res.rows[0];
  return row ? rowToRun(row) : undefined;
}
