import MagicString, { type SourceMap } from 'magic-string';
import { parseSync } from 'oxc-parser';
import { AnchorMissError, GraftError, lineColumn, type AnchorResult } from '@graft/core';
import type { AstNode, Program } from './anchors.js';
import { anchorFile, type Variant } from './variant.js';

export function parseCode(file: string, code: string): Program {
  const lang = /\.(c|m)?tsx?$/.test(file) ? undefined : 'js';
  const result = parseSync(file, code, { sourceType: /\.cjs$/.test(file) ? 'script' : 'module', ...(lang ? { lang } : {}) } as never);
  const fatal = result.errors.filter((e: { severity?: string }) => e.severity !== 'Warning');
  if (fatal.length) throw new GraftError(`could not parse ${file}: ${fatal[0]!.message}`, 'transform/parse');
  return result.program as unknown as Program;
}

export interface LocatedAnchor extends AnchorResult {
  node?: AstNode;
}

/** Locate every anchor assigned to `file`. Never throws for misses; reports them. */
export function locateAnchors(variant: Variant, targets: string[], file: string, code: string, program?: Program): LocatedAnchor[] {
  const ast = program ?? parseCode(file, code);
  const out: LocatedAnchor[] = [];
  for (const [name, def] of Object.entries(variant.anchors)) {
    if (anchorFile(def, targets) !== file) continue;
    const base = { name, file, description: def.description };
    let nodes: AstNode[];
    try {
      nodes = def.find({ program: ast, code, file }, ast);
    } catch (err) {
      out.push({ ...base, matched: false, error: `anchor threw: ${(err as Error).message}` });
      continue;
    }
    if (nodes.length === 0) {
      out.push({ ...base, matched: false, error: 'no match' });
    } else if (nodes.length > 1 && def.ambiguity !== 'first') {
      const lines = nodes.slice(0, 5).map((n) => lineColumn(code, n.start).line);
      out.push({ ...base, matched: false, error: `ambiguous: ${nodes.length} matches (lines ${lines.join(', ')})` });
    } else {
      const node = nodes[0]!;
      out.push({ ...base, matched: true, node, location: { ...lineColumn(code, node.start), start: node.start, end: node.end } });
    }
  }
  return out;
}

export interface TransformTargetInput {
  graftId: string;
  variant: Variant;
  targets: string[];
  /** Target file relative to the package root. */
  file: string;
  code: string;
  id: string;
  version: string;
}

export interface TransformTargetResult {
  code: string;
  map: SourceMap;
  anchors: LocatedAnchor[];
}

/**
 * Apply a variant to one target file. Throws AnchorMissError if any anchor misses,
 * and GraftError if the transform leaves the code unchanged.
 */
export function transformTarget(input: TransformTargetInput): TransformTargetResult {
  const { graftId, variant, targets, file, code, id, version } = input;
  const ast = parseCode(file, code);
  const anchors = locateAnchors(variant, targets, file, code, ast);
  const missed = anchors.filter((a) => !a.matched);
  if (missed.length) {
    throw new AnchorMissError(
      `graft "${graftId}": ${missed.map((a) => `anchor "${a.name}" ${a.error ?? 'missed'}`).join('; ')} in ${file}@${version}`,
      graftId,
      missed.map((a) => a.name),
    );
  }
  const s = new MagicString(code);
  const nodes = Object.fromEntries(anchors.map((a) => [a.name, a.node!]));
  let returned: void | string;
  try {
    returned = variant.transform({ code, id, file, version, ast, s, anchors: nodes });
  } catch (err) {
    if (err instanceof GraftError) throw err;
    throw new GraftError(`graft "${graftId}": transform threw in ${file}: ${(err as Error).message}`, 'transform/threw');
  }
  if (typeof returned === 'string') {
    if (returned === code) throw new GraftError(`graft "${graftId}": transform produced no change in ${file}`, 'transform/no-change');
    const replaced = new MagicString(code);
    replaced.overwrite(0, code.length || 0, returned);
    return { code: returned, map: replaced.generateMap({ source: id, includeContent: true, hires: 'boundary' }), anchors };
  }
  if (!s.hasChanged()) throw new GraftError(`graft "${graftId}": transform produced no change in ${file}`, 'transform/no-change');
  return { code: s.toString(), map: s.generateMap({ source: id, includeContent: true, hires: 'boundary' }), anchors };
}
