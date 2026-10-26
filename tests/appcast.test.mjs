// Verifies Sparkle appcast parsing, the Downloads cross-check, signed policy validation and the build-time gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SPARKLE_NAMESPACE, SPARKLE_PUBLIC_KEY, checkMacUpdateFeed, crossCheckAppcast, parseAppcast, verifyPolicy } from '../scripts/appcast.mjs';

const SIGNATURE = `${'A'.repeat(86)}==`;
const download = (version, build) => `https://github.com/AstralDeep/AstralDeep/releases/download/macos-v${version}-${build}/AstralDeep-${version}-${build}-arm64.zip`;
const downloads = (patch = {}) => ({
  schemaVersion: 1,
  macos: {
    version: '1.9', build: 71, minimumMacOS: '14.0', architecture: 'arm64', format: 'zip', channel: 'stable', bytes: 22000000,
    sha256: 'a'.repeat(64), url: download('1.9', 71),
    releaseURL: 'https://github.com/AstralDeep/AstralDeep/releases/tag/macos-v1.9-71',
    checksumsURL: 'https://github.com/AstralDeep/AstralDeep/releases/download/macos-v1.9-71/SHA256SUMS',
    source: { deep: 'b'.repeat(40), projection: 'c'.repeat(40) }, ...patch
  }
});
const item = ({ build = 71, version = '1.9', length = 22000000, signature = SIGNATURE, url = download(version, build), extra = '', enclosure } = {}) => `
    <item>
      <title>${version}</title>
      <description sparkle:format="markdown"><![CDATA[<item> notes & more]]></description>
      <pubDate>Sun, 25 Oct 2026 12:00:00 +0000</pubDate>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0.0</sparkle:minimumSystemVersion>${extra}
      ${enclosure ?? `<enclosure url="${url}" length="${length}" type="application/octet-stream" sparkle:edSignature="${signature}"/>`}
    </item>`;
const feed = (items = [item()], root = `<rss version="2.0" xmlns:sparkle="${SPARKLE_NAMESPACE}" xmlns:dc="http://purl.org/dc/elements/1.1/">`) =>
  `<?xml version="1.0" standalone="yes"?>\n${root}\n  <channel>\n    <title>AstralDeep</title>${items.join('')}\n  </channel>\n</rss>\n`;

test('a well-formed feed parses and reports the newest item whatever the document order', () => {
  const parsed = parseAppcast(feed([item({ build: 70, version: '1.8' }), item(), item({ build: 69, version: '1.8', extra: '\n      <sparkle:channel>preview</sparkle:channel>' })]));
  assert.deepEqual(parsed.items.map(entry => entry.build), [70, 71, 69]);
  assert.equal(parsed.newest.build, 71);
  assert.equal(parsed.newest.shortVersion, '1.9');
  assert.equal(parsed.newest.channel, null);
  assert.equal(parsed.items[2].channel, 'preview');
  assert.equal(parsed.newest.length, 22000000);
  assert.equal(parsed.newest.url, download('1.9', 71));
  assert.equal(parsed.newest.minimumSystemVersion, '14.0.0');
});

test('CDATA, comments, entities and enclosure-attribute versions are read without being executed', () => {
  const enclosure = `<enclosure url='${download('1.9', 71)}' length="22000000" sparkle:version="71" sparkle:shortVersionString="1.9" sparkle:edSignature="${SIGNATURE}"/>`;
  const body = `<item><!-- <item>comment</item> --><title>A &amp; B &#x41;&#66;</title>${enclosure}</item>`;
  const parsed = parseAppcast(feed([body]));
  assert.equal(parsed.newest.build, 71);
  assert.equal(parsed.newest.shortVersion, '1.9');
});

test('a feed that matches the Downloads record passes the cross-check', () => {
  crossCheckAppcast(parseAppcast(feed([item({ build: 70, version: '1.8' }), item()])), downloads());
  crossCheckAppcast(parseAppcast(feed([item({ extra: '\n      <sparkle:channel>preview</sparkle:channel>' })])), downloads({ channel: 'preview' }));
});

test('each disagreement between the newest item and downloads.json is reported', () => {
  const parsed = parseAppcast(feed([item()]));
  for (const [patch, pattern] of [
    [{ build: 72 }, /build 71 != 72/], [{ version: '1.10' }, /version 1\.9 != 1\.10/],
    [{ url: download('1.9', 72) }, /url /], [{ bytes: 22000001 }, /length 22000000 != 22000001/],
    [{ channel: 'preview' }, /channel null != preview/], [{ minimumMacOS: '15.0' }, /minimumSystemVersion 14\.0\.0 != 15\.0/]
  ]) assert.throws(() => crossCheckAppcast(parsed, downloads(patch)), pattern);
  assert.throws(() => crossCheckAppcast(parseAppcast(feed([item({ extra: '\n      <sparkle:channel>preview</sparkle:channel>' })])), downloads()), /channel preview != null/);
  assert.throws(() => crossCheckAppcast(parsed, { schemaVersion: 1, macos: null }), /without a Mac download record/);
  assert.throws(() => crossCheckAppcast(parsed, null), /without a Mac download record/);
});

test('items without a trustworthy version, asset or signature are rejected', () => {
  const enclosure = patch => `<enclosure url="${download('1.9', 71)}" length="22000000" sparkle:edSignature="${SIGNATURE}" ${patch}/>`;
  for (const [xml, pattern] of [
    [feed([item({ enclosure: '' })]), /no enclosure/],
    [feed([item({ build: 'seventy-one' })]), /no numeric sparkle:version/],
    [feed([item({ build: '071' })]), /no numeric sparkle:version/],
    [feed([item({ version: 'next' })]), /shortVersionString/],
    [feed([item({ url: 'https://example.com/AstralDeep.zip' })]), /not a release asset/],
    [feed([item({ url: `${download('1.9', 71)}?raw=1` })]), /not a release asset/],
    [feed([item({ enclosure: '<enclosure length="1" sparkle:edSignature="' + SIGNATURE + '"/>' })]), /not a release asset/],
    [feed([item({ length: 0 })]), /byte length/], [feed([item({ length: 'big' })]), /byte length/],
    [feed([item({ signature: '' })]), /EdDSA signature/], [feed([item({ signature: 'abc==' })]), /EdDSA signature/],
    [feed([item({ enclosure: enclosure('') + '' }).replace('sparkle:edSignature', 'sparkle:other')]), /EdDSA signature/],
    [feed([item(), item()]), /repeats a build number/], [feed([]), /lists no updates/]
  ]) assert.throws(() => parseAppcast(xml), pattern);
});

test('malformed or hostile XML is refused', () => {
  const good = feed();
  for (const [xml, pattern] of [
    ['', /empty or too large/], [undefined, /empty or too large/], ['x'.repeat(2 * 1024 * 1024 + 1), /empty or too large/],
    [good.replace('</channel>', ''), /out of order|open/], [good.replace('</rss>', '</RSS>'), /out of order/],
    [good.replace('</item>', '</item></item>'), /out of order/], [`${good}</rss>`, /out of order/],
    [good.replace('<title>AstralDeep</title>', '<title>AstralDeep'), /out of order|not well-formed/],
    [good.replace('<channel>', '<channel <'), /not well-formed/], [good.replace('<channel>', '< channel>'), /not well-formed/],
    [good.replace('<title>AstralDeep</title>', 'stray < text'), /not well-formed/],
    [`<!DOCTYPE rss [<!ENTITY x "y">]>${good}`, /document type/], [good.replace('<channel>', '<!ENTITY x "y"><channel>'), /document type/],
    [`${good}<rss/>`, /exactly one root/], ['text only', /exactly one root/], ['<rss', /not well-formed/], ['<!-- only -->', /exactly one root/],
    [good.replace('<channel>', '<channel a="1" a="2">'), /repeats attribute/],
    [good.replace('<title>AstralDeep</title>', '<title>&#xD800;</title>'), /invalid character/],
    [good.replace('<title>AstralDeep</title>', '<title>&#99999999;</title>'), /invalid character/]
  ]) assert.throws(() => parseAppcast(xml), pattern, String(xml).slice(0, 60));
  assert.throws(() => parseAppcast(feed([item()], '<rss version="2.0">')), /not a Sparkle RSS feed/);
  assert.throws(() => parseAppcast(feed([item()], `<atom xmlns:sparkle="${SPARKLE_NAMESPACE}">`).replace('</rss>', '</atom>')), /not a Sparkle RSS feed/);
  assert.throws(() => parseAppcast(`<rss xmlns:sparkle="${SPARKLE_NAMESPACE}"></rss>`), /no channel/);
});

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const policyText = (patch = {}) => JSON.stringify({ schemaVersion: 1, minimumBuild: 71, serial: 3, expires: '2027-06-01T00:00:00Z', message: 'Update required', ...patch });
const signed = (text, key = keys.privateKey) => ({ bytes: Buffer.from(text), signature: sign(null, Buffer.from(text), key).toString('base64') });

test('a signed policy verifies and every tampering or schema fault is refused', () => {
  const { bytes, signature } = signed(policyText());
  assert.equal(verifyPolicy(bytes, `${signature}\n`, publicKey).minimumBuild, 71);
  assert.throws(() => verifyPolicy(Buffer.from(policyText({ minimumBuild: 1 })), signature, publicKey), /does not verify/);
  assert.throws(() => verifyPolicy(bytes, signed(policyText(), generateKeyPairSync('ed25519').privateKey).signature, publicKey), /does not verify/);
  assert.throws(() => verifyPolicy(bytes, 'not-a-signature', publicKey), /malformed/);
  assert.throws(() => verifyPolicy(bytes, signature, 'AAAA'), /malformed/);
  assert.throws(() => verifyPolicy(bytes, signature), /does not verify/);
  const faults = [
    '{', 'null', policyText({ schemaVersion: 2 }), policyText({ minimumBuild: 0 }), policyText({ minimumBuild: 'x' }), policyText({ serial: -1 }),
    policyText({ message: '' }), policyText({ message: 'x'.repeat(201) }), policyText({ expires: 'tomorrow' }), policyText({ expires: '2027-13-45T99:00:00Z' }),
    policyText({ extra: true }), JSON.stringify({ schemaVersion: 1 })
  ];
  for (const text of faults) {
    const fixture = signed(text);
    assert.throws(() => verifyPolicy(fixture.bytes, fixture.signature, publicKey), /invalid|valid JSON/, text);
  }
  assert.equal(SPARKLE_PUBLIC_KEY, 'eg4hW6POM2f99hfVp8K+U5bx5Hpl8+P+IYLuW0+pPzw=');
});

const withSite = async run => {
  const root = await mkdtemp(join(tmpdir(), 'astral-appcast-test-'));
  try { await mkdir(join(root, 'data'), { recursive: true }); return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test('the build-time check tolerates absent files and rejects half-published or inconsistent ones', async () => {
  await withSite(async root => {
    assert.deepEqual(await checkMacUpdateFeed(root, downloads(), publicKey), { appcast: false, policy: false });
    assert.deepEqual(await checkMacUpdateFeed(join(root, 'missing'), downloads(), publicKey), { appcast: false, policy: false });

    await writeFile(join(root, 'appcast.xml'), feed([item({ build: 70, version: '1.8' }), item()]));
    assert.deepEqual(await checkMacUpdateFeed(root, downloads(), publicKey), { appcast: true, policy: false });
    await assert.rejects(checkMacUpdateFeed(root, downloads({ bytes: 5 }), publicKey), /disagrees with downloads\.json/);
    await assert.rejects(checkMacUpdateFeed(root, { schemaVersion: 1, macos: null }, publicKey), /without a Mac download record/);

    const { bytes, signature } = signed(policyText());
    await writeFile(join(root, 'data/mac-update-policy.json'), bytes);
    await assert.rejects(checkMacUpdateFeed(root, downloads(), publicKey), /published together/);
    await rm(join(root, 'data/mac-update-policy.json'));
    await writeFile(join(root, 'data/mac-update-policy.json.sig'), signature);
    await assert.rejects(checkMacUpdateFeed(root, downloads(), publicKey), /published together/);

    await writeFile(join(root, 'data/mac-update-policy.json'), bytes);
    assert.deepEqual(await checkMacUpdateFeed(root, downloads(), publicKey), { appcast: true, policy: true });
    await assert.rejects(checkMacUpdateFeed(root, downloads({ build: 70 }), publicKey), /disagrees|does not offer/);
    await writeFile(join(root, 'data/mac-update-policy.json'), Buffer.from(policyText({ minimumBuild: 72 })));
    await assert.rejects(checkMacUpdateFeed(root, downloads(), publicKey), /does not verify/);
    const high = signed(policyText({ minimumBuild: 72 }));
    await writeFile(join(root, 'data/mac-update-policy.json'), high.bytes);
    await writeFile(join(root, 'data/mac-update-policy.json.sig'), high.signature);
    await assert.rejects(checkMacUpdateFeed(root, downloads(), publicKey), /does not offer/);
    await rm(join(root, 'appcast.xml'));
    assert.deepEqual(await checkMacUpdateFeed(root, downloads({ build: 72 }), publicKey), { appcast: false, policy: true });
    await assert.rejects(checkMacUpdateFeed(root, { schemaVersion: 1, macos: null }, publicKey), /does not offer/);
  });
});

test('an unreadable appcast path surfaces the filesystem error instead of being skipped', async () => {
  await withSite(async root => {
    await mkdir(join(root, 'appcast.xml'));
    await assert.rejects(checkMacUpdateFeed(root, downloads(), publicKey), error => error.code === 'EISDIR');
  });
});

test('the site build fails on a mismatched appcast and publishes a matching feed verbatim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astral-appcast-build-'));
  try {
    for (const directory of ['scripts', 'site', 'data']) await cp(directory, join(root, directory), { recursive: true });
    const recorded = JSON.parse(await readFile(join(root, 'data/downloads.json'), 'utf8')).macos;
    const run = () => spawnSync(process.execPath, ['scripts/build.mjs', '--preview'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
    assert.equal(run().status, 0);
    const matching = feed([item({ build: recorded.build, version: recorded.version, length: recorded.bytes, url: recorded.url, extra: recorded.channel === 'preview' ? '\n      <sparkle:channel>preview</sparkle:channel>' : '' })]);
    await writeFile(join(root, 'site/appcast.xml'), matching);
    assert.equal(run().status, 0, run().stderr);
    assert.equal(await readFile(join(root, '_site/appcast.xml'), 'utf8'), matching);
    await writeFile(join(root, 'site/appcast.xml'), matching.replace(`length="${recorded.bytes}"`, `length="${recorded.bytes + 1}"`));
    const mismatch = run();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /disagrees with downloads\.json/);
    await writeFile(join(root, 'site/appcast.xml'), '<rss');
    assert.notEqual(run().status, 0);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'astral-appcast-build-')));
    await rm(root, { recursive: true, force: true });
  }
});
