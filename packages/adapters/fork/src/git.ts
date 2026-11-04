// Minimal git plumbing for the fork mechanism. Everything runs in a cache clone per graft under
// .grafts/.cache/fork/<id>/, with two remotes: `fork` (the modification) and `upstream`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraftError } from '@graftsync/core';

export async function git(cwd: string, args: string[], options: { allowFail?: boolean } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
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
