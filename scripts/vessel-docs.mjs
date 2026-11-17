// Checks a built Vessel docs folder against its astral-docs.json manifest, and runs as a CLI for the site build and CI.
// The site copy under site/AstralVessel comes from vessel/scripts/export_site_docs.py in AstralDeep and is never edited by hand.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'astral-docs.json';
const PAGE_PREFIX = 'https://astraldeep.github.io/AstralVessel/';

const walk = async (root, directory = '') => {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const relative = directory === '' ? entry.name : posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(root, relative));
    else found.push(relative);
  }
  return found;
};

const safePath = path => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

const sitemapPaths = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => {
  if (!url.startsWith(PAGE_PREFIX)) return { url, path: null };
  const rest = url.slice(PAGE_PREFIX.length);
  return { url, path: rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest };
});

export async function checkDocs(root) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, MANIFEST), 'utf8')); }
  catch (error) { return [`${MANIFEST} is missing or not JSON: ${error.message}`]; }
  if (!Array.isArray(manifest.files) || typeof manifest.commit !== 'string') return [`${MANIFEST} has no commit or file list`];
  const expected = new Map();
  for (const file of manifest.files) {
    if (!safePath(file.path) || file.path === MANIFEST) { problems.push(`unsafe manifest path: ${file.path}`); continue; }
    expected.set(file.path, file);
  }
  for (const [path, file] of expected) {
    let bytes;
    try { bytes = await readFile(join(root, ...path.split('/'))); }
    catch { problems.push(`missing file: ${path}`); continue; }
    if (bytes.length !== file.size) problems.push(`size differs: ${path}`);
    else if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) problems.push(`content differs: ${path}`);
  }
  for (const path of await walk(root)) {
    if (path !== MANIFEST && !expected.has(path)) problems.push(`extra file: ${path.split(sep).join('/')}`);
  }
  let sitemap = '';
  try { sitemap = await readFile(join(root, 'sitemap.xml'), 'utf8'); }
  catch { problems.push('missing file: sitemap.xml'); }
  for (const { url, path } of sitemapPaths(sitemap)) {
    if (path === null) problems.push(`sitemap URL outside the docs: ${url}`);
    else if (!(await stat(join(root, ...path.split('/'))).then(info => info.isFile(), () => false))) problems.push(`sitemap path has no page: ${url}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const folder = process.argv[2] === '--check' ? process.argv[3] : undefined;
  if (folder === undefined) { console.error('usage: vessel-docs.mjs --check <folder>'); process.exit(2); }
  const problems = await checkDocs(folder);
  if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${folder} matches ${MANIFEST}`);
}
