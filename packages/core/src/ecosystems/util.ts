// Helpers shared by the ecosystems: running a tool, fetching an index over HTTPS, caching pristine
// packages atomically, and channel-style dist-tags for registries that have none.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { VersionScheme } from '@graftsync/spec';
import { GraftError } from '../errors.js';

export interface ToolResult {
  stdout: string;
  stderr: string;
}

/** Run `cmd args` (no shell). Throws `code` with the tool's own message on failure. */
export async function tool(
  cmd: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; code?: string; timeoutMs?: number },
): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await promisify(execFile)(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 256 * 1024 * 1024,
      timeout: options.timeoutMs ?? 10 * 60_000,
      shell: process.platform === 'win32',
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') throw new GraftError(`${cmd} was not found on PATH`, options.code ?? 'tool/missing', { cause: err });
    const detail = (e.stderr || e.stdout || e.message).trim().split('\n').slice(-12).join('\n');
    throw new GraftError(`\`${[cmd, ...args].join(' ')}\` failed:\n${detail}`, options.code ?? 'tool/failed', { cause: err });
  }
}

/** GET a URL as text (through the environment's proxy settings, as Node's fetch does). */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'graft (https://github.com/brandonroberts/graft)' } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Fill `dest` once, atomically: `fill(tmp)` writes into a temp directory that is renamed into place
 * only when it succeeds and `marker` exists in it. A failure leaves no partial cache entry.
 */
export async function cacheDir(
  dest: string,
  marker: string,
  fill: (tmp: string) => Promise<void>,
  code = 'upstream/fetch',
): Promise<string> {
  if (existsSync(path.join(dest, marker))) return dest;
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(tmp, { recursive: true });
    await fill(tmp);
    if (!existsSync(path.join(tmp, marker))) throw new Error(`the package has no ${marker}`);
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err instanceof GraftError ? err : new GraftError((err as Error).message, code, { cause: err });
  }
  return dest;
}

/**
 * Registries without dist-tags: `latest` is the newest stable version, `next` the newest
 * prerelease when it is newer than `latest`.
 */
export function channelTags(versions: string[], scheme: VersionScheme): Record<string, string> {
  const sorted = versions.filter((v) => scheme.valid(v)).sort(scheme.compare);
  const stable = sorted.filter((v) => !scheme.isPrerelease(v));
  const tags: Record<string, string> = {};
  if (stable.length) tags.latest = stable.at(-1)!;
  const newest = sorted.at(-1);
  if (newest && scheme.isPrerelease(newest)) tags.next = newest;
  return tags;
}

export const posixPath = (p: string) => p.split(path.sep).join('/');
