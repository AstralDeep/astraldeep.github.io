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
