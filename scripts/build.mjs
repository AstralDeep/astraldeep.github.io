// Builds only the public site allowlist and safely embeds the generated board in static HTML.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { summarize } from './model.mjs';

const config = JSON.parse(await readFile('data/config.json', 'utf8'));
let board;
try { board = JSON.parse(await readFile('.cache/board.json', 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (process.env.GITHUB_ACTIONS === 'true' && !process.argv.includes('--preview')) throw new Error('A deployment requires a successful live sync');
  board = summarize([], {}, [], new Date().toISOString());
}
await mkdir('_site/data', { recursive: true });
await cp('site', '_site', { recursive: true });
const safeJSON = JSON.stringify({ ...board, repositories: config.repositories, coordinator: config.coordinator }).replaceAll('<', '\\u003c');
for (const filename of ['index.html', 'bounties.html', 'leaderboard.html', 'contribute.html']) {
  const html = await readFile(`site/${filename}`, 'utf8');
  await writeFile(`_site/${filename}`, html.replace('<!-- BOARD_DATA -->', `<script type="application/json" id="board-data">${safeJSON}</script>`));
}
await writeFile('_site/data/board.json', `${JSON.stringify(board, null, 2)}\n`);
await writeFile('_site/.nojekyll', '');
console.log('Built public pages and data; review drafts and internal ledgers are excluded.');
