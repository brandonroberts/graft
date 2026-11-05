// Fake `graft` CLI for action tests. Behavior comes from the JSON scenario in FAKE_SCENARIO.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `graft ${args.join(' ')}\n`);
const arg = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'check') {
  const mode = scenario.check ?? 'ok';
  if (mode === 'error') {
    console.error('graft: lib is not installed; pass an explicit version');
    process.exit(2);
  }
  const report = (ok) => ({
    graft: 'lib-graft',
    package: 'lib',
    version: '1.0.0',
    variant: { range: '>=1.0.0', module: './variants/v1.patch' },
    anchors: [{ name: 'index.js#1', file: 'index.js', matched: true }],
    errors: ok ? [] : ['installed lib@1.0.0 index.js is not patched with ./variants/v1.patch; run `graft apply` (or reinstall)'],
    ok,
  });
  console.log(JSON.stringify(scenario.check === undefined ? [] : [report(mode === 'ok')]));
  process.exit(mode === 'ok' ? 0 : 1);
}
if (args[0] === 'outdated') {
  console.log(JSON.stringify(scenario.outdated));
  process.exit(0);
}
// Repo mode: a branch Graft would leave in its cache clone: `files` on top of the upstream commit
// for the version (upstream.txt added to the fork's root commit, so it shares the fork's history).
const commitRef = (ref, files, version) => {
  const run = (cmd, env = {}) => execSync(cmd, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const index = `${process.env.FAKE_LOG}.index`;
  const env = { GIT_INDEX_FILE: index };
  const write = (file, content) => {
    writeFileSync(`${index}.blob`, content);
    const oid = run(`git hash-object -w ${JSON.stringify(`${index}.blob`)}`);
    run(`git update-index --add --cacheinfo 100644,${oid},${file}`, env);
  };
  const nonce = scenario.changeUpstream ? `-${process.hrtime.bigint()}` : '';
  const upstreamRef = `refs/fake-upstream/${version}${nonce}`;
  let upstream = run(`git rev-parse -q --verify ${upstreamRef} || true`);
  if (!upstream) {
    const root = run('git rev-list --max-parents=0 HEAD');
    run(`git read-tree ${root}`, env);
    write('upstream.txt', `upstream ${version}\n`);
    upstream = run(`git -c user.name=u -c user.email=u@u commit-tree ${run('git write-tree', env)} -p ${root} -m upstream-${version}${nonce}`);
    run(`git update-ref ${upstreamRef} ${upstream}`);
  }
  run('git read-tree HEAD', env);
  write('upstream.txt', `upstream ${version}\n`);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(`${index}.blob`, content);
    const oid = run(`git hash-object -w ${JSON.stringify(`${index}.blob`)}`);
    run(`git update-index --add --cacheinfo 100644,${oid},${file}`, env);
  }
  const tree = run('git write-tree', env);
  const commit = run(`git -c user.name=g -c user.email=g@g commit-tree ${tree} -p ${upstream} -m fake`);
  run(`git update-ref refs/heads/${ref} ${commit}`);
  return { repo: '.', ref, ...(scenario.noUpstream ? {} : { upstream }) };
};
if (args[0] === 'sync' && arg('--id') && arg('--id') !== 'sync') {
  const id = arg('--id');
  const version = arg('--version');
  const mode = scenario.sync[id];
  const page = existsSync('content/page.md') ? readFileSync('content/page.md', 'utf8') : '';
  const report = (outcome, extra = {}) => ({ exitCode: 0, targets: [{ package: 'docs', version, standalone: true }], grafts: [{ id, package: 'docs', from: '1.0.0', to: version, outcome, reasons: outcome === 'green' ? [] : ['anchors: content/page.md#1 missed'], ...extra }] });
  if (mode === 'repo-green' || (mode === 'repo-conflict' && page && !page.includes('<<<<<<<'))) {
    const fetch = commitRef(`graft/${id}/${version}`, { 'content/page.md': page || `çevrildi ${version}\n`, [`.grafts/${id}/graft.md`]: `verified: ${version}\nstatus: applied\n` }, version);
    console.log(JSON.stringify(report('green', { materialized: { fetch } })));
    process.exit(0);
  }
  if (mode === 'repo-conflict') {
    const start = commitRef(`graft/${id}/${version}-agent`, { 'content/page.md': '<<<<<<< upstream\nNew English.\n=======\nTürkçe.\n>>>>>>> fork\n', [`.grafts/${id}/graft.md`]: `verified: ${version}\nstatus: conflicted\n` }, version);
    console.log(JSON.stringify(report('needs-agent', { agentStart: { ...start, conflicts: ['content/page.md'], description: 'merged with conflicts' } })));
    process.exit(1);
  }
}
if (args[0] === 'sync') {
  const pkg = arg('--package');
  const version = arg('--version');
  const mode = scenario.sync[pkg];
  const report = (outcome, reasons = []) => ({ exitCode: 0, targets: [{ package: pkg, version }], grafts: [{ id: `${pkg}-graft`, package: pkg, from: '1.0.0', to: version, outcome, reasons }] });
  const green = () => {
    mkdirSync(`.grafts/${pkg}-graft`, { recursive: true });
    writeFileSync(`.grafts/${pkg}-graft/graft.md`, `verified: ${version}\n`);
    writeFileSync('package.json', JSON.stringify({ name: 'app', dependencies: { [pkg]: version } }));
    console.log(JSON.stringify(report('green')));
    process.exit(0);
  };
  if (mode === 'green') green();
  if (mode === 'needs-agent') {
    if (existsSync('.agent-fixed')) green();
    console.log(JSON.stringify(report('needs-agent', ['anchors: lib/index.js#1 missed'])));
    process.exit(1);
  }
  if (mode === 'error') {
    console.log(JSON.stringify(report('error', ['registry unreachable'])));
    process.exit(2);
  }
}
process.exit(9);
