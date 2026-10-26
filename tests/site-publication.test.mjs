// Enforces static publication's main-only read permissions, serialized deployment, and absence of award writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('static publication is main-only, least-privilege, pinned and serialized with the community writer', () => {
  const source = readFileSync('.github/workflows/site-pages.yml', 'utf8');
  assert.equal((source.match(/if: github.ref == 'refs\/heads\/main'/g) || []).length, 2);
  assert.match(source, /group: community-board\n  cancel-in-progress: false/);
  assert.match(readFileSync('.github/workflows/pages.yml', 'utf8'), /group: community-board\n  cancel-in-progress: false/);
  assert.match(source, /contents: read\n      actions: read/);
  assert.doesNotMatch(source, /contents: write|issues: write|persist-awards|state-cli|secrets\./);
  for (const action of source.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  for (const timeout of source.matchAll(/timeout-minutes: (\d+)/g)) assert.ok(Number(timeout[1]) <= 30);
  assert.match(source, /ref: \$\{\{ github.sha \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /git\/ref\/heads\/main/);
  assert.match(source, /\$GITHUB_SHA/);
  const loader = readFileSync('scripts/retain-site-snapshot.mjs', 'utf8');
  assert.doesNotMatch(loader, /persistState|persist-awards|synchronize\(/);
  assert.match(loader, /readState\(/);
});

test('snapshot loader refuses candidate Actions contexts before any provider call', () => {
  for (const [repository, ref] of [['other/site', 'refs/heads/main'], ['AstralDeep/astraldeep.github.io', 'refs/heads/feature']]) {
    const result = spawnSync(process.execPath, ['scripts/retain-site-snapshot.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_TOKEN: '' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires coordinator main/);
  }
});

const job = (source, name) => {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/\n  [\w-]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};
const steps = text => text.slice(text.indexOf('    steps:\n'));
const permissions = text => /    permissions:\n((?:      .+\n)+)/.exec(text)?.[1];

test('release sync redeploys Pages only for a newer release, with the static publisher\'s pinned steps', () => {
  const source = readFileSync('.github/workflows/release-sync.yml', 'utf8');
  const pages = readFileSync('.github/workflows/site-pages.yml', 'utf8');
  assert.match(source, /^on:\n  schedule:\n    - cron: '\*\/10 \* \* \* \*'\n  workflow_dispatch:\n/m);
  assert.match(source, /^permissions:\n  contents: read\n/m);
  assert.match(source, /^concurrency:\n  group: community-board\n  cancel-in-progress: false\n/m);
  const sync = job(source, 'sync');
  assert.match(sync, /^  sync:\n    if: github.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n/);
  assert.equal(permissions(sync), '      contents: read\n');
  assert.match(sync, /outputs:\n      changed: \$\{\{ steps.discover.outputs.changed \}\}/);
  assert.match(sync, /- run: npm run check && npm test\n/);
  assert.match(sync, /id: discover\n        run: node scripts\/release-discovery-cli.mjs --live https:\/\/astraldeep.github.io\/data\/downloads.json --github-output "\$GITHUB_OUTPUT"\n        env:\n          GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  for (const name of ['build', 'deploy']) {
    const mine = job(source, name);
    const theirs = job(pages, name);
    assert.match(mine, /    if: github.ref == 'refs\/heads\/main' && needs.sync.outputs.changed == 'true'\n/, name);
    assert.equal(steps(mine), steps(theirs), name);
    assert.equal(permissions(mine), permissions(theirs), name);
    assert.equal(/timeout-minutes: (\d+)/.exec(mine)[1], /timeout-minutes: (\d+)/.exec(theirs)[1], name);
  }
  assert.match(job(source, 'build'), /    needs: sync\n/);
  assert.match(job(source, 'deploy'), /    needs: \[sync, build\]\n/);
  assert.match(job(source, 'deploy'), /name: Require current main before publication/);
  assert.doesNotMatch(source, /contents: write|issues: write|persist-awards|state-cli|secrets\.|always\(\)/);
  const uses = text => [...text.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  for (const action of uses(source)) assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  assert.deepEqual([...new Set(uses(source))].sort(), [...new Set(uses(pages))].sort());
  for (const timeout of source.matchAll(/timeout-minutes: (\d+)/g)) assert.ok(Number(timeout[1]) <= 30);
});
