import { spawn } from 'node:child_process';
import type { Graft, Workspace } from './types.js';
import type { Project } from './project.js';

export interface OracleModeResult {
  mode: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  /** Combined stdout+stderr, truncated to the last `maxOutput` characters. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface OracleResult {
  graft: string;
  version: string | undefined;
  passed: boolean;
  modes: OracleModeResult[];
  /** For standalone grafts: how to get the materialized result the oracle ran against. */
  workspace?: string;
}

export interface RunOracleOptions {
  /** Restrict to these modes (default: all configured modes). */
  modes?: string[];
  /** Upstream version under test; exported to the oracle as GRAFT_UPSTREAM_VERSION. */
  version?: string;
  maxOutput?: number;
  /** Stream output to these writers as it arrives. */
  onOutput?: (chunk: string) => void;
}

const DEFAULT_TIMEOUT_S = 600;

/** Run the graft's oracle once per mode. The oracle is the only proof that a graft holds. */
export async function runOracle(project: Project, graft: Graft, options: RunOracleOptions = {}): Promise<OracleResult> {
  const { oracle, rootstock } = graft.frontmatter;
  const version = options.version ?? (await project.currentVersion(graft));
  const modes = options.modes?.length ? oracle.modes.filter((m) => options.modes!.includes(m)) : oracle.modes;
  const adapter = project.adapterFor(graft);

  // A standalone graft installs nothing: its oracle runs in the materialized upstream source.
  let workspace: Workspace | undefined;
  if (project.isStandalone(graft)) {
    const failed = (output: string): OracleResult => ({
      graft: graft.id,
      version,
      passed: false,
      modes: modes.map((mode) => ({ mode, command: oracle.command.replaceAll('{mode}', mode), passed: false, exitCode: null, output, durationMs: 0, timedOut: false })),
    });
    if (!version) return failed(`[graft] no version to run the oracle against\n`);
    if (!adapter.workspace) return failed(`[graft] mechanism "${adapter.name}" is standalone but provides no workspace\n`);
    try {
      workspace = await adapter.workspace(project.context(graft), version);
    } catch (err) {
      return failed(`[graft] could not materialize ${rootstock.package}@${version} with the graft applied: ${(err as Error).message}\n`);
    }
  }

  const results: OracleModeResult[] = [];
  try {
    for (const mode of modes) {
      const command = oracle.command.replaceAll('{mode}', mode);
      results.push(
        await runCommand(command, {
          cwd: workspace?.dir ?? project.root,
          env: {
            GRAFT_ID: graft.id,
            GRAFT_DIR: graft.dir,
            GRAFT_MODE: mode,
            GRAFT_PACKAGE: rootstock.package,
            GRAFT_UPSTREAM_VERSION: version ?? '',
            GRAFT_PROJECT_ROOT: project.root,
            ...(workspace ? { GRAFT_WORKSPACE: workspace.dir } : {}),
          },
          timeoutMs: (oracle.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
          maxOutput: options.maxOutput ?? 20_000,
          onOutput: options.onOutput,
        }).then((r) => ({ mode, command, ...r })),
      );
    }
  } finally {
    await workspace?.dispose();
  }
  return {
    graft: graft.id,
    version,
    passed: results.length > 0 && results.every((r) => r.passed),
    modes: results,
    ...(workspace?.result ? { workspace: workspace.result } : {}),
  };
}

interface CommandResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export function runCommand(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutput?: number;
    onOutput?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 20_000;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf: Buffer) => {
      const chunk = buf.toString();
      opts.onOutput?.(chunk);
      output += chunk;
      if (output.length > max * 2) output = output.slice(-max);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : undefined;
    const finish = (exitCode: number | null, extra = '') => {
      if (timer) clearTimeout(timer);
      output += extra;
      const truncated = output.length > max ? `[…truncated…]\n${output.slice(-max)}` : output;
      resolve({
        passed: exitCode === 0 && !timedOut,
        exitCode,
        output: truncated,
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.on('error', (err) => finish(null, `\n[graft] failed to start oracle: ${err.message}\n`));
    child.on('close', (code) => finish(code, timedOut ? '\n[graft] oracle timed out\n' : ''));
  });
}
