/** Payload Kody delivers to `community.fork.upstream_updated` subscribers. */
export interface CommunityForkUpstreamUpdatedEvent {
  event: 'community.fork.upstream_updated';
  event_id: string;
  listing: {
    id: string;
    name: string;
    kody_id: string;
    public_url: string;
  };
  publisher: {
    username: string | null;
  };
  fork: {
    id: string;
    package_id: string;
    kody_id: string;
    origin_commit: string;
    forked_at: string;
  };
  previous: {
    pinned_commit: string;
    package_version: string | null;
  };
  current: {
    pinned_commit: string;
    package_version: string | null;
  };
  published_at: string;
  synthetic?: boolean;
}

/** How a green sync result is pushed back to the fork. */
export type SyncPushMode = 'branch' | 'push' | 'publish';

/** Per-fork configuration stored in `packageStorage()`. */
export interface ForkPolicy {
  /** Fork package identity (e.g. `@brandontroberts/my-fork`). */
  forkKodyId: string;
  /**
   * - `branch` (default): push adopted merge to `graft/sync-<short-sha>` without touching the default branch.
   * - `push`: push adopted merge directly to the default branch (does not advance Kody's live `published_commit`).
   * - `publish`: push to the default branch, then call `packagePublishExternalPush` (still gated by Kody checks and `locked_at`).
   */
  mode: SyncPushMode;
  /** Optional local command run in the fork checkout before pushing a green merge (e.g. `npm test`). */
  testCommand?: string;
  /**
   * Optional local coding-agent shell command run on the Execution Context when `graft sync`
   * reports `needs-agent` (e.g. `claude -p "$(cat "$GRAFT_PROMPT_FILE")"`). Graft adopts the
   * `-agent` branch, runs this command, and re-runs `graft sync` (plus `testCommand`) before
   * pushing — never trusting the agent blindly.
   */
  agentCommand?: string;
  /**
   * Command + leading args for invoking Graft on the Execution Context.
   * Defaults to `['graft']` when on `PATH`, falling back to `['npx', '-y', '@graftsync/cli@latest']`.
   */
  graftCommand?: string[];
  /** Absolute path on the Execution Context where fork clones are cached (default: `<homedir>/.cache/kody-graft`). */
  workspaceRoot?: string;
  /** Base HTTPS origin for Kody git remotes (default: `https://kody.codes`). */
  kodyOrigin?: string;
  /** Push the conflict-marked `-agent` branch to `origin` when `needs-agent` (default: `true`). */
  pushAgentBranch?: boolean;
  /**
   * Opt-in Kody workaround: when `graft sync` returns `needs-agent` ONLY because of a `package.json`
   * hunk (e.g. upstream bumped `"version"` next to `communityFork`'s `"name"` rewrite) AND git's
   * 3-way merge has zero conflicts (`agentStart.conflicts.length === 0`), adopt the clean merge
   * and re-verify with `graft sync` before pushing. Default: `false` (strict fuzz 0).
   */
  allowZeroConflictPackageJson?: boolean;
  /** Updated ISO timestamp. */
  updatedAt: string;
}

export type SyncRunOutcome = 'green' | 'needs-agent' | 'skipped-no-graft' | 'error';

/** Durable record of one Graft sync run in `packageStorage()`. */
export interface SyncRunRecord {
  id: string;
  eventId: string;
  forkKodyId: string;
  upstreamKodyId: string;
  fromCommit: string;
  toCommit: string;
  targetVersion: string;
  outcome: SyncRunOutcome;
  mode: SyncPushMode;
  /** Pushed branch ref (e.g. `graft/sync-abc12345`, `main`, or `graft/agent-abc12345`). */
  branch?: string;
  /** Adopted commit SHA when green and pushed. */
  commit?: string;
  /** Conflicting file paths reported by Graft on `needs-agent`. */
  conflicts: string[];
  /** Reasons reported by Graft or the runner. */
  reasons: string[];
  /** Markdown report from `.grafts/.report/sync.md`, when present. */
  reportMd?: string;
  /** True when `policy.agentCommand` ran during this sync attempt. */
  agentRan?: boolean;
  /** Result status of `packagePublishExternalPush` in `publish` mode. */
  publishStatus?: string;
  /** Human approval URL when Kody returns `locked` on publish. */
  approvalUrl?: string;
  /** Non-fatal operational notes (e.g. event emission skipped). */
  warnings: string[];
  createdAt: string;
}

/** Minimal `kody.command.run` interface (injected for tests, wired to `kody:runtime` in Kody). */
export interface CommandRunner {
  run(input: {
    command?: string;
    file?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>;
}

/** Minimal `packageStorage()` SQLite interface. */
export interface StorageBucket {
  sql<Row = Record<string, unknown>>(
    query: string,
    params?: Array<string | number | boolean | null>,
  ): Promise<{ rows: Row[]; rowCount: number }>;
}

/** Optional publisher for `mode: 'publish'`. */
export interface ExternalPublisher {
  publish(input: { kody_id?: string; package_id?: string }): Promise<{
    status: string;
    published_commit?: string;
    approval_url?: string;
    error?: string;
  }>;
}

/** Optional downstream event emitter (`kody:runtime`'s `events.dispatch`). */
export interface SyncEventEmitter {
  emit(record: SyncRunRecord): Promise<void>;
}

/** Subset of Graft's `graft sync --json` report consumed by this package. */
export interface GraftSyncJsonReport {
  exitCode: 0 | 1 | 2;
  grafts: Array<{
    id: string;
    package: string;
    from: string;
    to?: string;
    outcome: 'green' | 'needs-agent' | 'skipped' | 'error';
    reasons: string[];
    anchors?: {
      ok: boolean;
      anchors: Array<{ file: string; matched: boolean; error?: string }>;
      errors: string[];
    };
    materialized?: {
      description?: string;
      fetch?: { repo: string; ref: string; upstream?: string };
    };
    agentStart?: {
      description: string;
      repo?: string;
      ref?: string;
      upstream?: string;
      conflicts?: string[];
      next?: string;
    };
  }>;
}
