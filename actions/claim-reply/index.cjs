// Routes source-issue claim comments to the central form without creating reservations or assignments.
const config = require('../../data/config.json');

function positiveId(value) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number)) throw new Error('Invalid GitHub identifier');
  return number;
}

function responseBody(repository, issue, comment) {
  const marker = `<!-- astral-claim-help:${comment.id} -->`;
  const contributor = `@${comment.user.login}`;
  let message;
  if (issue.assignees.some(user => user.id === comment.user.id)) {
    message = `${contributor} this task is already assigned to you, so you can get started. No separate claim form is needed for this assignment. Please link this issue in your PR and include tests and evidence for its acceptance criteria.`;
  } else if (issue.assignees.length) {
    message = `${contributor} this task is already assigned to another contributor. Please choose an available task from the [bounty board](${config.site}/bounties.html).`;
  } else {
    const target = `https://github.com/${repository}/issues/${issue.number}`;
    const form = `https://github.com/${config.coordinator}/issues/new?template=claim.yml&title=${encodeURIComponent(`[Claim] ${repository}#${issue.number}`)}&task=${encodeURIComponent(target)}`;
    message = `${contributor} thanks for your interest! To request this task, submit the [prefilled claim form](${form}) from your account and wait for the bot's **reserved** reply. This comment alone does not reserve it. Reservations last seven days, with one active task per contributor. If you already have a confirmed reservation for this task, keep using that request.`;
  }
  return `${marker}\n${message}\n\nPoints are recognition only, with no cash value. They are credited after completed work is reviewed, merged, and recorded in the award ledger.`;
}

async function replyToClaim({ github, context, commentId = '', dryRun = 'false' }) {
  if (!['true', 'false'].includes(dryRun)) throw new Error('Invalid dry-run option');
  if (!['issue_comment', 'workflow_dispatch'].includes(context.eventName)) return { status: 'ignored', reason: 'unsupported event' };
  if (context.eventName === 'issue_comment' && !['created', 'edited'].includes(context.payload.action)) return { status: 'ignored', reason: 'unsupported comment event' };
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!config.repositories.includes(repository) || context.serverUrl !== 'https://github.com' || context.apiUrl !== 'https://api.github.com' || context.ref !== 'refs/heads/main') throw new Error('Claim replies require an approved public repository on main');
  const id = positiveId(context.eventName === 'issue_comment' ? context.payload.comment?.id : commentId);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const { data: metadata } = await github.rest.repos.get(repo);
  if (metadata.private !== false || metadata.archived !== false || metadata.has_issues !== true) throw new Error('Claim replies require an active public issue repository');
  const { data: comment } = await github.rest.issues.getComment({ ...repo, comment_id: id });
  if (comment.id !== id) throw new Error('Comment identity mismatch');
  if (comment.user?.type !== 'User') return { status: 'ignored', reason: 'not a human comment' };
  positiveId(comment.user.id);
  if (typeof comment.user.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(comment.user.login)) throw new Error('Invalid GitHub login');
  if (typeof comment.body !== 'string' || comment.body.trim().split(/\r?\n/, 1)[0].trim().toLowerCase() !== '/claim') return { status: 'ignored', reason: 'not a claim command' };
  const prefix = `https://api.github.com/repos/${repository}/issues/`;
  if (typeof comment.issue_url !== 'string' || !comment.issue_url.startsWith(prefix)) throw new Error('Comment issue is outside the current repository');
  const issueNumber = positiveId(comment.issue_url.slice(prefix.length));
  if (context.eventName === 'issue_comment' && context.payload.issue?.number !== issueNumber) throw new Error('Event issue mismatch');
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.number !== issueNumber) throw new Error('Issue identity mismatch');
  if (issue.pull_request || issue.state !== 'open' || !issue.labels.some(label => (typeof label === 'string' ? label : label.name) === config.bountyLabel)) return { status: 'ignored', reason: 'not an open bounty issue' };
  const marker = `<!-- astral-claim-help:${id} -->`;
  for (let page = 1; page <= 20; page += 1) {
    const { data: comments } = await github.rest.issues.listComments({ ...repo, issue_number: issueNumber, per_page: 100, page });
    if (!Array.isArray(comments)) throw new Error('Invalid comment page');
    if (comments.some(item => item.user?.id === 41898282 && item.user?.type === 'Bot' && item.user?.login === 'github-actions[bot]' && typeof item.body === 'string' && item.body.includes(marker))) return { status: 'already-replied', commentId: id };
    if (comments.length < 100) break;
    if (page === 20) throw new Error('Comment pagination limit reached');
  }
  const body = responseBody(repository, issue, comment);
  if (dryRun === 'true') return { status: 'dry-run', commentId: id, body };
  const { data: reply } = await github.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
  if (reply.body !== body || !Number.isSafeInteger(reply.id) || reply.id < 1) throw new Error('Reply could not be verified');
  return { status: 'replied', commentId: id, replyId: reply.id, url: reply.html_url };
}

module.exports = { replyToClaim };
