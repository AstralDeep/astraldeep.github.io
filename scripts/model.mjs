// Validates task identities, reconciles exclusive reservations, and computes points for the community board.
import protocol from '../actions/claim-reply/protocol.cjs';
const { accountId } = protocol;

export function taskKey(repository, number) {
  return `${repository}#${number}`;
}

export function parseTask(value, config) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(value.trim());
  if (!match || !config.repositories.includes(match[1]) || !Number.isSafeInteger(Number(match[2]))) return null;
  return { repository: match[1], number: Number(match[2]), key: taskKey(match[1], Number(match[2])) };
}

export function taskFromIssue(repository, issue, config) {
  const labels = issue.labels.map(label => typeof label === 'string' ? label : label.name);
  if (issue.pull_request || !labels.includes(config.bountyLabel)) return null;
  const values = labels.filter(label => /^points:/.test(label));
  const points = values.length === 1 ? Number(values[0].slice(7)) : 0;
  if (!config.points.includes(points)) throw new Error(`Invalid points labels on ${repository}#${issue.number}`);
  return {
    key: taskKey(repository, issue.number), repository, number: issue.number,
    title: issue.title, url: `https://github.com/${repository}/issues/${issue.number}`,
    points, state: issue.state, stateReason: issue.state_reason,
    assignees: issue.assignees.map(user => user.login),
    assigneeIds: issue.assignees.map(accountId),
    tracks: config.tracks.filter(track => labels.includes(`track:${track}`)),
    priority: labels.find(label => /^priority:P[123]$/.test(label))?.slice(9) || 'P3',
  };
}

export function claimTarget(body, config) {
  const fields = [...body.matchAll(/^### Task\r?\n+([^\r\n]+)\s*$/gm)];
  return fields.length === 1 ? parseTask(fields[0][1], config) : null;
}

function commandOrder(left, right) {
  return (Date.parse(left.source?.commandAt || left.createdAt) || 0) - (Date.parse(right.source?.commandAt || right.createdAt) || 0) || (left.source?.comment || 0) - (right.source?.comment || 0);
}

export function reconcileClaims(previous, requests, tasks, config, now) {
  const claims = structuredClone(previous);
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error('Invalid reconciliation time');
  const requestMap = new Map(requests.map(issue => [String(issue.source ? issue.id : issue.number), issue]));
  const taskMap = new Map(tasks.map(task => [task.key, task]));
  for (const [id, claim] of Object.entries(claims)) {
    accountId({ id: claim.userId, login: claim.login });
    const request = requestMap.get(id);
    if (request) {
      if (accountId(request.user) !== claim.userId) throw new Error('Claim request owner does not match stored account');
      claim.login = request.user.login;
      if (typeof request.user.node_id === 'string') claim.userNodeId = request.user.node_id;
    }
    if (claim.status !== 'active') continue;
    const task = taskMap.get(claim.key);
    if (!claim.source && (!request || request.state !== 'open' || request.everClosed)) claim.status = 'released';
    else if (Date.parse(claim.expiresAt) <= clock) claim.status = 'expired';
    else if (!task || task.state !== 'open') claim.status = 'finished';
    else if (task.manuallyReleasedClaims?.includes(id)) { claim.status = 'superseded'; claim.reason = 'A maintainer removed the source assignment.'; }
    else if (task.assigneeIds.some(userId => userId !== claim.userId)) claim.status = 'superseded';
    if (claim.status !== 'active') claim.endedAt = now;
  }
  const active = Object.values(claims).filter(claim => claim.status === 'active');
  for (const request of [...requests].sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || a.number - b.number || String(a.id).localeCompare(String(b.id)))) {
    const id = String(request.source ? request.id : request.number);
    if (request.pull_request || claims[id] || request.state !== 'open') continue;
    if (!request.labels.some(label => (label.name || label) === 'claim-request')) continue;
    const target = request.source ? request.target : claimTarget(request.body || '', config);
    const task = target && taskMap.get(target.key);
    const userId = accountId(request.user);
    const login = request.user.login;
    const current = active.find(claim => claim.status === 'active' && claim.key === target?.key && claim.userId === userId);
    let reason = '';
    if (request.everClosed) reason = 'Closed claim requests cannot be reused. Open a new request.';
    else if (request.user.type !== 'User') reason = 'Claims must be made by a human GitHub account.';
    else if (request.changedCommand) reason = 'This command was edited. Post a new /claim or /unclaim comment.';
    else if (!task || task.state !== 'open') reason = 'Choose an open, approved bounty from the board.';
    if (request.source?.command === 'unclaim') {
      const cancellationValid = !reason;
      if (!reason && current && commandOrder(current, { source: request.source }) <= 0) {
        current.status = 'released'; current.endedAt = now; current.releasedBy = id;
      } else if (!reason) reason = 'You have no active reservation on this issue. Manual assignments require a maintainer.';
      claims[id] = { source: request.source, userId, login, key: target?.key || null, status: reason ? 'rejected' : 'released', cancellationValid, reason, createdAt: now, endedAt: now };
      continue;
    }
    if (!reason && request.source && current) {
      claims[id] = { source: request.source, userId, login, key: target.key, status: 'duplicate', reservation: Object.keys(claims).find(key => claims[key] === current), reason: 'Your existing reservation remains unchanged.', createdAt: now };
      continue;
    }
    const prior = request.source && Object.entries(claims).find(([, item]) => {
      if (item.key !== target?.key || item.userId !== userId || !item.expiresAt || item.status === 'rejected' || item.status === 'duplicate') return false;
      const start = item.source?.commandAt || item.createdAt;
      const end = claims[item.releasedBy]?.source?.commandAt || item.endedAt || item.expiresAt;
      const submitted = Date.parse(request.source.commandAt);
      return submitted >= Date.parse(start) && submitted < Math.min(Date.parse(end), Date.parse(item.expiresAt));
    });
    if (!reason && prior) {
      claims[id] = { source: request.source, userId, login, key: target.key, status: 'duplicate', reservation: prior[0], reason: 'This command was posted during your earlier reservation; its expiry is unchanged.', createdAt: now };
      continue;
    }
    const release = request.source && Object.entries(claims).find(([, item]) => item.source?.command === 'unclaim' && item.cancellationValid === true && item.userId === userId && item.key === target?.key && commandOrder({ source: request.source }, item) < 0);
    if (!reason && release) {
      claims[id] = { source: request.source, userId, login, key: target.key, status: 'released', reason: 'A later /unclaim cancelled this command.', createdAt: now, endedAt: now, releasedBy: release[0] };
      continue;
    }
    if (!reason && request.source && tasks.some(item => (item.key === target.key || item.assigneeIds.includes(userId)) && item.managedAssignments?.some(assignment => claims[assignment.id] && claims[assignment.id].status !== 'active'))) continue;
    if (!reason && task.assigneeIds.some(assigneeId => assigneeId !== userId)) reason = 'The source issue is assigned to another contributor.';
    else if (!reason && active.some(claim => claim.status === 'active' && claim.key === target.key)) reason = 'This bounty already has an active claim.';
    else if (!reason && (active.some(claim => claim.status === 'active' && claim.userId === userId) || tasks.some(item => item.state === 'open' && item.key !== target.key && item.assigneeIds.includes(userId)))) reason = 'Finish or release your existing bounty first.';
    const claim = {
      ...(request.source ? { source: request.source } : { request: request.number }), userId, login, ...(typeof request.user.node_id === 'string' ? { userNodeId: request.user.node_id } : {}), key: target?.key || null, status: reason ? 'rejected' : 'active',
      reason, createdAt: now,
      expiresAt: new Date(clock + config.claimHours * 3600000).toISOString(),
    };
    claims[id] = claim;
    if (!reason) active.push(claim);
  }
  return claims;
}

export function validateAwards(awards, tasks, config) {
  config.awardApprovers.forEach(accountId);
  const seen = new Set();
  const prs = new Set();
  for (const award of awards) {
    const target = parseTask(award.issue, config);
    const task = target && tasks.find(item => item.key === target.key);
    if (!task || task.state !== 'closed' || task.stateReason !== 'completed') throw new Error('Awards require a completed approved bounty');
    if (seen.has(task.key)) throw new Error('Duplicate task award');
    if (prs.has(award.pr)) throw new Error('A PR can only earn one bounty award');
    if (!config.points.includes(award.points) || award.points !== task.points) throw new Error('Award points must match the approved issue');
    accountId({ id: award.userId, login: award.login });
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(award.login) || !Number.isSafeInteger(award.review) || award.review < 1) throw new Error('Invalid contributor or approval review');
    if (!new RegExp(`^https://github\\.com/${target.repository}/pull/[1-9]\\d*$`).test(award.pr)) throw new Error('Award PR must be in the task repository');
    if (!Number.isFinite(Date.parse(award.awardedAt))) throw new Error('Invalid award date');
    seen.add(task.key);
    prs.add(award.pr);
  }
}

export function verifyAwardEvidence(award, pr, review, approvers) {
  const authorId = accountId(pr.user);
  const reviewerId = accountId(review.user);
  if (!pr.merged_at || pr.html_url !== award.pr || authorId !== accountId({ id: award.userId, login: award.login })) throw new Error('Award needs a merged PR by its credited contributor');
  if (review.id !== award.review || review.state !== 'APPROVED' || reviewerId === authorId) throw new Error('An independent approval review is required');
  if (!approvers.map(accountId).includes(reviewerId)) throw new Error('Approving reviewer must be a configured award approver');
  if (Date.parse(review.submitted_at) > Date.parse(pr.merged_at) || Date.parse(award.awardedAt) < Date.parse(pr.merged_at)) throw new Error('Award and review dates do not match the merge');
  if (review.commit_id !== pr.head.sha) throw new Error('Approval must cover the merged PR head');
  const attestations = typeof review.body === 'string' ? review.body.split(/\r?\n/).filter(line => /^\s*Bounty-issue\s*:/i.test(line)) : [];
  if (attestations.length !== 1 || attestations[0] !== `Bounty-issue: ${award.issue}`) throw new Error('Approval must contain exactly one exact Bounty-issue attestation line');
  return { ...award, displayLogin: pr.user.login };
}

export function summarize(tasks, claims, awards, now) {
  const people = new Map();
  for (const award of awards) {
    const key = accountId({ id: award.userId, login: award.displayLogin });
    const person = people.get(key) || { userId: key, points: 0, completed: 0 };
    person.login = award.displayLogin;
    person.points += award.points;
    person.completed += 1;
    people.set(key, person);
  }
  const leaderboard = [...people.values()].sort((a, b) => b.points - a.points || b.completed - a.completed || a.login.localeCompare(b.login));
  leaderboard.forEach((person, index) => { person.rank = index > 0 && leaderboard[index - 1].points === person.points ? leaderboard[index - 1].rank : index + 1; });
  return {
    generatedAt: now, tasks: tasks.map(task => {
      const claim = Object.values(claims).find(item => item.key === task.key && item.status === 'active' && Date.parse(item.expiresAt) > Date.parse(now));
      const award = awards.find(item => item.issue === task.url);
      const { managedAssignments, manuallyReleasedClaims, ...publicTask } = task;
      return { ...publicTask, status: award ? 'completed' : task.state === 'closed' ? 'closed' : claim || task.assignees.length ? 'claimed' : 'available', claim: claim || null };
    }),
    claims: Object.values(claims), awards, leaderboard,
  };
}
