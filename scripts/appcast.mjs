// Parses the Sparkle appcast and signed update policy with Node built-ins and cross-checks them against the Downloads record.
// build.mjs calls checkMacUpdateFeed so a feed that disagrees with downloads.json can never be published.
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SPARKLE_NAMESPACE = 'http://www.andymatuschak.org/xml-namespaces/sparkle';
export const SPARKLE_PUBLIC_KEY = 'eg4hW6POM2f99hfVp8K+U5bx5Hpl8+P+IYLuW0+pPzw=';
const RELEASE_ROOT = 'https://github.com/AstralDeep/AstralDeep/releases/download/';
const MAX_BYTES = 2 * 1024 * 1024;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([A-Za-z_][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decode = text => text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, name) => {
  if (name[0] !== '#') return ENTITIES[name];
  const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  if (!Number.isSafeInteger(code) || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) throw new Error('Appcast contains an invalid character reference');
  return String.fromCodePoint(code);
});

function parseXML(xml) {
  if (typeof xml !== 'string' || xml.length === 0 || Buffer.byteLength(xml) > MAX_BYTES) throw new Error('Appcast is empty or too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Appcast must not declare a document type');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < xml.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(xml);
    if (!match) throw new Error(`Appcast is not well-formed near offset ${start}`);
    const [, cdata, closing, opening, rawAttributes, selfClosing, text] = match;
    const current = stack.at(-1);
    if (cdata !== undefined) current.text += cdata;
    else if (text !== undefined) current.text += decode(text);
    else if (opening !== undefined) {
      const attrs = {};
      for (const [, name, double, single] of rawAttributes.matchAll(ATTRIBUTE)) {
        if (Object.hasOwn(attrs, name)) throw new Error(`Appcast repeats attribute ${name}`);
        attrs[name] = decode(double ?? single);
      }
      const element = { name: opening, attrs, children: [], text: '' };
      current.children.push(element);
      if (!selfClosing) stack.push(element);
    } else if (closing !== undefined) {
      if (stack.length < 2 || stack.at(-1).name !== closing) throw new Error(`Appcast closes <${closing}> out of order`);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new Error(`Appcast leaves <${stack.at(-1).name}> open`);
  const elements = root.children;
  if (elements.length !== 1 || root.text.trim() !== '') throw new Error('Appcast must contain exactly one root element');
  return elements[0];
}

const child = (element, name) => element.children.find(item => item.name === name);
const childText = (element, name) => child(element, name)?.text.trim();
const numeric = value => /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
const versionParts = value => String(value).split('.').map(Number);
const sameVersion = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => (a[index] ?? 0) === (b[index] ?? 0)).every(Boolean);
};

export function parseAppcast(xml) {
  const rss = parseXML(xml);
  if (rss.name !== 'rss' || rss.attrs['xmlns:sparkle'] !== SPARKLE_NAMESPACE) throw new Error('Appcast is not a Sparkle RSS feed');
  const channel = child(rss, 'channel');
  if (!channel) throw new Error('Appcast has no channel');
  const items = channel.children.filter(element => element.name === 'item').map((item, index) => {
    const label = `Appcast item ${index + 1}`;
    const enclosure = child(item, 'enclosure');
    if (!enclosure) throw new Error(`${label} has no enclosure`);
    const build = numeric(childText(item, 'sparkle:version') ?? enclosure.attrs['sparkle:version']);
    const shortVersion = childText(item, 'sparkle:shortVersionString') ?? enclosure.attrs['sparkle:shortVersionString'];
    if (build === null) throw new Error(`${label} has no numeric sparkle:version`);
    if (!/^[1-9]\d*\.\d+(?:\.\d+)?$/.test(shortVersion ?? '')) throw new Error(`${label} has no sparkle:shortVersionString`);
    const url = enclosure.attrs.url;
    if (typeof url !== 'string' || !url.startsWith(RELEASE_ROOT) || /[?#\s]/.test(url)) throw new Error(`${label} enclosure is not a release asset`);
    const length = numeric(enclosure.attrs.length);
    if (length === null) throw new Error(`${label} enclosure has no byte length`);
    const signature = enclosure.attrs['sparkle:edSignature'];
    if (!SIGNATURE.test(signature ?? '')) throw new Error(`${label} enclosure has no EdDSA signature`);
    return {
      build, shortVersion, url, length, signature,
      channel: childText(item, 'sparkle:channel') ?? null,
      minimumSystemVersion: childText(item, 'sparkle:minimumSystemVersion') ?? null
    };
  });
  if (items.length === 0) throw new Error('Appcast lists no updates');
  if (new Set(items.map(item => item.build)).size !== items.length) throw new Error('Appcast repeats a build number');
  return { items, newest: items.reduce((best, item) => item.build > best.build ? item : best) };
}

export function crossCheckAppcast(appcast, downloads) {
  const mac = downloads?.macos;
  if (!mac) throw new Error('Appcast is published without a Mac download record');
  const { newest } = appcast;
  const expectedChannel = mac.channel === 'preview' ? 'preview' : null;
  const mismatches = [
    ['build', newest.build, mac.build], ['version', newest.shortVersion, mac.version],
    ['url', newest.url, mac.url], ['length', newest.length, mac.bytes], ['channel', newest.channel, expectedChannel]
  ].filter(([, actual, expected]) => actual !== expected).map(([name, actual, expected]) => `${name} ${actual} != ${expected}`);
  if (newest.minimumSystemVersion !== null && !sameVersion(newest.minimumSystemVersion, mac.minimumMacOS)) {
    mismatches.push(`minimumSystemVersion ${newest.minimumSystemVersion} != ${mac.minimumMacOS}`);
  }
  if (mismatches.length) throw new Error(`Appcast newest item disagrees with downloads.json: ${mismatches.join('; ')}`);
}

export function verifyPolicy(bytes, signatureText, publicKey = SPARKLE_PUBLIC_KEY) {
  const signature = Buffer.from(String(signatureText).trim(), 'base64');
  const raw = Buffer.from(publicKey, 'base64');
  if (signature.length !== 64 || raw.length !== 32) throw new Error('Update policy signature is malformed');
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  if (!verify(null, bytes, key, signature)) throw new Error('Update policy signature does not verify');
  let policy;
  try { policy = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Update policy is not valid JSON'); }
  const keys = Object.keys(policy ?? {}).sort().join();
  if (keys !== 'expires,message,minimumBuild,schemaVersion,serial' || policy.schemaVersion !== 1
    || !Number.isSafeInteger(policy.minimumBuild) || policy.minimumBuild < 1
    || !Number.isSafeInteger(policy.serial) || policy.serial < 0
    || typeof policy.message !== 'string' || policy.message.length === 0 || policy.message.length > 200
    || typeof policy.expires !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(policy.expires)
    || !Number.isFinite(Date.parse(policy.expires))) throw new Error('Update policy fields are invalid');
  return policy;
}

async function optional(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function checkMacUpdateFeed(siteRoot, downloads, publicKey = SPARKLE_PUBLIC_KEY) {
  const xml = await optional(join(siteRoot, 'appcast.xml'));
  const appcast = xml === null ? null : parseAppcast(xml.toString('utf8'));
  if (appcast) crossCheckAppcast(appcast, downloads);
  const bytes = await optional(join(siteRoot, 'data/mac-update-policy.json'));
  const signature = await optional(join(siteRoot, 'data/mac-update-policy.json.sig'));
  if (bytes === null && signature === null) return { appcast: appcast !== null, policy: false };
  if (bytes === null || signature === null) throw new Error('Update policy and its signature must be published together');
  const policy = verifyPolicy(bytes, signature.toString('utf8'), publicKey);
  if (policy.minimumBuild > (downloads?.macos?.build ?? 0)) throw new Error('Update policy requires a build the Downloads record does not offer');
  return { appcast: appcast !== null, policy: true };
}
