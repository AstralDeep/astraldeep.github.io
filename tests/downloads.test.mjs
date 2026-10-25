// Verifies download metadata, publication boundaries, and accessible static rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderMacDownload, validateDownloads, verifyPublishedDownload } from '../scripts/downloads.mjs';

const release = () => ({
  version: '1.8', build: 69, minimumMacOS: '14.0', architecture: 'arm64',
  bytes: 23456789, sha256: 'a'.repeat(64),
  url: 'https://github.com/AstralDeep/AstralDeep/releases/download/macos-v1.8-69/AstralDeep-1.8-69-arm64.dmg',
  releaseURL: 'https://github.com/AstralDeep/AstralDeep/releases/tag/macos-v1.8-69',
  checksumsURL: 'https://github.com/AstralDeep/AstralDeep/releases/download/macos-v1.8-69/SHA256SUMS',
  source: { deep: 'b'.repeat(40), projection: 'c'.repeat(40) }
});

test('an unpublished Mac package exposes no download action or signed-status claim', () => {
  assert.deepEqual(validateDownloads({ schemaVersion: 1, macos: null }), { schemaVersion: 1, macos: null });
  const html = renderMacDownload(null);
  assert.match(html, /Mac download in preparation/);
  assert.doesNotMatch(html, /href=.*\.dmg|Download for Mac|notarized|disabled/);
});

test('a release produces an explicit Mac download with compatibility and integrity details', () => {
  const manifest = validateDownloads({ schemaVersion: 1, macos: release() });
  const html = renderMacDownload(manifest.macos);
  assert.match(html, /Download for Mac/);
  assert.match(html, /Apple silicon/);
  assert.match(html, /macOS 14\.0 or later/);
  assert.match(html, /1\.8 \(69\)/);
  assert.match(html, /22\.4 MB/);
  assert.match(html, /SHA256SUMS/);
  assert.match(html, new RegExp('a'.repeat(64)));
  assert.match(html, /Release notes/);
  assert.doesNotMatch(html, /target="_blank"|onclick|<script/);
  assert.match(renderMacDownload({ ...release(), architecture: 'universal', url: release().url.replace('arm64', 'universal') }), /Apple silicon and Intel/);
  assert.match(renderMacDownload({ ...release(), architecture: 'x86_64', url: release().url.replace('arm64', 'x86_64') }), /Intel/);
});

test('download metadata rejects incomplete, cross-repository and mismatched values', () => {
  for (const manifest of [null, {}, { schemaVersion: 2, macos: null }, { schemaVersion: 1 }, { schemaVersion: 1, macos: [] }]) {
    assert.throws(() => validateDownloads(manifest));
  }
  for (const patch of [
    { version: '1.8<script>' }, { build: 0 }, { build: 69.1 }, { minimumMacOS: '14.0"' },
    { architecture: 'automatic' }, { bytes: 0 }, { bytes: 2.1 }, { sha256: 'b'.repeat(63) },
    { url: 'javascript:alert(1)' },
    { url: 'https://github.com/other/app/releases/download/macos-v1.8-69/AstralDeep-1.8-69-arm64.dmg' },
    { url: `${release().url}?download=1` }, { url: release().url.replace('69-arm64', '68-arm64') },
    { releaseURL: release().releaseURL.replace('1.8', '1.7') },
    { checksumsURL: release().checksumsURL.replace('SHA256SUMS', 'other.txt') },
    { notarization: { status: 'Accepted', id: 'not-proof-of-notarization' } },
    { source: { deep: 'main', projection: 'c'.repeat(40) } }, { source: null }, { unexpected: 'not public' }
  ]) {
    assert.throws(() => validateDownloads({ schemaVersion: 1, macos: { ...release(), ...patch } }), JSON.stringify(patch));
  }
});

function provider() {
  const mac = release();
  const name = mac.url.split('/').at(-1);
  const text = `${mac.sha256}  ${name}\n`;
  const published = { id: 17, tag_name: 'macos-v1.8-69', html_url: mac.releaseURL, draft: false, prerelease: false, immutable: true, published_at: '2026-10-25T12:00:00Z' };
  const assets = [
    { id: 21, name, browser_download_url: mac.url, state: 'uploaded', size: mac.bytes, digest: `sha256:${mac.sha256}` },
    { id: 22, name: 'SHA256SUMS', browser_download_url: mac.checksumsURL, state: 'uploaded', size: Buffer.byteLength(text), digest: `sha256:${createHash('sha256').update(text).digest('hex')}` }
  ];
  return {
    mac, published, assets, text,
    reference: { ref: 'refs/tags/macos-v1.8-69', object: { type: 'commit', sha: mac.source.deep } },
    component: { sha: mac.source.projection, path: 'components/AstralProjection', submodule_git_url: 'https://github.com/AstralDeep/AstralProjection.git' }
  };
}

const api = state => ({
  request: async path => {
    if (path.includes('/git/ref/')) return state.reference;
    if (path.includes('/git/tags/')) return state.annotation;
    if (path.includes('/contents/')) return state.component;
    assert.equal(path, '/repos/AstralDeep/AstralDeep/releases/tags/macos-v1.8-69');
    return state.published;
  },
  pages: async path => { assert.equal(path, '/repos/AstralDeep/AstralDeep/releases/17/assets'); return state.assets; }
});

test('only provider-confirmed immutable public assets with matching checksum bytes activate a download', async () => {
  await verifyPublishedDownload(null, { request: () => assert.fail('unpublished state must not use the network') });
  const state = provider();
  const github = api(state);
  await verifyPublishedDownload(state.mac, github, async (url, options) => {
    assert.equal(url, state.mac.checksumsURL);
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(state.text.slice(0, 20)));
      controller.enqueue(Buffer.from(state.text.slice(20)));
      controller.close();
    } }));
  });
  state.reference.object = { type: 'tag', sha: 'e'.repeat(40) };
  state.annotation = { object: { type: 'commit', sha: state.mac.source.deep } };
  await verifyPublishedDownload(state.mac, github, async () => new Response(state.text));
});

test('provider failures, drafts, mutable releases, replaced assets and checksum disagreement block activation', async () => {
  for (const patch of [null, { draft: true }, { prerelease: true }, { immutable: false }, { tag_name: 'other' }, { html_url: 'https://github.com/other/release' }, { published_at: null }, { id: 0 }]) {
    const state = provider();
    await assert.rejects(verifyPublishedDownload(state.mac, { request: async () => patch === null ? null : { ...state.published, ...patch } }));
  }
  for (const mutate of [
    s => { s.reference.ref = 'refs/heads/main'; }, s => { s.reference.object.sha = 'd'.repeat(40); },
    s => { s.reference = null; }, s => { s.reference.object = { type: 'tag', sha: 'e'.repeat(40) }; s.annotation = { object: s.reference.object }; },
    s => { s.component.sha = 'd'.repeat(40); }, s => { s.component.path = 'other'; }, s => { s.component.submodule_git_url = 'https://github.com/other/repo.git'; },
    s => { s.assets = []; }, s => { s.assets.push({ ...s.assets[0] }); },
    s => { s.assets[0].state = 'new'; }, s => { s.assets[0].id = 0; }, s => { s.assets[0].name = 'other.dmg'; },
    s => { s.assets[0].digest = `sha256:${'d'.repeat(64)}`; }, s => { s.assets[0].size++; },
    s => { s.assets[1].size = 0; }, s => { s.assets[1].size = 4097; }, s => { s.assets[1].digest = null; }
  ]) {
    const state = provider(); mutate(state);
    await assert.rejects(verifyPublishedDownload(state.mac, api(state)));
  }
  for (const response of [new Response('', { status: 404 }), new Response('x'.repeat(4097)), new Response('wrong checksum')]) {
    const state = provider();
    await assert.rejects(verifyPublishedDownload(state.mac, api(state), async () => response));
  }
  const state = provider();
  const github = api(state);
  const invalid = `${'d'.repeat(64)}  ${state.assets[0].name}\n`;
  state.assets[1].digest = `sha256:${createHash('sha256').update(invalid).digest('hex')}`;
  state.assets[1].size = Buffer.byteLength(invalid);
  await assert.rejects(verifyPublishedDownload(state.mac, github, async () => new Response(invalid)));
  for (const malformed of [` ${state.text}`, `\uFEFF${state.text}`, state.text.replace('\n', ' \n'), state.text.trimEnd()]) {
    state.assets[1].size = Buffer.byteLength(malformed);
    state.assets[1].digest = `sha256:${createHash('sha256').update(malformed).digest('hex')}`;
    await assert.rejects(verifyPublishedDownload(state.mac, github, async () => new Response(malformed)));
  }
  await assert.rejects(verifyPublishedDownload(state.mac, { request: async () => { throw new Error('provider unavailable'); } }));
});
