// Verifies the Vessel docs check catches missing, changed, extra and unreachable files, and that the committed copy and a built _site pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkDocs } from '../scripts/vessel-docs.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const PAGES = { 'index.html': '<h1>home</h1>', 'run/pairing/index.html': '<h1>pairing</h1>' };
const sitemap = urls => `<urlset>${urls.map(url => `<url><loc>https://astraldeep.github.io/AstralVessel/${url}</loc></url>`).join('')}</urlset>`;

const fixture = async (mutate = async () => {}) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-vessel-docs-'));
  const files = { ...PAGES, 'sitemap.xml': sitemap(['', 'run/pairing/']) };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const manifest = { commit: 'a'.repeat(40), files: Object.entries(files).map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: digest(text) })) };
  await writeFile(join(root, 'astral-docs.json'), JSON.stringify(manifest));
  await mutate(root, manifest);
  return root;
};
const withFixture = async (mutate, assertion) => {
  const root = await fixture(mutate);
  try { await assertion(await checkDocs(root)); }
  finally { assert.ok(root.startsWith(join(tmpdir(), 'astral-vessel-docs-'))); await rm(root, { recursive: true, force: true }); }
};

test('a matching folder passes', () => withFixture(undefined, problems => assert.deepEqual(problems, [])));
test('a missing page fails', () => withFixture(root => rm(join(root, 'run/pairing/index.html')), problems => assert.deepEqual(problems, ['missing file: run/pairing/index.html', 'sitemap path has no page: https://astraldeep.github.io/AstralVessel/run/pairing/'])));
test('a changed byte fails', () => withFixture(root => writeFile(join(root, 'index.html'), '<h1>homE</h1>'), problems => assert.deepEqual(problems, ['content differs: index.html'])));
test('a changed size fails', () => withFixture(root => writeFile(join(root, 'index.html'), '<h1>home!</h1>'), problems => assert.deepEqual(problems, ['size differs: index.html'])));
test('an extra file fails', () => withFixture(root => writeFile(join(root, 'extra.html'), 'x'), problems => assert.deepEqual(problems, ['extra file: extra.html'])));
test('a sitemap path with no page fails', () => withFixture(async (root, manifest) => {
  const text = sitemap(['', 'run/pairing/', 'run/ghost/']);
  await writeFile(join(root, 'sitemap.xml'), text);
  Object.assign(manifest.files.find(file => file.path === 'sitemap.xml'), { size: Buffer.byteLength(text), sha256: digest(text) });
  await writeFile(join(root, 'astral-docs.json'), JSON.stringify(manifest));
}, problems => assert.deepEqual(problems, ['sitemap path has no page: https://astraldeep.github.io/AstralVessel/run/ghost/'])));
test('a sitemap URL outside the docs fails', () => withFixture(async (root, manifest) => {
  const text = '<urlset><url><loc>https://example.com/x/</loc></url></urlset>';
  await writeFile(join(root, 'sitemap.xml'), text);
  Object.assign(manifest.files.find(file => file.path === 'sitemap.xml'), { size: Buffer.byteLength(text), sha256: digest(text) });
  await writeFile(join(root, 'astral-docs.json'), JSON.stringify(manifest));
}, problems => assert.deepEqual(problems, ['sitemap URL outside the docs: https://example.com/x/'])));
test('a missing sitemap fails', () => withFixture(async (root, manifest) => {
  await rm(join(root, 'sitemap.xml'));
  manifest.files = manifest.files.filter(file => file.path !== 'sitemap.xml');
  await writeFile(join(root, 'astral-docs.json'), JSON.stringify(manifest));
}, problems => assert.deepEqual(problems, ['missing file: sitemap.xml'])));
test('unsafe manifest paths fail', () => withFixture(async (root, manifest) => {
  manifest.files.push({ path: '../escape', size: 0, sha256: '' }, { path: 'astral-docs.json', size: 0, sha256: '' });
  await writeFile(join(root, 'astral-docs.json'), JSON.stringify(manifest));
}, problems => assert.deepEqual(problems, ['unsafe manifest path: ../escape', 'unsafe manifest path: astral-docs.json'])));
test('a missing or malformed manifest fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-vessel-docs-'));
  try {
    assert.match((await checkDocs(root))[0], /astral-docs\.json is missing or not JSON/);
    await writeFile(join(root, 'astral-docs.json'), '{"files":1}');
    assert.deepEqual(await checkDocs(root), ['astral-docs.json has no commit or file list']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the committed site copy passes the CLI, names 25a056c and covers the 24 live sitemap pages', async () => {
  const run = spawnSync(process.execPath, ['scripts/vessel-docs.mjs', '--check', 'site/AstralVessel'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(await readFile('site/AstralVessel/astral-docs.json', 'utf8'));
  assert.ok(manifest.commit.startsWith('25a056c'));
  assert.equal((await readFile('site/AstralVessel/sitemap.xml', 'utf8')).match(/<loc>/g).length, 24);
  assert.equal(spawnSync(process.execPath, ['scripts/vessel-docs.mjs'], { encoding: 'utf8' }).status, 2);
});

test('the CLI fails on a tampered copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-vessel-docs-'));
  try {
    await cp('site/AstralVessel', root, { recursive: true });
    await writeFile(join(root, 'extra.txt'), 'x');
    const run = spawnSync(process.execPath, ['scripts/vessel-docs.mjs', '--check', root], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /extra file: extra\.txt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
