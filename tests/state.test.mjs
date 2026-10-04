// Verifies data-only state hydration, immutable reads, and durable fast-forward publication under failures and races.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readState, persistState, statePaths } from '../scripts/state.mjs';

const config = { coordinator: 'AstralDeep/astraldeep.github.io', stateBranch: 'community-state' };
const first = 'a'.repeat(40), candidate = 'c'.repeat(40);
const files = Object.fromEntries(statePaths.map(name => [name, name.endsWith('awards.json') ? '[]\n' : '{}\n']));

function fixture() {
  const state = { head: first, files: { ...files }, calls: [], tree: statePaths.map(path => ({ path, mode: '100644', type: 'blob' })), truncated: false };
  const api = { request: async (path, method = 'GET', body) => {
    state.calls.push({ path, method, body });
    if (state.error && state.error(path, method)) throw new Error('Provider unavailable');
    if (path.includes('/git/ref/heads/')) return { object: { sha: state.head } };
    if (path.includes('/git/commits/') && method === 'GET') return { tree: { sha: 'b'.repeat(40) } };
    if (path.includes('/git/trees/') && method === 'GET') return { tree: state.tree, truncated: state.truncated };
    if (path.includes('/contents/')) {
      const name = path.split('/contents/')[1].split('?')[0];
      return { type: state.fileType || 'file', encoding: state.encoding || 'base64', content: state.content ?? Buffer.from(state.files[name]).toString('base64') };
    }
    if (path.endsWith('/git/trees')) { state.pending = Object.fromEntries(body.tree.map(item => [item.path, item.content])); return { sha: 'b'.repeat(40) }; }
    if (path.endsWith('/git/commits')) return { sha: state.candidate || candidate };
    if (path.includes('/git/refs/heads/')) {
      if (state.race) throw new Error('Non-fast-forward update rejected');
      state.head = candidate; state.files = state.pending;
      if (state.ambiguous) throw new Error('Response lost');
      if (state.corrupt) state.files['data/awards.json'] = '[]';
      return {};
    }
    throw new Error(`Unexpected request ${path}`);
  } };
  return { state, api };
}

test('hydrates all ledgers from one captured commit and advances only a data-only tree', async () => {
  const f = fixture(); const snapshot = await readState(f.api, config);
  assert.deepEqual(snapshot, { sha: first, files });
  assert.ok(f.state.calls.filter(call => call.path.includes('/contents/')).every(call => call.path.endsWith(`?ref=${first}`)));
  const next = { ...files, 'data/awards.json': '[{"new":true}]\n' };
  assert.equal(await persistState(f.api, config, snapshot, next), candidate);
  const tree = f.state.calls.find(call => call.method === 'POST' && call.path.endsWith('/git/trees')).body;
  assert.deepEqual(Object.keys(tree), ['tree']);
  assert.deepEqual(tree.tree.map(item => item.path), statePaths);
  assert.deepEqual(f.state.calls.find(call => call.method === 'POST' && call.path.endsWith('/git/commits')).body.parents, [first]);
  assert.deepEqual(f.state.calls.find(call => call.method === 'PATCH').body, { sha: candidate, force: false });
  assert.deepEqual(f.state.files, next);
});

test('no-op persistence verifies current data without writes', async () => {
  const f = fixture(); const snapshot = await readState(f.api, config);
  assert.equal(await persistState(f.api, config, snapshot, files), first);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
});

test('archived reservation and activation bytes cannot be changed by award persistence', async () => {
  for (const name of statePaths.filter(path => path !== 'data/awards.json')) {
    const f = fixture(); const snapshot = await readState(f.api, config);
    await assert.rejects(persistState(f.api, config, snapshot, { ...files, [name]: '{"changed":true}' }), /immutable/);
    assert.ok(f.state.calls.every(call => call.method === 'GET'));
  }
});

test('stale snapshots and changed bytes stop before writing', async () => {
  for (const change of [state => { state.head = 'd'.repeat(40); }, state => { state.files[statePaths[0]] = '{"changed":true}'; }]) {
    const f = fixture(); const snapshot = await readState(f.api, config); change(f.state);
    await assert.rejects(persistState(f.api, config, snapshot, files), /changed/);
    assert.ok(f.state.calls.every(call => call.method === 'GET'));
  }
});

test('rejected and ambiguous writes fail closed and an applied write recovers from fresh data', async () => {
  for (const condition of ['race', 'ambiguous', 'corrupt']) {
    const f = fixture(); const snapshot = await readState(f.api, config); f.state[condition] = true;
    await assert.rejects(persistState(f.api, config, snapshot, { ...files, 'data/awards.json': '[{"saved":true}]' }));
    if (condition === 'ambiguous') {
      f.state.ambiguous = false;
      const recovered = await readState(f.api, config);
      assert.equal(await persistState(f.api, config, recovered, recovered.files), candidate);
    }
  }
});

test('unexpected files, symlinks, executable modes, missing files and truncated trees are rejected', async () => {
  const changes = [state => state.tree.push({ path: 'run.sh', mode: '100644', type: 'blob' }), state => { state.tree[0].mode = '120000'; }, state => { state.tree[0].mode = '100755'; }, state => state.tree.pop(), state => { state.truncated = true; }, state => { state.tree = null; }, state => state.tree.push({ path: 'scripts', type: 'tree' })];
  for (const change of changes) { const f = fixture(); change(f.state); await assert.rejects(readState(f.api, config), /tree/); }
});

test('missing, malformed and oversized provider data or invalid identities are rejected', async () => {
  const changes = [state => { state.head = 'bad'; }, state => { state.fileType = 'symlink'; }, state => { state.encoding = 'utf8'; }, state => { state.content = 7; }, state => { state.content = 'x'.repeat(2800001); }, state => { state.files[statePaths[0]] = 'invalid'; }, state => { state.files[statePaths[0]] = JSON.stringify('x'.repeat(2000001)); }, state => { state.error = path => path.includes('/contents/'); }];
  for (const change of changes) { const f = fixture(); change(f.state); await assert.rejects(readState(f.api, config)); }
  for (const bad of [{ ...config, stateBranch: 'main' }, { ...config, coordinator: 'other/repo' }]) await assert.rejects(readState(fixture().api, bad), /destination/);
});

test('persistence rejects invalid snapshots, file sets, contents and provider commit identity', async () => {
  for (const bad of [null, { ...files, 'extra.json': '{}' }, { ...files, 'state/claims.json': 7 }, { ...files, 'state/claims.json': 'invalid' }, { ...files, 'state/claims.json': JSON.stringify('x'.repeat(1000000)) }]) {
    const f = fixture(); const snapshot = await readState(f.api, config);
    await assert.rejects(persistState(f.api, config, snapshot, bad));
    assert.ok(f.state.calls.every(call => call.method === 'GET'));
  }
  const f = fixture(); const snapshot = await readState(f.api, config); f.state.candidate = 'bad';
  await assert.rejects(persistState(f.api, config, snapshot, { ...files, 'data/awards.json': '[{"next":true}]' }), /commit/);
  assert.ok(!f.state.calls.some(call => call.method === 'PATCH'));
});

test('workflow saves before publication, executes main code and never pushes main', async () => {
  const workflow = await readFile('.github/workflows/pages.yml', 'utf8');
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref: main\n\s+persist-credentials: false/);
  const commands = ['npm run check && npm test', 'node scripts/state-cli.mjs load', 'node scripts/run.mjs --persist-awards', 'node scripts/state-cli.mjs save', 'npm run build'];
  for (let i = 1; i < commands.length; i++) assert.ok(workflow.indexOf(commands[i - 1]) < workflow.indexOf(commands[i]));
  assert.doesNotMatch(workflow, /continue-on-error|git push|ref: community-state/);
  assert.doesNotMatch(workflow, /issues: write|notify\.mjs|persist-claims/);
  for (const args of [[], ['load'], ['save'], ['other']]) {
    const result = spawnSync(process.execPath, ['scripts/state-cli.mjs', ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: config.coordinator, GITHUB_REF: 'refs/heads/untrusted' } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /require coordinator main/);
  }
});


test('local sync reads live ledgers without mutating them and missing state never falls back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astral-live-sync-'));
  try {
    for (const path of ['scripts', 'data', 'state']) await cp(path, join(directory, path), { recursive: true });
    const historic = 'invalid historical snapshot';
    await writeFile(join(directory, 'state/claims.json'), historic);
    const bootstrap = join(directory, 'provider.mjs');
    await writeFile(bootstrap, `import { readFile } from 'node:fs/promises';
const files = {'state/claims.json':'{}','state/claim-protocol.json':'{"version":1,"enabledAt":null}','data/awards.json':'[]'};
globalThis.fetch = async (url, options) => {
  if (options.method !== 'GET') throw new Error('Unexpected provider write');
  let data;
  if (url.includes('/git/ref/heads/community-state')) {
    if (process.env.TASK_STATE_MISSING === 'true') return new Response('{}', {status:404});
    data = {object:{sha:'a'.repeat(40)}};
  } else if (url.includes('/git/commits/')) data = {tree:{sha:'b'.repeat(40)}};
  else if (url.includes('/git/trees/')) data = {truncated:false,tree:Object.keys(files).map(path=>({path,type:'blob',mode:'100644'}))};
  else if (url.includes('/contents/')) {
    const path = url.split('/contents/')[1].split('?')[0];
    data = {type:'file',encoding:'base64',content:Buffer.from(files[path]).toString('base64')};
  } else if (url.includes('/issues?')) data = [];
  else if (/\\/repos\\/[^/]+\\/[^/?]+$/.test(url)) data = {private:false,archived:false,has_issues:true};
  else throw new Error('Unexpected provider route '+url);
  return new Response(JSON.stringify(data),{status:200});
};
`);
    const run = (missing = false, args = []) => spawnSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, 'scripts/run.mjs', ...args], { cwd: directory, encoding: 'utf8', env: { ...process.env, TASK_STATE_MISSING: String(missing), GITHUB_REF: 'refs/heads/untrusted', GITHUB_REPOSITORY: config.coordinator } });
    const success = run(); assert.equal(success.status, 0, success.stderr);
    const board = await readFile(join(directory, '.cache/board.json'), 'utf8');
    assert.equal(JSON.parse(board).tasks.length, 0);
    assert.equal(await readFile(join(directory, 'state/claims.json'), 'utf8'), historic);
    const missing = run(true); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /returned 404/);
    assert.equal(await readFile(join(directory, '.cache/board.json'), 'utf8'), board);
    const denied = run(false, ['--persist-awards']); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /require the coordinator main branch/);
    const retired = run(false, ['--persist-claims']); assert.notEqual(retired.status, 0); assert.match(retired.stderr, /Expected optional --persist-awards/);
  } finally { await rm(directory, {recursive:true,force:true}); }
});
