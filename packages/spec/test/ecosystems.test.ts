import { describe, expect, it } from 'vitest';
import { parseGraft, pep440Scheme as pep, selectVariant, semverScheme, versionScheme } from '../src/index.js';

const doc = (fm: string) => `---\n${fm}\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- h\n`;
const graft = (rootstock: string, ranges: string[]) =>
  parseGraft(
    doc(
      `id: x\nrootstock: ${rootstock}\nmechanism: patch\nvariants:\n${ranges.map((r, i) => `  - range: "${r}"\n    module: ./v${i}.patch`).join('\n')}`,
    ),
    { directoryName: 'x' },
  );

describe('rootstock.ecosystem', () => {
  it('defaults to npm, so existing grafts stay valid', () => {
    const r = graft('{ package: ms, verified: 2.1.3 }', ['>=2.0.0']);
    expect(r.ok).toBe(true);
    expect(r.graft?.frontmatter.rootstock.ecosystem).toBe('npm');
  });

  it('rejects an unknown ecosystem with its own diagnostic', () => {
    const r = graft('{ package: ms, ecosystem: maven, verified: 2.1.3 }', ['>=2.0.0']);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'frontmatter/unknown-ecosystem')).toMatchObject({
      severity: 'error',
      path: 'rootstock.ecosystem',
    });
  });

  it('validates cargo and go with semver (Go keeps its v prefix)', () => {
    expect(graft('{ package: itoa, ecosystem: cargo, verified: 1.0.19 }', ['>=1.0.0']).ok).toBe(true);
    const go = graft('{ package: golang.org/x/text, ecosystem: go, verified: v0.14.0 }', ['>=0.14.0 <0.15.0', '>=v0.15.0']);
    expect(go.ok).toBe(true);
    expect(selectVariant(go.graft!.frontmatter.variants, 'v0.15.2', semverScheme)?.module).toBe('./v1.patch');
    // A Go pseudo-version is a semver prerelease and orders by its timestamp.
    expect(semverScheme.satisfies('v0.0.0-20240101120000-abcdef123456', '>=0.0.0-0')).toBe(true);
  });

  it('validates pypi with PEP 440, rejecting semver-only syntax', () => {
    const ok = graft('{ package: requests, ecosystem: pypi, verified: 2.31.0.post1 }', ['>=2.0,<3', '>=3.0.dev0']);
    expect(ok.ok).toBe(true);
    const bad = graft('{ package: requests, ecosystem: pypi, verified: 2.31.0 }', ['>=2.0.0 <3.0.0']);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.map((d) => d.message).join('\n')).toMatch(/valid PEP 440 range/);
    const overlap = graft('{ package: requests, ecosystem: pypi, verified: 2.31.0 }', ['>=2.0', '~=2.31']);
    expect(overlap.diagnostics.map((d) => d.code)).toContain('variants/overlap');
  });

  it('picks the scheme by ecosystem', () => {
    expect(versionScheme('pypi')).toBe(pep);
    expect(versionScheme('cargo')).toBe(semverScheme);
    expect(versionScheme(undefined)).toBe(semverScheme);
  });
});

describe('PEP 440 scheme', () => {
  // Expected values were produced by Python's `packaging` 26 (SpecifierSet.contains, prereleases=True).
  it.each([
    ['1.0rc1', '>=1.0', false],
    ['1.0rc1', '<1.0', false],
    ['1.0.dev1', '<1.0', false],
    ['0.9', '<1.0', true],
    ['1.0a1', '<1.0.post2', true],
    ['1.0.post1', '>1.0', false],
    ['1.0.post1', '>1.0a1', true],
    ['1.0+local.1', '==1.0', true],
    ['1.0+local.1', '>1.0', false],
    ['1.0.5', '==1.0.*', true],
    ['1.5', '==1.0.*', false],
    ['1.0.1', '~=1.0', true],
    ['2.0', '~=1.0', false],
    ['1.1', '~=1.0.1', false],
    ['1!0.5', '>=1.0', true],
    ['2.0rc1', '>=2.0.dev0', true],
    ['1.5', '>=1.0,!=1.5,<3', false],
    ['1.0.0', '===1.0', false],
  ])('%s in "%s" is %s', (version, range, expected) => {
    expect(pep.satisfies(version, range)).toBe(expected);
  });

  it('orders versions as PEP 440 does', () => {
    const sorted = ['1.0', '1.0.dev0', '1.0a1', '1.0.post1', '1.0rc1', '1.0b2', '1!0.1', '1.0.post1.dev0', '0.9'].sort(pep.compare);
    expect(sorted).toEqual(['0.9', '1.0.dev0', '1.0a1', '1.0b2', '1.0rc1', '1.0', '1.0.post1.dev0', '1.0.post1', '1!0.1']);
  });

  it('intersects ranges, never missing an overlap', () => {
    expect(pep.intersects('>=1.0,<2', '>=2.0')).toBe(false);
    expect(pep.intersects('<2.0', '==2.0rc1')).toBe(false);
    expect(pep.intersects('<2.0.dev0', '>=2.0.dev0')).toBe(false);
    expect(pep.intersects('==1.*', '>=1.9')).toBe(true);
    expect(pep.intersects('~=1.4', '>=2')).toBe(false);
    expect(pep.intersects('!=1.5', '==1.5')).toBe(false);
    expect(pep.intersects('>1.0', '==1.0.post3')).toBe(false);
  });

  it('builds ranges for new variants and narrows old ones', () => {
    expect(pep.from('2.0rc1')).toBe('>=2.0.dev0');
    expect(pep.from('2.31.0')).toBe('>=2.31.0');
    expect(pep.fromMajor('2.31.0')).toBe('>=2.dev0');
    expect(pep.minVersion('>=2.0,<3')).toBe('2.0');
    expect(pep.minVersion('==2.*')).toBe('2.dev0');
    expect(pep.minVersion('<3')).toBeUndefined();
    const capped = pep.capBelow('>=1.0', pep.minVersion('>=2.0.dev0')!);
    expect(capped).toBe('>=1.0,<2.0.dev0');
    expect(pep.intersects(capped, '>=2.0.dev0')).toBe(false);
    expect(pep.satisfiable('>=2,<1')).toBe(false);
  });

  it('rejects invalid versions and specifiers', () => {
    expect(pep.valid('1.0-SNAPSHOT')).toBe(false);
    expect(pep.valid('2.0.0-rc.1+build')).toBe(true); // PEP 440 normalizes it to 2.0.0rc1+build
    expect(pep.validRange('>=1.0.0 <2.0.0')).toBe(false);
    expect(pep.validRange('~=1')).toBe(false);
    expect(pep.validRange('>=1.0.*')).toBe(false);
    expect(pep.validRange('')).toBe(true);
  });
});
