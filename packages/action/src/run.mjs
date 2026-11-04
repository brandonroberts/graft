// Entry point for the composite action. Inputs arrive as JSON in GRAFT_INPUTS.
import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseInputs, runAction, sh } from './sync-action.mjs';

const options = parseInputs(JSON.parse(process.env.GRAFT_INPUTS || '{}'));
const tmpDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'graft-action');

const writeOutput = async (name, value) => {
  if (!process.env.GITHUB_OUTPUT) return console.log(`${name}=${value}`);
  const delimiter = `graft_${Math.random().toString(36).slice(2)}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
};
const writeSummary = async (md) => {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  else console.log(md);
};

try {
  const { results, failed } = await runAction(options, {
    cwd: process.cwd(),
    sh,
    log: (m) => console.log(m),
    writeOutput,
    writeSummary,
    tmpDir,
    actionPath: process.env.GITHUB_ACTION_PATH || path.resolve(import.meta.dirname, '..'),
    streamAgent: true,
  });
  for (const r of results) console.log(`${r.package}: ${r.outcome}${r.pullRequest ? ` ${r.pullRequest}` : ''}`);
  if (failed) {
    console.log('::error::graft sync hit a tooling error for at least one package (see the job summary)');
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`::error::${err.message.split('\n')[0]}`);
  console.error(err);
  process.exitCode = 1;
}
