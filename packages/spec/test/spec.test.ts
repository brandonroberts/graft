import { describe, expect, it } from 'vitest';
import { GraftDocumentEditor, parseGraft, selectVariant } from '../src/index.js';

const doc = (fm: string, body = '## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- h\n') =>
  `---\n${fm}\n---\n${body}`;
const FM = `id: x
rootstock: { package: p, verified: 1.2.0 }
mechanism: patch
# keep me
variants:
  - range: ">=1.0.0"
    module: ./v1.patch
oracle: { command: "true" }`;

describe('parseGraft', () => {
  it('accepts a valid graft and applies defaults', () => {
    const r = parseGraft(doc(FM), { directoryName: 'x' });
    expect(r.ok).toBe(true);
    expect(r.graft?.frontmatter.status).toBe('applied');
    // A leftover oracle block (from before 0.2) is ignored, with a warning saying why.
    expect(r.graft).toBeDefined();
    expect(r.diagnostics.find((d) => d.code === 'frontmatter/oracle-ignored')).toMatchObject({ severity: 'warning', path: 'oracle' });
  });

  it('reports missing sections, bad ranges, overlaps and id mismatch', () => {
    const bad = FM.replace('">=1.0.0"', '">=1.0.0"\n    module: ./a.patch\n  - range: ">=1.5.0"').replace('./v1.patch', './b.patch');
    const r = parseGraft(doc(bad, '## Why\nw\n'), { directoryName: 'y' });
    const codes = r.diagnostics.map((d) => d.code);
    expect(r.ok).toBe(false);
    expect(codes).toContain('body/missing-section');
    expect(codes).toContain('variants/overlap');
    expect(codes).toContain('frontmatter/id-mismatch');
  });

  it('accepts a generator that writes to {out}, and rejects one that does not', () => {
    const ok = parseGraft(doc(`${FM}\ngenerator: { command: "node gen.mjs {version} {out}" }`), { directoryName: 'x' });
    expect(ok.ok).toBe(true);
    expect(ok.graft?.frontmatter.generator?.command).toBe('node gen.mjs {version} {out}');
    const bad = parseGraft(doc(`${FM}\ngenerator: { command: "node gen.mjs {version}" }`), { directoryName: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.map((d) => d.message).join('\n')).toMatch(/\{out\}/);
  });

  it('selects variants including prereleases', () => {
    const variants = [{ range: '>=1.0.0 <2.0.0-0' }, { range: '>=2.0.0-0' }];
    expect(selectVariant(variants, '2.0.0-rc.1')).toBe(variants[1]);
    expect(selectVariant(variants, '1.9.0')).toBe(variants[0]);
  });
});

describe('GraftDocumentEditor', () => {
  it('edits bookkeeping fields while preserving comments and body', () => {
    const out = new GraftDocumentEditor(doc(FM))
      .setVerified('1.3.0')
      .setStatus('conflicted')
      .addVariant({ range: '>=2.0.0', module: './v2.patch' }, new Map([[0, '>=1.0.0 <2.0.0']]))
      .appendHistory('bumped', '2026-11-03')
      .toString();
    expect(out).toContain('# keep me');
    expect(out).toContain('verified: 1.3.0');
    expect(out).toContain('status: conflicted');
    expect(out).toMatch(/range: ">=1.0.0 <2.0.0"|range: >=1.0.0 <2.0.0/);
    expect(out).toContain('./v2.patch');
    expect(out.trimEnd().endsWith('- 2026-11-03: bumped')).toBe(true);
    expect(parseGraft(out).ok).toBe(true);
  });
});
