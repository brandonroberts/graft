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
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--full-index', from, to];
  if (sub) args.splice(1, 0, `--relative=${sub}`);
  return (await git(dir, args)).stdout;
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
