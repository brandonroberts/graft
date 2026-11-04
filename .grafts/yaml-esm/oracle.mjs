// Oracle for graft "yaml-esm": yaml's Node build loads as native ESM and behaves exactly like
// the pristine CommonJS dist/ build.
import { assert, assertNoCommonJS, consumerRequire, differential, installedDir, pristine, run, trackFormats } from '../.shared/oracle.mjs';

const formats = trackFormats();
const mode = process.env.GRAFT_MODE ?? 'esm';
const require = consumerRequire('packages/spec');
const dir = installedDir(require, 'yaml');
const { version } = require('yaml/package.json');
if (process.env.GRAFT_UPSTREAM_VERSION) assert.equal(version, process.env.GRAFT_UPSTREAM_VERSION);

const pristineCopy = await pristine('yaml', version);
const ref = pristineCopy.require('./dist/index.js');
const refUtil = pristineCopy.require('./dist/util.js');
let YAML;
let util;
if (mode === 'cjs') {
  YAML = require('yaml');
  util = require('yaml/util');
} else {
  const ns = await import(require.resolve('yaml'));
  YAML = ns.default;
  util = await import(require.resolve('yaml/util'));
  for (const key of Object.keys(ref)) assert.equal(ns[key], YAML[key], `named export ${key} !== default.${key}`);
}

const DOCS = [
  'a: 1\nb: [1, 2, {c: d}]\n',
  '# comment\nkey: value # trailing\n---\nsecond: doc\n...\n',
  'anchors:\n  base: &base { x: 1, y: 2 }\n  derived:\n    <<: *base\n    y: 3\n',
  '%YAML 1.1\n---\nbin: !!binary aGVsbG8gd29ybGQ=\nset: !!set { a, b }\nomap: !!omap [ {a: 1}, {b: 2} ]\nbool: yes\noct: 0777\ntime: 2001-12-14t21:59:43.10-05:00\n',
  'bin: !!binary |\n  R0lGODlhDAAMAIQAAP//9/X17unp5WZmZgAAAOfn515eXvPz7Y6OjuDg4J+fn5\n',
  'str: |\n  literal\n  block\nfolded: >-\n  folded\n  text\nquoted: "esc\\taped"\nsingle: \'it\'\'s\'\n',
  'num: [0x1F, 1e3, .inf, -.Inf, .nan, 1_000]\nnulls: [~, null, Null, ]\n',
  '? complex key\n: complex value\n[a, b]: flow key\n',
  'bad: [unclosed\nindent:\n - a\n  - b\n',
  'dup: 1\ndup: 2\n',
  'tag: !custom value\nref: *missing\n',
  '- a\n- - nested\n  - seq\n- {k: v}\n',
  '',
];
const VALUES = [{ a: 1, b: [true, null, 'x'] }, [1, 'two', { three: 3 }], 'multi\nline\nstring', new Map([['k', 1]]), new Set(['a']), Buffer.from('bytes'), { date: new Date(0) }, 3.14, null];

function* cases() {
  for (const src of DOCS) {
    const s = JSON.stringify(src).slice(0, 40);
    for (const opts of [undefined, { version: '1.1' }, { merge: true }, { prettyErrors: false, uniqueKeys: false }]) {
      const o = JSON.stringify(opts);
      yield [`parse ${s} ${o}`, () => YAML.parse(src, opts), () => ref.parse(src, opts)];
      yield [`parseAllDocuments ${s} ${o}`, () => YAML.parseAllDocuments(src, opts).map((d) => [String(d), d.errors.map((e) => [e.code, e.message]), d.warnings.map((w) => [w.code, w.message]), d.toJS()]), () => ref.parseAllDocuments(src, opts).map((d) => [String(d), d.errors.map((e) => [e.code, e.message]), d.warnings.map((w) => [w.code, w.message]), d.toJS()])];
    }
    yield [`binary is Buffer ${s}`, () => { const v = YAML.parse(src, { version: '1.1' }); return v && typeof v === 'object' ? Object.values(v).map((x) => Buffer.isBuffer(x)) : null; }, () => { const v = ref.parse(src, { version: '1.1' }); return v && typeof v === 'object' ? Object.values(v).map((x) => Buffer.isBuffer(x)) : null; }];
    yield [`lexer ${s}`, () => [...new YAML.Lexer().lex(src)], () => [...new ref.Lexer().lex(src)]];
    yield [`parser ${s}`, () => [...new YAML.Parser().parse(src)].map((t) => YAML.CST.stringify(t)), () => [...new ref.Parser().parse(src)].map((t) => ref.CST.stringify(t))];
    yield [`visit ${s}`, () => { const out = []; YAML.visit(YAML.parseDocument(src), { Scalar: (k, n) => { out.push([k, n.value]); } }); return out; }, () => { const out = []; ref.visit(ref.parseDocument(src), { Scalar: (k, n) => { out.push([k, n.value]); } }); return out; }];
  }
  for (const value of VALUES) {
    for (const opts of [undefined, { indent: 4 }, { defaultStringType: 'QUOTE_DOUBLE' }, { version: '1.1' }]) {
      yield [`stringify ${String(value).slice(0, 20)} ${JSON.stringify(opts)}`, () => YAML.stringify(value, opts), () => ref.stringify(value, opts)];
    }
  }
  yield ['util.stringifyString', () => util.stringifyString(new YAML.Scalar('x\ny'), { options: {} }), () => refUtil.stringifyString(new ref.Scalar('x\ny'), { options: {} })];
}

await run('yaml-esm', [
  ['same public API as the pristine release', () => {
    assert.deepEqual(Object.keys(YAML).sort(), Object.keys(ref).sort());
    assert.deepEqual(Object.keys(util).filter((k) => k !== 'default' && k !== 'module.exports').sort(), Object.keys(refUtil).sort());
  }],
  ['behaves identically to pristine yaml', () => {
    const all = [...cases()];
    const mismatches = differential(all);
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} mismatches`);
    return `${all.length} cases`;
  }],
  ['warnings still go through process.emitWarning', () => {
    const seen = [];
    const original = process.emitWarning;
    process.emitWarning = (w) => seen.push(String(w));
    try {
      YAML.parse('a: !!nope x', { logLevel: 'warn' });
    } finally {
      process.emitWarning = original;
    }
    assert.ok(seen.length > 0, 'expected a warning via process.emitWarning');
  }],
  ['nothing from yaml loaded as CommonJS', () => `${assertNoCommonJS(formats, dir)} modules, all ESM`],
]);
