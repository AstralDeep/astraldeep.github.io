// Projects durable central reservations into source-issue receipts and bot-owned assignments.
const config = require('../../data/config.json');
const p = require('./protocol.cjs');
const { annotation } = p;

async function pages(method, args) {
  const result = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await method({ ...args, per_page: 100, page });
    if (!Array.isArray(data)) throw new Error('Invalid GitHub list page');
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw new Error('Pagination limit reached');
}

async function readState(github) {
  const [owner, repo] = config.coordinator.split('/');
  const { data: head } = await github.rest.repos.getCommit({ owner, repo, ref: 'main' });
  if (!/^[a-f0-9]{40}$/.test(head.sha)) throw new Error('Invalid coordinator head');
  async function read(path) {
    const { data } = await github.rest.repos.getContent({ owner, repo, path, ref: head.sha });
    if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > 2000000) throw new Error('Invalid coordinator state file');
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  }
  const activation = p.protocol(await read('state/claim-protocol.json'));
  const claims = await read('state/claims.json');
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Invalid reservation ledger');
  for (const [id, claim] of Object.entries(claims)) {
    p.accountId({ id: claim.userId, login: claim.login });
    if (!['active', 'duplicate', 'rejected', 'released', 'expired', 'finished', 'superseded'].includes(claim.status)) throw new Error('Invalid reservation status');
    if (claim.key !== null && (typeof claim.key !== 'string' || !config.repositories.some(repository => new RegExp(`^${repository.replaceAll('.', '\\.')}#[1-9]\\d*$`).test(claim.key)))) throw new Error('Invalid reservation task');
    if (claim.source) {
      if (!config.repositories.includes(claim.source.repository) || id !== p.sourceId(claim.source.repository, claim.source.comment) || claim.key !== `${claim.source.repository}#${p.positiveId(claim.source.issue)}` || !['claim', 'unclaim'].includes(claim.source.command)) throw new Error('Invalid source reservation identity');
    } else if (String(p.positiveId(claim.request)) !== id) throw new Error('Invalid legacy reservation identity');
    if (claim.status === 'active' && (!Number.isFinite(Date.parse(claim.expiresAt)) || typeof claim.userNodeId !== 'string' || !claim.userNodeId)) throw new Error('Invalid active reservation');
  }
  return { claims, activation };
}

function annotations(body) {
  return ['reservation', 'assignment-intent', 'assignment'].flatMap(name => {
    const value = annotation(body, name);
    return value ? [`<!-- astral-${name}:${encodeURIComponent(value.id)}${value.event === null ? '' : `:${value.event}`} -->`] : [];
  });
}

function live(claim, now) {
  return claim?.status === 'active' && Date.parse(claim.expiresAt) > Date.parse(now);
}

function decision(claims, repository, number, original, reply) {
  const key = `${repository}#${number}`;
  let id = p.sourceId(repository, original.id);
  let claim = claims[id];
  if (claim?.status === 'duplicate') { id = claim.reservation; claim = claims[id]; }
  if (!claim) {
    const saved = annotation(reply?.body, 'reservation');
    if (saved) { id = saved.id; claim = claims[id]; }
  }
  if (!claim && p.command(original.body) === 'claim') {
    const existing = Object.entries(claims).find(([, item]) => !item.source && item.status === 'active' && item.key === key && item.userId === original.user.id);
    if (existing) [id, claim] = existing;
  }
  if (claim && (claim.userId !== original.user.id || claim.key !== key)) throw new Error('Reservation does not match source command');
  return { id, claim };
}

function latestAssignment(events, userId) {
  return events.filter(event => ['assigned', 'unassigned'].includes(event.event) && event.assignee?.id === userId).sort((a, b) => b.id - a.id)[0];
}

async function processCommand(github, repo, number, original, reply, dryRun, clock, state, comments) {
  const repository = `${repo.owner}/${repo.repo}`;
  const args = { ...repo, issue_number: number };
  const frozen = reply && p.receipt(reply);
  const registered = state.claims[p.sourceId(repository, original.id)];
  const command = registered?.source.command || frozen?.command || p.command(original.body);
  if (!command || original.user?.type !== 'User') return { status: 'ignored' };
  p.accountId(original.user); p.positiveId(original.id);
  if (frozen && (frozen.commentId !== original.id || frozen.userId !== original.user.id)) throw new Error('Command receipt owner mismatch');
  let metadata = annotations(reply?.body);
  const commandAt = registered?.source.commandAt || p.commandTime(reply?.body) || original.updated_at;
  if (!Number.isFinite(Date.parse(commandAt))) throw new Error('Invalid source command time');
  metadata.unshift(`<!-- astral-command-time:${commandAt} -->`);
  const save = async message => {
    const body = [p.marker(original.id, original.user.id, command), `<!-- astral-claim-help:${original.id} -->`, ...metadata, message,
      '', 'One active task per contributor. Reservations last seven days. Post a new `/unclaim` comment here to release yours. Use `Closes #N` in your PR description. A configured maintainer’s merge awards points automatically, including their own work. Points have no cash value.'].join('\n');
    if (dryRun || reply?.body === body) return;
    const result = reply
      ? await github.rest.issues.updateComment({ ...repo, comment_id: reply.id, body })
      : await github.rest.issues.createComment({ ...args, body });
    if (result.data.body !== body || !Number.isSafeInteger(result.data.id) || result.data.id < 1) throw new Error('Claim receipt could not be verified');
    reply = result.data;
    const position = comments.findIndex(item => item.id === reply.id);
    if (position === -1) comments.push(reply); else comments[position] = reply;
  };
  if (state.activation.enabledAt === null) return { status: 'not-active' };
  const { id, claim } = decision(state.claims, repository, number, original, reply);
  if (!frozen && !claim && !p.eligible(original, state.activation.enabledAt)) return { status: 'before-rollout' };
  let { data: issue } = await github.rest.issues.get(args);
  if (issue.number !== number || issue.pull_request) throw new Error('Invalid claim issue');
  const eligibleIssue = issue.state === 'open' && issue.labels.some(label => (label.name || label) === config.bountyLabel);
  if (!reply && !eligibleIssue) return { status: 'ignored' };
  if (!claim) {
    await save(p.command(original.body) !== command
      ? `@${original.user.login} this command was edited. Post a new \`/claim\` or \`/unclaim\` comment to continue.`
      : `@${original.user.login} your \`/${command}\` is queued. No form or further action is needed. The bot will confirm the result here after checking all five repositories. GitHub processing can take several minutes; wait for **Reserved** before starting.`);
    return { status: dryRun ? 'dry-run' : 'pending' };
  }
  metadata = metadata.filter(line => !line.startsWith('<!-- astral-reservation:'));
  metadata.unshift(`<!-- astral-reservation:${encodeURIComponent(id)} -->`);
  let events = await pages(github.rest.issues.listEvents, args);
  let latest = latestAssignment(events, claim.userId);
  const evidence = name => comments.filter(item => p.receipt(item)?.userId === claim.userId).map(item => annotation(item.body, name)).filter(item => item?.id === id).sort((a, b) => b.event - a.event)[0];
  let owned = evidence('assignment');
  const intent = evidence('assignment-intent');
  if (!owned && intent?.id === id && latest?.event === 'assigned' && p.trustedBot(latest.actor) && latest.id > intent.event) {
    owned = { id, event: p.positiveId(latest.id) };
    metadata.push(`<!-- astral-assignment:${encodeURIComponent(id)}:${owned.event} -->`);
  }
  const assigned = issue.assignees.find(user => user.id === claim.userId);
  const ownership = owned || intent;
  const manuallyRemoved = ownership?.id === id && latest?.event === 'unassigned' && latest.id > ownership.event && !p.trustedBot(latest.actor);
  const active = live(claim, clock()) && eligibleIssue && !manuallyRemoved && !issue.assignees.some(user => user.id !== claim.userId);
  if (!active) {
    if (assigned && owned?.id === id && latest?.id === owned.event && latest.event === 'assigned' && p.trustedBot(latest.actor)) {
      if (!dryRun) {
        const fresh = await readState(github);
        if (live(fresh.claims[id], clock()) && eligibleIssue) return { status: 'changed-during-recovery' };
        events = await pages(github.rest.issues.listEvents, args);
        latest = latestAssignment(events, claim.userId);
        if (latest?.id === owned.event && latest.event === 'assigned' && p.trustedBot(latest.actor)) {
          await github.graphql('mutation($issue: ID!, $user: ID!) { removeAssigneesFromAssignable(input: {assignableId: $issue, assigneeIds: [$user]}) { clientMutationId } }', { issue: issue.node_id, user: assigned.node_id });
          const { data: verified } = await github.rest.issues.get(args);
          if (verified.assignees.some(user => user.id === claim.userId)) throw new Error('Assignment removal could not be verified');
        }
      }
    }
    const status = claim.status === 'active' ? Date.parse(claim.expiresAt) <= Date.parse(clock()) ? 'expired' : 'unavailable' : claim.status;
    await save(`@${original.user.login} claim status: **${status}**. ${manuallyRemoved ? 'A maintainer removed this assignment. The bot will preserve that decision.' : claim.reason || 'This reservation is no longer active. Choose an available task and post a new /claim comment.'}`);
    return { status: dryRun ? 'dry-run' : status };
  }
  await save(`@${original.user.login} **Reserved** until **${claim.expiresAt}**. ${assigned ? 'The issue is assigned to you.' : 'The source assignment is pending; the bot will retry automatically.'} Link this issue in your PR and follow its acceptance checks and review requirements.`);
  if (assigned || dryRun) return { status: dryRun ? 'dry-run' : 'reserved' };
  const fresh = await readState(github);
  ({ data: issue } = await github.rest.issues.get(args));
  if (!live(fresh.claims[id], clock()) || issue.state !== 'open' || !issue.labels.some(label => (label.name || label) === config.bountyLabel) || issue.assignees.length) return { status: 'changed-before-assignment' };
  const { node } = await github.graphql('query($id: ID!) { node(id: $id) { ... on User { id databaseId login } } }', { id: claim.userNodeId });
  if (node?.id !== claim.userNodeId || p.accountId({ id: node.databaseId, login: node.login }) !== claim.userId) throw new Error('Claimant node identity mismatch');
  events = await pages(github.rest.issues.listEvents, args);
  const floor = events.reduce((max, event) => Math.max(max, p.positiveId(event.id)), 0);
  metadata = metadata.filter(line => !line.startsWith('<!-- astral-assignment'));
  metadata.push(`<!-- astral-assignment-intent:${encodeURIComponent(id)}:${floor} -->`);
  await save(`@${node.login} **Reserved** until **${claim.expiresAt}**. The source assignment is pending; the bot will retry automatically.`);
  await github.graphql('mutation($issue: ID!, $user: ID!) { addAssigneesToAssignable(input: {assignableId: $issue, assigneeIds: [$user]}) { clientMutationId } }', { issue: issue.node_id, user: node.id });
  const { data: verified } = await github.rest.issues.get(args);
  if (!verified.assignees.some(user => user.id === claim.userId) || verified.assignees.some(user => user.id !== claim.userId)) throw new Error('Assignment could not be verified');
  latest = latestAssignment(await pages(github.rest.issues.listEvents, args), claim.userId);
  if (latest?.event === 'assigned' && p.trustedBot(latest.actor) && latest.id > floor) metadata.push(`<!-- astral-assignment:${encodeURIComponent(id)}:${p.positiveId(latest.id)} -->`);
  await save(`@${node.login} **Reserved** and assigned to you until **${claim.expiresAt}**. Link this issue in your PR and follow its acceptance checks and review requirements.`);
  return { status: 'reserved' };
}

async function replyToClaim({ github, context, commentId = '', dryRun = 'false', clock = () => new Date().toISOString() }) {
  if (!['true', 'false'].includes(dryRun)) throw new Error('Invalid dry-run option');
  if (!['issue_comment', 'workflow_dispatch', 'schedule'].includes(context.eventName)) return { status: 'ignored', reason: 'unsupported event' };
  if (context.eventName === 'issue_comment' && !['created', 'edited'].includes(context.payload.action)) return { status: 'ignored', reason: 'unsupported comment event' };
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!config.repositories.includes(repository) || context.serverUrl !== 'https://github.com' || context.apiUrl !== 'https://api.github.com' || context.ref !== 'refs/heads/main') throw new Error('Claim replies require an approved public repository on main');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const { data: metadata } = await github.rest.repos.get(repo);
  if (metadata.private !== false || metadata.archived !== false || metadata.has_issues !== true) throw new Error('Claim replies require an active public issue repository');
  const state = await readState(github);
  const targets = new Map();
  let selected = null;
  if (context.eventName === 'issue_comment' || commentId !== '') {
    const id = p.positiveId(context.eventName === 'issue_comment' ? context.payload.comment?.id : commentId);
    const { data: comment } = await github.rest.issues.getComment({ ...repo, comment_id: id });
    if (comment.id !== id) throw new Error('Comment identity mismatch');
    if (comment.user?.type !== 'User' || (!p.command(comment.body) && !state.claims[p.sourceId(repository, id)]?.source)) return { status: 'ignored' };
    p.accountId(comment.user);
    const prefix = `https://api.github.com/repos/${repository}/issues/`;
    if (typeof comment.issue_url !== 'string' || !comment.issue_url.startsWith(prefix)) throw new Error('Comment issue is outside the current repository');
    const number = p.positiveId(comment.issue_url.slice(prefix.length));
    if (context.eventName === 'issue_comment' && context.payload.issue?.number !== number) throw new Error('Event issue mismatch');
    selected = id; targets.set(number, comment);
  } else {
    for (const issue of await pages(github.rest.issues.listForRepo, { ...repo, state: 'all', labels: config.bountyLabel })) if (!issue.pull_request) targets.set(p.positiveId(issue.number), null);
    for (const claim of Object.values(state.claims)) if (claim.key?.startsWith(`${repository}#`)) targets.set(p.positiveId(claim.key.split('#')[1]), null);
  }
  const results = [];
  const errors = [];
  for (const [number, selectedComment] of targets) {
    try {
      const comments = await pages(github.rest.issues.listComments, { ...repo, issue_number: number });
      const receipts = new Map();
      for (const item of comments) {
        const record = p.receipt(item);
        if (!record) continue;
        if (receipts.has(record.commentId)) throw new Error('Duplicate trusted command receipts');
        receipts.set(record.commentId, item);
      }
      const processed = new Set();
      const originals = selectedComment ? [selectedComment] : comments.filter(item => item.user?.type === 'User' && (receipts.has(item.id) || state.claims[p.sourceId(repository, item.id)]?.source || p.eligible(item, state.activation.enabledAt) || (p.command(item.body) === 'claim' && Object.values(state.claims).some(claim => !claim.source && claim.status === 'active' && claim.key === `${repository}#${number}` && claim.userId === item.user.id))));
      for (const original of originals) {
        processed.add(original.id);
        let reply = receipts.get(original.id);
        if (!reply) reply = comments.find(item => p.trustedBot(item.user) && typeof item.body === 'string' && item.body.startsWith(`<!-- astral-claim-help:${original.id} -->`));
        results.push({ issue: number, comment: original.id, ...await processCommand(github, repo, number, original, reply, dryRun === 'true', clock, state, comments) });
      }
      for (const claim of Object.values(state.claims)) {
        if (selected !== null || claim.source?.repository !== repository || claim.source.issue !== number || processed.has(claim.source.comment)) continue;
        const original = { id: claim.source.comment, body: `/${claim.source.command}`, updated_at: claim.source.commandAt, user: { id: claim.userId, login: claim.login, type: 'User' } };
        processed.add(original.id);
        results.push({ issue: number, comment: original.id, ...await processCommand(github, repo, number, original, receipts.get(original.id), dryRun === 'true', clock, state, comments) });
      }
      for (const [id, reply] of receipts) {
        if (selected !== null || processed.has(id) || comments.some(item => item.id === id)) continue;
        const record = p.receipt(reply);
        const commandClaim = state.claims[p.sourceId(repository, id)];
        const saved = annotation(reply.body, 'reservation');
        const claim = commandClaim?.status === 'duplicate' ? state.claims[commandClaim.reservation] : commandClaim || (saved && state.claims[saved.id]);
        if (claim && (claim.userId !== record.userId || claim.key !== `${repository}#${number}`)) throw new Error('Orphan receipt reservation mismatch');
        if (claim) results.push({ issue: number, comment: id, ...await processCommand(github, repo, number, { id, body: `/${record.command}`, updated_at: claim.source?.commandAt || claim.createdAt, user: { id: claim.userId, login: claim.login, type: 'User' } }, reply, dryRun === 'true', clock, state, comments) });
      }
    } catch (error) { errors.push(`${repository}#${number}: ${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { status: 'reconciled', results };
}

module.exports = { replyToClaim };
