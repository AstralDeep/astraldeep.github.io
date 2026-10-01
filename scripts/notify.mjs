// Publishes idempotent claim-status receipts only after the reservation ledger is durably pushed.
import { readFile } from 'node:fs/promises';
import { GitHub } from './github.mjs';

const config = JSON.parse(await readFile('data/config.json', 'utf8'));
if (process.env.GITHUB_REPOSITORY !== config.coordinator || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Notifications require coordinator main');
const api = new GitHub(process.env.GITHUB_TOKEN);
const claims = JSON.parse(await readFile('state/claims.json', 'utf8'));
for (const claim of Object.values(claims)) {
  if (claim.source) continue;
  const marker = `<!-- astral-claim:${claim.request}:${claim.status} -->`;
  const path = `/repos/${config.coordinator}/issues/${claim.request}/comments`;
  const comments = await api.pages(path);
  if (comments.some(comment => comment.user.login === 'github-actions[bot]' && comment.body.includes(marker))) continue;
  const detail = claim.status === 'active'
    ? `Reserved **${claim.key}** for @${claim.login} until **${claim.expiresAt}**. Close this request to release it. The source repository's review and security rules still apply.`
    : `Claim status: **${claim.status}**. ${claim.reason || 'This reservation is no longer active. Post /claim on an available source bounty to start another task.'}`;
  await api.request(path, 'POST', { body: `${marker}\n${detail}\n\n[Board and claim status](${config.site}/bounties.html#claims). Points are awarded automatically when a configured maintainer merges your linked PR and it closes the claimed bounty.` });
}
