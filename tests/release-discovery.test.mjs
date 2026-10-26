// Verifies build-time Mac release discovery, its floor, bounded asset fetches, feed cross-checks and the Pages change detector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GitHub } from '../scripts/github.mjs';
import { ASSET_LIMITS, discoverMacRelease, liveReleaseChange, newestMacRelease } from '../scripts/release-discovery.mjs';
import { ReleaseWorld, appcastFor, macRecord, publicKey, signedPolicy } from './release-fixture.mjs';

const LIVE = 'https://astraldeep.github.io/data/downloads.json';
const floorRelease = world => world.publish('1.8', 69, { channel: 'preview', format: 'zip', feed: false }).record;
const discover = (world, floor) => discoverMacRelease(new GitHub('', world.transport), floor, world.transport, publicKey);
const downloadsOf = (name, world) => world.calls.filter(url => url.startsWith('https://github.com/') && url.endsWith(`/${name}`));

test('discovery picks the highest macos build and ignores drafts and other namespaces', async () => {
  const world = new ReleaseWorld();
  const floor = floorRelease(world);
  const current = world.publish('2.0.0', 71, { older: [floor] });
  world.publish('2.0.1', 72, { draft: true });
  world.publish('1.9.4', 70);
  world.releases.push(
    { id: 901, tag_name: 'apple-v1.7', draft: false }, { id: 902, tag_name: 'v0.6.0', draft: false },
    { id: 903, tag_name: 'macos-v9.0-999', draft: true }, { id: 904, tag_name: 'macos-v3.0-500-rc', draft: false }, { id: 905, draft: false }
  );
  const found = await discover(world, floor);
  assert.deepEqual(found.record, current.record);
  assert.equal(found.appcast, current.files['appcast.xml']);
  assert.ok(found.policy.equals(current.files['mac-update-policy.json']));
  assert.equal(found.signature, current.files['mac-update-policy.json.sig']);
  assert.equal(world.calls.some(url => url.includes('macos-v2.0.1-72') || url.includes('/releases/72/')), false);
  for (const name of Object.keys(ASSET_LIMITS)) assert.deepEqual(downloadsOf(name, world), [`https://github.com/AstralDeep/AstralDeep/releases/download/macos-v2.0.0-71/${name}`]);
  assert.deepEqual(ASSET_LIMITS, { 'downloads.json': 16384, 'appcast.xml': 2097152, 'mac-update-policy.json': 4096, 'mac-update-policy.json.sig': 256 });
  assert.deepEqual((await discover(world, null)).record, current.record);

  assert.equal(newestMacRelease([]), null);
  assert.deepEqual(newestMacRelease(world.releases), { id: 71, tag: 'macos-v2.0.0-71', version: '2.0.0', build: 71 });
  assert.throws(() => newestMacRelease([...world.releases, { id: 906, tag_name: 'macos-v2.0-71', draft: false }]), /share the newest build/);
  assert.deepEqual(newestMacRelease([{ id: 1, tag_name: 'macos-v1.0-5', draft: false }, { id: 2, tag_name: 'macos-v1.1-5', draft: false }, { id: 3, tag_name: 'macos-v1.2-6', draft: false }]).build, 6);
  for (const release of [{ id: 7, tag_name: 'macos-v2.0-071', draft: false }, { id: 7, tag_name: 'macos-v2.0-0', draft: false }, { id: 0, tag_name: 'macos-v2.0-73', draft: false }, { id: 7, tag_name: 'macos-v2.0-99999999999999999', draft: false }]) {
    assert.throws(() => newestMacRelease([release]), /not canonical|release identity/, JSON.stringify(release));
  }
  assert.throws(() => newestMacRelease({}), /release list/);
});

test('discovery returns the verified floor when nothing newer is published', async () => {
  const world = new ReleaseWorld();
  const floor = floorRelease(world);
  world.publish('1.7', 68);
  assert.deepEqual(await discover(world, floor), { record: floor, appcast: null, policy: null, signature: null });
  assert.ok(world.calls.includes('https://api.github.com/repos/AstralDeep/AstralDeep/releases/tags/macos-v1.8-69'));
  assert.ok(world.calls.includes(floor.checksumsURL));
  for (const name of Object.keys(ASSET_LIMITS)) assert.deepEqual(downloadsOf(name, world), []);

  const empty = new ReleaseWorld();
  assert.deepEqual(await discover(empty, null), { record: null, appcast: null, policy: null, signature: null });
  assert.deepEqual(empty.calls, ['https://api.github.com/repos/AstralDeep/AstralDeep/releases?per_page=100&page=1']);

  const unlisted = new ReleaseWorld();
  const recorded = floorRelease(unlisted);
  unlisted.releases.length = 0;
  assert.deepEqual((await discover(unlisted, recorded)).record, recorded);
  const unpublished = new ReleaseWorld();
  await assert.rejects(discover(unpublished, recorded), /releases\/tags\/macos-v1\.8-69 returned 404/);

  const renamed = new ReleaseWorld();
  renamed.publish('1.8.0', 69, { channel: 'preview', format: 'zip', feed: false });
  await assert.rejects(discover(renamed, recorded), /disagrees with the committed floor/);
  await assert.rejects(discover(world, { ...floor, url: 'https://example.com/AstralDeep.zip' }), /links disagree/);
});

test('discovery refuses a record older than the floor', async () => {
  const world = new ReleaseWorld();
  floorRelease(world);
  await assert.rejects(discover(world, macRecord('2.0.0', 71)), /older than the committed floor/);
});

test('discovery rejects a record whose digest disagrees with the provider', async () => {
  const tamper = async mutate => {
    const world = new ReleaseWorld();
    const entry = world.publish('2.0.0', 71);
    mutate(world, entry);
    return discover(world, null);
  };
  await assert.rejects(tamper((world, entry) => {
    const image = entry.assets[0];
    image.digest = `sha256:${'d'.repeat(64)}`;
    world.json(`/releases/${entry.release.id}/assets?per_page=100&page=1`, entry.assets);
  }), /asset identity disagrees/);
  await assert.rejects(tamper((world, entry) => {
    world.replaceAsset(entry, 'downloads.json', `${JSON.stringify({ schemaVersion: 1, macos: { ...entry.record, sha256: 'e'.repeat(64) } })}\n`);
  }), /asset identity disagrees/);
  await assert.rejects(tamper((world, entry) => {
    world.replaceAsset(entry, 'downloads.json', `${JSON.stringify({ schemaVersion: 1, macos: { ...entry.record, bytes: entry.record.bytes + 1 } })}\n`);
  }), /asset identity disagrees/);
  await assert.rejects(tamper((world, entry) => {
    world.file(entry.assets.find(item => item.name === 'downloads.json').browser_download_url, entry.files['downloads.json'].replace('"14.0"', '"15.0"'));
  }), /disagrees with its provider digest/);
  await assert.rejects(tamper((world, entry) => {
    world.replaceAsset(entry, 'downloads.json', entry.files['downloads.json'], { digest: `sha256:${'0'.repeat(64)}` });
  }), /disagrees with its provider digest/);
  await assert.rejects(tamper((world, entry) => {
    world.replaceAsset(entry, 'downloads.json', entry.files['downloads.json'], { size: Buffer.byteLength(entry.files['downloads.json']) - 1 });
  }), /disagrees with its provider digest/);
  await assert.rejects(tamper((world, entry) => {
    world.replaceAsset(entry, 'downloads.json', entry.files['downloads.json'], { digest: null });
  }), /no provider digest/);
});

test('discovery binds the Downloads record to the release tag it came from', async () => {
  const tamper = async body => {
    const world = new ReleaseWorld();
    const entry = world.publish('2.0.0', 71);
    world.replaceAsset(entry, 'downloads.json', typeof body === 'function' ? body(entry) : body);
    return discover(world, null);
  };
  for (const other of [macRecord('2.0.0', 72), macRecord('2.0.1', 71), macRecord('2.0', 71)]) {
    await assert.rejects(tamper(`${JSON.stringify({ schemaVersion: 1, macos: other })}\n`), /record for another release/);
  }
  await assert.rejects(tamper(entry => JSON.stringify({ schemaVersion: 1, macos: { ...entry.record, url: entry.record.url.replace('macos-v2.0.0-71/', 'macos-v2.0.0-70/') } })), /links disagree/);
  await assert.rejects(tamper(JSON.stringify({ schemaVersion: 1, macos: null })), /record for another release/);
  await assert.rejects(tamper('{'), /not valid JSON/);
  await assert.rejects(tamper(Buffer.from([0xff, 0xfe, 0x7b])), /not UTF-8/);
});

test('discovery rejects an appcast or update policy that disagrees with the record', async () => {
  const tamper = async (file, body) => {
    const world = new ReleaseWorld();
    const entry = world.publish('2.0.0', 71);
    world.replaceAsset(entry, file, typeof body === 'function' ? body(entry) : body);
    return discover(world, null);
  };
  await assert.rejects(tamper('appcast.xml', entry => appcastFor([{ ...entry.record, bytes: entry.record.bytes + 1 }])), /disagrees with downloads\.json/);
  await assert.rejects(tamper('appcast.xml', entry => appcastFor([entry.record, { ...macRecord('2.0.1', 72) }])), /disagrees with downloads\.json/);
  await assert.rejects(tamper('appcast.xml', entry => appcastFor([{ ...entry.record, channel: 'preview' }])), /disagrees with downloads\.json/);
  await assert.rejects(tamper('appcast.xml', '<rss'), /not well-formed/);
  await assert.rejects(tamper('mac-update-policy.json.sig', signedPolicy(70, generateKeyPairSync('ed25519').privateKey).signature), /does not verify/);
  await assert.rejects(tamper('mac-update-policy.json.sig', `  ${signedPolicy(70).signature}`), /signature is malformed/);
  await assert.rejects(tamper('mac-update-policy.json.sig', 'not base64\n'), /signature is malformed/);
  await assert.rejects(tamper('mac-update-policy.json', signedPolicy(70).bytes.toString().replace('70', '71')), /does not verify/);
  const world = new ReleaseWorld();
  const entry = world.publish('2.0.0', 71, { minimumBuild: 72 });
  await assert.rejects(discover(world, null), /does not offer/);
  assert.equal(entry.record.build, 71);
  const exact = new ReleaseWorld();
  exact.publish('2.0.0', 71, { minimumBuild: 71 });
  assert.equal((await discover(exact, null)).record.build, 71);
  await assert.rejects(discoverMacRelease(new GitHub('', exact.transport), null, exact.transport), /does not verify/);
});

test('discovery rejects an oversized, missing or unavailable asset', async () => {
  for (const [name, limit] of Object.entries(ASSET_LIMITS)) {
    const declared = new ReleaseWorld();
    const entry = declared.publish('2.0.0', 71);
    entry.assets.find(item => item.name === name).size = limit + 1;
    declared.json(`/releases/${entry.release.id}/assets?per_page=100&page=1`, entry.assets);
    await assert.rejects(discover(declared, null), /exceeds its size limit/, name);
    assert.deepEqual(downloadsOf(name, declared), [], name);

    const streamed = new ReleaseWorld();
    const lying = streamed.publish('2.0.0', 71);
    streamed.file(lying.assets.find(item => item.name === name).browser_download_url, 'x'.repeat(limit + 1));
    await assert.rejects(discover(streamed, null), /exceeds its size limit/, name);
  }
  const mutations = [
    [entry => { entry.assets = entry.assets.filter(item => item.name !== 'appcast.xml'); }, /missing or ambiguous/],
    [entry => { entry.assets.push({ ...entry.assets.at(-1) }); }, /missing or ambiguous/],
    [entry => { entry.assets.at(-1).state = 'starter'; }, /missing or ambiguous/],
    [entry => { entry.assets.at(-1).browser_download_url = 'https://example.com/mac-update-policy.json.sig'; }, /missing or ambiguous/],
    [entry => { entry.assets.at(-1).size = 0; }, /exceeds its size limit/]
  ];
  for (const [mutate, pattern] of mutations) {
    const world = new ReleaseWorld();
    const entry = world.publish('2.0.0', 71);
    mutate(entry);
    world.json(`/releases/${entry.release.id}/assets?per_page=100&page=1`, entry.assets);
    await assert.rejects(discover(world, null), pattern);
  }
  const missing = new ReleaseWorld();
  const entry = missing.publish('2.0.0', 71);
  missing.routes.delete(entry.assets.find(item => item.name === 'appcast.xml').browser_download_url);
  await assert.rejects(discover(missing, null), /is unavailable/);
  const legacy = new ReleaseWorld();
  legacy.publish('2.0.0', 71, { feed: false });
  await assert.rejects(discover(legacy, null), /downloads\.json is missing or ambiguous/);
  await assert.rejects(discoverMacRelease({ pages: async () => { throw new Error('provider unavailable'); } }, null), /provider unavailable/);
});

test('the Pages change detector compares the newest release tag with the live Downloads record', async () => {
  const world = new ReleaseWorld();
  const old = floorRelease(world);
  const live = record => world.file(LIVE, `${JSON.stringify({ schemaVersion: 1, macos: record }, null, 2)}\n`);
  const check = () => liveReleaseChange(new GitHub('', world.transport), LIVE, world.transport);
  live(old);
  assert.deepEqual(await check(), { newest: 'macos-v1.8-69', live: 'macos-v1.8-69', changed: false });
  const current = world.publish('2.0.0', 71).record;
  assert.deepEqual(await check(), { newest: 'macos-v2.0.0-71', live: 'macos-v1.8-69', changed: true });
  live(current);
  assert.deepEqual(await check(), { newest: 'macos-v2.0.0-71', live: 'macos-v2.0.0-71', changed: false });
  live(null);
  assert.equal((await check()).changed, true);
  world.routes.delete(LIVE);
  assert.deepEqual(await check(), { newest: 'macos-v2.0.0-71', live: null, changed: true });
  const empty = new ReleaseWorld();
  assert.deepEqual(await liveReleaseChange(new GitHub('', empty.transport), LIVE, empty.transport), { newest: null, live: null, changed: false });
  for (const [route, pattern] of [[{ status: 500, body: Buffer.from('') }, /unavailable/], [{ status: 200, body: Buffer.from('x'.repeat(16385)) }, /size limit/], [{ status: 200, body: Buffer.from('{}') }, /Invalid download manifest/], [{ status: 200, body: Buffer.from('{') }, /not valid JSON/]]) {
    world.routes.set(LIVE, route);
    await assert.rejects(check(), pattern);
  }
  await assert.rejects(liveReleaseChange(new GitHub('', world.transport), 'http://astraldeep.github.io/data/downloads.json', world.transport), /https/);
});

test('the release sync command writes its change decision for the workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-release-sync-'));
  try {
    const world = new ReleaseWorld();
    world.file(LIVE, JSON.stringify({ schemaVersion: 1, macos: floorRelease(world) }));
    world.publish('2.0.0', 71);
    await writeFile(join(root, 'routes.json'), JSON.stringify(world.serialize()));
    const output = join(root, 'github-output');
    await writeFile(output, 'previous=kept\n');
    const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'tests/fetch-fixture.mjs')).href, 'scripts/release-discovery-cli.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ASTRAL_FETCH_FIXTURE: join(root, 'routes.json'), GITHUB_TOKEN: '' } });
    const changed = run(['--live', LIVE, '--github-output', output]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /changed=true/);
    assert.match(changed.stdout, /macos-v2\.0\.0-71/);
    assert.equal(await readFile(output, 'utf8'), 'previous=kept\nchanged=true\n');
    const printed = run(['--live', LIVE]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /changed=true/);
    for (const args of [[], ['--live'], ['--live', LIVE, '--other', 'x'], ['--github-output', output], ['--live', LIVE, '--live', LIVE]]) {
      assert.notEqual(run(args).status, 0, JSON.stringify(args));
    }
    assert.equal(await readFile(output, 'utf8'), 'previous=kept\nchanged=true\n');
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'astral-release-sync-')));
    await rm(root, { recursive: true, force: true });
  }
});
