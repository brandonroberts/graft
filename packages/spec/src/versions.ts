// Version schemes: how an ecosystem's versions and ranges are validated, compared and intersected.
// Every comparison includes prereleases (a graft must also cover the prereleases it is synced to).
import semver from 'semver';
import { pep440Scheme } from './pep440.js';

export interface VersionScheme {
  name: 'semver' | 'pep440';
  /** An example version and range, for error messages. */
  example: { version: string; range: string };
  valid(version: string): boolean;
  validRange(range: string): boolean;
  /** Does `version` satisfy `range`? Prereleases included. */
  satisfies(version: string, range: string): boolean;
  /** Do the two ranges share any version? Prereleases included. MAY over-approximate (never under). */
  intersects(a: string, b: string): boolean;
  compare(a: string, b: string): number;
  isPrerelease(version: string): boolean;
  /** The smallest version `range` admits, if it has a lower bound. */
  minVersion(range: string): string | undefined;
  /** True when some version satisfies `range`. */
  satisfiable(range: string): boolean;
  /** `range` restricted to versions below `version`. */
  capBelow(range: string, version: string): string;
  /** An open-ended range from `version` on, covering `version`'s own release's prereleases when it is one. */
  from(version: string): string;
  /** The version's major component (scaffolds name the first variant after it). */
  major(version: string): number;
  /** An open-ended range covering `version`'s major line from its first prerelease on. */
  fromMajor(version: string): string;
}

const opts = { includePrerelease: true };

/** node-semver, prereleases included. Also accepts Go's `v` prefix (`v0.14.0`). */
export const semverScheme: VersionScheme = {
  name: 'semver',
  example: { version: '4.2.0', range: '>=4.0.0 <5.0.0' },
  valid: (v) => semver.valid(v) !== null,
  validRange: (r) => semver.validRange(r, opts) !== null,
  satisfies: (v, r) => semver.satisfies(v, r, opts),
  intersects: (a, b) => semver.intersects(a, b, opts),
  compare: (a, b) => semver.compare(a, b),
  isPrerelease: (v) => semver.prerelease(v) !== null,
  minVersion: (r) => semver.minVersion(r)?.version,
  satisfiable(r) {
    const min = semver.minVersion(r);
    return !!min && semver.satisfies(min, r, opts);
  },
  capBelow: (range, upper) =>
    range
      .split('||')
      .map((set) => `${set.trim()} <${upper}`.trim())
      .join(' || '),
  from(v) {
    const p = semver.parse(v)!;
    return p.prerelease.length ? `>=${p.major}.${p.minor}.${p.patch}-0` : `>=${p.version}`;
  },
  major: (v) => semver.major(v),
  fromMajor: (v) => `>=${semver.major(v)}.0.0-0`,
};

/** Package ecosystems a rootstock can belong to (`rootstock.ecosystem`). */
export const ECOSYSTEMS = ['npm', 'cargo', 'go', 'pypi'] as const;
export type EcosystemName = (typeof ECOSYSTEMS)[number];
export const DEFAULT_ECOSYSTEM: EcosystemName = 'npm';

export const isEcosystem = (name: string): name is EcosystemName => (ECOSYSTEMS as readonly string[]).includes(name);

/** The version scheme of an ecosystem (semver for npm, cargo and go; PEP 440 for pypi). Unknown names get semver. */
export function versionScheme(ecosystem: string | undefined): VersionScheme {
  return ecosystem === 'pypi' ? pep440Scheme : semverScheme;
}
