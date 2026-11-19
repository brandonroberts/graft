// Run a shell command with a timeout, capturing (and optionally streaming) its output. Used for
// generators, package-manager installs and fork builds.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

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
    let forceKill: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          // The command runs in a shell: stop everything it started, not just the shell, or a
          // timed-out install keeps running (and holds the output pipes open).
          killTree(child.pid, 'SIGTERM');
          forceKill = setTimeout(() => killTree(child.pid, 'SIGKILL'), 5_000);
        }, opts.timeoutMs)
      : undefined;
    const finish = (exitCode: number | null, extra = '') => {
      if (timer) clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
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

/** Process ids of every descendant of `pid` (children first), from `/proc` on Linux and `ps` elsewhere. */
function descendants(pid: number): number[] {
  const parents = new Map<number, number[]>();
  const add = (child: number, parent: number) => parents.set(parent, [...(parents.get(parent) ?? []), child]);
  try {
    if (process.platform === 'linux') {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces and parentheses.
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          add(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
        } catch {
          // the process exited while we looked
        }
      }
    } else {
      for (const line of execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (child && parent !== undefined) add(child, parent);
      }
    }
  } catch {
    return [];
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const c of parents.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

/** Send `signal` to `pid` and all its descendants (Windows: `taskkill /T /F`). */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    return;
  }
  for (const p of [pid, ...descendants(pid)]) {
    try {
      process.kill(p, signal);
    } catch {
      // already gone
    }
  }
}
