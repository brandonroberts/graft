import { parseDocument, type Document } from 'yaml';

const FENCE = '---';

export interface SplitDocument {
  /** Raw YAML between the fences (no fences). */
  frontmatter: string;
  /** Everything after the closing fence. */
  body: string;
  /** Line number (1-based) where the body starts. */
  bodyLine: number;
}

/** Split a graft.md file into frontmatter YAML and markdown body. */
export function splitFrontmatter(text: string): SplitDocument | null {
  const normalized = text.replace(/^﻿/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return null;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
  if (close === -1) return null;
  return {
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines.slice(close + 1).join('\n'),
    bodyLine: close + 2,
  };
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  const fm = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`;
  return `${FENCE}\n${fm}${FENCE}\n${body}`;
}

export interface Section {
  /** Heading text, trimmed. */
  title: string;
  /** Section content (without the heading line), trimmed. */
  content: string;
  /** 1-based line of the heading within the body. */
  line: number;
}

/** Extract level-2 (`## `) sections from a markdown body. Ignores headings inside code fences. */
export function parseSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { title: string; line: number; start: number } | null = null;
  let inFence = false;
  const flush = (end: number) => {
    if (!current) return;
    sections.push({
      title: current.title,
      line: current.line,
      content: lines.slice(current.start, end).join('\n').trim(),
    });
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && !line.startsWith('###')) {
      flush(i);
      current = { title: m[1]!, line: i + 1, start: i + 1 };
    }
  });
  flush(lines.length);
  return sections;
}

export function findSection(sections: Section[], title: string): Section | undefined {
  const wanted = title.toLowerCase();
  return sections.find((s) => s.title.toLowerCase() === wanted);
}

/**
 * Comment- and formatting-preserving editor for graft.md.
 * Used for bookkeeping (status, verified version, variants, history) so that
 * hand-written YAML comments and the agent-facing body survive tool edits.
 */
export class GraftDocumentEditor {
  private doc: Document;
  private body: string;

  constructor(text: string) {
    const split = splitFrontmatter(text);
    if (!split) throw new Error('graft.md has no YAML frontmatter');
    this.doc = parseDocument(split.frontmatter);
    if (this.doc.errors.length) throw new Error(`invalid frontmatter YAML: ${this.doc.errors[0]!.message}`);
    this.body = split.body;
  }

  get(path: (string | number)[]): unknown {
    const v = this.doc.getIn(path);
    return v && typeof v === 'object' && 'toJSON' in v ? (v as { toJSON(): unknown }).toJSON() : v;
  }

  set(path: (string | number)[], value: unknown): this {
    this.doc.setIn(path, value);
    return this;
  }

  setStatus(status: string): this {
    return this.set(['status'], status);
  }

  setVerified(version: string): this {
    return this.set(['rootstock', 'verified'], version);
  }

  /** Append a variant entry. Existing entries are left untouched except where `rangeUpdates` says so. */
  addVariant(variant: { range: string; module: string }, rangeUpdates: Map<number, string> = new Map()): this {
    for (const [index, range] of rangeUpdates) this.doc.setIn(['variants', index, 'range'], range);
    const node = this.doc.createNode({ range: variant.range, module: variant.module });
    const seq = this.doc.getIn(['variants']);
    if (seq && typeof seq === 'object' && 'add' in seq) {
      (seq as { add(n: unknown): void }).add(node);
    } else {
      this.doc.setIn(['variants'], [variant]);
    }
    return this;
  }

  /** Append a bullet to the `## History` section, creating it if missing. */
  appendHistory(entry: string, date: string = new Date().toISOString().slice(0, 10)): this {
    const bullet = `- ${date}: ${entry.trim().replace(/\n+/g, ' ')}`;
    const lines = this.body.split('\n');
    let start = -1;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && /^##\s+history\s*$/i.test(line.trim())) {
        start = i;
        break;
      }
    }
    if (start === -1) {
      const trimmed = this.body.replace(/\s*$/, '');
      this.body = `${trimmed}\n\n## History\n\n${bullet}\n`;
      return this;
    }
    // Find end of the History section: next level-1/2 heading (outside code fences).
    let end = lines.length;
    inFence = false;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && /^#{1,2}\s/.test(line)) {
        end = i;
        break;
      }
    }
    // Insert after the last non-blank line of the section.
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
    const needsBlank = insertAt === start + 1;
    lines.splice(insertAt, 0, ...(needsBlank ? ['', bullet] : [bullet]));
    this.body = lines.join('\n');
    return this;
  }

  toString(): string {
    return joinFrontmatter(this.doc.toString(), this.body);
  }
}
