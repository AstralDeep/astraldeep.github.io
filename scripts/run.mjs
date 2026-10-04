// Refreshes verified bounty points while preserving archived reservation bytes in the trusted state snapshot.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { synchronize } from './sync.mjs';
import { readState } from './state.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const config = await json('data/config.json');
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--persist-awards')) throw new Error('Expected optional --persist-awards');
const persist = args.includes('--persist-awards');
if (persist && (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main')) throw new Error('Award writes require the coordinator main branch');
const api = new GitHub(process.env.GITHUB_TOKEN);
const snapshot = persist ? null : await readState(api, config);
const ledger = async path => snapshot ? JSON.parse(snapshot.files[path]) : json(path);
const claims = await ledger('state/claims.json');
const awards = await ledger('data/awards.json');
const result = await synchronize(api, config, claims, awards, new Date().toISOString());
await mkdir('.cache', { recursive: true });
await writeFile('.cache/board.json', `${JSON.stringify(result.board, null, 2)}\n`);
if (persist) await writeFile('data/awards.json', `${JSON.stringify(result.awards, null, 2)}\n`);
console.log(`Validated ${result.board.tasks.length} tasks and ${result.awards.length} awards.`);
