import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs tooling module without type declarations
import { packageReadme } from '../package-readme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const script = path.resolve(here, '../package-readme.mjs');

/** A scratch repository with a few files and directories to link to. */
function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'package-readme-'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/spec.md'), '# Spec\n');
  writeFileSync(path.join(root, 'docs/flow.png'), '');
  mkdirSync(path.join(root, 'packages/action'), { recursive: true });
  return root;
}

describe('packageReadme', () => {
  it('points files, directories and images at the release tag on GitHub', () => {
    const md = [
      'See [the spec](docs/spec.md#lifecycle), [the Action](packages/action) and [this](./docs/spec.md).',
      '![Flow](docs/flow.png)',
      'Also [npm](https://www.npmjs.com/) and [below](#usage).',
    ].join('\n');
    expect(packageReadme(md, { root: fixtureRoot(), ref: 'v1.2.3' }).split('\n')).toEqual([
      'See [the spec](https://github.com/brandonroberts/graft/blob/v1.2.3/docs/spec.md#lifecycle), [the Action](https://github.com/brandonroberts/graft/tree/v1.2.3/packages/action) and [this](https://github.com/brandonroberts/graft/blob/v1.2.3/docs/spec.md).',
      '![Flow](https://raw.githubusercontent.com/brandonroberts/graft/v1.2.3/docs/flow.png)',
      'Also [npm](https://www.npmjs.com/) and [below](#usage).',
    ]);
  });

  it('leaves links inside fenced code alone', () => {
    const md = '```md\n[missing](nowhere.md)\n```\n[spec](docs/spec.md)';
    expect(packageReadme(md, { root: fixtureRoot(), ref: 'v1.0.0' })).toBe(
      '```md\n[missing](nowhere.md)\n```\n[spec](https://github.com/brandonroberts/graft/blob/v1.0.0/docs/spec.md)',
    );
  });

  it('fails on a relative link to a path that does not exist, instead of publishing it broken', () => {
    expect(() => packageReadme('[gone](docs/gone.md) and [out](../elsewhere.md)', { root: fixtureRoot(), ref: 'v1.0.0' })).toThrow(
      "README links to paths that don't exist in the repository: docs/gone.md, ../elsewhere.md",
    );
  });

  it("rewrites this repository's own README with no missing paths", () => {
    const out = packageReadme(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), { root: repoRoot, ref: 'v0.0.0' });
    expect(out).toContain('](https://github.com/brandonroberts/graft/tree/v0.0.0/packages/action)');
    expect(out).toContain('](https://raw.githubusercontent.com/brandonroberts/graft/v0.0.0/docs/workflow.png)');
    expect(out).not.toMatch(/\]\((?!https?:|#|mailto:)[^)]+\)/);
  });
});

describe('package-readme.mjs', () => {
  it('writes README.md for the package version on prepack and removes it on --clean', () => {
    const pkg = mkdtempSync(path.join(os.tmpdir(), 'package-readme-pkg-'));
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'x', version: '4.5.6' }));
    execFileSync(process.execPath, [script], { cwd: pkg });
    const readme = readFileSync(path.join(pkg, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# Graft/);
    expect(readme).toContain('https://github.com/brandonroberts/graft/blob/v4.5.6/docs/spec.md');
    execFileSync(process.execPath, [script, '--clean'], { cwd: pkg });
    expect(existsSync(path.join(pkg, 'README.md'))).toBe(false);
  });

  it('fails when package.json has no version to link to', () => {
    const pkg = mkdtempSync(path.join(os.tmpdir(), 'package-readme-pkg-'));
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(() => execFileSync(process.execPath, [script], { cwd: pkg, stdio: 'pipe' })).toThrow(/no version/);
    expect(existsSync(path.join(pkg, 'README.md'))).toBe(false);
  });
});
