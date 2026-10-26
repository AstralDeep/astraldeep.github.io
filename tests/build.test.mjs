// Verifies HTML publication boundaries, embedded-data escaping, and offline/deployment failure behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SPARKLE_PUBLIC_KEY } from '../scripts/appcast.mjs';
import { ReleaseWorld, appcastFor, publicKey } from './release-fixture.mjs';

const preload = pathToFileURL(join(process.cwd(), 'tests/fetch-fixture.mjs')).href;
const builder = (root, world) => async (env = {}, args = []) => {
  await writeFile(join(root, 'routes.json'), JSON.stringify(world.serialize()));
  return spawnSync(process.execPath, ['--import', preload, 'scripts/build.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_TOKEN: '', ASTRAL_FETCH_FIXTURE: join(root, 'routes.json'), ...env } });
};

test('build excludes internal drafts, safely embeds data, and fails deployment without a sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-site-test-'));
  try {
    for (const directory of ['scripts', 'site', 'data']) await cp(directory, join(root, directory), { recursive: true });
    await writeFile(join(root, 'data/downloads.json'), JSON.stringify({ schemaVersion: 1, macos: null }));
    const run = builder(root, new ReleaseWorld());
    assert.equal((await run()).status, 0);
    assert.notEqual((await run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' })).status, 0);
    assert.notEqual((await run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' })).status, 0);
    assert.equal((await run({ GITHUB_ACTIONS: 'true' }, ['--preview'])).status, 0);
    await mkdir(join(root, '.cache'));
    await writeFile(join(root, 'private-review.md'), 'Unapproved private review');
    const malicious = '</script><script>alert(1)</script>';
    await writeFile(join(root, '.cache/board.json'), JSON.stringify({ tasks: [{ title: malicious }], awards: [], leaderboard: [], generatedAt: '2026-10-01T00:00:00Z' }));
    assert.equal((await run()).status, 0);
    const html = await readFile(join(root, '_site/bounties.html'), 'utf8');
    assert.equal(html.includes(malicious), false);
    assert.ok(html.includes('\\u003c/script>'));
    assert.doesNotMatch(html, /claim-section|claim-list|value="claimed"|\/claim|\/unclaim/);
    for (const file of ['contribute.html', 'app.js', 'llms.txt', 'llms-full.txt', 'assets/video/astraldeep-introduction-transcript.txt', 'assets/video/astraldeep-introduction.en.vtt']) {
      assert.doesNotMatch(await readFile(join(root, '_site', file), 'utf8'), /\/claim|\/unclaim|Claim on GitHub|request a claim|wait for your reservation/);
    }
    assert.match(await readFile(join(root, '_site/contribute.html'), 'utf8'), /successfully merge it into main/);
    const published = await readdir(join(root, '_site'));
    assert.deepEqual(published.sort(), ['.nojekyll', 'app.js', 'assets', 'bounties.html', 'contribute.html', 'data', 'downloads.html', 'index.html', 'leaderboard.html', 'llms-full.txt', 'llms.txt', 'robots.txt', 'sitemap.xml', 'styles.css', 'theme.js'].sort());
    assert.deepEqual((await readdir(join(root, '_site/data'))).sort(), ['board.json', 'downloads.json']);
    assert.deepEqual(JSON.parse(await readFile(join(root, '_site/data/downloads.json'), 'utf8')), { schemaVersion: 1, macos: null });
    assert.match(await readFile(join(root, '_site/downloads.html'), 'utf8'), /Mac download in preparation/);
    for (const page of ['index.html', 'downloads.html', 'bounties.html', 'leaderboard.html', 'contribute.html']) {
      const text = await readFile(join(root, '_site', page), 'utf8');
      assert.equal((text.match(/<h1>/g) || []).length, 1);
      assert.ok(text.includes('Skip to content'));
      assert.ok(text.includes('Content-Security-Policy'));
      assert.match(text, /<nav aria-label="Main navigation"><a href="downloads.html"/);
      for (const asset of ['styles.css', 'theme.js', 'app.js']) assert.ok(new RegExp(`="${asset.replace('.', '\\.')}\\?v=[a-f0-9]{12}"`).test(text));
      for (const asset of ['assets/astraldeep-icon.png', 'assets/astraldeep-wordmark.png']) {
        const digest = createHash('sha256').update(await readFile(join(root, 'site', asset))).digest('hex').slice(0, 12);
        assert.ok(text.includes(`${asset}?v=${digest}`), `${page}: current brand asset version`);
      }
      const urls = [...text.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)].map(match => match[1]).filter(url => !url.startsWith('http'));
      for (const url of urls) assert.ok((await readFile(join(root, '_site', url))).length > 0, `${page}: ${url}`);
    }
    await writeFile(join(root, '.cache/board.json'), '{');
    assert.notEqual((await run()).status, 0);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'astral-site-test-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('build renders the newest verified release and writes its discovered feed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-site-discovery-'));
  try {
    for (const directory of ['scripts', 'site', 'data']) await cp(directory, join(root, directory), { recursive: true });
    const trusted = await readFile(join(root, 'scripts/appcast.mjs'), 'utf8');
    assert.equal(trusted.split(`'${SPARKLE_PUBLIC_KEY}'`).length, 2);
    await writeFile(join(root, 'scripts/appcast.mjs'), trusted.replace(`'${SPARKLE_PUBLIC_KEY}'`, `'${publicKey}'`));
    const world = new ReleaseWorld();
    const run = builder(root, world);
    const site = path => readFile(join(root, '_site', path));
    const floor = world.publish('1.8', 69, { channel: 'preview', format: 'zip', feed: false }).record;
    await writeFile(join(root, 'data/downloads.json'), JSON.stringify({ schemaVersion: 1, macos: floor }));

    const unchanged = await run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(JSON.parse(await site('data/downloads.json')), { schemaVersion: 1, macos: floor });
    assert.match((await site('downloads.html')).toString(), /1\.8 \(69\) preview/);
    await assert.rejects(site('appcast.xml'), { code: 'ENOENT' });

    const current = world.publish('2.0.0', 71, { older: [floor] });
    const discovered = await run();
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.deepEqual(JSON.parse(await site('data/downloads.json')), { schemaVersion: 1, macos: current.record });
    assert.equal((await site('appcast.xml')).toString(), current.files['appcast.xml']);
    assert.ok((await site('data/mac-update-policy.json')).equals(current.files['mac-update-policy.json']));
    assert.equal((await site('data/mac-update-policy.json.sig')).toString(), current.files['mac-update-policy.json.sig']);
    const page = (await site('downloads.html')).toString();
    assert.match(page, /2\.0\.0 \(71\)/);
    assert.ok(page.includes(`href="${current.record.url}"`));
    assert.doesNotMatch(page, /1\.8 \(69\)/);

    world.replaceAsset(current, 'appcast.xml', appcastFor([{ ...current.record, bytes: current.record.bytes + 1 }]));
    const mismatch = await run();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /disagrees with downloads\.json/);

    await writeFile(join(root, 'data/downloads.json'), JSON.stringify({ schemaVersion: 1, macos: { ...current.record, version: '2.0.1', build: 72, url: current.record.url.replaceAll('2.0.0-71', '2.0.1-72'), releaseURL: current.record.releaseURL.replace('2.0.0-71', '2.0.1-72'), checksumsURL: current.record.checksumsURL.replace('2.0.0-71', '2.0.1-72') } }));
    const regressed = await run();
    assert.notEqual(regressed.status, 0);
    assert.match(regressed.stderr, /older than the committed floor/);

    const offline = spawnSync(process.execPath, ['scripts/build.mjs', '--preview'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
    assert.equal(offline.status, 0, offline.stderr);
    assert.deepEqual(JSON.parse(await site('data/downloads.json')), { schemaVersion: 1, macos: null });
    for (const stale of ['appcast.xml', 'data/mac-update-policy.json', 'data/mac-update-policy.json.sig']) await assert.rejects(site(stale), { code: 'ENOENT' });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'astral-site-discovery-')));
    await rm(root, { recursive: true, force: true });
  }
});
