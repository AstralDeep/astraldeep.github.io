// Hydrates or persists the three community ledgers while executable code stays on the trusted main branch.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { readState, persistState, statePaths } from './state.mjs';

const config = JSON.parse(await readFile('data/config.json', 'utf8'));
if (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Community state operations require coordinator main');
const api = new GitHub(process.env.GITHUB_TOKEN);
const mode = process.argv[2];
if (mode === 'load') {
  const snapshot = await readState(api, config);
  await mkdir('.cache', { recursive: true });
  for (const path of statePaths) await writeFile(path, snapshot.files[path]);
  await writeFile('.cache/state-snapshot.json', JSON.stringify(snapshot));
  console.log(`Loaded community state at ${snapshot.sha}.`);
} else if (mode === 'save') {
  const snapshot = JSON.parse(await readFile('.cache/state-snapshot.json', 'utf8'));
  const files = Object.fromEntries(await Promise.all(statePaths.map(async path => [path, await readFile(path, 'utf8')])));
  console.log(`Verified durable community state at ${await persistState(api, config, snapshot, files)}.`);
} else throw new Error('Expected community state load or save');
