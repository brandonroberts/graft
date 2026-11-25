import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deleteForkPolicy, getForkPolicy, getSyncRun, listForkPolicies, listSyncRuns, upsertForkPolicy } from '../src/storage.ts';
import { syncForkFromUpstreamEvent } from '../src/sync.ts';
import type { CommandRunner, CommunityForkUpstreamUpdatedEvent, ExternalPublisher, StorageBucket, SyncRunRecord } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAFT_BIN = path.resolve(HERE, '../../cli/dist/bin.js');

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

/** Real host command runner backed by child_process.execFile (mirrors Kody Execution Context `kody.command.run`). */
function createHostRunner(): CommandRunner {
  return {
    run(input) {
      return new Promise((resolve) => {
        const opts = {
          cwd: input.cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'tester',
            GIT_AUTHOR_EMAIL: 'tester@example.com',
            GIT_COMMITTER_NAME: 'tester',
            GIT_COMMITTER_EMAIL: 'tester@example.com',
            ...input.env,
          },
          timeout: input.timeoutMs ?? 60_000,
          maxBuffer: 16 * 1024 * 1024,
        };
        const cb = (
          err: (Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals }) | null,
          stdout: string,
          stderr: string,
        ) => {
          const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({
            exitCode,
            signal: err?.signal ?? null,
            timedOut: Boolean(err?.killed && err.signal),
            stdout: String(stdout),
            stderr: String(stderr),
          });
        };
        if (input.command) {
          execFile('/bin/sh', ['-c', input.command], opts, cb);
        } else {
          execFile(input.file!, input.args ?? [], opts, cb);
        }
      });
    },
  };
}

/** Real SQLite StorageBucket backed by Node's built-in `node:sqlite`. */
function createSqliteBucket(): StorageBucket {
  const db = new DatabaseSync(':memory:');
  return {
    async sql<Row = Record<string, unknown>>(
      query: string,
      params?: Array<string | number | boolean | null>,
    ): Promise<{ rows: Row[]; rowCount: number }> {
      const trimmed = query.trim();
      const statements = trimmed
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const bindings = (params ?? []).map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
      if (statements.length > 1) {
        for (const stmt of statements.slice(0, -1)) db.exec(stmt);
      }
      const last = statements.at(-1)!;
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(last)) {
        const rows = db.prepare(last).all(...bindings) as Row[];
        return { rows, rowCount: rows.length };
      }
      const info = db.prepare(last).run(...bindings);
      return { rows: [], rowCount: Number(info.changes) };
    },
  };
}

interface Fixture {
  root: string;
  upstream: string;
  forkBare: string;
  workspaceRoot: string;
  originCommit: string;
  commitUpstream: (files: Record<string, string>, message: string) => Promise<string>;
  makeEvent: (toCommit: string, packageVersion?: string | null) => CommunityForkUpstreamUpdatedEvent;
}

/**
 * Create a realistic Kody fork setup:
 * - `upstream`: public upstream package repo (no tags, optional package.json#version)
 * - `forkBare`: bare remote representing `https://kody.codes/@brandontroberts/my-tool.git`
 *   with an unrelated initial commit (just like `communityFork`), scope rewrite in `package.json`,
 *   a behavioral customization in `src/index.ts`, and `.grafts/upstream-sync/` scaffolded via real `graft add`.
 */
async function setupKodyFork(opts: { withGraft?: boolean; initialVersion?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-kody-'));
  const upstream = path.join(root, 'upstream');
  const forkBare = path.join(root, 'fork.git');
  const forkWork = path.join(root, 'fork-init');
  const workspaceRoot = path.join(root, 'cache');

  await mkdir(path.join(upstream, 'src'), { recursive: true });
  gitIn(upstream, 'init', '-q');

  const commitUpstream = async (files: Record<string, string>, message: string) => {
    for (const [f, content] of Object.entries(files)) {
      const abs = path.join(upstream, f);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    gitIn(upstream, 'add', '-A');
    gitIn(upstream, 'commit', '-q', '-m', message);
    return gitIn(upstream, 'rev-parse', 'HEAD').trim();
  };

  const pkgBase = {
    name: '@origin/my-tool',
    description: 'Upstream helper tool',
    ...(opts.initialVersion ? { version: opts.initialVersion } : {}),
    type: 'module',
    exports: { '.': './src/index.ts' },
  };
  const originCommit = await commitUpstream(
    {
      'package.json': `${JSON.stringify(pkgBase, null, 2)}\n`,
      'src/index.ts': 'export function greet(name: string) {\n  return `hello ${name}`;\n}\n',
      'src/util.ts': 'export const VERSION = 1;\n',
      'README.md': '# My Tool\n\n## Intent\n\nHelper.\n',
      'AGENTS.md': '# Agents\n',
    },
    'initial upstream publish',
  );

  // Create bare fork remote + unrelated-history initial fork commit (like Kody's `communityFork`).
  gitIn(root, 'init', '--bare', '-q', forkBare);
  await mkdir(path.join(forkWork, 'src'), { recursive: true });
  gitIn(forkWork, 'init', '-q');
  gitIn(forkWork, 'remote', 'add', 'origin', `file://${forkBare}`);

  const forkPkg = { ...pkgBase, name: '@brandontroberts/my-tool' };
  await writeFile(path.join(forkWork, 'package.json'), `${JSON.stringify(forkPkg, null, 2)}\n`);
  await writeFile(path.join(forkWork, 'src/index.ts'), 'export function greet(name: string) {\n  return `howdy ${name}!`;\n}\n');
  await writeFile(path.join(forkWork, 'src/util.ts'), 'export const VERSION = 1;\n');
  await writeFile(path.join(forkWork, 'README.md'), '# My Tool\n\n## Intent\n\nPersonalized helper.\n');
  await writeFile(path.join(forkWork, 'AGENTS.md'), '# Agents\n');

  if (opts.withGraft !== false) {
    execFileSync(
      process.execPath,
      [
        GRAFT_BIN,
        'add',
        'upstream-sync',
        '--package',
        '@origin/my-tool',
        '--mechanism',
        'fork',
        '--in-place',
        '--upstream',
        `file://${upstream}`,
        '--track',
        'main',
        '--version',
        `${opts.initialVersion ?? '0.0.0'}+${originCommit.slice(0, 12)}`,
      ],
      { cwd: forkWork, encoding: 'utf8', stdio: 'pipe' },
    );
  }

  gitIn(forkWork, 'add', '-A');
  gitIn(forkWork, 'commit', '-q', '-m', 'initial fork');
  gitIn(forkWork, 'push', '-q', '-u', 'origin', 'main');

  const makeEvent = (toCommit: string, packageVersion: string | null = opts.initialVersion ?? null): CommunityForkUpstreamUpdatedEvent => ({
    event: 'community.fork.upstream_updated',
    event_id: `evt-${toCommit.slice(0, 8)}`,
    listing: {
      id: 'lst-1',
      name: '@origin/my-tool',
      kody_id: '@origin/my-tool',
      public_url: 'https://kody.codes/@origin/my-tool',
    },
    publisher: { username: 'origin' },
    fork: {
      id: 'frk-1',
      package_id: 'pkg-1',
      kody_id: '@brandontroberts/my-tool',
      origin_commit: originCommit,
      forked_at: '2026-11-24T00:00:00.000Z',
    },
    previous: { pinned_commit: originCommit, package_version: opts.initialVersion ?? null },
    current: { pinned_commit: toCommit, package_version: packageVersion },
    published_at: '2026-11-24T01:00:00.000Z',
  });

  return { root, upstream, forkBare, workspaceRoot, originCommit, commitUpstream, makeEvent };
}

describe('packages/kody (@brandontroberts/graft-sync)', () => {
  it('skips non-grafted forks cleanly and records skipped-no-graft', async () => {
    const fx = await setupKodyFork({ withGraft: false });
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'bump util');
    const storage = createSqliteBucket();

    const record = await syncForkFromUpstreamEvent(fx.makeEvent(next), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });

    expect(record.outcome).toBe('skipped-no-graft');
    expect(record.branch).toBeUndefined();
    const saved = await getSyncRun(storage, record.id);
    expect(saved?.outcome).toBe('skipped-no-graft');
  });

  it('syncs a non-conflicting upstream update in branch mode with two-parent merge ancestry', async () => {
    const fx = await setupKodyFork();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream util change');
    const storage = createSqliteBucket();
    const emitted: SyncRunRecord[] = [];

    await upsertForkPolicy(storage, {
      forkKodyId: '@brandontroberts/my-tool',
      mode: 'branch',
      graftCommand: [process.execPath, GRAFT_BIN],
      workspaceRoot: fx.workspaceRoot,
    });

    const record = await syncForkFromUpstreamEvent(fx.makeEvent(next), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      emitter: {
        async emit(r) {
          emitted.push(r);
        },
      },
    });

    expect(record.outcome, JSON.stringify(record)).toBe('green');
    expect(record.branch).toBe(`graft/sync-${next.slice(0, 12)}`);
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.outcome).toBe('green');

    // Verify pushed branch preserves fork customization, upstream change, updated graft.md, and upstream parent.
    const ref = `refs/heads/${record.branch}`;
    expect(gitIn(fx.forkBare, 'show', `${ref}:src/index.ts`)).toContain('howdy ${name}!');
    expect(gitIn(fx.forkBare, 'show', `${ref}:src/util.ts`)).toBe('export const VERSION = 2;\n');
    expect(gitIn(fx.forkBare, 'show', `${ref}:.grafts/upstream-sync/graft.md`)).toContain(`verified: 0.0.0+${next}`);
    const parents = gitIn(fx.forkBare, 'rev-list', '--parents', '-n1', ref).trim().split(' ').slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(next);
    // Default branch untouched in `branch` mode.
    expect(gitIn(fx.forkBare, 'show', 'refs/heads/main:src/util.ts')).toBe('export const VERSION = 1;\n');
  });

  it('pushes to main and calls publisher in publish mode, surfacing locked approval_url and failing closed on test failure', async () => {
    const fx = await setupKodyFork();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream v2');
    const storage = createSqliteBucket();
    const publishCalls: Array<{ kody_id?: string; package_id?: string }> = [];
    const publisher: ExternalPublisher = {
      async publish(input) {
        publishCalls.push(input);
        return { status: 'locked', approval_url: 'https://kody.codes/@brandontroberts/my-tool/approve?commit=abc' };
      },
    };

    // First, verify a failing testCommand aborts the push and marks needs-agent.
    const failedTest = await syncForkFromUpstreamEvent(fx.makeEvent(next), {
      command: createHostRunner(),
      storage,
      publisher,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'publish',
        testCommand: 'exit 1',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(failedTest.outcome).toBe('needs-agent');
    expect(failedTest.reasons[0]).toMatch(/testCommand/);
    expect(publishCalls).toHaveLength(0);
    expect(gitIn(fx.forkBare, 'show', 'refs/heads/main:src/util.ts')).toBe('export const VERSION = 1;\n');

    // Now run with a passing testCommand: pushes to main and invokes publisher.
    const ok = await syncForkFromUpstreamEvent(fx.makeEvent(next), {
      command: createHostRunner(),
      storage,
      publisher,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'publish',
        testCommand: 'node -e "process.exit(0)"',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(ok.outcome, JSON.stringify(ok)).toBe('green');
    expect(ok.branch).toBe('main');
    expect(ok.publishStatus).toBe('locked');
    expect(ok.approvalUrl).toBe('https://kody.codes/@brandontroberts/my-tool/approve?commit=abc');
    expect(publishCalls).toEqual([{ package_id: 'pkg-1' }]);
    expect(gitIn(fx.forkBare, 'show', 'refs/heads/main:src/util.ts')).toBe('export const VERSION = 2;\n');
  });

  it('pushes -agent conflict branch and stores sync.md report on conflicting upstream edits', async () => {
    const fx = await setupKodyFork();
    const conflicting = await fx.commitUpstream(
      { 'src/index.ts': 'export function greet(name: string) {\n  return `hi there ${name}`;\n}\n' },
      'conflicting greeting edit',
    );
    const storage = createSqliteBucket();

    const record = await syncForkFromUpstreamEvent(fx.makeEvent(conflicting), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });

    expect(record.outcome).toBe('needs-agent');
    expect(record.conflicts).toEqual(['src/index.ts']);
    expect(record.branch).toBe(`graft/agent-${conflicting.slice(0, 12)}`);
    expect(record.reportMd).toContain('# Graft sync report');
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:src/index.ts`)).toContain('<<<<<<<');

    const runs = await listSyncRuns(storage, { forkKodyId: '@brandontroberts/my-tool' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.conflicts).toEqual(['src/index.ts']);
  });

  it('keeps package.json context drift strict by default and adopts cleanly when allowZeroConflictPackageJson is enabled', async () => {
    const fx = await setupKodyFork({ initialVersion: '1.0.0' });
    const bumpedPkg = {
      name: '@origin/my-tool',
      description: 'Upstream helper tool',
      version: '1.0.1',
      type: 'module',
      exports: { '.': './src/index.ts' },
    };
    const bumped = await fx.commitUpstream(
      { 'package.json': `${JSON.stringify(bumpedPkg, null, 2)}\n`, 'src/util.ts': 'export const VERSION = 2;\n' },
      'bump version within -U3 context of name',
    );
    const storage = createSqliteBucket();

    // Default (strict fuzz 0): bounces to needs-agent with 0 git conflicts.
    const strict = await syncForkFromUpstreamEvent(fx.makeEvent(bumped, '1.0.1'), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        pushAgentBranch: false,
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(strict.outcome).toBe('needs-agent');
    expect(strict.conflicts).toEqual([]);

    // Opt-in `allowZeroConflictPackageJson`: merges cleanly, re-verifies with graft sync, and pushes green.
    const relaxed = await syncForkFromUpstreamEvent(fx.makeEvent(bumped, '1.0.1'), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        allowZeroConflictPackageJson: true,
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(relaxed.outcome, JSON.stringify(relaxed)).toBe('green');
    expect(relaxed.warnings).toContain('adopted zero-conflict package.json merge and re-verified with graft sync');
    const mergedPkg = JSON.parse(gitIn(fx.forkBare, 'show', `refs/heads/${relaxed.branch}:package.json`)) as {
      name: string;
      version: string;
    };
    expect(mergedPkg.name).toBe('@brandontroberts/my-tool');
    expect(mergedPkg.version).toBe('1.0.1');

    // A genuine git conflict in package.json (adjacent line edited) still stays needs-agent even with the flag on.
    const adjacentConflict = await fx.commitUpstream(
      {
        'package.json': `${JSON.stringify({ ...bumpedPkg, description: 'Changed right next to name' }, null, 2)}\n`,
      },
      'edit description immediately adjacent to name',
    );
    const stillConflicted = await syncForkFromUpstreamEvent(fx.makeEvent(adjacentConflict, '1.0.1'), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        allowZeroConflictPackageJson: true,
        pushAgentBranch: false,
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(stillConflicted.outcome).toBe('needs-agent');
    expect(stillConflicted.conflicts).toEqual(['package.json']);
  });

  it('reports missing upstream commits (exit 2) as outcome error without pushing', async () => {
    const fx = await setupKodyFork();
    const storage = createSqliteBucket();
    const missingSha = 'deadbeefcafe1234567890abcdef1234567890ab';

    const record = await syncForkFromUpstreamEvent(fx.makeEvent(missingSha), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });

    expect(record.outcome).toBe('error');
    expect(record.branch).toBeUndefined();
    expect(record.reasons.join('\n')).toMatch(/upstream commit deadbeefcafe/);
  });

  it('falls back to npx -y @graftsync/cli@latest when graft is not on PATH', async () => {
    const fx = await setupKodyFork();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream v2');
    const real = createHostRunner();
    const seenNpx: string[][] = [];
    const runner: CommandRunner = {
      async run(input) {
        if (input.file === 'graft' && input.args?.[0] === '--version') {
          return { exitCode: 127, signal: null, timedOut: false, stdout: '', stderr: 'not found' };
        }
        if (input.file === 'npx' && input.args?.[0] === '-y' && input.args[1] === '@graftsync/cli@latest') {
          seenNpx.push(input.args);
          return real.run({ ...input, file: process.execPath, args: [GRAFT_BIN, ...input.args.slice(2)] });
        }
        return real.run(input);
      },
    };

    const record = await syncForkFromUpstreamEvent(fx.makeEvent(next), {
      command: runner,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(record.outcome, JSON.stringify(record)).toBe('green');
    expect(seenNpx).toHaveLength(1);
    expect(seenNpx[0]?.slice(0, 3)).toEqual(['-y', '@graftsync/cli@latest', 'sync']);
  });

  it('runs agentCommand on conflicts, re-verifies with graft sync, and rejects unresolved markers', async () => {
    const fx = await setupKodyFork();
    const conflicting = await fx.commitUpstream(
      { 'src/index.ts': 'export function greet(name: string) {\n  return `hi there ${name}`;\n}\n' },
      'conflicting greeting edit',
    );
    const storage = createSqliteBucket();

    // 1. A liar agent that exits 0 without resolving conflict markers must NOT produce a green push.
    const liar = await syncForkFromUpstreamEvent(fx.makeEvent(conflicting), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        agentCommand: 'node -e "process.exit(0)"',
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(liar.outcome).toBe('needs-agent');
    expect(liar.agentRan).toBe(true);
    expect(liar.warnings.join('\n')).toMatch(/left conflict markers/);
    expect(liar.branch).toBe(`graft/agent-${conflicting.slice(0, 12)}`);

    // 2. A real agent script that reads GRAFT_PROMPT_FILE / GRAFT_CONFLICTS and resolves src/index.ts.
    const agentScript = path.join(fx.root, 'resolve-agent.mjs');
    await writeFile(
      agentScript,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        'if (!existsSync(process.env.GRAFT_PROMPT_FILE)) process.exit(2);',
        "if (process.env.GRAFT_CONFLICTS !== 'src/index.ts') process.exit(3);",
        "const prompt = readFileSync(process.env.GRAFT_PROMPT_FILE, 'utf8');",
        "if (!prompt.includes('src/index.ts')) process.exit(4);",
        "writeFileSync('src/index.ts', 'export function greet(name: string) {\\n  return `howdy there ${name}!`;\\n}\\n');",
      ].join('\n'),
    );

    const resolved = await syncForkFromUpstreamEvent(fx.makeEvent(conflicting), {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        agentCommand: `"${process.execPath}" "${agentScript}"`,
        graftCommand: [process.execPath, GRAFT_BIN],
        workspaceRoot: fx.workspaceRoot,
        updatedAt: '2026-11-24T01:00:00.000Z',
      },
    });
    expect(resolved.outcome, JSON.stringify(resolved)).toBe('green');
    expect(resolved.agentRan).toBe(true);
    expect(resolved.branch).toBe(`graft/sync-${conflicting.slice(0, 12)}`);
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${resolved.branch}:src/index.ts`)).toContain('howdy there ${name}!');
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${resolved.branch}:.grafts/upstream-sync/graft.md`)).toContain('status: applied');
    const parents = gitIn(fx.forkBare, 'rev-list', '--parents', '-n1', `refs/heads/${resolved.branch}`).trim().split(' ').slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(conflicting);

    const stored = await getSyncRun(storage, resolved.id);
    expect(stored?.agentRan).toBe(true);
  });

  it('persists, lists, updates, and deletes fork policies in SQLite storage', async () => {
    const storage = createSqliteBucket();
    expect(await listForkPolicies(storage)).toEqual([]);

    const saved = await upsertForkPolicy(storage, {
      forkKodyId: '@brandontroberts/alpha',
      mode: 'publish',
      testCommand: 'npm test',
      agentCommand: 'claude -p "$(cat "$GRAFT_PROMPT_FILE")"',
      graftCommand: ['npx', '-y', '@graftsync/cli@latest'],
      allowZeroConflictPackageJson: true,
    });
    expect(saved.mode).toBe('publish');
    expect(saved.agentCommand).toBe('claude -p "$(cat "$GRAFT_PROMPT_FILE")"');
    expect(await getForkPolicy(storage, '@brandontroberts/alpha')).toMatchObject({
      mode: 'publish',
      testCommand: 'npm test',
      agentCommand: 'claude -p "$(cat "$GRAFT_PROMPT_FILE")"',
      graftCommand: ['npx', '-y', '@graftsync/cli@latest'],
      allowZeroConflictPackageJson: true,
    });
    expect((await listForkPolicies(storage)).map((p) => p.forkKodyId)).toEqual(['@brandontroberts/alpha']);

    expect(await deleteForkPolicy(storage, '@brandontroberts/alpha')).toBe(true);
    expect(await getForkPolicy(storage, '@brandontroberts/alpha')).toBeUndefined();
  });

  it('contains no cross-scope kody:@ strings that would trip Kody publish checks', async () => {
    const pkgDir = path.resolve(HERE, '..');
    const files = [
      'package.json',
      'README.md',
      'AGENTS.md',
      'skills/graft-sync/SKILL.md',
      'src/types.ts',
      'src/storage.ts',
      'src/sync.ts',
      'src/on-upstream-updated.ts',
      'src/index.ts',
    ];
    for (const rel of files) {
      const content = await readFile(path.join(pkgDir, rel), 'utf8');
      expect(content, `${rel} must not contain cross-scope kody:@ references`).not.toMatch(/kody:@[a-z0-9._-]+\//i);
    }
  });

  it('declares valid Kody subscription execution routing requiring local fs', async () => {
    const pkg = JSON.parse(await readFile(path.resolve(HERE, '..', 'package.json'), 'utf8')) as {
      kody?: {
        subscriptions?: Record<
          string,
          { execution?: { context?: string; chain?: string[]; requires?: string[]; whenOffline?: string; queueMinutes?: number } }
        >;
      };
    };
    const execution = pkg.kody?.subscriptions?.['community.fork.upstream_updated']?.execution;
    expect(execution).toEqual({
      requires: ['fs'],
      whenOffline: 'queue',
      queueMinutes: 1440,
    });
  });

  it('resolves bare-leaf fork.kody_id via resolvePackageName and treats dispatched publish as clean', async () => {
    const fx = await setupKodyFork();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream v2');
    const storage = createSqliteBucket();
    await upsertForkPolicy(storage, {
      forkKodyId: '@brandontroberts/my-tool',
      mode: 'publish',
      graftCommand: [process.execPath, GRAFT_BIN],
      workspaceRoot: fx.workspaceRoot,
    });

    const baseEvent = fx.makeEvent(next);
    const bareLeafEvent: CommunityForkUpstreamUpdatedEvent = {
      ...baseEvent,
      listing: { ...baseEvent.listing, name: '@upstream/my-tool', kody_id: 'my-tool' },
      fork: { ...baseEvent.fork, kody_id: 'my-tool', package_id: 'pkg-uuid-1' },
    };

    // Without resolvePackageName, a bare leaf must fail loudly.
    await expect(
      syncForkFromUpstreamEvent(bareLeafEvent, {
        command: createHostRunner(),
        storage,
        forkGitUrl: `file://${fx.forkBare}`,
      }),
    ).rejects.toThrow(/Invalid fork kody_id: "my-tool"/);

    // With resolvePackageName (backed by kody.packageGet in production), it resolves @owner/leaf,
    // loads the saved policy, uses listing.name for upstreamKodyId, and treats dispatched as clean.
    const publishCalls: Array<{ kody_id?: string; package_id?: string }> = [];
    const run = await syncForkFromUpstreamEvent(bareLeafEvent, {
      command: createHostRunner(),
      storage,
      forkGitUrl: `file://${fx.forkBare}`,
      resolvePackageName: async (packageId) => (packageId === 'pkg-uuid-1' ? '@brandontroberts/my-tool' : undefined),
      publisher: {
        async publish(input) {
          publishCalls.push(input);
          return { status: 'dispatched' };
        },
      },
    });
    expect(run.outcome, JSON.stringify(run)).toBe('green');
    expect(run.forkKodyId).toBe('@brandontroberts/my-tool');
    expect(run.upstreamKodyId).toBe('@upstream/my-tool');
    expect(run.publishStatus).toBe('dispatched');
    expect(run.warnings).toEqual([]);
    expect(publishCalls).toEqual([{ package_id: 'pkg-uuid-1' }]);
  });

  it('uses exact .ts relative import specifiers that Kody module resolution expects', async () => {
    const srcDir = path.resolve(HERE, '..', 'src');
    const srcFiles = ['index.ts', 'on-upstream-updated.ts', 'storage.ts', 'sync.ts', 'types.ts'];
    const importRe = /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g;
    for (const file of srcFiles) {
      const content = await readFile(path.join(srcDir, file), 'utf8');
      for (const match of content.matchAll(importRe)) {
        const spec = match[1]!;
        const target = path.resolve(srcDir, spec);
        expect(existsSync(target), `${file} imports "${spec}" which does not exist at ${target}`).toBe(true);
      }
    }
  });
});
