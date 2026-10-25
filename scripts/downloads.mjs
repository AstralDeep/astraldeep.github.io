// Validates published client metadata and renders the static download action used by build.mjs.
import { createHash } from 'node:crypto';

const architectures = { arm64: 'Apple silicon', x86_64: 'Intel', universal: 'Apple silicon and Intel' };
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const version = value => typeof value === 'string' && /^[1-9]\d*\.\d+(?:\.\d+)?$/.test(value);
const keys = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export function validateDownloads(manifest) {
  if (!keys(manifest, ['schemaVersion', 'macos']) || manifest.schemaVersion !== 1) throw new Error('Invalid download manifest');
  const mac = manifest.macos;
  if (mac === null) return manifest;
  if (!keys(mac, ['version', 'build', 'minimumMacOS', 'architecture', 'format', 'channel', 'bytes', 'sha256', 'url', 'releaseURL', 'checksumsURL', 'source'])
    || !version(mac.version) || !version(mac.minimumMacOS) || !Number.isSafeInteger(mac.build) || mac.build < 1
    || !Object.hasOwn(architectures, mac.architecture) || !['dmg', 'zip'].includes(mac.format) || !['stable', 'preview'].includes(mac.channel)
    || !Number.isSafeInteger(mac.bytes) || mac.bytes < 1 || mac.bytes > 2147483648
    || !hex(mac.sha256, 64)) throw new Error('Invalid Mac release identity');
  const root = 'https://github.com/AstralDeep/AstralDeep/releases';
  const tag = `macos-v${mac.version}-${mac.build}`;
  const filename = `AstralDeep-${mac.version}-${mac.build}-${mac.architecture}.${mac.format}`;
  if (mac.url !== `${root}/download/${tag}/${filename}` || mac.releaseURL !== `${root}/tag/${tag}`
    || mac.checksumsURL !== `${root}/download/${tag}/SHA256SUMS`) throw new Error('Mac release links disagree');
  if (!keys(mac.source, ['deep', 'projection']) || !hex(mac.source.deep, 40) || !hex(mac.source.projection, 40)) throw new Error('Mac release source is not pinned');
  return manifest;
}

export function renderMacDownload(release) {
  const mac = validateDownloads({ schemaVersion: 1, macos: release }).macos;
  if (mac === null) return '<p class="download-status" role="status">Mac download in preparation</p>';
  return `<p class="download-version">${mac.version} (${mac.build})${mac.channel === 'preview' ? ' preview' : ''}</p>
<p class="download-compatibility">${architectures[mac.architecture]}<br>macOS ${mac.minimumMacOS} or later</p>
<a class="button primary download-action" id="download-macos" href="${mac.url}">Download for Mac <span class="download-size">${mac.format.toUpperCase()} ${(mac.bytes / 1048576).toFixed(1)} MB</span></a>
<div class="download-links"><a href="${mac.releaseURL}">Release notes</a><a href="${mac.checksumsURL}">Checksums</a></div>
<details class="download-integrity"><summary>SHA-256</summary><code>${mac.sha256}</code></details>`;
}

export async function verifyPublishedDownload(release, github, transport = fetch) {
  const mac = validateDownloads({ schemaVersion: 1, macos: release }).macos;
  if (mac === null) return;
  const tag = `macos-v${mac.version}-${mac.build}`;
  const published = await github.request(`/repos/AstralDeep/AstralDeep/releases/tags/${tag}`);
  if (!published || published.draft !== false || published.prerelease !== (mac.channel === 'preview') || published.immutable !== true
    || published.tag_name !== tag || published.html_url !== mac.releaseURL || !Number.isFinite(Date.parse(published.published_at))
    || !Number.isSafeInteger(published.id) || published.id < 1) throw new Error('Mac release is not published and immutable');
  const reference = await github.request(`/repos/AstralDeep/AstralDeep/git/ref/tags/${tag}`);
  let object = reference?.object;
  for (let depth = 0; depth < 5 && object?.type === 'tag' && hex(object.sha, 40); depth++) {
    object = (await github.request(`/repos/AstralDeep/AstralDeep/git/tags/${object.sha}`))?.object;
  }
  if (reference?.ref !== `refs/tags/${tag}` || object?.type !== 'commit' || object.sha !== mac.source.deep) throw new Error('Mac release tag disagrees with its source');
  const component = await github.request(`/repos/AstralDeep/AstralDeep/contents/components/AstralProjection?ref=${mac.source.deep}`);
  if (component?.sha !== mac.source.projection || component.path !== 'components/AstralProjection'
    || component.submodule_git_url !== 'https://github.com/AstralDeep/AstralProjection.git') throw new Error('Mac release component pin disagrees');
  const assets = await github.pages(`/repos/AstralDeep/AstralDeep/releases/${published.id}/assets`);
  const asset = url => {
    const matches = assets.filter(item => item.browser_download_url === url);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || !Number.isSafeInteger(matches[0].id)
      || matches[0].id < 1 || matches[0].name !== url.split('/').at(-1)) throw new Error('Mac release asset is missing or ambiguous');
    return matches[0];
  };
  const image = asset(mac.url);
  const sums = asset(mac.checksumsURL);
  if (image.size !== mac.bytes || image.digest !== `sha256:${mac.sha256}` || !Number.isSafeInteger(sums.size)
    || sums.size < 1 || sums.size > 4096 || !/^sha256:[a-f0-9]{64}$/.test(sums.digest)) throw new Error('Mac release asset identity disagrees');
  const response = await transport(mac.checksumsURL, { signal: AbortSignal.timeout(30000), credentials: 'omit', redirect: 'follow' });
  if (!response.ok) throw new Error('Mac checksums are unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error('Mac checksums exceed their size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (size !== sums.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== sums.digest
    || !bytes.equals(Buffer.from(`${mac.sha256}  ${image.name}\n`))) throw new Error('Mac checksum bytes disagree');
}
