// Finds the newest macos-v release of AstralDeep/AstralDeep and returns its verified Downloads record, appcast and signed policy.
// build.mjs renders what discoverMacRelease returns; release-discovery-cli.mjs uses liveReleaseChange to decide whether Pages redeploys.
import { createHash } from 'node:crypto';
import { validateDownloads, verifyPublishedDownload } from './downloads.mjs';
import { SPARKLE_PUBLIC_KEY, crossCheckAppcast, parseAppcast, verifyPolicy } from './appcast.mjs';

const REPOSITORY = '/repos/AstralDeep/AstralDeep';
const DOWNLOAD_ROOT = 'https://github.com/AstralDeep/AstralDeep/releases/download';
const TAG = /^macos-v([1-9]\d*\.\d+(?:\.\d+)?)-(\d+)$/;
const SIGNATURE_LINE = /^[A-Za-z0-9+/]{86}==\n?$/;
export const ASSET_LIMITS = Object.freeze({ 'downloads.json': 16384, 'appcast.xml': 2097152, 'mac-update-policy.json': 4096, 'mac-update-policy.json.sig': 256 });

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
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > ASSET_LIMITS[name]) throw new Error(`${label} is empty or exceeds its size limit`);
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error(`${label} has no provider digest`);
  const bytes = await readBounded(await transport(url, { ...request, signal: AbortSignal.timeout(30000) }), ASSET_LIMITS[name], label);
  if (bytes.length !== asset.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error(`${label} disagrees with its provider digest`);
  return bytes;
}

export async function discoverMacRelease(github, floor, transport = fetch, publicKey = SPARKLE_PUBLIC_KEY) {
  const base = validateDownloads({ schemaVersion: 1, macos: floor }).macos;
  const newest = newestMacRelease(await github.pages(`${REPOSITORY}/releases`));
  if (newest && base && newest.build < base.build) throw new Error(`Newest Mac release ${newest.tag} is older than the committed floor`);
  if (!newest || (base && newest.build === base.build)) {
    if (newest && newest.version !== base.version) throw new Error(`Mac release ${newest.tag} disagrees with the committed floor`);
    await verifyPublishedDownload(base, github, transport);
    return { record: base, appcast: null, policy: null, signature: null };
  }
  const assets = await github.pages(`${REPOSITORY}/releases/${newest.id}/assets`);
  const files = {};
  for (const name of Object.keys(ASSET_LIMITS)) files[name] = await releaseAsset(assets, newest.tag, name, transport);
  const record = validateDownloads(json(utf8(files['downloads.json'], 'Mac release downloads.json'), 'Mac release downloads.json')).macos;
  if (record === null || record.version !== newest.version || record.build !== newest.build) throw new Error(`Mac release ${newest.tag} carries a Downloads record for another release`);
  await verifyPublishedDownload(record, github, transport);
  const appcast = utf8(files['appcast.xml'], 'Mac release appcast.xml');
  crossCheckAppcast(parseAppcast(appcast), { schemaVersion: 1, macos: record });
  const signature = utf8(files['mac-update-policy.json.sig'], 'Mac release update policy signature');
  if (!SIGNATURE_LINE.test(signature)) throw new Error('Update policy signature is malformed');
  const policy = verifyPolicy(files['mac-update-policy.json'], signature, publicKey);
  if (policy.minimumBuild > record.build) throw new Error('Update policy requires a build the discovered release does not offer');
  return { record, appcast, policy: files['mac-update-policy.json'], signature };
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
