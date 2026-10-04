// Credits PR authors after verified main merges close approved bounties and rechecks preserved historical awards.
import { accountId, validateAwards, verifyAwardEvidence } from './model.mjs';

export function mergedAward(task, pr, closure, now) {
  if (closure?.closer?.__typename !== 'PullRequest' || closure.closer.url !== pr.html_url || !new RegExp(`^https://github\\.com/${task.repository}/pull/[1-9]\\d*$`).test(pr.html_url)) return null;
  if (task.state !== 'closed' || task.stateReason !== 'completed' || !pr.merged_at || pr.base?.ref !== 'main' || pr.base.repo?.full_name !== task.repository) return null;
  const userId = accountId(pr.user);
  const mergedBy = accountId(pr.merged_by);
  const [submitted, merged, closed, awarded] = [pr.created_at, pr.merged_at, closure.createdAt, now].map(Date.parse);
  if (![submitted, merged, closed, awarded].every(Number.isFinite) || submitted > merged || merged > closed || closed > awarded) throw new Error('Invalid automatic award dates');
  if (![pr.head?.sha, pr.merge_commit_sha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Missing merged commit identities');
  if (typeof closure.id !== 'string' || !closure.id) throw new Error('Missing closure identity');
  return { policy: 'main-merge', issue: task.url, pr: pr.html_url, userId, login: pr.user.login, points: task.points, baseRef: 'main', submittedAt: pr.created_at, mergedBy, headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, closureId: closure.id, closedAt: closure.createdAt, awardedAt: now };
}

async function verifyHistoricalClaim(api, task, saved, claims, config) {
  if (!config.historicalAwardApprovers.map(accountId).includes(saved.mergedBy)) throw new Error('Historical award merger is not a configured approver');
  const claim = saved.claim;
  if (claim?.type === 'reservation') {
    const record = claims[claim.id];
    const dates = [claim.createdAt, claim.expiresAt, saved.submittedAt].map(Date.parse);
    if (!record || record.key !== task.key || record.userId !== saved.userId || record.createdAt !== claim.createdAt || record.expiresAt !== claim.expiresAt || !dates.every(Number.isFinite) || dates[0] > dates[2] || dates[2] >= dates[1]) throw new Error('Historical reservation evidence changed');
  } else if (claim?.type === 'assignment') {
    const events = await api.pages(`/repos/${task.repository}/issues/${task.number}/events`);
    const event = events.find(item => item.id === claim.eventId);
    if (!event || event.event !== 'assigned' || event.assigner?.type !== 'User' || accountId(event.assigner) !== claim.assignerId || accountId(event.assignee) !== saved.userId || claim.userId !== saved.userId || event.created_at !== claim.createdAt || !Number.isFinite(Date.parse(claim.createdAt)) || Date.parse(claim.createdAt) > Date.parse(saved.submittedAt)) throw new Error('Historical assignment evidence changed');
  } else throw new Error('Invalid historical claim evidence');
}

export async function reconcileAwards(api, config, tasks, historicalClaims, awards, now) {
  validateAwards(awards, tasks, config);
  const ledger = structuredClone(awards);
  const verified = [];
  for (const task of tasks.filter(task => task.state === 'closed' && task.stateReason === 'completed')) {
    const saved = awards.find(award => award.issue === task.url);
    if (saved && !saved.policy) {
      const base = `/repos/${task.repository}/pulls/${saved.pr.split('/').at(-1)}`;
      verified.push(verifyAwardEvidence(saved, await api.request(base), await api.request(`${base}/reviews/${saved.review}`), config.historicalAwardApprovers));
      continue;
    }
    const closure = await api.closedBy(task.repository, task.number);
    const prefix = `https://github.com/${task.repository}/pull/`;
    let candidate = null;
    if (closure?.closer?.__typename === 'PullRequest' && closure.closer.url.startsWith(prefix) && /^[1-9]\d*$/.test(closure.closer.url.slice(prefix.length))) {
      const pr = await api.request(`/repos/${task.repository}/pulls/${closure.closer.url.slice(prefix.length)}`);
      candidate = mergedAward(task, pr, closure, saved?.awardedAt || now);
    }
    if (saved) {
      if (saved.policy === 'maintainer-merge') {
        await verifyHistoricalClaim(api, task, saved, historicalClaims, config);
        if (candidate) { delete candidate.baseRef; candidate.policy = saved.policy; candidate.claim = saved.claim; }
      }
      if (!candidate || Object.keys(candidate).some(key => key !== 'login' && JSON.stringify(candidate[key]) !== JSON.stringify(saved[key]))) throw new Error(`Stored award evidence changed: ${task.key}`);
      verified.push({ ...saved, displayLogin: candidate.login });
    } else if (candidate) {
      if (ledger.some(award => award.pr === candidate.pr)) throw new Error('A PR closes multiple eligible bounties; resolve award scope before publishing');
      ledger.push(candidate);
      verified.push({ ...candidate, displayLogin: candidate.login });
    }
  }
  validateAwards(ledger, tasks, config);
  return { awards: ledger, verified };
}
