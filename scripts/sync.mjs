// Collects public task state and validates awards before reconciling central claim requests.
import { taskFromIssue, reconcileClaims, validateAwards, verifyAwardEvidence, summarize } from './model.mjs';

export async function synchronize(api, config, previous, awards, now) {
  const tasks = [];
  for (const repository of config.repositories) {
    const metadata = await api.request(`/repos/${repository}`);
    if (metadata.private || metadata.archived || !metadata.has_issues) throw new Error(`Repository is not an active public issue source: ${repository}`);
    const issues = await api.pages(`/repos/${repository}/issues?state=all&labels=${encodeURIComponent(config.bountyLabel)}`);
    tasks.push(...issues.map(issue => taskFromIssue(repository, issue, config)).filter(Boolean));
  }
  validateAwards(awards, tasks, config);
  const verifiedAwards = [];
  for (const award of awards) {
    const match = /^https:\/\/github.com\/(.+)\/pull\/(\d+)$/.exec(award.pr);
    const base = `/repos/${match[1]}`;
    const pr = await api.request(`${base}/pulls/${match[2]}`);
    const review = await api.request(`${base}/pulls/${match[2]}/reviews/${award.review}`);
    verifiedAwards.push(verifyAwardEvidence(award, pr, review, config.awardApprovers));
  }
  const requests = await api.pages(`/repos/${config.coordinator}/issues?state=all&labels=claim-request`);
  for (const request of requests) {
    if (request.pull_request || request.state !== 'open' || (previous[request.number] && previous[request.number].status !== 'active')) continue;
    const events = await api.pages(`/repos/${config.coordinator}/issues/${request.number}/events`);
    request.everClosed = events.some(event => event.event === 'closed');
  }
  const claims = reconcileClaims(previous, requests, tasks, config, now);
  return { claims, board: summarize(tasks, claims, verifiedAwards, now) };
}
