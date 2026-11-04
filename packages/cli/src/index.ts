import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineCommand, type CommandDef } from 'citty';
import {
  addGraft,
  applyGraft,
  applyInstalled,
  applyToProject,
  captureVariant,
  checkAnchors,
  GraftError,
  initProject,
  outdated,
  Project,
  projectStatus,
  recordVariant,
  replay,
  resolveVersion,
  runOracle,
  scopeDiff,
  setupAgent,
  sync,
  updateGraft,
  type AnchorReport,
  type MechanismAdapter,
} from '@graftsync/core';
import { patchAdapter } from '@graftsync/adapter-patch';
import { forkAdapter } from '@graftsync/adapter-fork';
import { GRAFT_STATUSES, REQUIRED_SECTIONS, type GraftStatus } from '@graftsync/spec';

/** Mechanisms the CLI knows about. */
export const defaultAdapters: MechanismAdapter[] = [patchAdapter, forkAdapter];

const EXIT = { ok: 0, attention: 1, tooling: 2 } as const;

const common = {
  root: { type: 'string', description: 'Project root (default: nearest directory with .grafts/)' },
  json: { type: 'boolean', description: 'Print machine-readable JSON' },
} as const;

async function open(root: string | undefined): Promise<Project> {
  const resolved = root ? path.resolve(root) : (Project.findRoot(process.cwd()) ?? process.cwd());
  return Project.open({ root: resolved, adapters: defaultAdapters });
}

const print = (json: boolean | undefined, value: unknown, human: () => void) => {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human();
};

/** Run a command body, mapping errors to exit code 2 (tooling error). */
const guarded =
  <A>(fn: (args: A) => Promise<number>) =>
  async ({ args }: { args: A }) => {
    try {
      process.exitCode = await fn(args);
    } catch (err) {
      console.error(err instanceof GraftError ? `graft: ${err.message}` : err);
      process.exitCode = EXIT.tooling;
    }
  };

function printAnchors(report: AnchorReport): void {
  console.log(`${report.graft}: ${report.package}@${report.version} → ${report.variant ? report.variant.module : '(no variant)'}`);
  for (const a of report.anchors) {
    const where = a.location ? `:${a.location.line}` : '';
    console.log(`  ${a.matched ? '✓' : '✗'} ${a.name} ${a.file}${where}${a.description ? ` — ${a.description}` : ''}${a.error ? ` (${a.error})` : ''}`);
  }
  for (const e of report.errors) console.log(`  ✗ ${e}`);
  if (report.upstreamed) {
    console.log(`  ⇡ likely upstreamed: ${report.package}@${report.version} already contains this graft's change; confirm and set status: upstreamed`);
    for (const e of report.upstreamed.evidence) console.log(`    ${e}`);
  }
  for (const w of report.warnings ?? []) console.log(`  ! ${w}`);
}

const init = defineCommand({
  meta: { name: 'init', description: 'Create .grafts/ (and a starter graft with --package; agent setup with --agent)' },
  args: {
    ...common,
    agent: {
      type: 'boolean',
      description: "Also onboard coding agents: install the graft-sync skill (it drives Graft through this CLI) into the project's agent skills folders",
    },
    'skills-dir': {
      type: 'string',
      description: 'With --agent: install into this skills folder instead of detecting (comma-separated for several), e.g. .agents/skills',
    },
    package: { type: 'string', description: 'Upstream package for a starter graft' },
    id: { type: 'string', description: 'Starter graft id (default: <package>-graft)' },
    mechanism: { type: 'string', default: 'patch', description: 'Mechanism for the starter graft' },
  },
  run: guarded(async (args) => {
    const root = path.resolve(args.root ?? process.cwd());
    // Agent setup first: if no skills folder can be found, fail before creating anything.
    const skillsDirs = args['skills-dir']?.split(',').map((d) => d.trim()).filter(Boolean);
    const agent = args.agent ? await setupAgent(root, { skill: await readBundledSkill(), skillsDirs }) : undefined;
    const created = await initProject(root);
    if (args.package) {
      const project = await open(root);
      const id = args.id ?? `${args.package.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-graft`;
      created.push(...(await addGraft(project, { id, package: args.package, mechanism: args.mechanism })));
    }
    print(args.json, { created, agent }, () => {
      for (const f of created) console.log(`created ${path.relative(process.cwd(), f)}`);
      for (const d of agent?.skillsDirs ?? []) if (d.reason !== 'requested') console.log(`skills    ${d.dir} (${d.reason})`);
      for (const f of agent?.files ?? []) {
        const what = { created: 'created', updated: 'updated', unchanged: 'up to date' }[f.action];
        console.log(`${what.padEnd(10)} ${path.relative(process.cwd(), f.file)}`);
      }
      for (const n of agent?.notes ?? []) console.log(`note: ${n}`);
      if (!args.package) console.log('next: graft add <id> --package <upstream>');
    });
    return EXIT.ok;
  }),
});

/** The graft-sync skill shipped in @graftsync/skill. */
async function readBundledSkill(): Promise<string> {
  const file = createRequire(import.meta.url).resolve('@graftsync/skill/SKILL.md');
  return readFile(file, 'utf8');
}

const add = defineCommand({
  meta: { name: 'add', description: 'Scaffold graft.md, a variant stub, and an oracle stub' },
  args: {
    ...common,
    id: { type: 'positional', required: true, description: 'Graft id (kebab-case)' },
    package: { type: 'string', required: true, description: 'Upstream npm package' },
    version: { type: 'string', description: 'Upstream version (default: installed)' },
    mechanism: { type: 'string', default: 'patch', description: 'Mechanism adapter' },
    target: { type: 'string', description: 'Comma-separated target files in the package' },
    modes: { type: 'string', description: 'Comma-separated oracle modes (default: default)' },
    'in-place': { type: 'boolean', description: 'fork: the graft lives in the fork itself (repo: ., repo mode, variant { @worktree, @verified })' },
    'repo-mode': { type: 'boolean', description: 'fork: the fork is the product, nothing is installed (install: none)' },
    'fork-repo': { type: 'string', description: 'fork: git URL (or path) of the fork' },
    upstream: { type: 'string', description: "fork: git URL of the upstream repo (in place, default: the checkout's `upstream` remote)" },
    tag: { type: 'string', description: 'fork: upstream release tag pattern (default: v{version})' },
    track: { type: 'string', description: 'fork, repo mode: upstream branch whose tip `outdated` offers' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const split = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
    const options = Object.fromEntries(
      Object.entries({
        inPlace: args['in-place'],
        repoMode: args['repo-mode'],
        repo: args['fork-repo'],
        upstream: args.upstream,
        tag: args.tag,
        track: args.track,
      }).filter(([, v]) => v !== undefined && v !== false && v !== ''),
    ) as Record<string, string | boolean>;
    const flag: Record<string, string> = { inPlace: '--in-place', repoMode: '--repo-mode', repo: '--fork-repo', upstream: '--upstream', tag: '--tag', track: '--track' };
    if (Object.keys(options).length && args.mechanism !== 'fork') {
      const used = Object.keys(options).map((k) => flag[k]);
      throw new GraftError(`${used.join(', ')} ${used.length > 1 ? 'apply' : 'applies'} only to --mechanism fork`, 'add/options');
    }
    const files = await addGraft(project, {
      id: args.id,
      package: args.package,
      version: args.version,
      mechanism: args.mechanism,
      targets: split(args.target),
      modes: split(args.modes),
      options,
    });
    print(args.json, { created: files }, () => files.forEach((f) => console.log(`created ${path.relative(process.cwd(), f)}`)));
    return EXIT.ok;
  }),
});

const status = defineCommand({
  meta: { name: 'status', description: 'List grafts, rootstock versions, status, and anchor health' },
  args: common,
  run: guarded(async (args) => {
    const project = await open(args.root);
    const result = await projectStatus(project);
    const unhealthy = result.invalid.length > 0 || result.grafts.some((g) => g.error || (g.anchors && !g.anchors.ok));
    print(args.json, result, () => {
      if (!result.grafts.length && !result.invalid.length) console.log('no grafts (run `graft add`)');
      for (const g of result.grafts) {
        const health = g.error ? `✗ ${g.error}` : !g.anchors ? (g.installed ? '—' : 'not installed') : g.anchors.ok ? '✓ anchors ok' : g.anchors.upstreamed ? '✗ anchors miss (likely upstreamed)' : '✗ anchors miss';
        console.log(`${g.id}  ${g.package}  verified ${g.verified}  installed ${g.installed ?? '—'}  ${g.status}  ${health}`);
        if (g.anchors && !g.anchors.ok) printAnchors(g.anchors);
      }
      for (const g of result.invalid) {
        console.log(`${g.id}  ✗ invalid`);
        for (const e of g.errors) console.log(`  - ${e}`);
      }
    });
    return result.invalid.length ? EXIT.tooling : unhealthy ? EXIT.attention : EXIT.ok;
  }),
});

const check = defineCommand({
  meta: { name: 'check', description: 'Check anchors against the installed or a specified upstream version' },
  args: {
    ...common,
    id: { type: 'positional', required: false, description: 'Graft id (default: all active grafts)' },
    version: { type: 'string', description: 'Upstream version (default: installed)' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const ids = args.id
      ? [args.id]
      : (await project.loadAll()).grafts.filter((g) => ['applied', 'conflicted'].includes(g.frontmatter.status)).map((g) => g.id);
    const reports: AnchorReport[] = [];
    for (const id of ids) reports.push(await checkAnchors(project, id, args.version));
    print(args.json, reports, () => reports.forEach(printAnchors));
    return reports.every((r) => r.ok) ? EXIT.ok : EXIT.attention;
  }),
});

const apply = defineCommand({
  meta: { name: 'apply', description: 'Point the package manager at each graft\'s selected variant, reinstall, and re-check' },
  args: {
    ...common,
    id: { type: 'positional', required: false, description: 'Graft id (default: all active grafts)' },
    install: { type: 'boolean', default: true, description: 'Reinstall afterwards (--no-install to only write config)' },
    installed: {
      type: 'boolean',
      description: "Apply variants directly to installed packages (Graft's built-in applier; run from postinstall). Offline and idempotent; exits 1 if any graft does not fit.",
    },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    if (args.installed) {
      const { reports, ok } = await applyInstalled(project, { ids: args.id ? [args.id] : undefined });
      print(args.json, { reports, ok }, () => {
        for (const r of reports) {
          for (const c of r.copies) {
            const where = c.primary ? '' : ` (nested: ${path.relative(project.root, c.dir)})`;
            if (c.action === 'patched' || c.action === 'already-patched') console.log(`graft: ${c.action === 'patched' ? 'patched' : 'already patched'} ${r.package}@${c.version} with ${r.graft}${where}`);
          }
          for (const w of r.warnings) console.log(`graft: warning: ${w}`);
          for (const e of r.errors) console.error(`graft: error: ${e}`);
        }
        if (!ok) console.error('graft: one or more grafts could not be applied; failing the install so the package is never left silently unmodified');
      });
      return ok ? EXIT.ok : EXIT.attention;
    }
    const result = await applyToProject(project, { ids: args.id ? [args.id] : undefined, install: args.install });
    print(args.json, result, () => {
      for (const c of result.configured) console.log(`configured ${c.id}: ${c.package}@${c.version} → ${c.variant}`);
      if (result.installCommand) console.log(`ran ${result.installCommand}`);
      result.anchors.forEach(printAnchors);
      for (const e of result.errors) console.log(`✗ ${e.id}: ${e.error}`);
    });
    return result.errors.length ? EXIT.tooling : result.anchors.every((a) => a.ok) ? EXIT.ok : EXIT.attention;
  }),
});

const diff = defineCommand({
  meta: { name: 'diff', description: 'Print the scoped upstream diff for a graft' },
  args: {
    ...common,
    id: { type: 'positional', required: true },
    from: { type: 'positional', required: false, description: 'From version (default: rootstock.verified)' },
    to: { type: 'positional', required: false, description: 'To version (default: installed)' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const result = await scopeDiff(project, args.id, args.from, args.to);
    print(args.json, result, () => process.stdout.write(result.patch || `no changes in target files between ${result.from} and ${result.to}\n`));
    return EXIT.ok;
  }),
});

const syncCmd = defineCommand({
  meta: { name: 'sync', description: 'Re-verify grafts against an upstream version (deterministic first pass)' },
  args: {
    ...common,
    version: { type: 'string', description: 'Target upstream version (default: installed)' },
    package: { type: 'string', description: 'Only grafts on this upstream package' },
    id: { type: 'string', description: 'Comma-separated graft ids' },
    install: { type: 'boolean', description: 'Install the target version if it is not installed' },
    'dry-run': { type: 'boolean', description: 'Do not update graft.md on success' },
    quiet: { type: 'boolean', description: 'Do not stream oracle output' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const report = await sync(project, {
      version: args.version,
      package: args.package,
      ids: args.id?.split(',').map((s) => s.trim()).filter(Boolean),
      install: args.install,
      dryRun: args['dry-run'],
      onProgress: args.json ? undefined : (m) => console.error(`graft: ${m}`),
      onOutput: args.json || args.quiet ? undefined : (c) => process.stderr.write(c),
    });
    print(args.json, report, () => {
      for (const g of report.grafts) {
        console.log(`${g.outcome === 'green' ? '✓' : g.outcome === 'skipped' ? '-' : '✗'} ${g.id}  ${g.from} → ${g.to ?? '?'}  ${g.outcome}${g.likelyUpstreamed ? ' (likely upstreamed)' : ''}`);
        if (g.regenerated) console.log(`    ${g.regenerated.rolledBack ? 'rolled back regenerated' : 'regenerated'} variant ${g.regenerated.module} with \`${g.regenerated.command}\``);
        for (const r of g.reasons) console.log(`    ${r}`);
      }
      if (report.reportFiles) console.log(`report: ${path.relative(process.cwd(), report.reportFiles.markdown)}`);
    });
    return report.exitCode;
  }),
});

const verify = defineCommand({
  meta: { name: 'verify', description: "Run a graft's oracle in all configured modes" },
  args: {
    ...common,
    id: { type: 'positional', required: true },
    mode: { type: 'string', description: 'Comma-separated subset of modes' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const graft = await project.get(args.id);
    const result = await runOracle(project, graft, {
      modes: args.mode?.split(','),
      onOutput: args.json ? undefined : (c) => process.stdout.write(c),
    });
    print(args.json, result, () => {
      for (const m of result.modes) console.log(`${m.passed ? '✓' : '✗'} ${m.mode} (exit ${m.exitCode}, ${m.durationMs}ms)`);
    });
    return result.passed ? EXIT.ok : EXIT.attention;
  }),
});

const outdatedCmd = defineCommand({
  meta: { name: 'outdated', description: 'Find newer upstream versions (dist-tags) to sync against' },
  args: { ...common, tags: { type: 'string', description: 'Comma-separated dist-tags (default: latest,next,rc,beta)' } },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const entries = await outdated(project, { tags: args.tags?.split(',') });
    print(args.json, entries, () => {
      for (const e of entries) {
        console.log(`${e.package}  verified ${e.verified}  ${e.candidate ? `→ ${e.candidate.version} (${e.candidate.tag})` : 'up to date'}  [${e.grafts.join(', ')}]`);
      }
    });
    return EXIT.ok;
  }),
});

const replayCmd = defineCommand({
  meta: { name: 'replay', description: "Replay a graft's static checks across published upstream versions" },
  args: {
    ...common,
    id: { type: 'positional', required: true },
    range: { type: 'string', description: 'Only versions in this semver range' },
    prerelease: { type: 'boolean', description: 'Include prereleases' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const entries = await replay(project, args.id, {
      range: args.range,
      prerelease: args.prerelease,
      onProgress: args.json ? undefined : (e) => console.log(`${e.ok ? '✓' : '✗'} ${e.version.padEnd(12)} ${e.variant ?? '—'}  ${e.ok ? '' : e.summary}`),
    });
    if (args.json) console.log(JSON.stringify(entries, null, 2));
    else console.log(`${entries.filter((e) => e.ok).length}/${entries.length} versions pass static checks`);
    return EXIT.ok;
  }),
});

const show = defineCommand({
  meta: { name: 'show', description: "A graft's intent, variants (resolved paths) and the variant selected for the installed version" },
  args: { ...common, id: { type: 'positional', required: true, description: 'Graft id' } },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const graft = await project.get(args.id);
    const fm = graft.frontmatter;
    const installed = await project.currentVersion(graft);
    const selected = installed ? project.selectVariant(graft, installed) : null;
    const sections = Object.fromEntries(
      REQUIRED_SECTIONS.map((name) => [name, graft.sections.find((x) => x.title.toLowerCase() === name.toLowerCase())?.content ?? null]),
    );
    const value = {
      id: graft.id,
      file: graft.file,
      dir: graft.dir,
      frontmatter: fm,
      sections,
      variants: fm.variants.map((v) => project.resolveVariant(graft, v)),
      installed: installed ?? null,
      selectedForInstalled: selected?.module ?? null,
      diagnostics: graft.diagnostics,
    };
    print(args.json, value, () => {
      console.log(`${graft.id}: ${fm.rootstock.package} (verified ${fm.rootstock.verified}, installed ${installed ?? '—'}) · ${fm.mechanism} · ${fm.status}`);
      for (const v of value.variants) console.log(`  ${v.module === value.selectedForInstalled ? '▶' : ' '} ${v.range.padEnd(20)} ${v.module}`);
      console.log(`  oracle: ${fm.oracle.command} [${fm.oracle.modes.join(', ')}]`);
      for (const d of graft.diagnostics) console.log(`  ${d.severity}: ${d.message}`);
      console.log(`  intent: ${path.relative(process.cwd(), graft.file)}`);
    });
    return EXIT.ok;
  }),
});

const preview = defineCommand({
  meta: {
    name: 'preview',
    description: "Apply a graft's selected variant to pristine upstream and write the modified files to a folder for inspection (installs nothing)",
  },
  args: {
    ...common,
    id: { type: 'positional', required: true, description: 'Graft id' },
    version: { type: 'string', description: 'Upstream version (default: installed)' },
    out: { type: 'string', description: 'Output folder (default: .grafts/.report/<id>/applied)' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const outDir = args.out ? path.resolve(args.out) : path.join(project.reportDir, args.id, 'applied');
    const result = await applyGraft(project, args.id, { version: args.version, outDir });
    print(args.json, result, () => {
      console.log(`${result.graft}: ${result.variant?.module ?? '(no variant)'} on ${result.version}`);
      for (const f of result.files) console.log(`  ${f.error ? '✗' : '✓'} ${f.file}${f.outputPath ? ` → ${path.relative(process.cwd(), f.outputPath)}` : ''}${f.error ? ` (${f.error})` : ''}`);
      for (const e of result.errors) console.log(`  ✗ ${e}`);
    });
    return result.ok ? EXIT.ok : EXIT.attention;
  }),
});

const variantAdd = defineCommand({
  meta: {
    name: 'add',
    description: 'Register a variant file you wrote for a version range. Never edits existing variants; narrows overlapping open-ended older ranges; appends History',
  },
  args: {
    ...common,
    id: { type: 'positional', required: true, description: 'Graft id' },
    range: { type: 'string', required: true, description: 'Semver range the variant is valid for, e.g. ">=5.0.0-0"' },
    module: { type: 'string', required: true, description: 'Variant path relative to the graft directory, e.g. ./variants/v5.patch' },
    'verify-version': { type: 'string', description: 'Refuse (and roll back) unless all anchors match at this version' },
    narrow: { type: 'boolean', default: true, description: 'Narrow overlapping older ranges (--no-narrow to refuse instead)' },
    note: { type: 'string', description: 'History note: what moved upstream and how the variant differs' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const result = await recordVariant(
      project,
      args.id,
      { range: args.range, module: args.module, narrow: args.narrow },
      { verifyVersion: args['verify-version'], note: args.note },
    );
    const value = { variants: result.graft.frontmatter.variants, narrowed: result.narrowed, anchors: result.anchors };
    print(args.json, value, () => {
      console.log(`recorded ${args.module} for "${args.range}"`);
      for (const n of result.narrowed) console.log(`  narrowed ${n.module}: "${n.from}" → "${n.to}"`);
      if (result.anchors) printAnchors(result.anchors);
    });
    return EXIT.ok;
  }),
});

const variant = defineCommand({
  meta: { name: 'variant', description: 'Manage variants (add)' },
  subCommands: { add: variantAdd },
});

const capture = defineCommand({
  meta: { name: 'capture', description: "Turn your edit of the installed package into the graft's variant (diff against the published package)" },
  args: {
    ...common,
    id: { type: 'positional', required: true, description: 'Graft id' },
    version: { type: 'string', description: 'Installed upstream version (default: installed)' },
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const result = await captureVariant(project, args.id, { version: args.version });
    print(args.json, result, () => {
      const files = result.apply.files.map((f) => f.file);
      console.log(
        result.replacedStub
          ? `captured ${result.module} (${files.length} file(s): ${files.join(', ')})`
          : `captured ${result.module} as a new variant for "${result.range}" (${files.length} file(s): ${files.join(', ')})`,
      );
      console.log(`next: graft apply (so installs apply it), then write the oracle and graft verify ${result.graft}`);
    });
    return EXIT.ok;
  }),
});

const mark = defineCommand({
  meta: {
    name: 'mark',
    description: `Set a graft's status (${GRAFT_STATUSES.join(' | ')}) and/or verified version, and append a History entry`,
  },
  args: {
    ...common,
    id: { type: 'positional', required: true, description: 'Graft id' },
    status: { type: 'string', description: GRAFT_STATUSES.join(' | ') },
    verified: { type: 'string', description: 'Set rootstock.verified (only after the oracle passed at that version)' },
    history: { type: 'string', description: 'History entry to append' },
  },
  run: guarded(async (args) => {
    if (!args.status && !args.verified && !args.history) throw new GraftError('nothing to change: pass --status, --verified and/or --history', 'cli/usage');
    const project = await open(args.root);
    if (args.verified) await resolveVersion(project, await project.get(args.id, { allowConflicts: true }), args.verified);
    const graft = await updateGraft(project, args.id, { status: args.status as GraftStatus | undefined, verified: args.verified, history: args.history });
    const value = { id: graft.id, status: graft.frontmatter.status, verified: graft.frontmatter.rootstock.verified };
    print(args.json, value, () => console.log(`${value.id}: status ${value.status}, verified ${value.verified}`));
    return EXIT.ok;
  }),
});

/** This package's version, from its own package.json (next to dist/, in the repo and when published). */
const CLI_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const main: CommandDef = defineCommand({
  meta: { name: 'graft', version: CLI_VERSION, description: 'Keep local modifications to upstream packages in sync' },
  subCommands: { init, add, capture, show, apply, preview, status, check, diff, sync: syncCmd, verify, variant, mark, outdated: outdatedCmd, replay: replayCmd },
}) as CommandDef;
