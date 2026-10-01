// Verifies HTML publication boundaries, embedded-data escaping, and offline/deployment failure behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('build excludes internal drafts, safely embeds data, and fails deployment without a sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-site-test-'));
  try {
    for (const directory of ['scripts', 'site', 'data']) await cp(directory, join(root, directory), { recursive: true });
    const run = (env, args = []) => spawnSync(process.execPath, ['scripts/build.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', ...env } });
    assert.equal(run().status, 0);
    assert.notEqual(run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }).status, 0);
    assert.notEqual(run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }).status, 0);
    assert.equal(run({ GITHUB_ACTIONS: 'true' }, ['--preview']).status, 0);
    await mkdir(join(root, '.cache'));
    await writeFile(join(root, 'private-review.md'), 'Unapproved private review');
    const malicious = '</script><script>alert(1)</script>';
    await writeFile(join(root, '.cache/board.json'), JSON.stringify({ tasks: [{ title: malicious }], claims: [], awards: [], leaderboard: [], generatedAt: '2026-10-01T00:00:00Z' }));
    assert.equal(run().status, 0);
    const html = await readFile(join(root, '_site/bounties.html'), 'utf8');
    assert.equal(html.includes(malicious), false);
    assert.ok(html.includes('\\u003c/script>'));
    const published = await readdir(join(root, '_site'));
    assert.deepEqual(published.sort(), ['.nojekyll', 'app.js', 'assets', 'bounties.html', 'contribute.html', 'data', 'index.html', 'leaderboard.html', 'llms-full.txt', 'llms.txt', 'robots.txt', 'sitemap.xml', 'styles.css', 'theme.js'].sort());
    for (const page of ['index.html', 'bounties.html', 'leaderboard.html', 'contribute.html']) {
      const text = await readFile(join(root, '_site', page), 'utf8');
      assert.equal((text.match(/<h1>/g) || []).length, 1);
      assert.ok(text.includes('Skip to content'));
      assert.ok(text.includes('Content-Security-Policy'));
      for (const asset of ['styles.css', 'theme.js', 'app.js']) assert.ok(new RegExp(`="${asset.replace('.', '\\.')}\\?v=[a-f0-9]{12}"`).test(text));
      const urls = [...text.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)].map(match => match[1]).filter(url => !url.startsWith('http'));
      for (const url of urls) assert.ok((await readFile(join(root, '_site', url))).length > 0, `${page}: ${url}`);
    }
    await writeFile(join(root, '.cache/board.json'), '{');
    assert.notEqual(run().status, 0);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'astral-site-test-')));
    await rm(root, { recursive: true, force: true });
  }
});
