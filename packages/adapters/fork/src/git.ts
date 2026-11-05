// Minimal git plumbing for the fork mechanism. Everything runs in a cache clone per graft under
// .grafts/.cache/fork/<id>/, with two remotes: `fork` (the modification) and `upstream`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { GraftError } from '@graftsync/core';

const semverValid = (v: string) => semver.valid(v) !== null;
const semverCompare = (a: string, b: string) => semver.compare(a, b);

export async function git(
  cwd: string,
  args: string[],
  options: { allowFail?: boolean; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env } }, (err, stdout, stderr) => {
      if (err && !options.allowFail) {
        reject(new GraftError(`git ${args.join(' ')} failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`, 'fork/git'));
        return;
      }
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Fetch both remotes at most once per process per cache dir (agents and sync call this repeatedly). */
const fetched = new Map<string, Promise<void>>();

/** Ensure the cache clone exists with `fork` and `upstream` remotes, fetched (tags + branches). */
export async function ensureRepo(dir: string, forkUrl: string, upstreamUrl: string): Promise<void> {
  const key = `${dir}\n${forkUrl}\n${upstreamUrl}`;
  if (!fetched.has(key)) {
    fetched.set(
      key,
      (async () => {
        if (!existsSync(path.join(dir, '.git'))) {
          await mkdir(dir, { recursive: true });
          await git(dir, ['init', '--quiet']);
        }
        for (const [name, url] of [['fork', forkUrl], ['upstream', upstreamUrl]] as const) {
          await refusePartialClone(name, url);
          const has = await git(dir, ['remote', 'get-url', name], { allowFail: true });
          if (!has.ok) await git(dir, ['remote', 'add', name, url]);
          else if (has.stdout.trim() !== url) await git(dir, ['remote', 'set-url', name, url]);
        }
        await git(dir, ['fetch', '--quiet', '--tags', '--force', 'upstream']);
        await git(dir, ['fetch', '--quiet', '--force', 'fork', '+refs/heads/*:refs/remotes/fork/*', '+refs/tags/*:refs/fork-tags/*']);
      })().catch((err) => {
        fetched.delete(key);
        throw err;
      }),
    );
  }
  return fetched.get(key);
}

/**
 * A local repository that is a partial clone (`--filter=blob:none`) lacks objects, and git can't
 * fetch everything from it: it fails with "possible repository corruption on the remote side".
 * Say what it is instead. (A shallow clone is fine.)
 */
async function refusePartialClone(name: string, url: string): Promise<void> {
  if (!path.isAbsolute(url) || !existsSync(url)) return;
  // `extensions.partialClone` names the promisor remote; git also marks it `remote.<name>.promisor`
  // (the only mark older clones carry).
  const ext = (await git(url, ['config', '--get', 'extensions.partialClone'], { allowFail: true })).stdout.trim();
  const marked = (await git(url, ['config', '--bool', '--get-regexp', '^remote\\..*\\.promisor$'], { allowFail: true })).stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, v]) => v === 'true')?.[0]
    ?.replace(/^remote\.|\.promisor$/g, '');
  const promisor = ext || marked;
  if (!promisor) return;
  const filter = (await git(url, ['config', '--get', `remote.${promisor}.partialCloneFilter`], { allowFail: true })).stdout.trim();
  throw new GraftError(
    `the ${name} repository ${url} is a partial clone${filter ? ` (--filter=${filter})` : ''}, so it is missing objects the cache clone needs, and git can't fetch them from it. Use a full clone (a shallow one is fine): with actions/checkout, drop \`filter\``,
    'fork/partial-clone',
  );
}

/** Forget fetch state (tests, or after the fork was updated). */
export function resetFetchCache(): void {
  fetched.clear();
}

/** Resolve a commit for a fork ref (branch on the fork, fork tag, or any sha/ref). */
export async function resolveForkRef(dir: string, ref: string): Promise<string | undefined> {
  for (const candidate of [`refs/remotes/fork/${ref}`, `refs/fork-tags/${ref}`, ref]) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFail: true });
    if (r.ok && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

/** Resolve any upstream ref (tag, branch, or commit) to a commit, or undefined. */
export async function resolveUpstreamRef(dir: string, ref: string): Promise<string | undefined> {
  for (const candidate of [`refs/tags/${ref}`, `refs/remotes/upstream/${ref}`, ref]) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFail: true });
    if (r.ok && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

/** Resolve an upstream tag to a commit, or undefined. */
export async function resolveTag(dir: string, tag: string): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Contents of `file` at commit `rev`, or undefined if it doesn't exist there. */
export async function showFile(dir: string, rev: string, file: string): Promise<string | undefined> {
  const r = await git(dir, ['show', `${rev}:${file}`], { allowFail: true });
  return r.ok ? r.stdout : undefined;
}

/** Unified diff between two commits, limited to `sub` and with paths relative to it. */
export async function diff(dir: string, from: string, to: string, sub?: string): Promise<string> {
  // `.grafts/` is excluded: a fork may carry its own graft definitions (repo mode).
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--full-index', from, to, '--', '.', ':(top,exclude).grafts'];
  if (sub) args.splice(1, 0, `--relative=${sub}`);
  return (await git(dir, args)).stdout;
}

/** Commit everything in worktree `wt` on top of its HEAD and point `branch` (in the cache clone) at it. */
export async function commitTo(wt: string, branch: string, message: string): Promise<string> {
  await git(wt, ['add', '-A']);
  await git(wt, ['-c', 'user.name=graft', '-c', 'user.email=graft@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message]);
  const sha = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(wt, ['branch', '--force', branch, sha]);
  return sha;
}

/** Check out `rev` into a fresh temporary directory (a detached worktree). */
export async function checkout(dir: string, rev: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-fork-'));
  const wt = path.join(tmp, 'src');
  await git(dir, ['worktree', 'add', '--quiet', '--detach', '--force', wt, rev]);
  return {
    path: wt,
    dispose: async () => {
      await git(dir, ['worktree', 'remove', '--force', wt], { allowFail: true });
      await rm(tmp, { recursive: true, force: true });
      await git(dir, ['worktree', 'prune'], { allowFail: true });
    },
  };
}

/** Files whose change between two commits is binary (no text hunks), limited to `sub`. */
export async function binaryChanges(dir: string, from: string, to: string, sub?: string): Promise<string[]> {
  const args = ['diff', '--numstat', '--no-renames', '-z', from, to, '--', '.', ':(top,exclude).grafts'];
  if (sub) args.splice(1, 0, `--relative=${sub}`);
  const out = (await git(dir, args)).stdout;
  return out
    .split('\0')
    .filter((entry) => entry.startsWith('-\t-\t'))
    .map((entry) => entry.slice(4));
}

/** Object id of `file` at `rev`, or undefined when it doesn't exist there. */
export async function blobId(dir: string, rev: string, file: string): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`], { allowFail: true });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Raw bytes of `file` at `rev`. */
export async function readBlob(dir: string, rev: string, file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['show', `${rev}:${file}`], { cwd: dir, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new GraftError(`git show ${rev}:${file} failed: ${err.message}`, 'fork/git'));
      else resolve(stdout);
    });
  });
}

/** Files whose executable bit the fork sets or clears (including files it creates executable). */
export async function modeChanges(dir: string, from: string, to: string, sub?: string): Promise<{ file: string; executable: boolean }[]> {
  const args = ['diff', '--raw', '--no-renames', '-z', from, to, '--', '.', ':(top,exclude).grafts'];
  if (sub) args.splice(1, 0, `--relative=${sub}`);
  const parts = (await git(dir, args)).stdout.split('\0');
  const out: { file: string; executable: boolean }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , , status] = parts[i]!.replace(/^:/, '').split(' ');
    const file = parts[i + 1]!;
    if (status === 'D' || !newMode || !/^100(644|755)$/.test(newMode)) continue;
    if (newMode !== oldMode && (status !== 'A' || newMode === '100755')) out.push({ file, executable: newMode === '100755' });
  }
  return out;
}

const IDENTITY = ['-c', 'user.name=graft', '-c', 'user.email=graft@localhost'];

/**
 * git's own three-way merge of `theirs` onto `ours` with `base` as the merge base (a rebase of
 * the change base..theirs onto ours), written as a commit on top of `ours` and pointed at by
 * `branch`. Conflicting files keep git's conflict markers. Returns the conflicted paths.
 */
export async function mergeToBranch(dir: string, base: string, ours: string, theirs: string, branch: string, message: string): Promise<string[]> {
  const r = await git(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs], { allowFail: true });
  const [tree, ...rest] = r.stdout.split('\n');
  if (!tree || !/^[0-9a-f]{40,64}$/.test(tree.trim())) throw new GraftError(`git merge-tree failed: ${r.stderr.trim() || r.stdout.trim()}`, 'fork/git');
  const conflicted = r.ok ? [] : [...new Set(rest.map((l) => l.trim()).filter(Boolean))];
  const full = conflicted.length ? `${message}\n\nConflicts (git markers left in place):\n${conflicted.map((f) => `- ${f}`).join('\n')}\n` : message;
  const commit = (await git(dir, [...IDENTITY, 'commit-tree', tree.trim(), '-p', ours, '-m', full])).stdout.trim();
  await git(dir, ['update-ref', `refs/heads/${branch}`, commit]);
  return conflicted;
}

/**
 * Replace `prefix/` in the tip commit of `branch` with the files of `srcDir` (amending it, same
 * parent and message). Used to carry the graft's own `.grafts/` into a repo-mode result.
 */
export async function replaceSubtree(dir: string, branch: string, prefix: string, files: { rel: string; abs: string; executable: boolean }[]): Promise<void> {
  const index = path.join(await mkdtemp(path.join(os.tmpdir(), 'graft-index-')), 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', `refs/heads/${branch}`], { env });
    await git(dir, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', prefix], { env });
    for (const f of files) {
      const oid = (await git(dir, ['hash-object', '-w', '--', f.abs])).stdout.trim();
      await git(dir, ['update-index', '--add', '--cacheinfo', `${f.executable ? '100755' : '100644'},${oid},${prefix}/${f.rel}`], { env });
    }
    const tree = (await git(dir, ['write-tree'], { env })).stdout.trim();
    const parent = (await git(dir, ['rev-parse', `refs/heads/${branch}^`])).stdout.trim();
    const message = (await git(dir, ['log', '-1', '--format=%B', `refs/heads/${branch}`])).stdout;
    const commit = (await git(dir, [...IDENTITY, 'commit-tree', tree, '-p', parent, '-m', message.trimEnd()])).stdout.trim();
    await git(dir, ['update-ref', `refs/heads/${branch}`, commit]);
  } finally {
    await rm(path.dirname(index), { recursive: true, force: true });
  }
}

/** Versions of the upstream tags matching `pattern` (e.g. `v{version}`), ascending. */
export async function upstreamTags(dir: string, pattern: string): Promise<string[]> {
  const [prefix, suffix] = pattern.split('{version}') as [string, string];
  const out = (await git(dir, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'])).stdout.split('\n');
  const versions = out
    .filter((t) => t.startsWith(prefix) && t.endsWith(suffix) && t.length > prefix.length + suffix.length)
    .map((t) => t.slice(prefix.length, t.length - suffix.length))
    .filter((v) => semverValid(v));
  return versions.sort(semverCompare);
}
