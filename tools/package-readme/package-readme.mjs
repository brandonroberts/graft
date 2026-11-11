#!/usr/bin/env node
// Writes the repository README into a package as README.md when it is packed, so npm shows it.
// Relative links are rewritten to the release's tag on GitHub (npm resolves none of them), and a
// relative link to anything that doesn't exist in the repository is an error, never a broken link.
//
//   node ../../tools/package-readme/package-readme.mjs          # prepack: write ./README.md
//   node ../../tools/package-readme/package-readme.mjs --clean  # postpack: remove it
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'https://github.com/brandonroberts/graft';
const RAW = 'https://raw.githubusercontent.com/brandonroberts/graft';

/**
 * Rewrite the relative links and images in `markdown` to absolute GitHub URLs at `ref`:
 * directories to /tree/, files to /blob/, images to raw content. Links in fenced code blocks,
 * absolute URLs and same-page anchors are left alone.
 */
export function packageReadme(markdown, { root, ref }) {
  const missing = [];
  let fenced = false;
  const lines = markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (match, bang, text, target) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) return match;
      const hash = target.indexOf('#');
      const file = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : target.slice(hash);
      const rel = path.posix.normalize(file.replace(/^\.\//, ''));
      const abs = path.join(root, rel);
      if (rel.startsWith('..') || !existsSync(abs)) {
        missing.push(target);
        return match;
      }
      const url = bang ? `${RAW}/${ref}/${rel}` : `${REPOSITORY}/${statSync(abs).isDirectory() ? 'tree' : 'blob'}/${ref}/${rel}`;
      return `${bang}[${text}](${url}${anchor})`;
    });
  });
  if (missing.length) throw new Error(`README links to paths that don't exist in the repository: ${missing.join(', ')}`);
  return lines.join('\n');
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const out = path.resolve('README.md');
  if (process.argv.includes('--clean')) {
    rmSync(out, { force: true });
    return;
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!version) throw new Error('package.json has no version, so there is no release tag to link to');
  writeFileSync(out, packageReadme(readFileSync(path.join(root, 'README.md'), 'utf8'), { root, ref: `v${version}` }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
