// Oracle for the angular-tr graft. Runs in the rebased checkout ($GRAFT_WORKSPACE), a worktree
// of Graft's cache clone, so upstream revisions resolve there.
//
// pages: every page the fork had translated, as last committed (HEAD of $GRAFT_PROJECT_ROOT,
// against the `verified` recorded there), must still be translated in the result (against the
// target upstream). HEAD, not the working tree: while an agent resolves a sync, the working
// tree already holds the merged result, and comparing it with itself would prove nothing.
//   - not identical to upstream's English,
//   - no more English headings than before,
//   - no more English prose lines than before (e.g. an upstream paragraph merged in cleanly),
//   - the same shape as upstream (headings, code blocks, <docs-*> elements) wherever it had it
//     before: a translation that drops upstream's new section fails,
//   - and no conflict markers anywhere.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'pages';
const ws = process.env.GRAFT_WORKSPACE ?? process.cwd();
const project = process.env.GRAFT_PROJECT_ROOT;
const graftDir = process.env.GRAFT_DIR;
const CONTENT = 'adev/src/content';

if (mode !== 'pages') {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: ws, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const projectGit = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', maxBuffer: 1 << 28 });
/** Upstream revision for a Graft version: `X+<sha>` names a commit, otherwise the tag vX. */
const rev = (version) => {
  const [v, sha] = version.split('+');
  return git('rev-parse', `${sha ?? `refs/tags/v${v}`}^{commit}`);
};
const graftMd = path.relative(project, path.join(graftDir, 'graft.md')).split(path.sep).join('/');
const verified = /verified:\s*(\S+)/.exec(projectGit('show', `HEAD:${graftMd}`))[1];
const baseRev = rev(verified);
const targetRev = rev(process.env.GRAFT_UPSTREAM_VERSION);

/** Contents of many `rev:path` blobs at once (undefined when missing). */
function blobs(specs, cwd = ws) {
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: specs.join('\n') + '\n', maxBuffer: 1 << 30 });
  const out = r.stdout;
  const result = [];
  let i = 0;
  for (const spec of specs) {
    const nl = out.indexOf(10, i);
    const header = out.subarray(i, nl).toString();
    i = nl + 1;
    if (header.endsWith(' missing')) {
      result.push(undefined);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    result.push(out.subarray(i, i + size).toString('utf8'));
    i += size + 1;
  }
  return result;
}

const walk = (dir, rel = '') =>
  readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, path.join(rel, e.name)) : e.name.endsWith('.md') ? [path.join(rel, e.name)] : [],
  );

/** Prose lines and headings outside code fences. */
function shape(text) {
  const prose = [];
  const headings = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line) continue;
    if (/^#{1,6} /.test(line)) headings.push(line.replace(/\s*\{#[^}]*\}\s*$/, ''));
    else if (line.length >= 30 && /[a-z].* .*[a-z]/i.test(line) && !/^[<{|@]|^import /.test(line)) prose.push(line);
  }
  return { prose, headings };
}
/** A page's structure: what a translation keeps from upstream. */
function structure(text) {
  if (text === undefined) return undefined;
  const lines = text.split('\n').map((l) => l.trim());
  return [
    lines.filter((l) => /^#{1,6} /.test(l)).length,
    lines.filter((l) => /^(```|~~~)/.test(l)).length,
    (text.match(/<docs-[a-z-]+/g) ?? []).length,
  ].join('/');
}
/** How much of `text` is upstream English, verbatim. */
function english(text, upstream) {
  if (upstream === undefined) return { prose: 0, headings: 0 };
  const up = shape(upstream);
  const ups = { prose: new Set(up.prose), headings: new Set(up.headings) };
  const s = shape(text);
  return { prose: s.prose.filter((l) => ups.prose.has(l)).length, headings: s.headings.filter((h) => ups.headings.has(h)).length };
}

const files = walk(path.join(ws, CONTENT)).map((f) => path.join(CONTENT, f).split(path.sep).join('/'));
const [baseTexts, targetTexts] = [blobs(files.map((f) => `${baseRev}:${f}`)), blobs(files.map((f) => `${targetRev}:${f}`))];
const beforeTexts = blobs(files.map((f) => `HEAD:${f}`), project);
const problems = [];
let checked = 0;
files.forEach((file, i) => {
  const after = readFileSync(path.join(ws, file), 'utf8');
  if (/^(<{7}|>{7}) /m.test(after) || /^={7}$/m.test(after)) problems.push(`${file}: conflict markers`);
  const before = beforeTexts[i];
  if (before === undefined) return; // a page new upstream: not translated yet, not a regression
  if (baseTexts[i] !== undefined && before === baseTexts[i]) return; // the fork never translated it
  checked++;
  if (targetTexts[i] !== undefined && after === targetTexts[i]) {
    problems.push(`${file}: reverted to upstream's English`);
    return;
  }
  const [was, wasUp, is, isUp] = [structure(before), structure(baseTexts[i]), structure(after), structure(targetTexts[i])];
  if (was === wasUp && isUp !== undefined && is !== isUp) {
    problems.push(`${file}: structure ${is} (headings/fence lines/docs elements) no longer matches upstream's ${isUp}; upstream content was dropped or duplicated`);
  }
  const b = english(before, baseTexts[i]);
  const a = english(after, targetTexts[i]);
  if (a.headings > b.headings) problems.push(`${file}: ${a.headings - b.headings} new English heading(s)`);
  if (a.prose > b.prose) problems.push(`${file}: ${a.prose - b.prose} new English prose line(s)`);
});

console.log(`checked ${checked} translated page(s) of ${files.length}: ${verified} -> ${process.env.GRAFT_UPSTREAM_VERSION}`);
for (const p of problems) console.log(`  ✗ ${p}`);
process.exit(problems.length ? 1 : 0);
