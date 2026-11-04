import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { patchAdapter } from '@graftsync/adapter-patch';
import {
  applyGraft,
  applyToProject,
  checkAnchors,
  GraftError,
  Project,
  projectStatus,
  recordVariant,
  resolveVersion,
  runOracle,
  scopeDiff,
  sync,
  updateGraft,
  type MechanismAdapter,
} from '@graftsync/core';
import { GRAFT_STATUSES, REQUIRED_SECTIONS } from '@graftsync/spec';

/** Mechanisms the MCP server knows about (same set as the CLI). */
export const defaultAdapters: MechanismAdapter[] = [patchAdapter];

export interface GraftServerOptions {
  /** Project root. Default: GRAFT_ROOT, else the nearest directory with .grafts/ above cwd. */
  root?: string;
  adapters?: MechanismAdapter[];
  /** Override how the project is opened (tests inject an upstream source here). */
  openProject?: () => Promise<Project>;
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const MAX_TEXT = 60_000;

function ok(value: unknown, summary?: string): ToolResult {
  const json = JSON.stringify(value, null, 2);
  const text = summary ? `${summary}\n\n${json}` : json;
  return {
    content: [{ type: 'text', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value },
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof GraftError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Create the Graft MCP server. It exposes the same core operations as the CLI, so an agent
 * gets context (graft intent, anchors, scoped diffs), verification (anchors, oracle), and
 * bookkeeping (variants, status, History). Agents write variant files with their own tools.
 */
export function createGraftServer(options: GraftServerOptions = {}): McpServer {
  const adapters = options.adapters ?? defaultAdapters;
  const open =
    options.openProject ??
    (async () => {
      const root = options.root ?? process.env.GRAFT_ROOT ?? Project.findRoot(process.cwd()) ?? process.cwd();
      return Project.open({ root: path.resolve(root), adapters });
    });
  // Each call opens the project afresh, so edits an agent makes between calls are always seen.
  const tool = <A>(fn: (project: Project, args: A) => Promise<ToolResult>) => async (args: A) => {
    try {
      return await fn(await open(), args);
    } catch (err) {
      return fail(err);
    }
  };

  const server = new McpServer(
    { name: 'graft', version: '0.1.0' },
    {
      instructions:
        'Graft keeps local modifications ("grafts") to upstream npm packages in sync. Each graft has an intent file ' +
        '(.grafts/<id>/graft.md) whose Invariants are the contract and whose oracle is the only proof. Start with ' +
        'list_grafts or sync; read_graft before changing anything; never edit an existing variant file — write a new ' +
        'one for the new version range and register it with record_variant.',
    },
  );

  server.registerTool(
    'list_grafts',
    {
      title: 'List grafts',
      description: 'All grafts with status, rootstock package, verified and installed versions, and (optionally) anchor health against the installed version.',
      inputSchema: { includeAnchors: z.boolean().optional().describe('Also check anchors against installed versions (slower). Default true.') },
      annotations: { readOnlyHint: true },
    },
    tool(async (project, { includeAnchors }: { includeAnchors?: boolean }) => {
      const status = await projectStatus(project);
      const grafts = status.grafts.map((g) => ({
        ...g,
        anchors: includeAnchors === false ? undefined : g.anchors && { ok: g.anchors.ok, variant: g.anchors.variant?.module ?? null, missed: g.anchors.anchors.filter((a) => !a.matched).map((a) => a.name), errors: g.anchors.errors, warnings: g.anchors.warnings },
      }));
      return ok({ root: project.root, grafts, invalid: status.invalid }, `${grafts.length} graft(s), ${status.invalid.length} invalid`);
    }),
  );

  server.registerTool(
    'read_graft',
    {
      title: 'Read graft',
      description:
        'The full intent file (frontmatter + Why / Invariants / Where to look / Anchors / History) plus its variants with resolved paths, and which variant the installed upstream version selects. Read this before changing anything.',
      inputSchema: { id: z.string().describe('Graft id (directory name under .grafts/)') },
      annotations: { readOnlyHint: true },
    },
    tool(async (project, { id }: { id: string }) => {
      const graft = await project.get(id);
      const fm = graft.frontmatter;
      const installed = await project.installedVersion(fm.rootstock.package);
      const sections = Object.fromEntries(REQUIRED_SECTIONS.map((name) => [name, graft.sections.find((s) => s.title.toLowerCase() === name.toLowerCase())?.content ?? null]));
      return ok({
        id: graft.id,
        file: graft.file,
        dir: graft.dir,
        frontmatter: fm,
        sections,
        variants: fm.variants.map((v) => ({ ...project.resolveVariant(graft, v) })),
        installed: installed ?? null,
        selectedForInstalled: installed ? (project.selectVariant(graft, installed)?.module ?? null) : null,
        diagnostics: graft.diagnostics,
        body: graft.body,
      });
    }),
  );

  server.registerTool(
    'check_anchors',
    {
      title: 'Check anchors',
      description: 'Which anchors of the variant selected for a version match or miss in that upstream version (pristine published contents). Fast; run it after every edit to a new variant.',
      inputSchema: {
        id: z.string(),
        version: z.string().optional().describe('Upstream version (default: installed)'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (project, { id, version }: { id: string; version?: string }) => {
      const report = await checkAnchors(project, id, version);
      const missed = report.anchors.filter((a) => !a.matched).length;
      return ok(report, report.ok ? `all ${report.anchors.length} anchors match ${report.package}@${report.version}` : `${missed} anchor(s) missed, ${report.errors.length} error(s)`);
    }),
  );

  server.registerTool(
    'scope_diff',
    {
      title: 'Scoped upstream diff',
      description: "The upstream diff between two versions, narrowed to the regions the graft's anchors touch. This is what moved upstream.",
      inputSchema: {
        id: z.string(),
        from: z.string().optional().describe('From version (default: rootstock.verified)'),
        to: z.string().optional().describe('To version (default: installed)'),
        maxChars: z.number().int().positive().optional().describe('Truncate the patch text (default 40000)'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (project, { id, from, to, maxChars }: { id: string; from?: string; to?: string; maxChars?: number }) => {
      const diff = await scopeDiff(project, id, from, to);
      const limit = maxChars ?? 40_000;
      const patch = diff.patch.length > limit ? `${diff.patch.slice(0, limit)}\n…[truncated ${diff.patch.length - limit} chars]` : diff.patch;
      const files = diff.files.map((f) => ({ file: f.file, status: f.status, totalHunks: f.totalHunks, keptHunks: f.hunks.length, narrowed: f.narrowed, candidates: f.candidates }));
      return {
        content: [{ type: 'text', text: `${diff.package} ${diff.from} → ${diff.to}\n${JSON.stringify(files, null, 2)}\n\n${patch || '(no changes in target files)'}` }],
        structuredContent: { graft: diff.graft, package: diff.package, from: diff.from, to: diff.to, files, patch },
      };
    }),
  );

  server.registerTool(
    'apply_cached',
    {
      title: 'Apply existing variants',
      description: "Apply the graft's existing variant for a version to pristine upstream contents and report per-file results. Writes the modified files under .grafts/.report/<id>/applied/ for inspection. Does not install anything.",
      inputSchema: { id: z.string(), version: z.string().optional().describe('Upstream version (default: installed)') },
    },
    tool(async (project, { id, version }: { id: string; version?: string }) => {
      const result = await applyGraft(project, id, { version, outDir: path.join(project.reportDir, id, 'applied') });
      return ok(result, result.ok ? `applied ${result.variant?.module} to ${result.version}` : `apply failed for ${result.version}`);
    }),
  );

  server.registerTool(
    'apply_to_project',
    {
      title: 'Apply grafts to the project',
      description:
        "Make the project use its grafts: point the package manager at each graft's variant for the installed version (e.g. pnpm patchedDependencies), reinstall, and re-check anchors. Run after record_variant when the new variant covers the installed version, before run_oracle.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe('Graft ids (default: all active grafts)'),
        install: z.boolean().optional().describe('Reinstall afterwards (default true)'),
      },
    },
    tool(async (project, args: { ids?: string[]; install?: boolean }) => {
      const result = await applyToProject(project, args);
      return ok(result, `configured ${result.configured.length} graft(s)${result.installCommand ? `, ran ${result.installCommand}` : ''}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
    }),
  );

  server.registerTool(
    'run_oracle',
    {
      title: 'Run oracle',
      description: "Run the graft's oracle (the only proof its invariants hold) against the installed upstream, once per mode. Returns pass/fail and output per mode.",
      inputSchema: { id: z.string(), modes: z.array(z.string()).optional().describe('Subset of configured modes') },
    },
    tool(async (project, { id, modes }: { id: string; modes?: string[] }) => {
      const graft = await project.get(id);
      const result = await runOracle(project, graft, { modes, maxOutput: 8_000 });
      return ok(result, `${result.passed ? 'PASS' : 'FAIL'}: ${result.modes.map((m) => `${m.mode}=${m.passed ? 'pass' : `fail(exit ${m.exitCode})`}`).join(', ')}`);
    }),
  );

  server.registerTool(
    'record_variant',
    {
      title: 'Record variant',
      description:
        "Register a variant file you wrote (inside the graft's directory) for a version range. Never edits existing variant files; narrows overlapping open-ended ranges of older variants. With verifyVersion, refuses (and rolls back) unless all anchors match at that version. Appends a History entry.",
      inputSchema: {
        id: z.string(),
        range: z.string().describe('Semver range the new variant is valid for, e.g. ">=5.0.0-0"'),
        module: z.string().describe('Variant path relative to the graft directory, e.g. ./variants/v5.patch'),
        narrow: z.boolean().optional().describe('Narrow overlapping older ranges (default true)'),
        verifyVersion: z.string().optional().describe('Require all anchors to match at this version'),
        note: z.string().optional().describe('History note: what moved upstream and how the new variant differs'),
      },
    },
    tool(async (project, args: { id: string; range: string; module: string; narrow?: boolean; verifyVersion?: string; note?: string }) => {
      const result = await recordVariant(project, args.id, { range: args.range, module: args.module, narrow: args.narrow }, { verifyVersion: args.verifyVersion, note: args.note });
      return ok({ variants: result.graft.frontmatter.variants, narrowed: result.narrowed, anchors: result.anchors }, `recorded ${args.module} for "${args.range}"`);
    }),
  );

  server.registerTool(
    'update_status',
    {
      title: 'Update status',
      description: `Set a graft's status (${GRAFT_STATUSES.join(' | ')}), optionally its verified version, and append a History entry. Use "conflicted" when the invariants cannot be satisfied, naming the failing invariant and what was tried.`,
      inputSchema: {
        id: z.string(),
        status: z.enum(GRAFT_STATUSES).optional(),
        verified: z.string().optional().describe('Set rootstock.verified (only after the oracle passed at that version)'),
        history: z.string().optional().describe('History entry to append'),
      },
    },
    tool(async (project, args: { id: string; status?: (typeof GRAFT_STATUSES)[number]; verified?: string; history?: string }) => {
      if (args.verified) await resolveVersion(project, await project.get(args.id), args.verified);
      const graft = await updateGraft(project, args.id, args);
      return ok({ id: graft.id, status: graft.frontmatter.status, verified: graft.frontmatter.rootstock.verified }, 'updated');
    }),
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync (deterministic first pass)',
      description:
        'Re-verify grafts against an upstream version: variant selection, anchors, and apply against pristine contents; then (if all pass) install with install=true and run the oracle. Green grafts get verified bumped. Returns the report; grafts marked needs-agent include reasons and a scoped diff path.',
      inputSchema: {
        version: z.string().optional().describe('Target upstream version (default: installed). Requires a single package.'),
        package: z.string().optional(),
        ids: z.array(z.string()).optional(),
        install: z.boolean().optional().describe('Install the target version if not installed (modifies package.json and the lockfile)'),
        dryRun: z.boolean().optional().describe('Do not update graft.md on green'),
      },
    },
    tool(async (project, args: { version?: string; package?: string; ids?: string[]; install?: boolean; dryRun?: boolean }) => {
      const report = await sync(project, args);
      const slim = {
        ...report,
        grafts: report.grafts.map((g) => ({
          ...g,
          anchors: g.anchors && { ok: g.anchors.ok, missed: g.anchors.anchors.filter((a) => !a.matched), errors: g.anchors.errors },
          apply: g.apply && { ok: g.apply.ok, errors: g.apply.errors, files: g.apply.files.filter((f) => f.error) },
          oracle: g.oracle && { passed: g.oracle.passed, modes: g.oracle.modes.map((m) => ({ mode: m.mode, passed: m.passed, exitCode: m.exitCode, output: m.passed ? undefined : m.output.slice(-4_000) })) },
        })),
      };
      return ok(slim, `exit ${report.exitCode}: ${report.grafts.map((g) => `${g.id}=${g.outcome}`).join(', ') || 'no grafts'}`);
    }),
  );

  return server;
}
