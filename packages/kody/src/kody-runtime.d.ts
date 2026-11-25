declare module 'kody:runtime' {
  export interface CommandRunInput {
    command?: string;
    file?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    shell?: 'cmd';
  }

  export interface CommandRunResult {
    commandId: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    durationMs: number;
  }

  export interface StorageSqlResult<Row = Record<string, unknown>> {
    columns: string[];
    rows: Row[];
    rowCount: number;
    rowsRead: number;
    rowsWritten: number;
    truncated?: boolean;
    warning?: string;
  }

  export interface PackageStorageBucket {
    readonly id: string;
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    list(options?: { prefix?: string; limit?: number }): Promise<string[]>;
    sql<Row = Record<string, unknown>>(query: string, params?: Array<string | number | boolean | null>): Promise<StorageSqlResult<Row>>;
  }

  export interface ExternalPublishResult {
    status: string;
    published_commit?: string;
    approval_url?: string;
    error?: string;
  }

  export interface PackageGitRemoteResult {
    package_id: string;
    kody_id: string;
    remote: string;
    git_extra_header?: string;
    scope: 'read' | 'write';
    git_author?: { name: string; email: string };
  }

  export const kody: {
    command?: {
      run(input: CommandRunInput): Promise<CommandRunResult>;
    };
    packageGet(input: { package_id: string }): Promise<{ package_id: string; name: string; kody_id: string; slug?: string }>;
    packageGetGitRemote(input: { package_id?: string; name?: string; scope?: 'read' | 'write' }): Promise<PackageGitRemoteResult>;
    packagePublishExternalPush(input: { kody_id?: string; package_id?: string }): Promise<ExternalPublishResult>;
  };

  export function packageStorage(): PackageStorageBucket;

  export const events: {
    dispatch(input: {
      topic: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): Promise<{ topic: string; source: string; idempotencyKey: string; status: string }>;
  };

  export const workflows: {
    create(input: {
      packageId?: string;
      exportName?: string;
      code?: string;
      execution?: { context?: string; chain?: string[]; requires?: string[]; whenOffline?: string; queueMinutes?: number };
      idempotencyKey?: string;
      runAt?: string | Date;
      params?: Record<string, unknown>;
    }): Promise<{ id: string; status?: string }>;
  };
}
