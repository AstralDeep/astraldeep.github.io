// Shares command and receipt identities between the coordinator and source-repository action.
function positiveId(value) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number)) throw new Error('Invalid GitHub identifier');
  return number;
}

function accountId(user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user.login !== 'string' || !/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(user.login)) throw new Error('Invalid GitHub account identity');
  return user.id;
}

function command(body) {
  const first = typeof body === 'string' ? body.trim().split(/\r?\n/, 1)[0].trim().toLowerCase() : '';
  return ['/claim', '/unclaim'].includes(first) ? first.slice(1) : null;
}

function trustedBot(user) {
  return user?.id === 41898282 && user.type === 'Bot' && user.login === 'github-actions[bot]';
}

function marker(commentId, userId, action) {
  if (!['claim', 'unclaim'].includes(action)) throw new Error('Invalid claim command');
  return `<!-- astral-claim-command:${positiveId(commentId)}:${positiveId(userId)}:${action} -->`;
}

function receipt(comment) {
  if (!trustedBot(comment.user) || typeof comment.body !== 'string') return null;
  const match = /^<!-- astral-claim-command:([1-9]\d*):([1-9]\d*):(claim|unclaim) -->\n/.exec(comment.body);
  return match ? { commentId: positiveId(match[1]), userId: positiveId(match[2]), command: match[3] } : null;
}

function sourceId(repository, commentId) {
  return `comment:${repository}:${positiveId(commentId)}`;
}

function protocol(value) {
  if (value?.version !== 1 || (value.enabledAt !== null && (typeof value.enabledAt !== 'string' || !Number.isFinite(Date.parse(value.enabledAt))))) throw new Error('Invalid claim protocol activation');
  return value;
}

function eligible(comment, enabledAt) {
  return enabledAt !== null && comment.user?.type === 'User' && command(comment.body) !== null && Number.isFinite(Date.parse(comment.updated_at)) && Date.parse(comment.updated_at) >= Date.parse(enabledAt);
}

function annotation(body, name) {
  const matches = [...String(body).matchAll(new RegExp(`^<!-- astral-${name}:([^\\s:]+)(?::(\\d+))? -->$`, 'gm'))];
  if (matches.length > 1) throw new Error('Duplicate assignment annotation');
  if (!matches.length) return null;
  const id = decodeURIComponent(matches[0][1]);
  const event = matches[0][2] === undefined ? null : Number(matches[0][2]);
  if (event !== null && (!Number.isSafeInteger(event) || event < 0)) throw new Error('Invalid assignment event');
  return { id, event };
}

function commandTime(body) {
  const matches = [...String(body).matchAll(/^<!-- astral-command-time:([^\r\n]+) -->$/gm)];
  if (matches.length > 1 || (matches.length && !Number.isFinite(Date.parse(matches[0][1])))) throw new Error('Invalid frozen command time');
  return matches[0]?.[1] || null;
}

module.exports = { positiveId, accountId, command, trustedBot, marker, receipt, sourceId, protocol, eligible, annotation, commandTime };
