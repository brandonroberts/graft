// Check for graft "semver-esm" (run by `pnpm test:grafts`): semver loads as native ESM and behaves exactly like the
// pristine CommonJS release.
import { assert, assertNoCommonJS, consumerRequire, differential, installedDir, pristine, run, trackFormats } from '../.shared/check.mjs';

const formats = trackFormats();
const mode = process.env.GRAFT_MODE ?? 'esm';
const require = consumerRequire('packages/spec');
const dir = installedDir(require, 'semver');
const { version } = require('semver/package.json');
if (process.env.GRAFT_UPSTREAM_VERSION) assert.equal(version, process.env.GRAFT_UPSTREAM_VERSION);

const ref = (await pristine('semver', version)).require('./index.js');
let semver;
if (mode === 'cjs') {
  semver = require('semver');
} else {
  const ns = await import(require.resolve('semver'));
  semver = ns.default;
  for (const key of Object.keys(ref)) assert.equal(ns[key], semver[key], `named export ${key} !== default.${key}`);
}

const VERSIONS = ['1.2.3', 'v1.2.3', '=1.2.3', ' 1.2.3 ', '1.2.3-alpha.1', '1.2.3-alpha.beta+build.5', '1.2.3+build', '1.2', '1', '01.2.3', '1.2.3-01', 'not', '', '9007199254740992.0.0', '1.2.3-0', '2.0.0-rc.1', '0.0.0', '10.20.30', '1.0.0-alpha.-1', 'v2.x', '4.6.3.9.2-alpha2', null, 42];
const RANGES = ['*', '', '1.2.3', '>=1.2.3', '^1.2.3', '~1.2.3', '1.x', '1.2.x', '>=1.0.0 <2.0.0', '1.2.3 - 2.3.4', '1.2 - 2', '^0.0.1', '^0.1.2', '~0', '>1.2.3-alpha.0', '<=2.0.0-rc.1', '1.2.3 || >=3.0.0', '>=2.0.0-0', '>= 1 < 2', 'garbage', '>01.2.3', '^1.2.3-beta.2', '~1.2.3-beta.2', '=1.2.3', '<1.2.3 >1.0.0'];
const OPTS = [undefined, { loose: true }, { includePrerelease: true }];
const RELEASES = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease', 'release', 'pre'];

function* cases() {
  for (const v of VERSIONS) {
    for (const o of OPTS) {
      for (const f of ['valid', 'clean', 'major', 'minor', 'patch', 'prerelease', 'coerce', 'parse']) {
        yield [`${f}(${JSON.stringify(v)}, ${JSON.stringify(o)})`, () => String(semver[f](v, o)), () => String(ref[f](v, o))];
      }
      for (const r of RANGES) {
        for (const f of ['satisfies', 'gtr', 'ltr']) yield [`${f}(${v}, ${r}, ${JSON.stringify(o)})`, () => semver[f](v, r, o), () => ref[f](v, r, o)];
      }
    }
    for (const w of VERSIONS.slice(0, 12)) {
      for (const f of ['compare', 'rcompare', 'compareLoose', 'compareBuild', 'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'diff']) {
        yield [`${f}(${v}, ${w})`, () => semver[f](v, w), () => ref[f](v, w)];
      }
      for (const op of ['===', '!==', '', '=', '==', '!=', '>', '>=', '<', '<=']) yield [`cmp(${v} ${op} ${w})`, () => semver.cmp(v, op, w), () => ref.cmp(v, op, w)];
    }
    for (const rel of RELEASES) yield [`inc(${v}, ${rel})`, () => semver.inc(v, rel, 'beta'), () => ref.inc(v, rel, 'beta')];
  }
  for (const r of RANGES) {
    for (const o of OPTS) {
      for (const f of ['validRange', 'minVersion', 'toComparators']) yield [`${f}(${r}, ${JSON.stringify(o)})`, () => String(semver[f](r, o)), () => String(ref[f](r, o))];
      yield [`Range(${r}).range`, () => new semver.Range(r, o).range, () => new ref.Range(r, o).range];
      yield [`maxSatisfying(${r})`, () => semver.maxSatisfying(VERSIONS.slice(0, 20).filter(Boolean), r, o), () => ref.maxSatisfying(VERSIONS.slice(0, 20).filter(Boolean), r, o)];
      yield [`minSatisfying(${r})`, () => semver.minSatisfying(VERSIONS.slice(0, 20).filter(Boolean), r, o), () => ref.minSatisfying(VERSIONS.slice(0, 20).filter(Boolean), r, o)];
      yield [`simplifyRange(${r})`, () => semver.simplifyRange(['1.0.0', '1.2.3', '2.0.0', '2.1.0-rc.1', '3.0.0'], r, o), () => ref.simplifyRange(['1.0.0', '1.2.3', '2.0.0', '2.1.0-rc.1', '3.0.0'], r, o)];
      for (const s of RANGES.slice(0, 12)) {
        yield [`intersects(${r}, ${s})`, () => semver.intersects(r, s, o), () => ref.intersects(r, s, o)];
        yield [`subset(${r}, ${s})`, () => semver.subset(r, s, o), () => ref.subset(r, s, o)];
      }
    }
  }
  const list = VERSIONS.filter((v) => typeof v === 'string' && ref.valid(v));
  yield ['sort', () => semver.sort([...list]), () => ref.sort([...list])];
  yield ['rsort', () => semver.rsort([...list]), () => ref.rsort([...list])];
  yield ['Comparator', () => new semver.Comparator('>=1.2.3-beta').test('1.2.3'), () => new ref.Comparator('>=1.2.3-beta').test('1.2.3')];
  yield ['SemVer.format', () => new semver.SemVer('1.2.3-a.1+b').inc('prerelease').format(), () => new ref.SemVer('1.2.3-a.1+b').inc('prerelease').format()];
  yield ['constants', () => [semver.SEMVER_SPEC_VERSION, semver.RELEASE_TYPES, Object.keys(semver.tokens).length], () => [ref.SEMVER_SPEC_VERSION, ref.RELEASE_TYPES, Object.keys(ref.tokens).length]];
}

await run('semver-esm', [
  ['same public API as the pristine release', () => assert.deepEqual(Object.keys(semver).sort(), Object.keys(ref).sort())],
  ['deep CommonJS requires return the old values', () => {
    assert.equal(typeof require('semver/functions/satisfies'), 'function');
    assert.equal(require('semver/functions/satisfies')('1.2.3', '^1'), true);
    assert.equal(require('semver/classes/range').name, 'Range');
    assert.equal(require('semver/classes/range'), semver.Range);
  }],
  ['behaves identically to pristine semver', () => {
    const all = [...cases()];
    const mismatches = differential(all);
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} mismatches`);
    return `${all.length} cases`;
  }],
  ['nothing from semver loaded as CommonJS', () => `${assertNoCommonJS(formats, dir)} modules, all ESM`],
]);
