// Requests missing PR context and applies explicit maintainer decisions using trusted provider metadata.
const REPOS = new Set(['AstralDeep', 'AstralPlane', 'AstralPrimitives', 'AstralProjection', 'LETS']);
const BOT_ID = 41898282;
const LABELS = {
  'needs-context': ['D4C5F9', 'Please explain the problem, issue scope, and verification evidence.'],
  'no-op': ['B60205', 'Reviewed change provides no new behavior or meaningful verification.'],
  'unsupported-completion': ['D93F0B', 'Claimed completed scope is absent from the reviewed implementation or evidence.'],
  duplicate: ['E99695', 'Reviewed change repeats existing behavior without a distinct improvement.'],
  superseded: ['C2E0C6', 'Completed merged work covers the reviewed change with no remaining useful delta.'],
};

async function pages(method, args) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const { data } = await method({ ...args, per_page: 100, page });
    if (!Array.isArray(data)) throw new Error('Invalid provider page');
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw new Error('Pagination limit exceeded');
}

function plain(body) {
  return String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, '').replace(/`[^`\n]*`/g, '');
}

function references(body, repo) {
  const text = plain(body);
  const found = new Map();
  for (const match of text.matchAll(/https:\/\/github\.com\/AstralDeep\/([\w.-]+)\/issues\/([1-9]\d*)\b|\bAstralDeep\/([\w.-]+)#([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/g)) {
    const target = match[1] ?? match[3] ?? repo;
    const number = Number(match[2] ?? match[4] ?? match[5]);
    if (REPOS.has(target) && Number.isSafeInteger(number)) found.set(`${target}#${number}`, { repo: target, number });
  }
  if (found.size > 20) throw new Error('Too many issue references');
  return [...found.values()];
}

function standalone(body) {
  const text = plain(body);
  const match = text.match(/^Standalone:[ \t]*([^\n]+)$/mi);
  return Boolean(match && match[1].trim().length >= 40);
}

function command(body) {
  const match = String(body ?? '').trim().match(/^\/astral-triage close ([a-f0-9]{40}) (no-op|unsupported-completion|duplicate|superseded)\r?\n([\s\S]{40,4000})$/);
  return match && match[3].trim().length >= 40 ? { head: match[1], reason: match[2], evidence: match[3].trim() } : null;
}

function eligible(pr, metadata) {
  return pr.state === 'open' && !pr.draft && !pr.merged && pr.base.ref === 'main' &&
    pr.base.repo.id === metadata.id && pr.head.repo && /^[a-f0-9]{40}$/.test(pr.head.sha);
}

function marker(number, kind) {
  return `<!-- astral-pr-triage:v1:${number}:${kind} -->`;
}

function receipt(comments, value) {
  return comments.find(item => item.user?.id === BOT_ID && item.user?.type === 'Bot' && item.body?.startsWith(value));
}

async function label(github, args, reason) {
  const name = 'triage:' + reason;
  try { await github.rest.issues.getLabel({ ...args, name }); }
  catch (error) {
    if (error.status !== 404) throw error;
    const [color, description] = LABELS[reason];
    await github.rest.issues.createLabel({ ...args, name, color, description });
  }
  return name;
}

async function reopen({ github, args, pr, recorded, body, reason }) {
  try {
    const { data } = await github.rest.pulls.update({ ...args, pull_number: pr.number, state: 'open' });
    if (data.state !== 'open' || data.merged) throw new Error('Provider did not confirm open state');
    await github.rest.issues.updateComment({ ...args, comment_id: recorded.id, body: body + `\n\nReopened for fresh review: ${reason}.` });
  } catch (error) {
    throw new Error(`Closure uncertain; reopening could not be confirmed: ${String(error.message).slice(0, 180)}`);
  }
}

async function contextForPr({ github, args, metadata, pr, dryRun }) {
  if (!eligible(pr, metadata)) return { number: pr.number, status: 'ineligible' };
  let valid = standalone(pr.body);
  if (!valid) {
    for (const ref of references(pr.body, args.repo)) {
      try {
        const { data } = await github.rest.issues.get({ owner: args.owner, repo: ref.repo, issue_number: ref.number });
        if (!data.pull_request && data.number === ref.number) { valid = true; break; }
      } catch (error) { if (error.status !== 404) throw error; }
    }
  }
  const comments = await pages(github.rest.issues.listComments, { ...args, issue_number: pr.number });
  const existing = receipt(comments, marker(pr.number, 'context'));
  const { data: current } = await github.rest.pulls.get({ ...args, pull_number: pr.number });
  if (!eligible(current, metadata) || current.head.sha !== pr.head.sha || current.body !== pr.body) return { number: pr.number, status: 'changed' };
  const hasLabel = current.labels.some(item => item.name === 'triage:needs-context');
  if (valid) {
    if (!dryRun && hasLabel) await github.rest.issues.removeLabel({ ...args, issue_number: pr.number, name: 'triage:needs-context' });
    const body = `${marker(pr.number, 'context')}\nIssue context is present for \`${pr.head.sha}\`. Maintainer review still determines whether the change and its claims are supported.`;
    if (!dryRun && existing && existing.body !== body) await github.rest.issues.updateComment({ ...args, comment_id: existing.id, body });
    return { number: pr.number, status: 'context-present' };
  }
  const body = `${marker(pr.number, 'context')}\nPlease add a real issue link and explain which acceptance checks this PR addresses. If this is a standalone improvement, add a paragraph starting with \`Standalone:\` describing the concrete problem and why the change belongs here. Include the checks you ran and their results.\n\nA reference to another PR is not an issue link. Missing context requests clarification; it does not automatically close this PR. See [.github/PR_TRIAGE.md](https://github.com/${args.owner}/${args.repo}/blob/main/.github/PR_TRIAGE.md).`;
  if (!dryRun) {
    if (!existing) await github.rest.issues.createComment({ ...args, issue_number: pr.number, body });
    else if (existing.body !== body) await github.rest.issues.updateComment({ ...args, comment_id: existing.id, body });
    if (!hasLabel) await github.rest.issues.addLabels({ ...args, issue_number: pr.number, labels: [await label(github, args, 'needs-context')] });
  }
  return { number: pr.number, status: dryRun ? 'would-request-context' : 'needs-context' };
}

async function closeFromComment({ github, context, args, metadata, dryRun }) {
  const payload = context.payload;
  if (payload.action !== 'created' || !payload.issue?.pull_request || !Number.isSafeInteger(payload.comment?.id)) return { status: 'ignored' };
  const { data: comment } = await github.rest.issues.getComment({ ...args, comment_id: payload.comment.id });
  const decision = command(comment.body);
  if (!decision) return { status: 'ignored' };
  if (comment.user?.type !== 'User' || comment.user.login !== context.actor || comment.updated_at !== comment.created_at || comment.issue_url !== `${context.apiUrl}/repos/${args.owner}/${args.repo}/issues/${payload.issue.number}`) throw new Error('Untrusted or edited decision comment');
  const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({ ...args, username: comment.user.login });
  if (!['write', 'maintain', 'admin'].includes(permission.permission) || permission.user?.id !== comment.user.id) throw new Error('Closure requires current maintainer write permission');
  const { data: pr } = await github.rest.pulls.get({ ...args, pull_number: payload.issue.number });
  if (!eligible(pr, metadata) || pr.head.sha !== decision.head) return { number: pr.number, status: 'changed' };
  const comments = await pages(github.rest.issues.listComments, { ...args, issue_number: pr.number });
  const value = marker(pr.number, `decision-${comment.id}`);
  if (receipt(comments, value)) return { number: pr.number, status: 'already-recorded' };
  const { data: latest } = await github.rest.pulls.get({ ...args, pull_number: pr.number });
  if (!eligible(latest, metadata) || latest.head.sha !== decision.head) return { number: pr.number, status: 'changed' };
  if (dryRun) return { number: pr.number, status: 'would-close', reason: decision.reason, head: decision.head };
  const body = `${value}\nMaintainer decision for \`${decision.head}\`: **${decision.reason}**. [Review evidence](https://github.com/${args.owner}/${args.repo}/pull/${pr.number}#issuecomment-${comment.id}).\n\nClosure is being applied to this reviewed commit. The underlying issue, contributor branch, and bounty are not changed. A substantive revision can be reviewed after reopening. If this operation fails or the head changes, submit a fresh decision comment after review; retries never reuse this receipt.`;
  const { data: recorded } = await github.rest.issues.createComment({ ...args, issue_number: pr.number, body });
  const { data: before } = await github.rest.pulls.get({ ...args, pull_number: pr.number });
  if (!eligible(before, metadata) || before.head.sha !== decision.head) {
    await github.rest.issues.updateComment({ ...args, comment_id: recorded.id, body: body + '\n\nNot closed: PR state or head changed before the operation.' });
    return { number: pr.number, status: 'changed' };
  }
  const { data: freshComment } = await github.rest.issues.getComment({ ...args, comment_id: comment.id });
  if (freshComment.body !== comment.body || freshComment.user?.id !== comment.user.id || freshComment.user?.login !== comment.user.login || freshComment.user?.type !== 'User' || freshComment.created_at !== comment.created_at || freshComment.updated_at !== comment.updated_at || freshComment.issue_url !== comment.issue_url) throw new Error('Decision comment changed; fresh review required');
  const { data: freshPermission } = await github.rest.repos.getCollaboratorPermissionLevel({ ...args, username: comment.user.login });
  if (!['write', 'maintain', 'admin'].includes(freshPermission.permission) || freshPermission.user?.id !== comment.user.id) throw new Error('Maintainer permission changed; closure denied');
  let closed, after;
  try {
    ({ data: closed } = await github.rest.pulls.update({ ...args, pull_number: pr.number, state: 'closed' }));
  } catch (error) {
    await reopen({ github, args, pr, recorded, body, reason: 'the close request could not be verified' });
    throw new Error(`Close request failed; reopened: ${String(error.message).slice(0, 180)}`);
  }
  if (closed.state !== 'closed' || closed.merged) throw new Error('Unable to verify exact-head unmerged closure');
  if (!eligible({ ...closed, state: 'open' }, metadata) || closed.head?.sha !== decision.head) {
    await reopen({ github, args, pr, recorded, body, reason: 'the head or PR scope changed during closure' });
    throw new Error('Head or PR scope changed during closure; reopened for fresh review');
  }
  try { ({ data: after } = await github.rest.pulls.get({ ...args, pull_number: pr.number })); }
  catch {
    await reopen({ github, args, pr, recorded, body, reason: 'the post-close readback failed' });
    throw new Error('Closure readback failed; reopened for fresh review');
  }
  if ((!eligible({ ...after, state: 'open' }, metadata) || after.head.sha !== decision.head) && after.state === 'closed' && !after.merged) {
    await reopen({ github, args, pr, recorded, body, reason: 'the head or PR scope changed during closure' });
    throw new Error('Head or PR scope changed during closure; reopened for fresh review');
  }
  if (after.state !== 'closed' || after.merged || after.head.sha !== decision.head) throw new Error('Unable to verify exact-head unmerged closure');
  await github.rest.issues.addLabels({ ...args, issue_number: pr.number, labels: [await label(github, args, decision.reason)] });
  await github.rest.issues.updateComment({ ...args, comment_id: recorded.id, body: body + '\n\nVerified closed at the reviewed commit.' });
  return { number: pr.number, status: 'closed', reason: decision.reason, head: decision.head };
}

async function triage({ github, context, dryRun = false }) {
  dryRun = dryRun === true || dryRun === 'true';
  const args = context.repo;
  if (context.serverUrl !== 'https://github.com' || context.apiUrl !== 'https://api.github.com' || context.ref !== 'refs/heads/main' || args.owner !== 'AstralDeep' || !REPOS.has(args.repo)) throw new Error('Untrusted controller context');
  if (!['issue_comment', 'schedule', 'workflow_dispatch'].includes(context.eventName)) throw new Error('Unsupported controller event');
  const { data: metadata } = await github.rest.repos.get(args);
  if (metadata.private || metadata.archived || metadata.default_branch !== 'main') throw new Error('Unsupported repository state');
  if (context.eventName === 'issue_comment') return closeFromComment({ github, context, args, metadata, dryRun });
  const prs = await pages(github.rest.pulls.list, { ...args, state: 'open', base: 'main' });
  const results = [], errors = [];
  for (const summary of prs) {
    try {
      const { data: pr } = await github.rest.pulls.get({ ...args, pull_number: summary.number });
      results.push(await contextForPr({ github, args, metadata, pr, dryRun }));
    } catch (error) { errors.push({ number: summary.number, message: String(error.message).slice(0, 300) }); }
  }
  return { status: errors.length ? 'incomplete' : 'complete', dryRun, results, errors };
}

module.exports = { triage, references, standalone, command };
