// Finds the newest macos-v release of AstralDeep/AstralDeep and returns its verified client offers, appcast and signed policy.
// build.mjs renders what discoverMacRelease returns; release-discovery-cli.mjs uses liveReleaseChange to decide whether Pages redeploys.
import { createHash } from 'node:crypto';
import { validateDownloads, verifyPublishedDownload } from './downloads.mjs';
import { SPARKLE_PUBLIC_KEY, crossCheckAppcast, parseAppcast, verifyPolicy } from './appcast.mjs';

const REPOSITORY = '/repos/AstralDeep/AstralDeep';
const DOWNLOAD_ROOT = 'https://github.com/AstralDeep/AstralDeep/releases/download';
const TAG = /^macos-v([1-9]\d*\.\d+(?:\.\d+)?)-(\d+)$/;
const SIGNATURE_LINE = /^[A-Za-z0-9+/]{86}==\n?$/;
export const ASSET_LIMITS = Object.freeze({ 'downloads.json': 16384, 'appcast.xml': 2097152, 'mac-update-policy.json': 4096, 'mac-update-policy.json.sig': 256 });
const NODE_PACK_ASSETS = Object.freeze({
  'macos-arm64': { descriptor: 'node-pack.json', manifest: 'node-pack-manifest.json' },
  'linux-x86_64': { descriptor: 'node-pack-linux-x86_64.json', manifest: 'node-pack-linux-x86_64-manifest.json' },
  'linux-aarch64': { descriptor: 'node-pack-linux-aarch64.json', manifest: 'node-pack-linux-aarch64-manifest.json' }
});
const NODE_PACK_ASSET_LIMITS = Object.freeze(Object.fromEntries(Object.values(NODE_PACK_ASSETS)
  .flatMap(names => [[names.descriptor, 65536], [names.manifest, 33554432]])));
const NODE_PACK_ARCHIVE_LIMIT = 1073741824;
const NODE_PACK_INSTALLED_LIMIT = 4294967296;
const NODE_PACK_FORMAT = 'astral.nodepack-descriptor/v1';
const NODE_PACK_MANIFEST_FORMAT = 'astral.nodepack-manifest/v1';

const request = { credentials: 'omit', redirect: 'follow' };
const utf8 = (bytes, label) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error(`${label} is not UTF-8`); }
};
const json = (text, label) => {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
};

async function readBounded(response, limit, label) {
  if (!response.ok || !response.body) throw new Error(`${label} is unavailable`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error(`${label} exceeds its size limit`);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export function newestMacRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Expected a GitHub release list');
  let newest = null;
  let tied = false;
  for (const release of releases) {
    const match = release?.draft === false && typeof release.tag_name === 'string' ? TAG.exec(release.tag_name) : null;
    if (!match) continue;
    const build = Number(match[2]);
    if (!Number.isSafeInteger(build) || build < 1 || String(build) !== match[2]) throw new Error(`Mac release tag is not canonical: ${release.tag_name}`);
    if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error(`Mac release identity is invalid: ${release.tag_name}`);
    if (newest && build === newest.build) tied = true;
    else if (!newest || build > newest.build) {
      newest = { id: release.id, tag: release.tag_name, version: match[1], build };
      tied = false;
    }
  }
  if (tied) throw new Error(`Two Mac releases share the newest build ${newest.build}`);
  return newest;
}

async function releaseAsset(assets, tag, name, transport) {
  const label = `Mac release asset ${name}`;
  const url = `${DOWNLOAD_ROOT}/${tag}/${name}`;
  const matches = assets.filter(item => item?.name === name);
  const asset = matches[0];
  if (matches.length !== 1 || asset.state !== 'uploaded' || asset.browser_download_url !== url) throw new Error(`${label} is missing or ambiguous`);
  const limit = ASSET_LIMITS[name] ?? NODE_PACK_ASSET_LIMITS[name];
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit) throw new Error(`${label} is empty or exceeds its size limit`);
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error(`${label} has no provider digest`);
  const bytes = await readBounded(await transport(url, { ...request, signal: AbortSignal.timeout(30000) }), limit, label);
  if (bytes.length !== asset.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error(`${label} disagrees with its provider digest`);
  return bytes;
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveSize = (value, limit) => Number.isSafeInteger(value) && value > 0 && value <= limit;
const exactKeys = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

async function discoverNodePack(assets, tag, transport, platform = 'macos-arm64') {
  const names = NODE_PACK_ASSETS[platform];
  const hasDescriptor = assets.some(asset => asset?.name === names.descriptor);
  const hasManifest = assets.some(asset => asset?.name === names.manifest);
  const hasArchive = assets.some(asset => typeof asset?.name === 'string' && asset.name.startsWith('astral-node-pack-') && asset.name.endsWith(`-${platform}.tar.gz`));
  if (!hasDescriptor && !hasManifest && !hasArchive) return null;
  const descriptorBytes = await releaseAsset(assets, tag, names.descriptor, transport);
  const descriptor = json(utf8(descriptorBytes, 'NodePack descriptor'), 'NodePack descriptor');
  if (!exactKeys(descriptor, ['format', 'platform', 'version', 'archive', 'installed_bytes', 'manifest_sha256'])
    || descriptor.format !== NODE_PACK_FORMAT || descriptor.platform !== platform
    || typeof descriptor.version !== 'string' || !/^\d+\.\d+\.\d+-[a-f0-9]{8}-[a-f0-9]{7}$/.test(descriptor.version)
    || !positiveSize(descriptor.installed_bytes, NODE_PACK_INSTALLED_LIMIT) || !digest(descriptor.manifest_sha256)
    || !exactKeys(descriptor.archive, ['file', 'size', 'sha256'])) throw new Error('NodePack descriptor is invalid');
  const { archive } = descriptor;
  const expectedFile = `astral-node-pack-${descriptor.version}-${platform}.tar.gz`;
  if (archive.file !== expectedFile || !positiveSize(archive.size, NODE_PACK_ARCHIVE_LIMIT) || !digest(archive.sha256)) throw new Error('NodePack archive identity is invalid');
  const manifestBytes = await releaseAsset(assets, tag, names.manifest, transport);
  if (createHash('sha256').update(manifestBytes).digest('hex') !== descriptor.manifest_sha256) throw new Error('NodePack manifest digest disagrees with descriptor');
  const manifest = json(utf8(manifestBytes, 'NodePack manifest'), 'NodePack manifest');
  const versionParts = descriptor.version.split('-');
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object'
    || manifest.format !== NODE_PACK_MANIFEST_FORMAT || manifest.platform !== descriptor.platform
    || manifest.version !== descriptor.version || manifest.installed_bytes !== descriptor.installed_bytes
    || typeof manifest.deep?.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.deep.commit) || !manifest.deep.commit.startsWith(versionParts[1])
    || typeof manifest.kernel?.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.kernel.commit) || !manifest.kernel.commit.startsWith(versionParts[2])) throw new Error('NodePack manifest identity disagrees with descriptor');
  const archiveURL = `${DOWNLOAD_ROOT}/${tag}/${archive.file}`;
  const matches = assets.filter(item => item?.name === archive.file);
  const asset = matches[0];
  if (matches.length !== 1 || asset.state !== 'uploaded' || asset.browser_download_url !== archiveURL
    || asset.size !== archive.size || asset.digest !== `sha256:${archive.sha256}`) throw new Error('NodePack archive disagrees with its provider asset');
  return { version: descriptor.version, archiveURL, archiveSize: archive.size, archiveSha256: archive.sha256,
    descriptorURL: `${DOWNLOAD_ROOT}/${tag}/${names.descriptor}`, manifestURL: `${DOWNLOAD_ROOT}/${tag}/${names.manifest}` };
}

export async function discoverMacRelease(github, floor, transport = fetch, publicKey = SPARKLE_PUBLIC_KEY) {
  const base = validateDownloads({ schemaVersion: 1, macos: floor }).macos;
  const newest = newestMacRelease(await github.pages(`${REPOSITORY}/releases`));
  if (newest && base && newest.build < base.build) throw new Error(`Newest Mac release ${newest.tag} is older than the committed floor`);
  if (!newest || (base && newest.build === base.build)) {
    if (newest && newest.version !== base.version) throw new Error(`Mac release ${newest.tag} disagrees with the committed floor`);
    await verifyPublishedDownload(base, github, transport);
    let nodePack = null;
    let linuxNodePack = null;
    let linuxArm64NodePack = null;
    if (base) {
      const tag = `macos-v${base.version}-${base.build}`;
      const published = await github.request(`${REPOSITORY}/releases/tags/${tag}`);
      const assets = await github.pages(`${REPOSITORY}/releases/${published.id}/assets`);
      nodePack = await discoverNodePack(assets, tag, transport);
      linuxNodePack = await discoverNodePack(assets, tag, transport, 'linux-x86_64');
      linuxArm64NodePack = await discoverNodePack(assets, tag, transport, 'linux-aarch64');
    }
    return { record: base, nodePack, linuxNodePack, linuxArm64NodePack, appcast: null, policy: null, signature: null };
  }
  const assets = await github.pages(`${REPOSITORY}/releases/${newest.id}/assets`);
  const files = {};
  for (const name of Object.keys(ASSET_LIMITS)) files[name] = await releaseAsset(assets, newest.tag, name, transport);
  const record = validateDownloads(json(utf8(files['downloads.json'], 'Mac release downloads.json'), 'Mac release downloads.json')).macos;
  if (record === null || record.version !== newest.version || record.build !== newest.build) throw new Error(`Mac release ${newest.tag} carries a Downloads record for another release`);
  await verifyPublishedDownload(record, github, transport);
  const nodePack = await discoverNodePack(assets, newest.tag, transport);
  const linuxNodePack = await discoverNodePack(assets, newest.tag, transport, 'linux-x86_64');
  const linuxArm64NodePack = await discoverNodePack(assets, newest.tag, transport, 'linux-aarch64');
  const appcast = utf8(files['appcast.xml'], 'Mac release appcast.xml');
  crossCheckAppcast(parseAppcast(appcast), { schemaVersion: 1, macos: record });
  const signature = utf8(files['mac-update-policy.json.sig'], 'Mac release update policy signature');
  if (!SIGNATURE_LINE.test(signature)) throw new Error('Update policy signature is malformed');
  const policy = verifyPolicy(files['mac-update-policy.json'], signature, publicKey);
  if (policy.minimumBuild > record.build) throw new Error('Update policy requires a build the discovered release does not offer');
  return { record, nodePack, linuxNodePack, linuxArm64NodePack, appcast, policy: files['mac-update-policy.json'], signature };
}

export async function liveReleaseChange(github, liveURL, transport = fetch) {
  if (new URL(liveURL).protocol !== 'https:') throw new Error('Live Downloads record URL must use https');
  const newest = newestMacRelease(await github.pages(`${REPOSITORY}/releases`));
  const response = await transport(liveURL, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  let live = null;
  if (response.status === 404) await response.body?.cancel();
  else {
    const label = 'Live Downloads record';
    const mac = validateDownloads(json(utf8(await readBounded(response, ASSET_LIMITS['downloads.json'], label), label), label)).macos;
    live = mac && `macos-v${mac.version}-${mac.build}`;
  }
  const tag = newest?.tag ?? null;
  return { newest: tag, live, changed: tag !== null && tag !== live };
}
