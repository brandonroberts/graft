import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { syncForkInCloud } from '../src/cloud-sync.ts';
import { routeUpstreamUpdatedEvent, type ContextWorkflowInput } from '../src/route.ts';
import { ensureSchema, getForkPolicy, getSyncRun, upsertForkPolicy } from '../src/storage.ts';
import type { CommunityForkUpstreamUpdatedEvent, StorageBucket, SyncRunRecord } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAFT_BIN = path.resolve(HERE, '../../cli/dist/bin.js');

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

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

function runGitRpc(repoDir: string, service: 'upload-pack' | 'receive-pack', args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [service, '--stateless-rpc', ...args, repoDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`git ${service} failed (exit ${code}): ${Buffer.concat(errChunks).toString('utf8')}`));
      else resolve(Buffer.concat(chunks));
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function encodePkt(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((payload.byteLength + 4).toString(16).padStart(4, '0'), 'utf8'), payload]);
}

interface GitHttpServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Real Git Smart HTTP v1 server backed by `git upload-pack --stateless-rpc` and
 * `git receive-pack --stateless-rpc`. Enforces Bearer auth on `/fork.git` (mirroring
 * Cloudflare Artifacts via `packageGetGitRemote`) and anonymous read-only access on `/upstream.git`.
 */
async function startRealGitHttpServer(opts: { forkBare: string; upstreamDir: string; forkToken: string }): Promise<GitHttpServerHandle> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const isFork = url.pathname.startsWith('/fork.git');
      const isUpstream = url.pathname.startsWith('/upstream.git');
      if (!isFork && !isUpstream) {
        res.writeHead(404).end('not found');
        return;
      }
      if (isFork && req.headers.authorization !== `Bearer ${opts.forkToken}`) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const repoDir = isFork ? opts.forkBare : opts.upstreamDir;
      const suffix = url.pathname.slice(isFork ? '/fork.git'.length : '/upstream.git'.length);

      if (req.method === 'GET' && suffix === '/info/refs') {
        const svc = url.searchParams.get('service');
        if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
          res.writeHead(400).end('bad service');
          return;
        }
        if (isUpstream && svc === 'git-receive-pack') {
          res.writeHead(401).end('upstream is read-only');
          return;
        }
        const gitSvc = svc === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
        const adv = await runGitRpc(repoDir, gitSvc, ['--advertise-refs']);
        const body = Buffer.concat([encodePkt(`# service=${svc}\n`), Buffer.from('0000', 'utf8'), adv]);
        res.writeHead(200, { 'Content-Type': `application/x-${svc}-advertisement` }).end(body);
        return;
      }

      if (req.method === 'POST' && (suffix === '/git-upload-pack' || suffix === '/git-receive-pack')) {
        const svc = suffix.slice(1) as 'git-upload-pack' | 'git-receive-pack';
        if (isUpstream && svc === 'git-receive-pack') {
          res.writeHead(401).end('upstream is read-only');
          return;
        }
        const reqChunks: Buffer[] = [];
        for await (const c of req) reqChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const gitSvc = svc === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
        const out = await runGitRpc(repoDir, gitSvc, [], Buffer.concat(reqChunks));
        res.writeHead(200, { 'Content-Type': `application/x-${svc}-result` }).end(out);
        return;
      }

      res.writeHead(404).end('not found');
    } catch (err) {
      res.writeHead(500).end((err as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface CloudFixture {
  root: string;
  upstream: string;
  forkBare: string;
  originCommit: string;
  server: GitHttpServerHandle;
  forkToken: string;
  commitUpstream: (files: Record<string, string | Buffer>, message: string) => Promise<string>;
  makeEvent: (toCommit: string, packageVersion?: string | null) => CommunityForkUpstreamUpdatedEvent;
}

const activeServers: GitHttpServerHandle[] = [];
afterEach(async () => {
  while (activeServers.length) {
    await activeServers.pop()!.close();
  }
});

async function setupCloudFixture(
  opts: {
    withGraft?: boolean;
    initialVersion?: string;
    includeBinaryAndMode?: boolean;
    includeTrickyTreeSort?: boolean;
    customForkFiles?: Record<string, string>;
  } = {},
): Promise<CloudFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-kody-cloud-'));
  const upstream = path.join(root, 'upstream');
  const forkBare = path.join(root, 'fork.git');
  const forkWork = path.join(root, 'fork-init');
  const forkToken = 'art_v1_test_secret_token';

  await mkdir(path.join(upstream, 'src'), { recursive: true });
  gitIn(upstream, 'init', '-q');
  gitIn(upstream, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');

  const commitUpstream = async (files: Record<string, string | Buffer>, message: string) => {
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
  const baseFiles: Record<string, string | Buffer> = {
    'package.json': `${JSON.stringify(pkgBase, null, 2)}\n`,
    'src/index.ts': 'export function greet(name: string) {\n  return `hello ${name}`;\n}\n',
    'src/util.ts': 'export const VERSION = 1;\n',
    'README.md': '# My Tool\n\n## Intent\n\nHelper.\n',
    'AGENTS.md': '# Agents\n',
  };
  if (opts.includeBinaryAndMode) {
    baseFiles['assets/logo.bin'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    baseFiles['scripts/run.sh'] = '#!/bin/sh\necho hi\n';
  }
  if (opts.includeTrickyTreeSort) {
    // Tests exact Git tree sort rule: `foo-bar` (0x2d) MUST sort before `foo/` (0x2f)!
    baseFiles['foo-bar.txt'] = 'dash file\n';
    baseFiles['foo/nested.txt'] = 'nested file\n';
  }
  const originCommit = await commitUpstream(baseFiles, 'initial upstream publish');

  gitIn(root, 'init', '--bare', '-q', forkBare);
  gitIn(forkBare, 'config', 'receive.denyCurrentBranch', 'ignore');

  const server = await startRealGitHttpServer({ forkBare, upstreamDir: upstream, forkToken });
  activeServers.push(server);

  await mkdir(path.join(forkWork, 'src'), { recursive: true });
  gitIn(forkWork, 'init', '-q');
  gitIn(forkWork, 'remote', 'add', 'origin', `file://${forkBare}`);

  const forkPkg = { ...pkgBase, name: '@brandontroberts/my-tool' };
  await writeFile(path.join(forkWork, 'package.json'), `${JSON.stringify(forkPkg, null, 2)}\n`);
  await writeFile(path.join(forkWork, 'src/index.ts'), 'export function greet(name: string) {\n  return `howdy ${name}!`;\n}\n');
  await writeFile(path.join(forkWork, 'src/util.ts'), 'export const VERSION = 1;\n');
  await writeFile(path.join(forkWork, 'README.md'), '# My Tool\n\n## Intent\n\nPersonalized helper.\n');
  await writeFile(path.join(forkWork, 'AGENTS.md'), '# Agents\n');
  if (opts.includeBinaryAndMode) {
    await mkdir(path.join(forkWork, 'assets'), { recursive: true });
    await mkdir(path.join(forkWork, 'scripts'), { recursive: true });
    await writeFile(path.join(forkWork, 'assets/logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x07]));
    await writeFile(path.join(forkWork, 'scripts/run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(path.join(forkWork, 'scripts/run.sh'), 0o755);
  }
  if (opts.includeTrickyTreeSort) {
    await mkdir(path.join(forkWork, 'foo'), { recursive: true });
    await writeFile(path.join(forkWork, 'foo-bar.txt'), 'dash file\n');
    await writeFile(path.join(forkWork, 'foo/nested.txt'), 'nested file\n');
  }
  for (const [f, content] of Object.entries(opts.customForkFiles ?? {})) {
    const abs = path.join(forkWork, f);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

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
        `${server.baseUrl}/upstream.git`,
        '--track',
        'main',
        '--version',
        `${opts.initialVersion ?? '0.0.0'}+${originCommit.slice(0, 12)}`,
      ],
      { cwd: forkWork, encoding: 'utf8', stdio: 'pipe' },
    );
    // Add a YAML comment inside graft.md to prove GraftDocumentEditor preserves comments in cloud mode.
    const graftMdAbs = path.join(forkWork, '.grafts/upstream-sync/graft.md');
    const raw = execFileSync('cat', [graftMdAbs], { encoding: 'utf8' });
    await writeFile(graftMdAbs, raw.replace('status: applied', '# keep this yaml comment\nstatus: applied'));
  }

  gitIn(forkWork, 'add', '-A');
  gitIn(forkWork, 'commit', '-q', '-m', 'initial fork');
  gitIn(forkWork, 'push', '-q', '-u', 'origin', 'main');

  // Force delta packing on both repos so our packfile unpacker is exercised against real OFS_DELTA entries.
  gitIn(forkBare, 'gc', '--aggressive', '--quiet');

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

  return { root, upstream, forkBare, originCommit, server, forkToken, commitUpstream, makeEvent };
}

describe('packages/kody workerd-native cloud sync (real Git Smart HTTP v1)', () => {
  it('skips non-grafted forks cleanly in cloud without pushing', async () => {
    const fx = await setupCloudFixture({ withGraft: false });
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'bump util');
    const storage = createSqliteBucket();

    const record = await syncForkInCloud(fx.makeEvent(next), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      storage,
    });

    expect(record.outcome).toBe('skipped-no-graft');
    expect(record.branch).toBeUndefined();
    expect((await getSyncRun(storage, record.id))?.outcome).toBe('skipped-no-graft');
  });

  it('syncs a green update over real Git HTTP with two-parent merge, binary+mode preservation, git fsck, and preserved YAML comments', async () => {
    const fx = await setupCloudFixture({ includeBinaryAndMode: true, includeTrickyTreeSort: true });
    await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'intermediate upstream commit');
    const next = await fx.commitUpstream(
      {
        'src/util.ts': 'export const VERSION = 3;\n',
        'foo/nested.txt': 'nested file updated upstream\n',
      },
      'upstream v3',
    );
    gitIn(fx.upstream, 'gc', '--aggressive', '--quiet');

    const storage = createSqliteBucket();
    const emitted: SyncRunRecord[] = [];
    const record = await syncForkInCloud(fx.makeEvent(next), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
          git_author: { name: 'Brandon Roberts', email: 'brandon@example.com' },
        }),
      },
      storage,
      emitter: {
        emit: async (r) => {
          emitted.push(r);
        },
      },
    });

    expect(record.outcome, JSON.stringify(record)).toBe('green');
    expect(record.branch).toBe(`graft/sync-${next.slice(0, 12)}`);
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.reportMd).toContain('# Graft sync report');
    expect(emitted).toHaveLength(1);

    // Real git fsck proves valid tree sort order (`foo-bar.txt` vs `foo/`), packfile, and object hashes!
    expect(() => gitIn(fx.forkBare, 'fsck', '--full', '--strict')).not.toThrow();

    // Verify 2-parent merge ancestry (parent 1 = fork main, parent 2 = upstream `next`).
    const parents = gitIn(fx.forkBare, 'rev-list', '--parents', '-n1', `refs/heads/${record.branch}`).trim().split(' ').slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(next);

    // Verify author from packageGetGitRemote was used.
    expect(gitIn(fx.forkBare, 'log', '-1', '--format=%an <%ae>', `refs/heads/${record.branch}`).trim()).toBe(
      'Brandon Roberts <brandon@example.com>',
    );

    // Verify upstream edits + fork edits + binary file + executable mode bit + YAML comment preservation!
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:src/util.ts`)).toContain('VERSION = 3');
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:src/index.ts`)).toContain('howdy ${name}!');
    expect(gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:foo/nested.txt`)).toContain('updated upstream');
    const logoBytes = execFileSync('git', ['show', `refs/heads/${record.branch}:assets/logo.bin`], { cwd: fx.forkBare });
    expect([...logoBytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x07]);
    expect(gitIn(fx.forkBare, 'ls-tree', `refs/heads/${record.branch}`, 'scripts/run.sh')).toMatch(/^100755 blob /);

    const updatedGraftMd = gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:.grafts/upstream-sync/graft.md`);
    expect(updatedGraftMd).toContain(`0.0.0+${next}`);
    expect(updatedGraftMd).toContain('# keep this yaml comment');
    expect(updatedGraftMd).toContain('status: applied');
  });

  it('pushes to default branch and calls packagePublishExternalPush in publish mode (handling locked approval URL)', async () => {
    const fx = await setupCloudFixture();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream v2');
    const storage = createSqliteBucket();
    await upsertForkPolicy(storage, { forkKodyId: '@brandontroberts/my-tool', mode: 'publish' });

    const publishCalls: Array<{ kody_id?: string; package_id?: string }> = [];
    const record = await syncForkInCloud(fx.makeEvent(next), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      storage,
      publisher: {
        async publish(input) {
          publishCalls.push(input);
          return { status: 'locked', approval_url: 'https://kody.codes/@brandontroberts/my-tool/approve?commit=abc' };
        },
      },
    });

    expect(record.outcome, JSON.stringify(record)).toBe('green');
    expect(record.branch).toBe('main');
    expect(record.publishStatus).toBe('locked');
    expect(record.approvalUrl).toBe('https://kody.codes/@brandontroberts/my-tool/approve?commit=abc');
    expect(publishCalls).toEqual([{ package_id: 'pkg-1' }]);
    expect(() => gitIn(fx.forkBare, 'fsck', '--full', '--strict')).not.toThrow();
    expect(gitIn(fx.forkBare, 'show', 'refs/heads/main:src/util.ts')).toContain('VERSION = 2');
  });

  it('materializes conflict markers on graft/agent-<sha> with scoped diff reportMd on needs-agent', async () => {
    const fx = await setupCloudFixture();
    const conflicting = await fx.commitUpstream(
      { 'src/index.ts': 'export function greet(name: string) {\n  return `greetings ${name}`;\n}\n' },
      'upstream rewrote greet',
    );
    const storage = createSqliteBucket();

    const record = await syncForkInCloud(fx.makeEvent(conflicting), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      storage,
    });

    expect(record.outcome).toBe('needs-agent');
    expect(record.conflicts).toEqual(['src/index.ts']);
    expect(record.branch).toBe(`graft/agent-${conflicting.slice(0, 12)}`);
    expect(record.reportMd).toContain('Missed anchors:');
    expect(record.reportMd).toContain('Scoped upstream diff');

    expect(() => gitIn(fx.forkBare, 'fsck', '--full', '--strict')).not.toThrow();
    const agentFile = gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:src/index.ts`);
    expect(agentFile).toContain('<<<<<<<');
    expect(agentFile).toContain('greetings');
    expect(agentFile).toContain('howdy');
    expect(agentFile).toContain('>>>>>>>');
    const agentGraftMd = gitIn(fx.forkBare, 'show', `refs/heads/${record.branch}:.grafts/upstream-sync/graft.md`);
    expect(agentGraftMd).toContain('status: conflicted');
  });

  it('flags likely-upstreamed when upstream adopts the fork change', async () => {
    const fx = await setupCloudFixture();
    const adopted = await fx.commitUpstream(
      {
        'package.json': `${JSON.stringify({ name: '@brandontroberts/my-tool', description: 'Upstream helper tool', type: 'module', exports: { '.': './src/index.ts' } }, null, 2)}\n`,
        'src/index.ts': 'export function greet(name: string) {\n  return `howdy ${name}!`;\n}\n',
        'README.md': '# My Tool\n\n## Intent\n\nPersonalized helper.\n',
      },
      'upstream adopted all fork changes',
    );

    const record = await syncForkInCloud(fx.makeEvent(adopted), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
    });

    expect(record.outcome).toBe('needs-agent');
    expect(record.reasons.some((r) => /already contains this graft's change/i.test(r))).toBe(true);
    expect(record.reportMd).toContain('(likely upstreamed)');
  });

  it('catches upstream lines appended right against an EOF fork edit (touchesNewUpstreamLines)', async () => {
    const fx = await setupCloudFixture();
    // Fork edited the very last line of README.md (`Helper.` -> `Personalized helper.`), leaving no trailing context.
    const appended = await fx.commitUpstream(
      { 'README.md': '# My Tool\n\n## Intent\n\nHelper.\n\n## Extra section\n' },
      'upstream appended right after EOF hunk',
    );

    const record = await syncForkInCloud(fx.makeEvent(appended), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
    });

    expect(record.outcome).toBe('needs-agent');
    expect(record.reportMd).toContain('upstream added lines right after the change');
  });

  it('respects allowZeroConflictPackageJson (strict by default, clean 3-way merge when opted in)', async () => {
    const fx = await setupCloudFixture({ initialVersion: '1.0.0' });
    const bumped = await fx.commitUpstream(
      {
        'package.json': `${JSON.stringify(
          {
            name: '@origin/my-tool',
            description: 'Upstream helper tool',
            version: '1.1.0',
            type: 'module',
            exports: { '.': './src/index.ts' },
          },
          null,
          2,
        )}\n`,
      },
      'upstream version bump to 1.1.0',
    );

    const strictRun = await syncForkInCloud(fx.makeEvent(bumped, '1.1.0'), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        pushAgentBranch: false,
        allowZeroConflictPackageJson: false,
        updatedAt: '2026-11-25T00:00:00.000Z',
      },
    });
    expect(strictRun.outcome).toBe('needs-agent');

    const optInRun = await syncForkInCloud(fx.makeEvent(bumped, '1.1.0'), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        allowZeroConflictPackageJson: true,
        updatedAt: '2026-11-25T00:00:00.000Z',
      },
    });
    expect(optInRun.outcome, JSON.stringify(optInRun)).toBe('green');
    expect(optInRun.warnings).toContain('adopted zero-conflict package.json merge and re-verified with graft sync');
    const mergedPkg = JSON.parse(gitIn(fx.forkBare, 'show', `refs/heads/${optInRun.branch}:package.json`)) as {
      name: string;
      version: string;
    };
    expect(mergedPkg.name).toBe('@brandontroberts/my-tool');
    expect(mergedPkg.version).toBe('1.1.0');
  });

  it('fails loudly (outcome: error) on missing target commit, auth failure, or direct cloud call with testCommand', async () => {
    const fx = await setupCloudFixture();
    const missingSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    // Missing upstream commit -> error, no push.
    const missing = await syncForkInCloud(fx.makeEvent(missingSha), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
    });
    expect(missing.outcome).toBe('error');
    expect(missing.reasons.join(' ')).toMatch(/not found/i);

    // HTTP 401 auth failure -> error.
    const unauth = await syncForkInCloud(fx.makeEvent(fx.originCommit), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: 'Authorization: Bearer wrong_token',
        }),
      },
    });
    expect(unauth.outcome).toBe('error');
    expect(unauth.reasons.join(' ')).toContain('HTTP 401');

    // Policy with testCommand invoked directly in cloud -> fails loudly, never silently skips tests.
    const withTests = await syncForkInCloud(fx.makeEvent(fx.originCommit), {
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      policy: {
        forkKodyId: '@brandontroberts/my-tool',
        mode: 'branch',
        testCommand: 'npm test',
        updatedAt: '2026-11-25T00:00:00.000Z',
      },
    });
    expect(withTests.outcome).toBe('error');
    expect(withTests.reasons.join(' ')).toContain('testCommand');
  });

  it('routes cloud-default policies to syncForkInCloud and delegates testCommand/agentCommand policies to ./sync-on-context', async () => {
    const fx = await setupCloudFixture();
    const next = await fx.commitUpstream({ 'src/util.ts': 'export const VERSION = 2;\n' }, 'upstream v2');
    const storage = createSqliteBucket();

    // 1. Default policy -> executes directly in Kody Cloud.
    const scheduled: ContextWorkflowInput[] = [];
    const cloudRes = await routeUpstreamUpdatedEvent(fx.makeEvent(next), {
      storage,
      storageId: 'package:pkg-sync-fork',
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      scheduleContextWorkflow: async (input) => {
        scheduled.push(input);
        return { id: 'wf-1' };
      },
    });
    expect('delegated' in cloudRes).toBe(false);
    expect((cloudRes as SyncRunRecord).outcome).toBe('green');
    expect(scheduled).toHaveLength(0);

    // 2. Policy with testCommand + executionContext -> schedules ./sync-on-context workflow.
    await upsertForkPolicy(storage, {
      forkKodyId: '@brandontroberts/my-tool',
      mode: 'branch',
      testCommand: 'npm test',
      executionContext: 'my-dev-box',
    });
    const delegatedRes = await routeUpstreamUpdatedEvent(fx.makeEvent(next), {
      storage,
      storageId: 'package:pkg-sync-fork',
      gitRemote: {
        getGitRemote: async () => ({
          remote: `${fx.server.baseUrl}/fork.git`,
          git_extra_header: `Authorization: Bearer ${fx.forkToken}`,
        }),
      },
      scheduleContextWorkflow: async (input) => {
        scheduled.push(input);
        return { id: 'wf-ctx-42' };
      },
    });
    expect(delegatedRes).toEqual({
      delegated: true,
      workflowId: 'wf-ctx-42',
      forkKodyId: '@brandontroberts/my-tool',
      target: 'my-dev-box',
    });
    expect(scheduled[0]).toMatchObject({
      packageId: 'pkg-sync-fork',
      exportName: './sync-on-context',
      execution: { context: 'my-dev-box', whenOffline: 'queue', queueMinutes: 1440 },
    });

    // 3. Policy with testCommand when scheduling fails -> records outcome: 'error' loudly.
    const failedRes = await routeUpstreamUpdatedEvent(fx.makeEvent(next), {
      storage,
      storageId: 'package:pkg-sync-fork',
      scheduleContextWorkflow: async () => {
        throw new Error('no execution context connected');
      },
    });
    expect('delegated' in failedRes).toBe(false);
    expect((failedRes as SyncRunRecord).outcome).toBe('error');
    expect((failedRes as SyncRunRecord).reasons[0]).toContain('no execution context connected');
  });

  it('migrates legacy fork_policies SQLite schema additively without losing existing rows', async () => {
    const storage = createSqliteBucket();
    // Create pre-cloud table without `execution` or `execution_context` columns.
    await storage.sql(`
      CREATE TABLE fork_policies (
        fork_kody_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        test_command TEXT,
        agent_command TEXT,
        graft_command_json TEXT,
        workspace_root TEXT,
        kody_origin TEXT,
        push_agent_branch INTEGER NOT NULL DEFAULT 1,
        allow_zero_conflict_package_json INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    await storage.sql(`INSERT INTO fork_policies (fork_kody_id, mode, test_command, updated_at) VALUES (?, ?, ?, ?)`, [
      '@brandontroberts/legacy',
      'push',
      'npm test',
      '2026-11-24T00:00:00.000Z',
    ]);

    await ensureSchema(storage);
    const existing = await getForkPolicy(storage, '@brandontroberts/legacy');
    expect(existing).toMatchObject({ forkKodyId: '@brandontroberts/legacy', mode: 'push', testCommand: 'npm test' });

    const updated = await upsertForkPolicy(storage, {
      forkKodyId: '@brandontroberts/legacy',
      mode: 'publish',
      execution: 'context',
      executionContext: 'mac-mini',
      testCommand: 'npm test',
    });
    expect(updated.execution).toBe('context');
    expect(updated.executionContext).toBe('mac-mini');
    expect(await getForkPolicy(storage, '@brandontroberts/legacy')).toMatchObject({
      mode: 'publish',
      execution: 'context',
      executionContext: 'mac-mini',
    });
  });
});
