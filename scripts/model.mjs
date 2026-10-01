// Validates task identities, reconciles exclusive reservations, and computes points for the community board.
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
    tracks: config.tracks.filter(track => labels.includes(`track:${track}`)),
    priority: labels.find(label => /^priority:P[123]$/.test(label))?.slice(9) || 'P3',
  };
}

export function claimTarget(body, config) {
  const fields = [...body.matchAll(/^### Task\r?\n+([^\r\n]+)\s*$/gm)];
  return fields.length === 1 ? parseTask(fields[0][1], config) : null;
}

export function reconcileClaims(previous, requests, tasks, config, now) {
  const claims = structuredClone(previous);
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error('Invalid reconciliation time');
  const requestMap = new Map(requests.map(issue => [String(issue.number), issue]));
  const taskMap = new Map(tasks.map(task => [task.key, task]));
  for (const [id, claim] of Object.entries(claims)) {
    if (claim.status !== 'active') continue;
    const request = requestMap.get(id);
    const task = taskMap.get(claim.key);
    if (!request || request.state !== 'open' || request.everClosed) claim.status = 'released';
    else if (Date.parse(claim.expiresAt) <= clock) claim.status = 'expired';
    else if (!task || task.state !== 'open') claim.status = 'finished';
    else if (task.assignees.some(login => login.toLowerCase() !== claim.login.toLowerCase())) claim.status = 'superseded';
    if (claim.status !== 'active') claim.endedAt = now;
  }
  const active = Object.values(claims).filter(claim => claim.status === 'active');
  for (const request of [...requests].sort((a, b) => a.number - b.number)) {
    if (request.pull_request || claims[request.number] || request.state !== 'open') continue;
    if (!request.labels.some(label => (label.name || label) === 'claim-request')) continue;
    const target = claimTarget(request.body || '', config);
    const task = target && taskMap.get(target.key);
    const login = request.user.login;
    let reason = '';
    if (request.everClosed) reason = 'Closed claim requests cannot be reused. Open a new request.';
    else if (request.user.type !== 'User') reason = 'Claims must be made by a human GitHub account.';
    else if (!task || task.state !== 'open') reason = 'Choose an open, approved bounty from the board.';
    else if (task.assignees.some(user => user.toLowerCase() !== login.toLowerCase())) reason = 'The source issue is assigned to another contributor.';
    else if (active.some(claim => claim.key === target.key)) reason = 'This bounty already has an active claim.';
    else if (active.some(claim => claim.login.toLowerCase() === login.toLowerCase()) || tasks.some(item => item.state === 'open' && item.key !== target.key && item.assignees.some(user => user.toLowerCase() === login.toLowerCase()))) reason = 'Finish or release your existing bounty first.';
    const claim = {
      request: request.number, login, key: target?.key || null, status: reason ? 'rejected' : 'active',
      reason, createdAt: now,
      expiresAt: new Date(clock + config.claimHours * 3600000).toISOString(),
    };
    claims[request.number] = claim;
    if (!reason) active.push(claim);
  }
  return claims;
}

export function validateAwards(awards, tasks, config) {
  const seen = new Set();
  const prs = new Set();
  for (const award of awards) {
    const target = parseTask(award.issue, config);
    const task = target && tasks.find(item => item.key === target.key);
    if (!task || task.state !== 'closed' || task.stateReason !== 'completed') throw new Error('Awards require a completed approved bounty');
    if (seen.has(task.key)) throw new Error('Duplicate task award');
    if (prs.has(award.pr)) throw new Error('A PR can only earn one bounty award');
    if (!config.points.includes(award.points) || award.points !== task.points) throw new Error('Award points must match the approved issue');
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(award.login) || !Number.isSafeInteger(award.review) || award.review < 1) throw new Error('Invalid contributor or approval review');
    if (!new RegExp(`^https://github\\.com/${target.repository}/pull/[1-9]\\d*$`).test(award.pr)) throw new Error('Award PR must be in the task repository');
    if (!Number.isFinite(Date.parse(award.awardedAt))) throw new Error('Invalid award date');
    seen.add(task.key);
    prs.add(award.pr);
  }
}

export function verifyAwardEvidence(award, pr, review, approvers) {
  if (!pr.merged_at || pr.html_url !== award.pr || pr.user.login.toLowerCase() !== award.login.toLowerCase()) throw new Error('Award needs a merged PR by its credited contributor');
  if (review.id !== award.review || review.state !== 'APPROVED' || review.user.login.toLowerCase() === award.login.toLowerCase()) throw new Error('An independent approval review is required');
  if (!approvers.map(login => login.toLowerCase()).includes(review.user.login.toLowerCase())) throw new Error('Approving reviewer must be a configured award approver');
  if (Date.parse(review.submitted_at) > Date.parse(pr.merged_at) || Date.parse(award.awardedAt) < Date.parse(pr.merged_at)) throw new Error('Award and review dates do not match the merge');
  if (review.commit_id !== pr.head.sha) throw new Error('Approval must cover the merged PR head');
}

export function summarize(tasks, claims, awards, now) {
  const people = new Map();
  for (const award of awards) {
    const key = award.login.toLowerCase();
    const person = people.get(key) || { login: award.login, points: 0, completed: 0 };
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
      return { ...task, status: award ? 'completed' : task.state === 'closed' ? 'closed' : claim || task.assignees.length ? 'claimed' : 'available', claim: claim || null };
    }),
    claims: Object.values(claims), awards, leaderboard,
  };
}
