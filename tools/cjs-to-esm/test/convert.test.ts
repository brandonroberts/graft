import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs tooling module without type declarations
import { convertFile, exportKeys, lazyEdges, requireEdges } from '../convert.mjs';

/** Write a CommonJS package, convert it, and return a function that runs code against the result. */
function convertPackage(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cjs-to-esm-'));
  const src = path.join(root, 'src');
  const out = path.join(root, 'out');
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    writeFileSync(path.join(src, rel), code);
  }
  const js = Object.keys(files).filter((f) => f.endsWith('.js'));
  const graph = new Map(js.map((f) => [path.join(src, f), requireEdges(path.join(src, f), files[f])]));
  const lazy = lazyEdges(graph);
  const keyCache = new Map();
  if (!files['package.json']) writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    const converted = rel.endsWith('.js')
      ? convertFile(path.join(src, rel), code, { keyCache, lazy: lazy.get(path.join(src, rel)) })
      : code;
    writeFileSync(path.join(out, rel), converted);
  }
  writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'pkg', type: 'module', version: '1.0.0' }));
  return { out, run: runner(root), lazy };
}

function runner(root: string) {
  return (code: string, ext = 'mjs') => {
    const file = path.join(root, `run.${ext}`);
    writeFileSync(file, code);
    return execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim();
  };
}

describe('cjs-to-esm', () => {
  it('keeps the module.exports value as default, named, and require(esm) result', () => {
    const { run } = convertPackage({
      'index.js': "const add = require('./add')\nmodule.exports = { add, twice: (n) => add(n, n) }\n",
      'add.js': 'module.exports = (a, b) => a + b\n',
    });
    expect(run("import d, { add, twice } from './out/index.js'\nconsole.log(d.add === add, twice(2))")).toBe('true 4');
    expect(run("const m = require('./out/index.js'); const add = require('./out/add.js'); console.log(m.twice(3), add(1, 2))", 'cjs')).toBe(
      '6 3',
    );
  });

  it('finds exports assigned anywhere, including nested `exports.x =` initializers', () => {
    const { out } = convertPackage({
      'index.js':
        "exports = module.exports = {}\nconst re = exports.re = []\nexports.t = {}\nObject.defineProperty(exports, 'x', { value: 1 })\n",
    });
    expect([...exportKeys(path.join(out, '..', 'src', 'index.js'))].sort()).toEqual(['re', 't', 'x']);
  });

  it('turns cyclic export-then-require edges into lazy requires (base class + subclasses)', () => {
    const { run, lazy } = convertPackage({
      'index.js': "const Base = require('./base')\nrequire('./sub')\nmodule.exports = Base\n",
      'base.js': "class Base { static make () { return new Sub() } }\nmodule.exports = Base\nconst Sub = require('./sub')\n",
      'sub.js': "const Base = require('./base')\nclass Sub extends Base {}\nmodule.exports = Sub\n",
    });
    expect([...lazy.values()].map((s) => [...s])).toEqual([['./sub']]);
    expect(run("import Base from './out/index.js'\nconst s = Base.make(); console.log(s.constructor.name, s instanceof Base)")).toBe(
      'Sub true',
    );
  });

  it('leaves requires of other packages as require() (no dual-package hazard)', () => {
    const { out } = convertPackage({ 'x.js': "const { EventEmitter } = require('events')\nmodule.exports = new EventEmitter()\n" });
    const converted = readFileSync(path.join(out, 'x.js'), 'utf8');
    expect(converted).toContain("const { EventEmitter } = require('events')");
    expect(converted).toContain('createRequire(import.meta.url)');
  });

  it('refuses to defer a cyclic binding that is used while the module loads', () => {
    expect(() =>
      convertPackage({
        'a.js': "module.exports = {}\nconst b = require('./b')\nconsole.log(b)\n",
        'b.js': "const a = require('./a')\nmodule.exports = { a }\n",
      }),
    ).toThrow(/used while the module loads/);
  });

  it('rewrites require.main and JSON requires', () => {
    const { run, out } = convertPackage({
      'cli.js':
        "#!/usr/bin/env node\nconst { version } = require('./package.json')\nif (module === require.main) console.log('main', version)\nmodule.exports = version\n",
    });
    expect(readFileSync(path.join(out, 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(execFileSync(process.execPath, [path.join(out, 'cli.js')], { encoding: 'utf8' }).trim()).toBe('main 1.0.0');
    expect(run("import v from './out/cli.js'\nconsole.log(v)")).toBe('1.0.0');
  });
});
