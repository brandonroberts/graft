#!/usr/bin/env node
// Build a patch variant that converts a published CommonJS package to native ESM.
//
//   node tools/cjs-to-esm/make-variant.mjs <package> <version> <out.patch>
//
// Reads the pristine published package (via Graft's upstream cache), converts every .js file
// with convert.mjs, marks the package `"type": "module"`, and writes a git-style patch that
// pnpm can apply through patchedDependencies.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { NpmUpstreamSource } from '@graftsync/core';
import { convertFile, lazyEdges, requireEdges } from './convert.mjs';

const [pkg, version, out] = process.argv.slice(2);
if (!pkg || !version || !out) {
  console.error('usage: make-variant.mjs <package> <version> <out.patch>');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '../..');
const upstream = new NpmUpstreamSource({ root, cacheDir: path.join(root, '.grafts/.cache') });
const dir = await upstream.resolve(pkg, version);

async function files(rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...(await files(child)));
    } else out.push(child);
  }
  return out.sort();
}

const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
if (manifest.type === 'module') throw new Error(`${pkg}@${version} is already "type": "module"`);

// Files in a subtree with its own {"type":"module"} package.json are already ESM.
const all = await files();
const esmScopes = [];
for (const f of all.filter((f) => f.endsWith('/package.json'))) {
  const scope = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
  if (scope.type === 'module') esmScopes.push(`${path.posix.dirname(f)}/`);
}

const keyCache = new Map();
const patches = [];
const diffFile = (file, before, after) =>
  `diff --git a/${file} b/${file}\n` +
  createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, '', '', { context: 3 })
    .replace(/^Index:.*\n=+\n/m, '')
    .replace(/\t$/gm, '');

const toConvert = all.filter((f) => f.endsWith('.js') && !esmScopes.some((s) => f.startsWith(s)));
const sources = new Map();
for (const file of toConvert) sources.set(file, await readFile(path.join(dir, file), 'utf8'));
const graph = new Map(toConvert.map((f) => [path.join(dir, f), requireEdges(path.join(dir, f), sources.get(f))]));
const lazy = lazyEdges(graph);
for (const [file, specs] of lazy) console.log(`  lazy (cyclic export-then-require): ${path.relative(dir, file)} -> ${[...specs].join(', ')}`);

let converted = 0;
for (const file of toConvert) {
  const code = sources.get(file);
  patches.push(diffFile(file, code, convertFile(path.join(dir, file), code, { keyCache, lazy: lazy.get(path.join(dir, file)) })));
  converted++;
}

// Mark the package as ESM. Insert next to stable keys so the hunk's context never includes
// the "version" line (which changes on every release).
const pjText = await readFile(path.join(dir, 'package.json'), 'utf8');
let pjNext;
if (/^ {2}"type": "commonjs",$/m.test(pjText)) {
  pjNext = pjText.replace(/^ {2}"type": "commonjs",$/m, '  "type": "module",');
} else if (/^ {2}"files": \[$/m.test(pjText)) {
  pjNext = pjText.replace(/^ {2}"files": \[$/m, '  "type": "module",\n  "files": [');
} else {
  throw new Error('package.json has neither "type" nor "files" to anchor the "type": "module" insertion');
}
patches.unshift(diffFile('package.json', pjText, pjNext));

await mkdir(path.dirname(path.resolve(out)), { recursive: true });
await writeFile(out, patches.join(''));
console.log(`${pkg}@${version}: converted ${converted} files → ${out}`);
