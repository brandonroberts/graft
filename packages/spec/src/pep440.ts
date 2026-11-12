// PEP 440 versions and specifier sets (https://peps.python.org/pep-0440/), prereleases always
// included. `satisfies` follows the PEP's (and `packaging`'s) rules exactly; `intersects` works on
// intervals of the version order and may over-approximate (it never misses a real overlap), which
// is the safe direction for overlap validation.
import type { VersionScheme } from './versions.js';

export interface Pep440Version {
  epoch: number;
  release: number[];
  /** [rank (a=0, b=1, rc=2), number] */
  pre?: [number, number];
  post?: number;
  dev?: number;
  local?: (number | string)[];
}

const VERSION_RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

const PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parsePep440(text: string): Pep440Version | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return undefined;
  const v: Pep440Version = { epoch: m[1] ? Number(m[1]) : 0, release: m[2]!.split('.').map(Number) };
  if (m[3]) v.pre = [PRE_RANK[m[3].toLowerCase()]!, m[4] ? Number(m[4]) : 0];
  if (m[5] !== undefined) v.post = Number(m[5]);
  else if (m[6]) v.post = m[7] ? Number(m[7]) : 0;
  if (m[8]) v.dev = m[9] ? Number(m[9]) : 0;
  if (m[10])
    v.local = m[10]
      .toLowerCase()
      .split(/[-_.]/)
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  return v;
}

const isPre = (v: Pep440Version) => v.pre !== undefined || v.dev !== undefined;
const publicOf = (v: Pep440Version): Pep440Version => ({ ...v, local: undefined });

function cmpNums(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpRelease(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = cmpNums(a[i] ?? 0, b[i] ?? 0);
    if (c) return c;
  }
  return 0;
}

function cmpLocal(a?: (number | string)[], b?: (number | string)[]): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (typeof x !== typeof y) return typeof x === 'number' ? 1 : -1;
    const c = typeof x === 'number' ? cmpNums(x, y as number) : x < (y as string) ? -1 : x > (y as string) ? 1 : 0;
    if (c) return c;
  }
  return 0;
}

/** Order of the parts after the release (packaging's `_cmpkey`). */
function restKey(v: Pep440Version): number[] {
  const pre = v.pre ? v.pre : v.post === undefined && v.dev !== undefined ? [-Infinity] : [Infinity];
  return [...pre, v.post ?? -Infinity, v.dev ?? Infinity];
}

export function comparePep440(a: Pep440Version, b: Pep440Version): number {
  const c = cmpNums(a.epoch, b.epoch) || cmpRelease(a.release, b.release);
  if (c) return c;
  const [ka, kb] = [restKey(a), restKey(b)];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = cmpNums(ka[i] ?? -Infinity, kb[i] ?? -Infinity);
    if (d) return d;
  }
  return cmpLocal(a.local, b.local);
}

// ---------------------------------------------------------------------------------------------
// Specifiers

type Op = '~=' | '===' | '==' | '!=' | '<=' | '>=' | '<' | '>';

interface Specifier {
  op: Op;
  text: string;
  version?: Pep440Version;
  /** `==1.2.*` / `!=1.2.*`: the release prefix. */
  prefix?: { epoch: number; release: number[] };
}

const SPEC_RE = /^(~=|===|==|!=|<=|>=|<|>)\s*(\S+)$/;

function parseSpecifier(text: string): Specifier | undefined {
  const m = SPEC_RE.exec(text.trim());
  if (!m) return undefined;
  const op = m[1] as Op;
  const value = m[2]!;
  if (op === '===') return { op, text: value, version: parsePep440(value) };
  if (value.endsWith('.*')) {
    if (op !== '==' && op !== '!=') return undefined;
    const v = parsePep440(value.slice(0, -2));
    if (!v || v.pre || v.post !== undefined || v.dev !== undefined || v.local) return undefined;
    return { op, text: value, prefix: { epoch: v.epoch, release: v.release } };
  }
  const v = parsePep440(value);
  if (!v) return undefined;
  if (v.local && op !== '==' && op !== '!=') return undefined;
  if (op === '~=' && v.release.length < 2) return undefined;
  return { op, text: value, version: v };
}

function parseSpecifierSet(range: string): Specifier[] | undefined {
  const parts = range
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const specs = parts.map(parseSpecifier);
  return specs.every((s): s is Specifier => !!s) ? specs : undefined;
}

/** `<V` stops below V's own prereleases unless V is one: below `V.dev0`. */
const lessThanBound = (v: Pep440Version): Pep440Version => (isPre(v) ? publicOf(v) : { ...publicOf(v), dev: 0 });

/** Just above V, its local versions and (unless V is a post-release) its post-releases. */
function greaterThanBound(v: Pep440Version): { v: Pep440Version; inc: boolean } {
  const pub = publicOf(v);
  if (v.dev !== undefined) return { v: { ...pub, dev: v.dev + 1 }, inc: true };
  if (v.post !== undefined) return { v: { ...pub, post: v.post + 1, dev: 0 }, inc: true };
  return { v: { ...pub, post: Infinity, dev: Infinity }, inc: false };
}

function greaterThan(v: Pep440Version, candidate: Pep440Version): boolean {
  const b = greaterThanBound(v);
  const c = comparePep440(candidate, b.v);
  return b.inc ? c >= 0 : c > 0;
}

function matchesPrefix(v: Pep440Version, prefix: { epoch: number; release: number[] }): boolean {
  return v.epoch === prefix.epoch && prefix.release.every((n, i) => (v.release[i] ?? 0) === n);
}

function matches(spec: Specifier, candidate: Pep440Version, raw: string): boolean {
  if (spec.op === '===') return raw.trim().toLowerCase() === spec.text.toLowerCase();
  if (spec.prefix) {
    const hit = matchesPrefix(publicOf(candidate), spec.prefix);
    return spec.op === '==' ? hit : !hit;
  }
  const v = spec.version!;
  const pub = publicOf(candidate);
  switch (spec.op) {
    case '==':
    case '!=': {
      const equal = v.local ? comparePep440(candidate, v) === 0 : comparePep440(pub, v) === 0;
      return spec.op === '==' ? equal : !equal;
    }
    case '~=':
      return comparePep440(pub, v) >= 0 && matchesPrefix(pub, { epoch: v.epoch, release: v.release.slice(0, -1) });
    case '>=':
      return comparePep440(pub, v) >= 0;
    case '<=':
      return comparePep440(pub, v) <= 0;
    case '<':
      return comparePep440(pub, lessThanBound(v)) < 0;
    case '>':
      return greaterThan(v, pub);
  }
}

// ---------------------------------------------------------------------------------------------
// Intervals over the version order, for intersection.

/** A version, or an edge just below (-1) / above (+1) every version with this epoch and release. */
type Point = { v: Pep440Version } | { epoch: number; release: number[]; edge: -1 | 1 };
type Bound = { p: Point; inc: boolean };
interface Interval {
  lo?: Bound;
  hi?: Bound;
}

function cmpPoint(a: Point, b: Point): number {
  const ea = 'v' in a ? a.v.epoch : a.epoch;
  const eb = 'v' in b ? b.v.epoch : b.epoch;
  const ra = 'v' in a ? a.v.release : a.release;
  const rb = 'v' in b ? b.v.release : b.release;
  const c = cmpNums(ea, eb) || cmpRelease(ra, rb);
  if (c) return c;
  if ('edge' in a || 'edge' in b) return cmpNums('edge' in a ? a.edge : 0, 'edge' in b ? b.edge : 0);
  return comparePep440(publicOf(a.v), publicOf(b.v));
}

const ALL: Interval = {};
const point = (v: Pep440Version): Point => ({ v: publicOf(v) });

function maxLo(a?: Bound, b?: Bound): Bound | undefined {
  if (!a || !b) return a ?? b;
  const c = cmpPoint(a.p, b.p);
  return c > 0 ? a : c < 0 ? b : { p: a.p, inc: a.inc && b.inc };
}

function minHi(a?: Bound, b?: Bound): Bound | undefined {
  if (!a || !b) return a ?? b;
  const c = cmpPoint(a.p, b.p);
  return c < 0 ? a : c > 0 ? b : { p: a.p, inc: a.inc && b.inc };
}

function nonEmpty(i: Interval): boolean {
  if (!i.lo || !i.hi) return true;
  const c = cmpPoint(i.lo.p, i.hi.p);
  return c < 0 || (c === 0 && i.lo.inc && i.hi.inc && 'v' in i.lo.p);
}

function intersectAll(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) out.push({ lo: maxLo(x.lo, y.lo), hi: minHi(x.hi, y.hi) });
  return out.filter(nonEmpty);
}

function prefixInterval(prefix: { epoch: number; release: number[] }): Interval {
  return {
    lo: { p: { epoch: prefix.epoch, release: prefix.release, edge: -1 }, inc: true },
    hi: { p: { epoch: prefix.epoch, release: [...prefix.release, Infinity], edge: -1 }, inc: false },
  };
}

function complement(i: Interval): Interval[] {
  const out: Interval[] = [];
  if (i.lo) out.push({ hi: { p: i.lo.p, inc: !i.lo.inc } });
  if (i.hi) out.push({ lo: { p: i.hi.p, inc: !i.hi.inc } });
  return out;
}

function intervals(spec: Specifier): Interval[] {
  if (spec.op === '===')
    return spec.version ? [{ lo: { p: point(spec.version), inc: true }, hi: { p: point(spec.version), inc: true } }] : [ALL];
  if (spec.prefix) return spec.op === '==' ? [prefixInterval(spec.prefix)] : complement(prefixInterval(spec.prefix));
  const v = spec.version!;
  const p = point(v);
  switch (spec.op) {
    case '==':
      return [{ lo: { p, inc: true }, hi: { p, inc: true } }];
    case '!=':
      return [{ hi: { p, inc: false } }, { lo: { p, inc: false } }];
    case '~=':
      return intersectAll([{ lo: { p, inc: true } }], [prefixInterval({ epoch: v.epoch, release: v.release.slice(0, -1) })]);
    case '>=':
      return [{ lo: { p, inc: true } }];
    case '<=':
      return [{ hi: { p, inc: true } }];
    case '<':
      return [{ hi: { p: point(lessThanBound(v)), inc: false } }];
    case '>': {
      const b = greaterThanBound(v);
      return [{ lo: { p: { v: b.v }, inc: b.inc } }];
    }
  }
}

function rangeIntervals(specs: Specifier[]): Interval[] {
  return specs.reduce<Interval[]>((acc, s) => intersectAll(acc, intervals(s)), [ALL]);
}

const formatRelease = (epoch: number, release: number[]) => `${epoch ? `${epoch}!` : ''}${release.join('.')}`;

export function formatPep440(v: Pep440Version): string {
  let s = formatRelease(v.epoch, v.release);
  if (v.pre) s += `${['a', 'b', 'rc'][v.pre[0]]}${v.pre[1]}`;
  if (v.post !== undefined) s += `.post${v.post}`;
  if (v.dev !== undefined) s += `.dev${v.dev}`;
  if (v.local) s += `+${v.local.join('.')}`;
  return s;
}

function mustParse(version: string): Pep440Version {
  const v = parsePep440(version);
  if (!v) throw new Error(`"${version}" is not a valid PEP 440 version`);
  return v;
}

export const pep440Scheme: VersionScheme = {
  name: 'pep440',
  example: { version: '2.31.0', range: '>=2.0,<3' },
  valid: (v) => parsePep440(v) !== undefined,
  validRange: (r) => parseSpecifierSet(r) !== undefined,
  satisfies(version, range) {
    const v = parsePep440(version);
    const specs = parseSpecifierSet(range);
    return !!v && !!specs && specs.every((s) => matches(s, v, version));
  },
  intersects(a, b) {
    const [sa, sb] = [parseSpecifierSet(a), parseSpecifierSet(b)];
    if (!sa || !sb) return false;
    return intersectAll(rangeIntervals(sa), rangeIntervals(sb)).length > 0;
  },
  compare: (a, b) => comparePep440(mustParse(a), mustParse(b)),
  isPrerelease: (v) => isPre(mustParse(v)),
  minVersion(range) {
    const specs = parseSpecifierSet(range);
    if (!specs) return undefined;
    const all = rangeIntervals(specs);
    if (!all.length || all.some((i) => !i.lo)) return undefined;
    const lo = all.map((i) => i.lo!).reduce((a, b) => (cmpPoint(a.p, b.p) <= 0 ? a : b));
    // `>V` starts just above V's post-releases (post = dev = Infinity): name V itself.
    if ('v' in lo.p) return formatPep440(lo.p.v.post === Infinity ? { ...lo.p.v, post: undefined, dev: undefined } : lo.p.v);
    return `${formatRelease(lo.p.epoch, lo.p.release)}${lo.p.edge < 0 ? '.dev0' : ''}`;
  },
  satisfiable(range) {
    const specs = parseSpecifierSet(range);
    return !!specs && rangeIntervals(specs).length > 0;
  },
  capBelow: (range, upper) => (range.trim() ? `${range.trim()},<${upper}` : `<${upper}`),
  from(version) {
    const v = mustParse(version);
    return isPre(v) ? `>=${formatRelease(v.epoch, v.release)}.dev0` : `>=${formatPep440(publicOf(v))}`;
  },
  major: (version) => mustParse(version).release[0]!,
  fromMajor(version) {
    const v = mustParse(version);
    return `>=${formatRelease(v.epoch, [v.release[0]!])}.dev0`;
  },
};
