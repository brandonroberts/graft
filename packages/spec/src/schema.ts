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
  /** Last upstream version this graft was verified against by its oracle. */
  verified: semverVersion,
});

export const VariantRefSchema = z.object({
  /** Upstream version range this variant is valid for. */
  range: semverRange,
  /** Path to the variant module, relative to the graft directory. */
  module: z.string().min(1),
});

export const OracleSchema = z.object({
  /**
   * Shell command that exits 0 iff the graft's invariants hold.
   * Runs once per mode, with GRAFT_MODE set. `{mode}` in the command is substituted.
   */
  command: z.string().min(1),
  /** Modes to run the oracle in (e.g. dev, build). */
  modes: z.array(z.string().min(1)).min(1).default(['default']),
  /** Optional timeout per mode, in seconds. */
  timeout: z.number().int().positive().optional(),
});

export const GraftFrontmatterSchema = z.object({
  id: z.string().regex(GRAFT_ID_PATTERN, 'must be lowercase kebab-case'),
  rootstock: RootstockSchema,
  /** Name of the mechanism adapter that applies this graft (e.g. vite-transform). */
  mechanism: z.string().min(1),
  /** Upstream files the mechanism operates on, relative to the package root. */
  targets: z.array(z.string().min(1)).optional(),
  variants: z.array(VariantRefSchema).min(1),
  oracle: OracleSchema,
  status: z.enum(GRAFT_STATUSES).default('applied'),
});

export type Rootstock = z.infer<typeof RootstockSchema>;
export type VariantRef = z.infer<typeof VariantRefSchema>;
export type Oracle = z.infer<typeof OracleSchema>;
export type GraftFrontmatter = z.infer<typeof GraftFrontmatterSchema>;
/** Frontmatter as authored, before defaults are applied. */
export type GraftFrontmatterInput = z.input<typeof GraftFrontmatterSchema>;
