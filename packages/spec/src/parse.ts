import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { parseSections, splitFrontmatter, findSection, type Section } from './document.js';
import { GraftFrontmatterSchema, REQUIRED_SECTIONS, type GraftFrontmatter } from './schema.js';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code, e.g. `frontmatter/invalid`, `body/missing-section`. */
  code: string;
  message: string;
  /** Dotted frontmatter path or section name the diagnostic refers to. */
  path?: string;
}

export interface ParsedGraft {
  frontmatter: GraftFrontmatter;
  body: string;
  sections: Section[];
}

export interface ParseResult {
  /** Present whenever frontmatter passed schema validation (even if other errors exist). */
  graft?: ParsedGraft;
  diagnostics: Diagnostic[];
  /** True when there are no error-severity diagnostics. */
  ok: boolean;
}

export interface ParseOptions {
  /** Name of the directory containing graft.md; must equal `id` when given. */
  directoryName?: string;
}

/** Parse and validate the text of a graft.md file. Never throws on invalid input. */
export function parseGraft(text: string, options: ParseOptions = {}): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const done = (graft?: ParsedGraft): ParseResult => ({
    graft,
    diagnostics,
    ok: !diagnostics.some((d) => d.severity === 'error'),
  });

  const split = splitFrontmatter(text);
  if (!split) {
    diagnostics.push({
      severity: 'error',
      code: 'frontmatter/missing',
      message: 'graft.md must start with YAML frontmatter delimited by `---` lines',
    });
    return done();
  }

  let raw: unknown;
  try {
    raw = parseYaml(split.frontmatter);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      code: 'frontmatter/yaml',
      message: `frontmatter is not valid YAML: ${(err as Error).message}`,
    });
    return done();
  }

  const result = GraftFrontmatterSchema.safeParse(raw ?? {});
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.push({
        severity: 'error',
        code: 'frontmatter/invalid',
        path: issue.path.join('.'),
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      });
    }
  }

  const sections = parseSections(split.body);
  for (const name of REQUIRED_SECTIONS) {
    const section = findSection(sections, name);
    if (!section) {
      diagnostics.push({
        severity: 'error',
        code: 'body/missing-section',
        path: name,
        message: `missing required section "## ${name}"`,
      });
    } else if (!section.content) {
      diagnostics.push({
        severity: 'warning',
        code: 'body/empty-section',
        path: name,
        message: `section "## ${name}" is empty; agents rely on it during sync`,
      });
    }
  }

  if (!result.success) return done();
  const fm = result.data;

  if (options.directoryName !== undefined && options.directoryName !== fm.id) {
    diagnostics.push({
      severity: 'error',
      code: 'frontmatter/id-mismatch',
      path: 'id',
      message: `id "${fm.id}" must match its directory name "${options.directoryName}"`,
    });
  }

  if (raw && typeof raw === 'object' && 'oracle' in raw) {
    diagnostics.push({
      severity: 'warning',
      code: 'frontmatter/oracle-ignored',
      path: 'oracle',
      message:
        "`oracle` is no longer used: Graft runs no runtime check, and verifying behavior is the agent's job. " +
        "Move the check into the project's tests (and say how to run it under Invariants), then remove the block.",
    });
  }

  diagnostics.push(...checkVariantRanges(fm));
  if (fm.mechanism === 'fork' && !fm.fork) {
    diagnostics.push({
      severity: 'error',
      code: 'frontmatter/fork-missing',
      path: 'fork',
      message: 'mechanism "fork" needs a `fork:` block ({ repo, upstream, tag })',
    });
  }

  return done({ frontmatter: fm, body: split.body, sections });
}

function checkVariantRanges(fm: GraftFrontmatter): Diagnostic[] {
  const out: Diagnostic[] = [];
  const opts = { includePrerelease: true };
  fm.variants.forEach((a, i) => {
    fm.variants.slice(i + 1).forEach((b, j) => {
      if (semver.intersects(a.range, b.range, opts)) {
        out.push({
          severity: 'error',
          code: 'variants/overlap',
          path: `variants.${i}`,
          message: `variant ranges "${a.range}" (variants.${i}) and "${b.range}" (variants.${i + j + 1}) overlap; a version must select exactly one variant`,
        });
      }
    });
  });
  const modules = new Set<string>();
  fm.variants.forEach((v, i) => {
    if (modules.has(v.module)) {
      out.push({
        severity: 'error',
        code: 'variants/duplicate-module',
        path: `variants.${i}.module`,
        message: `variant module "${v.module}" is listed more than once`,
      });
    }
    modules.add(v.module);
  });
  if (!fm.variants.some((v) => semver.satisfies(fm.rootstock.verified, v.range, opts))) {
    out.push({
      severity: 'warning',
      code: 'variants/verified-uncovered',
      path: 'rootstock.verified',
      message: `verified version ${fm.rootstock.verified} is not covered by any variant range`,
    });
  }
  return out;
}

/** Return the variant whose range contains `version` (prereleases included), if any. */
export function selectVariant<V extends { range: string }>(variants: readonly V[], version: string): V | undefined {
  return variants.find((v) => semver.satisfies(version, v.range, { includePrerelease: true }));
}
