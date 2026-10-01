// Collects authenticated source-comment commands for the central reservation transaction.
import protocol from '../actions/claim-reply/protocol.cjs';
const { accountId, command, receipt, sourceId, eligible, positiveId, annotation, trustedBot } = protocol;

export async function sourceRequests(api, tasks, previous, enabledAt) {
  if (enabledAt === null) return [];
  const requests = [];
  for (const task of tasks) {
    const comments = await api.pages(`/repos/${task.repository}/issues/${task.number}/comments`);
    const byId = new Map(comments.map(comment => [comment.id, comment]));
    const seen = new Set();
    let events;
    task.managedAssignments = [];
    task.manuallyReleasedClaims = [];
    const receipts = new Map();
    for (const reply of comments) {
      const record = receipt(reply);
      if (!record) continue;
      const id = sourceId(task.repository, record.commentId);
      if (seen.has(id)) throw new Error('Duplicate trusted command receipts');
      seen.add(id);
      receipts.set(record.commentId, { reply, record });
      const owned = annotation(reply.body, 'assignment');
      const intent = annotation(reply.body, 'assignment-intent');
      const assignment = owned || intent;
      const reservation = assignment && previous[assignment.id];
      if (reservation?.key === task.key && reservation.userId === record.userId) {
        events ??= await api.pages(`/repos/${task.repository}/issues/${task.number}/events`);
        const latest = events.filter(event => ['assigned', 'unassigned'].includes(event.event) && event.assignee?.id === record.userId).sort((a, b) => b.id - a.id)[0];
        if (latest?.event === 'assigned' && trustedBot(latest.actor) && task.assigneeIds.includes(record.userId) && (owned ? latest.id === owned.event : latest.id > intent.event)) task.managedAssignments.push({ id: assignment.id, userId: record.userId });
        if (latest?.event === 'unassigned' && !trustedBot(latest.actor) && latest.id > assignment.event) task.manuallyReleasedClaims.push(assignment.id);
      }
      const original = byId.get(record.commentId);
      if (!original || original.user?.type !== 'User') continue;
      if (accountId(original.user) !== record.userId) throw new Error('Source command owner mismatch');
    }
    for (const original of comments) {
      if (original.user?.type !== 'User') continue;
      const id = sourceId(task.repository, original.id);
      if (!previous[id] && !eligible(original, enabledAt)) continue;
      accountId(original.user);
      if (typeof original.user.node_id !== 'string' || !original.user.node_id) throw new Error('Missing immutable claimant node identity');
      const registered = receipts.get(original.id);
      const frozenCommand = previous[id]?.source.command || registered?.record.command || command(original.body);
      const commandAt = previous[id]?.source.commandAt || protocol.commandTime(registered?.reply.body) || original.updated_at;
      if (!Number.isFinite(Date.parse(commandAt))) throw new Error('Invalid source command timestamp');
      requests.push({
        id, number: original.id, state: 'open', labels: ['claim-request'], user: original.user,
        created_at: commandAt,
        target: { repository: task.repository, number: task.number, key: task.key },
        source: { repository: task.repository, issue: task.number, comment: positiveId(original.id), ...(registered ? { receipt: positiveId(registered.reply.id) } : {}), command: frozenCommand, commandAt },
        changedCommand: command(original.body) !== frozenCommand,
      });
    }
  }
  return requests;
}
