// Check for graft "pacote-esm" (run by `pnpm test:grafts`): pacote's own modules load as native ESM, with working named
// exports, and the API still works end to end.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { assert, assertNoCommonJS, consumerRequire, installedDir, repoRoot, run, trackFormats } from '../.shared/check.mjs';

const formats = trackFormats();
const mode = process.env.GRAFT_MODE ?? 'esm';
const require = consumerRequire('.');
const dir = installedDir(require, 'pacote');
const { version } = require('pacote/package.json');
if (process.env.GRAFT_UPSTREAM_VERSION) assert.equal(version, process.env.GRAFT_UPSTREAM_VERSION);

const API = ['GitFetcher', 'RegistryFetcher', 'FileFetcher', 'DirFetcher', 'RemoteFetcher', 'resolve', 'extract', 'manifest', 'packument', 'tarball'];
const cjs = require('pacote');
let pacote = cjs;
if (mode === 'esm') {
  const ns = await import(require.resolve('pacote'));
  pacote = ns;
  for (const key of API) {
    assert.notEqual(ns[key], undefined, `named export ${key} is undefined`);
    assert.equal(ns[key], ns.default[key], `named ${key} !== default.${key}`);
    assert.equal(ns[key], cjs[key], `named ${key} !== require('pacote').${key}`);
  }
}
const local = path.join(repoRoot, 'packages/spec');
// Directory specs need an Arborist constructor (pacote's own requirement), so extract/tarball
// use a local tarball built with pacote's own `tar` dependency.
const work = mkdtempSync(path.join(os.tmpdir(), 'pacote-check-'));
const tgz = path.join(work, 'spec.tgz');
createRequire(path.join(dir, 'package.json'))('tar').c({ gzip: true, file: tgz, cwd: local, prefix: 'package', sync: true }, ['package.json']);
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

await run('pacote-esm', [
  ['public API intact', () => {
    for (const key of API) assert.ok(key in pacote, `${key} missing`);
    assert.equal(typeof pacote.tarball.stream, 'function');
    assert.equal(typeof pacote.tarball.file, 'function');
  }],
  ['deep requires keep working', () => assert.equal(typeof require('pacote/lib/fetcher.js').get, 'function')],
  ['manifest(file:) works', async () => assert.equal((await pacote.manifest(`file:${local}`)).name, '@graftsync/spec')],
  ['extract(file:.tgz) writes the package', async () => {
    const dest = path.join(work, 'out');
    const result = await pacote.extract(`file:${tgz}`, dest);
    assert.deepEqual(readdirSync(dest), ['package.json']);
    assert.match(result.integrity, /^sha512-/);
  }],
  ['tarball(file:.tgz) integrity matches manifest', async () => {
    const data = await pacote.tarball(`file:${tgz}`);
    assert.ok(Buffer.isBuffer(data) && data.length > 0);
    assert.equal(String(data.integrity), (await pacote.manifest(`file:${tgz}`))._integrity);
  }],
  ['the pacote CLI still runs as a program', () => {
    const out = execFileSync(process.execPath, [path.join(dir, 'bin/index.js'), 'manifest', `file:${local}`], { encoding: 'utf8' });
    assert.match(out, /@graftsync\/spec/);
  }],
  ['nothing from pacote loaded as CommonJS', () => `${assertNoCommonJS(formats, dir)} modules, all ESM`],
]);
