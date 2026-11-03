// Oracle for graft "pacote-esm-named-exports". Exits 0 only if every invariant in
// graft.md holds for the pacote installed in packages/core (the package that depends on it).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const consumer = new URL('../../packages/core/package.json', import.meta.url);
const require = createRequire(consumer);
const mode = process.env.GRAFT_MODE ?? 'esm';
const expected = process.env.GRAFT_UPSTREAM_VERSION;

const { version } = require('pacote/package.json');
if (expected) assert.equal(version, expected, `installed pacote@${version}, oracle asked to verify ${expected}`);

const cjs = require('pacote');
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

if (mode === 'cjs') {
  check('require exposes the public API', () => {
    for (const key of ['GitFetcher', 'RegistryFetcher', 'FileFetcher', 'DirFetcher', 'RemoteFetcher', 'resolve', 'extract', 'manifest', 'packument', 'tarball']) {
      assert.ok(key in cjs, `require('pacote').${key} missing`);
    }
    assert.equal(typeof cjs.tarball.stream, 'function');
    assert.equal(typeof cjs.tarball.file, 'function');
  });
  check('deep requires keep working', () => {
    assert.equal(typeof require('pacote/lib/fetcher.js').get, 'function');
  });
  check('manifest works via require', async () => {
    const dir = fileURLToPath(new URL('../../packages/spec', import.meta.url));
    assert.equal((await cjs.manifest(`file:${dir}`)).name, '@graft/spec');
  });
} else {
  const ns = await import(pathToFileURL(require.resolve('pacote')).href);
  check('every CommonJS key is a named ESM export', () => {
    const missing = Object.keys(cjs).filter((k) => !(k in ns) || ns[k] === undefined);
    assert.deepEqual(missing, [], `not exposed as named exports: ${missing.join(', ')}`);
  });
  check('named exports are identical to CommonJS values', () => {
    for (const k of Object.keys(cjs)) assert.equal(ns[k], cjs[k], `ns.${k} !== require('pacote').${k}`);
    assert.equal(ns.default, cjs);
  });
  check('named manifest() works', async () => {
    const dir = fileURLToPath(new URL('../../packages/spec', import.meta.url));
    assert.equal((await ns.manifest(`file:${dir}`)).name, '@graft/spec');
  });
}

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(`[oracle:pacote-esm-named-exports] pacote@${version} mode=${mode}: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
