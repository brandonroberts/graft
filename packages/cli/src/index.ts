import path from 'node:path';
import { defineCommand, type CommandDef } from 'citty';
import {
  addGraft,
  applyToProject,
  checkAnchors,
  GraftError,
  initProject,
  outdated,
  Project,
  projectStatus,
  replay,
  runOracle,
  scopeDiff,
  sync,
  type AnchorReport,
  type MechanismAdapter,
} from '@graftsync/core';
import { patchAdapter } from '@graftsync/adapter-patch';

/** Mechanisms the CLI knows about. */
export const defaultAdapters: MechanismAdapter[] = [patchAdapter];

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
}

const init = defineCommand({
  meta: { name: 'init', description: 'Create .grafts/ (and a starter graft with --package)' },
  args: {
    ...common,
    package: { type: 'string', description: 'Upstream package for a starter graft' },
    id: { type: 'string', description: 'Starter graft id (default: <package>-graft)' },
    mechanism: { type: 'string', default: 'patch', description: 'Mechanism for the starter graft' },
  },
  run: guarded(async (args) => {
    const root = path.resolve(args.root ?? process.cwd());
    const created = await initProject(root);
    if (args.package) {
      const project = await open(root);
      const id = args.id ?? `${args.package.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-graft`;
      created.push(...(await addGraft(project, { id, package: args.package, mechanism: args.mechanism })));
    }
    print(args.json, { created }, () => {
      for (const f of created) console.log(`created ${path.relative(process.cwd(), f)}`);
      if (!args.package) console.log('next: graft add <id> --package <upstream>');
    });
    return EXIT.ok;
  }),
});

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
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
    const split = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
    const files = await addGraft(project, {
      id: args.id,
      package: args.package,
      version: args.version,
      mechanism: args.mechanism,
      targets: split(args.target),
      modes: split(args.modes),
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
        const health = g.error ? `✗ ${g.error}` : !g.anchors ? (g.installed ? '—' : 'not installed') : g.anchors.ok ? '✓ anchors ok' : '✗ anchors miss';
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
  },
  run: guarded(async (args) => {
    const project = await open(args.root);
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
        console.log(`${g.outcome === 'green' ? '✓' : g.outcome === 'skipped' ? '-' : '✗'} ${g.id}  ${g.from} → ${g.to ?? '?'}  ${g.outcome}`);
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

export const main: CommandDef = defineCommand({
  meta: { name: 'graft', version: '0.1.0', description: 'Keep local modifications to upstream packages in sync' },
  subCommands: { init, add, apply, status, check, diff, sync: syncCmd, verify, outdated: outdatedCmd, replay: replayCmd },
}) as CommandDef;
