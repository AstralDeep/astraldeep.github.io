// Credits claimed bounties closed by a maintainer-merged PR and retains verifiable evidence in the public ledger.
import protocol from '../actions/claim-reply/protocol.cjs';
import { validateAwards, verifyAwardEvidence } from './model.mjs';
const { accountId } = protocol;

function claimEvidence(task, pr, claims, events) {
  const submitted = Date.parse(pr.created_at);
  const assignments = new Map();
  let latestAuthorEvent;
  for (const event of [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)) {
    if (!['assigned', 'unassigned'].includes(event.event)) continue;
    if (!Number.isFinite(Date.parse(event.created_at))) throw new Error('Invalid assignment event time');
    if (Date.parse(event.created_at) > submitted) continue;
    const id = accountId(event.assignee);
    if (id === pr.user.id) latestAuthorEvent = event;
    if (event.event === 'unassigned') assignments.delete(id);
    else assignments.set(id, event);
  }
  if ([...assignments.keys()].some(id => id !== pr.user.id)) return null;
  for (const [id, claim] of Object.entries(claims)) {
    if (claim.key !== task.key || claim.userId !== pr.user.id || !['active', 'finished', 'expired', 'released', 'superseded'].includes(claim.status)) continue;
    if (latestAuthorEvent?.event === 'unassigned' && latestAuthorEvent.assigner?.type === 'User' && Date.parse(latestAuthorEvent.created_at) >= Date.parse(claim.createdAt)) continue;
    const cancelled = Object.values(claims).some(item => item.key === task.key && item.userId === pr.user.id && item.source?.command === 'unclaim' && item.cancellationValid === true && Date.parse(item.source.commandAt) >= Date.parse(claim.createdAt) && Date.parse(item.source.commandAt) <= submitted);
    if (cancelled) continue;
    const ended = claims[claim.releasedBy]?.source?.commandAt || claim.endedAt || claim.expiresAt;
    if (Date.parse(claim.createdAt) <= submitted && submitted < Math.min(Date.parse(claim.expiresAt), Date.parse(ended))) return { type: 'reservation', id, createdAt: claim.createdAt, expiresAt: claim.expiresAt };
  }
  const event = assignments.get(pr.user.id);
  if (assignments.size === 1 && event?.assigner?.type === 'User' && Number.isSafeInteger(event.id) && event.id > 0) return { type: 'assignment', eventId: event.id, assignerId: accountId(event.assigner), userId: pr.user.id, createdAt: event.created_at };
  return null;
}

export function mergedAward(task, pr, closure, claims, events, config, now) {
  if (closure?.closer?.__typename !== 'PullRequest' || closure.closer.url !== pr.html_url || !new RegExp(`^https://github\\.com/${task.repository}/pull/[1-9]\\d*$`).test(pr.html_url)) return null;
  if (task.state !== 'closed' || task.stateReason !== 'completed' || !pr.merged_at || pr.user?.type !== 'User') return null;
  const userId = accountId(pr.user);
  const mergedBy = accountId(pr.merged_by);
  if (!config.awardApprovers.map(accountId).includes(mergedBy)) return null;
  const [submitted, merged, closed, awarded] = [pr.created_at, pr.merged_at, closure.createdAt, now].map(Date.parse);
  if (![submitted, merged, closed, awarded].every(Number.isFinite) || submitted > merged || merged > closed || closed > awarded) throw new Error('Invalid automatic award dates');
  if (![pr.head?.sha, pr.merge_commit_sha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Missing merged commit identities');
  if (typeof closure.id !== 'string' || !closure.id) throw new Error('Missing closure identity');
  const claim = claimEvidence(task, pr, claims, events);
  if (!claim) return null;
  return { policy: 'maintainer-merge', issue: task.url, pr: pr.html_url, userId, login: pr.user.login, points: task.points, claim, submittedAt: pr.created_at, mergedBy, headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, closureId: closure.id, closedAt: closure.createdAt, awardedAt: now };
}

export async function reconcileAwards(api, config, tasks, claims, awards, now) {
  validateAwards(awards, tasks, config);
  const ledger = structuredClone(awards);
  const verified = [];
  for (const task of tasks.filter(task => task.state === 'closed' && task.stateReason === 'completed')) {
    const saved = awards.find(award => award.issue === task.url);
    if (saved && !saved.policy) {
      const number = saved.pr.split('/').at(-1);
      const base = `/repos/${task.repository}/pulls/${number}`;
      verified.push(verifyAwardEvidence(saved, await api.request(base), await api.request(`${base}/reviews/${saved.review}`), config.awardApprovers));
      continue;
    }
    const closure = await api.closedBy(task.repository, task.number);
    const prefix = `https://github.com/${task.repository}/pull/`;
    let candidate = null;
    if (closure?.closer?.__typename === 'PullRequest' && closure.closer.url.startsWith(prefix) && /^[1-9]\d*$/.test(closure.closer.url.slice(prefix.length))) {
      const pr = await api.request(`/repos/${task.repository}/pulls/${closure.closer.url.slice(prefix.length)}`);
      const events = await api.pages(`/repos/${task.repository}/issues/${task.number}/events`);
      candidate = mergedAward(task, pr, closure, claims, events, config, saved?.awardedAt || now);
    }
    if (saved) {
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
