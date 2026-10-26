// Serves deterministic AstralDeep GitHub releases and their assets so discovery and build tests never use the network.
// fetch-fixture.mjs replays the same routes inside a spawned build through a serialized copy.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { SPARKLE_NAMESPACE } from '../scripts/appcast.mjs';

export const keys = generateKeyPairSync('ed25519');
export const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const API = 'https://api.github.com/repos/AstralDeep/AstralDeep';
const ROOT = 'https://github.com/AstralDeep/AstralDeep/releases';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function macRecord(version, build, { channel = 'stable', format = 'dmg', bytes = 23456789 } = {}) {
  const tag = `macos-v${version}-${build}`;
  return {
    version, build, minimumMacOS: '14.0', architecture: 'arm64', format, channel, bytes,
    sha256: createHash('sha256').update(tag).digest('hex'),
    url: `${ROOT}/download/${tag}/AstralDeep-${version}-${build}-arm64.${format}`,
    releaseURL: `${ROOT}/tag/${tag}`, checksumsURL: `${ROOT}/download/${tag}/SHA256SUMS`,
    source: { deep: createHash('sha1').update(`deep ${tag}`).digest('hex'), projection: createHash('sha1').update(`projection ${tag}`).digest('hex') }
  };
}

export function appcastFor(records) {
  const items = records.map(record => `
    <item>
      <title>${record.version}</title>
      <sparkle:version>${record.build}</sparkle:version>
      <sparkle:shortVersionString>${record.version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${record.minimumMacOS}</sparkle:minimumSystemVersion>${record.channel === 'preview' ? '\n      <sparkle:channel>preview</sparkle:channel>' : ''}
      <enclosure url="${record.url}" length="${record.bytes}" type="application/octet-stream" sparkle:edSignature="${'A'.repeat(86)}=="/>
    </item>`).join('');
  return `<?xml version="1.0" standalone="yes"?>\n<rss version="2.0" xmlns:sparkle="${SPARKLE_NAMESPACE}">\n  <channel>\n    <title>AstralDeep</title>${items}\n  </channel>\n</rss>\n`;
}

export function signedPolicy(minimumBuild, key = keys.privateKey) {
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, minimumBuild, serial: 1, expires: '2027-04-26T00:00:00Z', message: 'Update AstralDeep to keep using it.' })}\n`);
  return { bytes, signature: `${sign(null, bytes, key).toString('base64')}\n` };
}

export class ReleaseWorld {
  constructor() {
    this.releases = [];
    this.routes = new Map();
    this.calls = [];
    this.transport = this.transport.bind(this);
  }

  json(path, value) { this.routes.set(`${API}${path}`, { status: 200, body: Buffer.from(JSON.stringify(value)) }); }

  file(url, body) { this.routes.set(url, { status: 200, body: Buffer.from(body) }); }

  publish(version, build, { channel = 'stable', format = 'dmg', id = build, draft = false, feed = true, older = [], minimumBuild = 70 } = {}) {
    const record = macRecord(version, build, { channel, format });
    const tag = `macos-v${version}-${build}`;
    const name = record.url.split('/').at(-1);
    const sums = `${record.sha256}  ${name}\n`;
    const release = { id, tag_name: tag, html_url: record.releaseURL, draft, prerelease: channel === 'preview', immutable: true, published_at: '2026-10-26T12:00:00Z' };
    const assets = [
      { id: id * 100 + 1, name, browser_download_url: record.url, state: 'uploaded', size: record.bytes, digest: `sha256:${record.sha256}` },
      { id: id * 100 + 2, name: 'SHA256SUMS', browser_download_url: record.checksumsURL, state: 'uploaded', size: Buffer.byteLength(sums), digest: digest(sums) }
    ];
    this.file(record.checksumsURL, sums);
    const files = {};
    if (feed) {
      const policy = signedPolicy(minimumBuild);
      files['downloads.json'] = `${JSON.stringify({ schemaVersion: 1, macos: record }, null, 2)}\n`;
      files['appcast.xml'] = appcastFor([...older, record]);
      files['mac-update-policy.json'] = policy.bytes;
      files['mac-update-policy.json.sig'] = policy.signature;
      for (const [file, body] of Object.entries(files)) {
        const url = `${ROOT}/download/${tag}/${file}`;
        assets.push({ id: id * 100 + assets.length + 1, name: file, browser_download_url: url, state: 'uploaded', size: Buffer.byteLength(body), digest: digest(body) });
        this.file(url, body);
      }
    }
    this.releases.push(release);
    this.json(`/releases/tags/${tag}`, release);
    this.json(`/git/ref/tags/${tag}`, { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: record.source.deep } });
    this.json(`/contents/components/AstralProjection?ref=${record.source.deep}`, { sha: record.source.projection, path: 'components/AstralProjection', submodule_git_url: 'https://github.com/AstralDeep/AstralProjection.git' });
    this.json(`/releases/${id}/assets?per_page=100&page=1`, assets);
    return { record, release, assets, files, tag };
  }

  replaceAsset(entry, file, body, declared = {}) {
    const asset = entry.assets.find(item => item.name === file);
    asset.size = Object.hasOwn(declared, 'size') ? declared.size : Buffer.byteLength(body);
    asset.digest = Object.hasOwn(declared, 'digest') ? declared.digest : digest(body);
    this.file(asset.browser_download_url, body);
    this.json(`/releases/${entry.release.id}/assets?per_page=100&page=1`, entry.assets);
  }

  serialize() {
    const routes = Object.fromEntries([...this.routes].map(([url, route]) => [url, { status: route.status, body: route.body.toString('base64') }]));
    routes[`${API}/releases?per_page=100&page=1`] = { status: 200, body: Buffer.from(JSON.stringify(this.releases)).toString('base64') };
    return routes;
  }

  async transport(url, options = {}) {
    this.calls.push(url);
    if (options.credentials !== undefined && options.credentials !== 'omit') throw new Error('Fixture requests must omit credentials');
    if (url === `${API}/releases?per_page=100&page=1`) return new Response(JSON.stringify(this.releases));
    const route = this.routes.get(url);
    return route ? new Response(route.body, { status: route.status }) : new Response('Not Found', { status: 404 });
  }
}
