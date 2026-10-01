// Collects public task state and validates awards before reconciling central claim requests.
import { taskFromIssue, reconcileClaims, summarize } from './model.mjs';
import { sourceRequests } from './source-claims.mjs';
import { reconcileAwards } from './awards.mjs';

export async function synchronize(api, config, previous, awards, now, enabledAt = null) {
  const tasks = [];
  for (const repository of config.repositories) {
    const metadata = await api.request(`/repos/${repository}`);
    if (metadata.private || metadata.archived || !metadata.has_issues) throw new Error(`Repository is not an active public issue source: ${repository}`);
    const issues = await api.pages(`/repos/${repository}/issues?state=all&labels=${encodeURIComponent(config.bountyLabel)}`);
    tasks.push(...issues.map(issue => taskFromIssue(repository, issue, config)).filter(Boolean));
  }
  const requests = await api.pages(`/repos/${config.coordinator}/issues?state=all&labels=claim-request`);
  for (const request of requests) {
    if (request.pull_request || request.state !== 'open' || (previous[request.number] && previous[request.number].status !== 'active')) continue;
    const events = await api.pages(`/repos/${config.coordinator}/issues/${request.number}/events`);
    request.everClosed = events.some(event => event.event === 'closed');
    request.firstClosedAt = events.find(event => event.event === 'closed')?.created_at;
  }
  requests.push(...await sourceRequests(api, tasks, previous, enabledAt));
  const claims = reconcileClaims(previous, requests, tasks, config, now);
  const credited = await reconcileAwards(api, config, tasks, claims, awards, now);
  return { claims, awards: credited.awards, board: summarize(tasks, claims, credited.verified, now) };
}
