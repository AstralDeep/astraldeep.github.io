// Validates public bounty and contributor identities and computes evidence-backed community points.
export function accountId(user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user.login !== 'string' || !/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(user.login)) throw new Error('Invalid GitHub account identity');
  return user.id;
}

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
    tracks: config.tracks.filter(track => labels.includes(`track:${track}`)),
    priority: labels.find(label => /^priority:P[123]$/.test(label))?.slice(9) || 'P3',
  };
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
    accountId({ id: award.userId, login: award.login });
    if (!['main-merge', 'maintainer-merge'].includes(award.policy) && (award.policy || !Number.isSafeInteger(award.review) || award.review < 1)) throw new Error('Invalid award policy');
    if (!new RegExp(`^https://github\\.com/${target.repository}/pull/[1-9]\\d*$`).test(award.pr)) throw new Error('Award PR must be in the task repository');
    if (!Number.isFinite(Date.parse(award.awardedAt))) throw new Error('Invalid award date');
    seen.add(task.key);
    prs.add(award.pr);
  }
}

export function verifyAwardEvidence(award, pr, review, approvers) {
  const authorId = accountId(pr.user);
  const reviewerId = accountId(review.user);
  const repository = award.pr.split('/').slice(3, 5).join('/');
  if (!pr.merged_at || pr.base?.ref !== 'main' || pr.base.repo?.full_name !== repository || pr.html_url !== award.pr || authorId !== accountId({ id: award.userId, login: award.login })) throw new Error('Award needs a PR merged into main by its credited contributor');
  if (review.id !== award.review || review.state !== 'APPROVED' || reviewerId === authorId) throw new Error('An independent approval review is required');
  if (!approvers.map(accountId).includes(reviewerId)) throw new Error('Approving reviewer must be a configured historical award approver');
  const dates = [review.submitted_at, pr.merged_at, award.awardedAt].map(Date.parse);
  if (!dates.every(Number.isFinite) || dates[0] > dates[1] || dates[2] < dates[1]) throw new Error('Award and review dates do not match the merge');
  if (review.commit_id !== pr.head.sha) throw new Error('Approval must cover the merged PR head');
  const attestations = typeof review.body === 'string' ? review.body.split(/\r?\n/).filter(line => /^\s*Bounty-issue\s*:/i.test(line)) : [];
  if (attestations.length !== 1 || attestations[0] !== `Bounty-issue: ${award.issue}`) throw new Error('Approval must contain exactly one exact Bounty-issue attestation line');
  return { ...award, displayLogin: pr.user.login };
}

export function summarize(tasks, awards, now) {
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
    generatedAt: now, tasks: tasks.map(task => ({ ...task, status: awards.some(award => award.issue === task.url) ? 'completed' : task.state === 'closed' ? 'closed' : 'available' })),
    awards, leaderboard,
  };
}
