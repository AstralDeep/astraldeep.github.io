// Refreshes the generated board and persists reservation decisions for the trusted main-branch workflow.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { synchronize } from './sync.mjs';
import { readState } from './state.mjs';
import protocol from '../actions/claim-reply/protocol.cjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const config = await json('data/config.json');
const persist = process.argv.includes('--persist-claims');
if (persist && (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main')) throw new Error('Reservation writes require the coordinator main branch');
const api = new GitHub(process.env.GITHUB_TOKEN);
const snapshot = persist ? null : await readState(api, config);
const ledger = async path => snapshot ? JSON.parse(snapshot.files[path]) : json(path);
const claims = await ledger('state/claims.json');
const awards = await ledger('data/awards.json');
const activation = protocol.protocol(await ledger('state/claim-protocol.json'));
const now = new Date().toISOString();
if (persist && activation.enabledAt === null) activation.enabledAt = now;
const result = await synchronize(api, config, claims, awards, now, activation.enabledAt);
await mkdir('.cache', { recursive: true });
await writeFile('.cache/board.json', `${JSON.stringify(result.board, null, 2)}\n`);
if (persist) {
  await writeFile('state/claims.json', `${JSON.stringify(result.claims, null, 2)}\n`);
  await writeFile('state/claim-protocol.json', `${JSON.stringify(activation, null, 2)}\n`);
  await writeFile('data/awards.json', `${JSON.stringify(result.awards, null, 2)}\n`);
}
console.log(`Validated ${result.board.tasks.length} tasks, ${Object.keys(result.claims).length} claim records, ${result.awards.length} awards.`);
