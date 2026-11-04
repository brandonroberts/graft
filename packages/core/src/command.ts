// Run a shell command with a timeout, capturing (and optionally streaming) its output. Used for
// generators, package-manager installs and fork builds.
import { spawn } from 'node:child_process';

export interface CommandResult {
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
    child.on('error', (err) => finish(null, `\n[graft] failed to start command: ${err.message}\n`));
    child.on('close', (code) => finish(code, timedOut ? '\n[graft] command timed out\n' : ''));
  });
}
