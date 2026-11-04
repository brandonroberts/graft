import semver from 'semver';
import { z } from 'zod';

/** Lifecycle of a graft. */
export const GRAFT_STATUSES = ['applied', 'conflicted', 'upstreamed', 'obsolete'] as const;
export type GraftStatus = (typeof GRAFT_STATUSES)[number];

/** Statuses for which tooling still applies and verifies the graft. */
export const ACTIVE_STATUSES: readonly GraftStatus[] = ['applied', 'conflicted'];

/** Body sections every graft.md must contain, in recommended order. */
export const REQUIRED_SECTIONS = ['Why', 'Invariants', 'Where to look', 'Anchors', 'History'] as const;
export type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

export const GRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const semverVersion = z
  .string()
  .refine((v) => semver.valid(v) !== null, { message: 'must be a valid semver version (e.g. "4.2.0")' });

const semverRange = z
  .string()
  .refine((r) => semver.validRange(r, { includePrerelease: true }) !== null, {
    message: 'must be a valid semver range (e.g. ">=4.0.0 <5.0.0")',
  });

export const RootstockSchema = z.object({
  /** npm package name of the upstream. */
  package: z.string().min(1),
  /** Last upstream version this graft was verified against (by sync's checks, or by an agent). */
  verified: semverVersion,
});

export const VariantRefSchema = z.object({
  /** Upstream version range this variant is valid for. */
  range: semverRange,
  /** Path to the variant module, relative to the graft directory. */
  module: z.string().min(1),
});

export const ForkSchema = z.object({
  /** Git URL (or path, relative to the project root) of the fork that carries the modification as commits. */
  repo: z.string().min(1),
  /** Git URL of the upstream source repository the fork tracks. */
  upstream: z.string().min(1),
  /** Upstream release tag for a version; `{version}` is substituted. */
  tag: z
    .string()
    .min(1)
    .default('v{version}')
    .refine((t) => t.includes('{version}'), { message: 'must contain {version}' }),
  /**
   * Repo mode: an upstream branch to follow (e.g. `main`). `graft outdated` then offers its tip as
   * `<version>+<commit>` instead of the newest release tag.
   */
  track: z.string().min(1).optional(),
  /** Package directory inside the repositories (for monorepos). Default: the repo root. */
  dir: z.string().min(1).optional(),
  /**
   * How the rebased fork is consumed. `package` (default): built, packed and installed into the
   * project as a vendored tarball. `none`: the fork is the product itself (e.g. a translated docs
   * site); nothing is installed, and sync's result is the rebased checkout.
   */
  install: z.enum(['package', 'none']).default('package'),
  /** Command run in the package directory of the rebased source before packing (e.g. `npm ci && npm run build`). */
  build: z.string().min(1).optional(),
  /** Optional timeout for the build, in seconds. */
  timeout: z.number().int().positive().optional(),
});

export const GeneratorSchema = z.object({
  /**
   * Shell command that writes a new variant module for an upstream version, run from the
   * project root. `{version}` is replaced with the target upstream version and `{out}` with
   * the path to write the variant to (also exported as GRAFT_UPSTREAM_VERSION and
   * GRAFT_VARIANT_OUT). `graft sync` runs it when no existing variant fits a new version.
   */
  command: z
    .string()
    .min(1)
    .refine((c) => c.includes('{out}') || c.includes('GRAFT_VARIANT_OUT'), {
      message: 'must write the variant to {out} (or $GRAFT_VARIANT_OUT)',
    }),
  /** Optional timeout, in seconds. */
  timeout: z.number().int().positive().optional(),
});

export const GraftFrontmatterSchema = z.object({
  id: z.string().regex(GRAFT_ID_PATTERN, 'must be lowercase kebab-case'),
  rootstock: RootstockSchema,
  /** Name of the mechanism adapter that applies this graft (e.g. patch). */
  mechanism: z.string().min(1),
  /** Upstream files the mechanism operates on, relative to the package root. */
  targets: z.array(z.string().min(1)).optional(),
  variants: z.array(VariantRefSchema).min(1),
  /** Optional command that regenerates a variant for a new upstream version. */
  generator: GeneratorSchema.optional(),
  /** For `mechanism: fork`: where the modification lives as commits, and how to build it. */
  fork: ForkSchema.optional(),
  status: z.enum(GRAFT_STATUSES).default('applied'),
});

export type Rootstock = z.infer<typeof RootstockSchema>;
export type VariantRef = z.infer<typeof VariantRefSchema>;
export type ForkConfig = z.infer<typeof ForkSchema>;
export type Generator = z.infer<typeof GeneratorSchema>;
export type GraftFrontmatter = z.infer<typeof GraftFrontmatterSchema>;
/** Frontmatter as authored, before defaults are applied. */
export type GraftFrontmatterInput = z.input<typeof GraftFrontmatterSchema>;
