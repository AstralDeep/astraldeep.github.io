// Collects approved public bounties and reconciles verified main-merge awards for the board.
import { taskFromIssue, summarize } from './model.mjs';
import { reconcileAwards } from './awards.mjs';

export async function synchronize(api, config, historicalClaims, awards, now) {
  const tasks = [];
  for (const repository of config.repositories) {
    const metadata = await api.request(`/repos/${repository}`);
    if (metadata.private || metadata.archived || !metadata.has_issues) throw new Error(`Repository is not an active public issue source: ${repository}`);
    const issues = await api.pages(`/repos/${repository}/issues?state=all&labels=${encodeURIComponent(config.bountyLabel)}`);
    tasks.push(...issues.map(issue => taskFromIssue(repository, issue, config)).filter(Boolean));
  }
  const credited = await reconcileAwards(api, config, tasks, historicalClaims, awards, now);
  return { awards: credited.awards, board: summarize(tasks, credited.verified, now) };
}
