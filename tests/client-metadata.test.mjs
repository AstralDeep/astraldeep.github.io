// Verifies the built Pages artifact carries the OAuth client metadata document and the Apple app-link association file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const APP_ID = '593LGH35GS.com.personalailabs.astraldeep';
const ORIGIN = 'https://astraldeep.github.io';

test('built site publishes the client metadata and app-link association files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-site-metadata-'));
  try {
    for (const directory of ['scripts', 'site', 'data']) await cp(directory, join(root, directory), { recursive: true });
    const build = spawnSync(process.execPath, ['scripts/build.mjs', '--preview'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_TOKEN: '' } });
    assert.equal(build.status, 0, build.stderr);

    const metadata = JSON.parse(await readFile(join(root, '_site/oauth/client-metadata.json'), 'utf8'));
    assert.equal(metadata.client_id, `${ORIGIN}/oauth/client-metadata.json`);
    assert.deepEqual(metadata.redirect_uris, [`${ORIGIN}/oauth/callback`]);
    assert.equal(metadata.token_endpoint_auth_method, 'none');
    assert.doesNotMatch(JSON.stringify(metadata), /secret/i);

    const association = JSON.parse(await readFile(join(root, '_site/.well-known/apple-app-site-association'), 'utf8'));
    assert.deepEqual(association.applinks.details[0].appIDs, [APP_ID]);
    assert.deepEqual(association.applinks.details[0].components, [{ '/': '/oauth/callback' }, { '/': '/contact/' }]);
    assert.deepEqual(association.webcredentials.apps, [APP_ID]);

    await readFile(join(root, '_site/.nojekyll'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
