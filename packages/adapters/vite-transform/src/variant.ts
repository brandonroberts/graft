import type MagicString from 'magic-string';
import type { AnchorDefinition, AstNode, Program } from './anchors.js';

export interface TransformContext<A extends Record<string, AnchorDefinition> = Record<string, AnchorDefinition>> {
  /** Original code of the target file. */
  code: string;
  /** Module id as seen by the bundler (absolute path, query stripped). */
  id: string;
  /** Target file relative to the package root (one of the graft's `targets`). */
  file: string;
  /** Upstream version being transformed. */
  version: string;
  ast: Program;
  /** Edit the code through this; the adapter generates the source map. */
  s: MagicString;
  /**
   * Located nodes for every anchor assigned to `file`. Anchors assigned to other
   * targets are absent. Every anchor here matched exactly once (misses throw before transform).
   */
  anchors: { [K in keyof A]: AstNode };
}

export interface VariantDefinition<A extends Record<string, AnchorDefinition> = Record<string, AnchorDefinition>> {
  anchors: A;
  /**
   * Apply the modification. Edit through `ctx.s`, or return replacement code.
   * A transform that changes nothing is an error: a graft must never silently apply nothing.
   */
  transform(ctx: TransformContext<A>): void | string;
}

export const VARIANT_BRAND = Symbol.for('graft.vite-transform.variant');

export type Variant<A extends Record<string, AnchorDefinition> = Record<string, AnchorDefinition>> = VariantDefinition<A> & {
  [VARIANT_BRAND]: true;
};

/** Declare a vite-transform variant. Use as the default export of a variant module. */
export function defineVariant<A extends Record<string, AnchorDefinition>>(definition: VariantDefinition<A>): Variant<A> {
  return Object.assign(definition, { [VARIANT_BRAND]: true as const });
}

/** Shape-check an imported variant module. Returns a list of problems (empty if valid). */
export function variantProblems(value: unknown, targets: string[]): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') return ['variant module must default-export defineVariant({ anchors, transform })'];
  const v = value as Partial<VariantDefinition>;
  if (typeof v.transform !== 'function') problems.push('variant must define transform(ctx)');
  if (!v.anchors || typeof v.anchors !== 'object') {
    problems.push('variant must define an `anchors` object (a graft without anchors cannot fail loudly)');
    return problems;
  }
  const entries = Object.entries(v.anchors);
  if (entries.length === 0) problems.push('variant must declare at least one anchor');
  for (const [name, a] of entries) {
    if (!a || typeof a.find !== 'function') {
      problems.push(`anchor "${name}" must be created with an anchor helper (missing find())`);
      continue;
    }
    const file = anchorFile(a, targets);
    if (!file) problems.push(`anchor "${name}" must declare \`file\` because the graft has ${targets.length} targets`);
    else if (!targets.includes(file)) problems.push(`anchor "${name}" targets "${file}", which is not in the graft's targets`);
  }
  return problems;
}

/** The target file an anchor applies to. */
export function anchorFile(a: AnchorDefinition, targets: string[]): string | undefined {
  return a.file ?? (targets.length === 1 ? targets[0] : undefined);
}
