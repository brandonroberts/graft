// Fake `graft` CLI for action tests. Behavior comes from the JSON scenario in FAKE_SCENARIO.
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
