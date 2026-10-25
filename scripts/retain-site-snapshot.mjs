// Loads a ledger-matching published snapshot for static-page deployment without reconciling or writing awards.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { GitHub } from './github.mjs';
import { readState } from './state.mjs';
import { loadPublishedSnapshot } from './published-snapshot.mjs';

const config = JSON.parse(await readFile('data/config.json', 'utf8'));
if (process.env.GITHUB_ACTIONS === 'true' && (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main')) throw new Error('Static publication requires coordinator main');
const github = new GitHub(process.env.GITHUB_TOKEN);
const snapshot = await readState(github, config);
const retained = await loadPublishedSnapshot(github, config, snapshot);
await mkdir('.cache', { recursive: true });
await writeFile('.cache/board.json', `${JSON.stringify(retained.board, null, 2)}\n`);
await writeFile('.cache/published-snapshot.json', `${JSON.stringify(retained.provenance, null, 2)}\n`);
console.log(JSON.stringify(retained.provenance));
