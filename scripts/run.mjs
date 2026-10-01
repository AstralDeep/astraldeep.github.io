// Refreshes the generated board and persists reservation decisions for the trusted main-branch workflow.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { synchronize } from './sync.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const config = await json('data/config.json');
const claims = await json('state/claims.json');
const awards = await json('data/awards.json');
const result = await synchronize(new GitHub(process.env.GITHUB_TOKEN), config, claims, awards, new Date().toISOString());
await mkdir('.cache', { recursive: true });
await writeFile('.cache/board.json', `${JSON.stringify(result.board, null, 2)}\n`);
if (process.argv.includes('--persist-claims')) {
  if (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Reservation writes require the coordinator main branch');
  await writeFile('state/claims.json', `${JSON.stringify(result.claims, null, 2)}\n`);
}
console.log(`Validated ${result.board.tasks.length} tasks, ${Object.keys(result.claims).length} claim records, ${awards.length} awards.`);
