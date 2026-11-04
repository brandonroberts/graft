// Shared helpers for the *-esm dogfood checks (`pnpm test:grafts`). Each check verifies that an upstream package,
// as installed with its graft applied, loads as native ESM (no CommonJS) and behaves exactly
// like the pristine CommonJS release.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { assert };
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Start recording the format of every module loaded from the installed package. Must be
 * called before anything imports the package.
 */
export function trackFormats() {
  const formats = new Map();
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith('file:')) formats.set(fileURLToPath(url), result.format);
      return result;
    },
  });
  return formats;
}

/** A require() function resolving from the workspace package that declares the dependency. */
export function consumerRequire(workspacePackage) {
  return createRequire(path.join(repoRoot, workspacePackage, 'package.json'));
}

/** Directory of the installed package, as resolved by `require`. */
export function installedDir(require, pkg) {
  return path.dirname(require.resolve(`${pkg}/package.json`));
}

/** Pristine published copy of pkg@version (Graft's upstream cache), loadable with require(). */
export async function pristine(pkg, version) {
  const { NpmUpstreamSource } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/dist/index.js')).href);
  const source = new NpmUpstreamSource({ root: repoRoot, cacheDir: path.join(repoRoot, '.grafts/.cache') });
  const dir = await source.resolve(pkg, version);
  return { dir, require: createRequire(path.join(dir, 'package.json')) };
}

/** Assert that every JS module loaded from `dir` (excluding nested node_modules) was ESM. */
export function assertNoCommonJS(formats, dir) {
  const loaded = [...formats].filter(([file]) => file.startsWith(dir + path.sep) && !file.slice(dir.length).includes(`${path.sep}node_modules${path.sep}`));
  assert.ok(loaded.length > 0, `no modules were loaded from ${dir}`);
  const cjs = loaded.filter(([, format]) => format !== 'module' && format !== 'json').map(([file, format]) => `${path.relative(dir, file)} (${format})`);
  assert.deepEqual(cjs, [], `loaded as non-ESM: ${cjs.join(', ')}`);
  return loaded.length;
}

/** Normalize a value for differential comparison (stable across class identities). */
export function snapshot(fn) {
  try {
    return { ok: normalize(fn()) };
  } catch (err) {
    return { threw: `${err?.constructor?.name}: ${err?.message}` };
  }
}

function normalize(value, seen = new Set()) {
  if (value === undefined) return '<undefined>';
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? `<fn ${value.name}>` : value;
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  if (Buffer.isBuffer(value)) return { '<Buffer>': value.toString('base64') };
  if (value instanceof Uint8Array) return { '<Uint8Array>': Buffer.from(value).toString('base64') };
  if (value instanceof Map) return { '<Map>': [...value].map(([k, v]) => [normalize(k, seen), normalize(v, seen)]) };
  if (value instanceof Set) return { '<Set>': [...value].map((v) => normalize(v, seen)) };
  if (value instanceof Date) return { '<Date>': value.toISOString() };
  if (Array.isArray(value)) return value.map((v) => normalize(v, seen));
  const out = { '<class>': value.constructor?.name };
  for (const key of Object.keys(value)) out[key] = normalize(value[key], seen);
  return out;
}

/** Compare `actual` vs `expected` snapshots over a corpus; returns mismatch descriptions. */
export function differential(cases) {
  const mismatches = [];
  for (const [label, actual, expected] of cases) {
    const a = JSON.stringify(snapshot(actual));
    const e = JSON.stringify(snapshot(expected));
    if (a !== e) mismatches.push(`${label}\n      esm:      ${a.slice(0, 300)}\n      pristine: ${e.slice(0, 300)}`);
  }
  return mismatches;
}

/** Run named checks; print results; exit non-zero if any failed. */
export async function run(name, checks) {
  let failed = 0;
  for (const [label, fn] of checks) {
    try {
      const note = await fn();
      console.log(`  ✓ ${label}${note ? ` (${note})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${label}\n    ${String(err.message).split('\n').join('\n    ')}`);
    }
  }
  console.log(`[check:${name}] mode=${process.env.GRAFT_MODE ?? '-'}: ${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
}
