// Validates the reviewed award corrections in config and matches them to closure evidence and stored ledger records for awards.mjs.
export const EVIDENCE_UNAVAILABLE = 'evidence no longer available from the provider';

const RESOLUTION_KEYS = ['repository', 'pr', 'award', 'declined', 'points', 'userId', 'mergedBy', 'headSha', 'mergeSha', 'closureId', 'reason', 'approvedBy'];
const UNAVAILABLE_KEYS = ['key', 'pr', 'userId', 'points', 'status', 'reason', 'approvedBy'];
const RECORDED = ['userId', 'mergedBy', 'points', 'headSha', 'mergeSha', 'closureId'];

const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = value => typeof value === 'string' && value.trim() !== '';
const shaped = (item, keys) => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).sort().join() === [...keys].sort().join();

const validResolution = (item, config) => shaped(item, RESOLUTION_KEYS) && config.repositories.includes(item.repository) && positive(item.pr) && positive(item.award)
  && Array.isArray(item.declined) && item.declined.length > 0 && item.declined.every(positive) && new Set(item.declined).size === item.declined.length && !item.declined.includes(item.award)
  && config.points.includes(item.points) && positive(item.userId) && positive(item.mergedBy) && sha(item.headSha) && sha(item.mergeSha)
  && text(item.closureId) && text(item.reason) && positive(item.approvedBy);

function validUnavailable(item, config) {
  const match = text(item?.key) ? /^(.+)#([1-9]\d*)$/.exec(item.key) : null;
  const prefix = match && `https://github.com/${match[1]}/pull/`;
  return shaped(item, UNAVAILABLE_KEYS) && Boolean(match) && config.repositories.includes(match[1])
    && typeof item.pr === 'string' && item.pr.startsWith(prefix) && /^[1-9]\d*$/.test(item.pr.slice(prefix.length))
    && positive(item.userId) && config.points.includes(item.points) && item.status === EVIDENCE_UNAVAILABLE && text(item.reason) && positive(item.approvedBy);
}

export function loadCorrections(config) {
  const { awardResolutions: resolutions = [], unavailableAwardEvidence: unavailable = [] } = config;
  if (!Array.isArray(resolutions) || !resolutions.every(item => validResolution(item, config)) || new Set(resolutions.map(item => `${item.repository}#${item.pr}`)).size !== resolutions.length) throw new Error('Invalid award resolution');
  if (!Array.isArray(unavailable) || !unavailable.every(item => validUnavailable(item, config)) || new Set(unavailable.map(item => item.key)).size !== unavailable.length) throw new Error('Invalid award evidence correction');
  return { resolutions, unavailable };
}

export function resolutionFor(corrections, task, closure) {
  const closer = closure?.closer;
  return corrections.resolutions.find(item => item.repository === task.repository && closer?.__typename === 'PullRequest'
    && closer.url === `https://github.com/${item.repository}/pull/${item.pr}` && (item.award === task.number || item.declined.includes(task.number)));
}

export function confirmResolution(resolution, task, candidate) {
  if (!candidate || RECORDED.some(key => candidate[key] !== resolution[key])) throw new Error(`Award resolution evidence changed: ${task.key}`);
}

export function unavailableFor(corrections, task, saved) {
  const entry = corrections.unavailable.find(item => item.key === task.key);
  if (entry && (saved.userId !== entry.userId || saved.pr !== entry.pr || saved.points !== entry.points)) throw new Error(`Award evidence correction does not match the stored award: ${task.key}`);
  return entry;
}
