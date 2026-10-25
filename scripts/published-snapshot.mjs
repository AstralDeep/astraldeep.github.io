// Reuses the published board only when its records match immutable community state and its original successful run.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountId, summarize, validateAwards } from './model.mjs';

export function validatePublishedSnapshot(board, awards, config, run, workflowID) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' || run.head_branch !== 'main'
    || run.path !== '.github/workflows/pages.yml' || run.workflow_id !== workflowID
    || run.repository?.full_name !== config.coordinator || run.head_repository?.full_name !== config.coordinator
    || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.id) || run.id < 1) throw new Error('Published snapshot run identity is invalid');
  const dates = [run.created_at, board?.generatedAt, run.updated_at].map(Date.parse);
  if (!dates.every(Number.isFinite) || dates[0] > dates[1] || dates[1] > dates[2]) throw new Error('Published snapshot timestamp disagrees with its run');
  if (!Array.isArray(board.tasks) || !Array.isArray(board.awards) || !Array.isArray(board.leaderboard)) throw new Error('Published snapshot is incomplete');
  const seen = new Set();
  for (const task of board.tasks) {
    if (!config.repositories.includes(task.repository) || !Number.isSafeInteger(task.number) || task.number < 1
      || task.key !== `${task.repository}#${task.number}` || task.url !== `https://github.com/${task.repository}/issues/${task.number}`
      || seen.has(task.key) || typeof task.title !== 'string' || task.title.length > 4096
      || !config.points.includes(task.points) || !['open', 'closed'].includes(task.state)
      || ![null, 'completed', 'not_planned', 'reopened'].includes(task.stateReason)
      || !['P1', 'P2', 'P3'].includes(task.priority) || !Array.isArray(task.tracks)
      || task.tracks.some(track => !config.tracks.includes(track))) throw new Error('Published snapshot contains invalid task data');
    seen.add(task.key);
  }
  validateAwards(awards, board.tasks, config);
  const retained = board.awards.map(({ displayLogin, ...award }) => {
    accountId({ id: award.userId, login: displayLogin });
    return award;
  });
  validateAwards(retained, board.tasks, config);
  const ordered = entries => [...entries].sort((a, b) => a.issue.localeCompare(b.issue));
  if (!isDeepStrictEqual(ordered(retained), ordered(awards))) throw new Error('Published awards differ from immutable community state');
  if (!isDeepStrictEqual(summarize(board.tasks, board.awards, board.generatedAt), board)) throw new Error('Published snapshot totals or statuses disagree');
}

export async function loadPublishedSnapshot(github, config, snapshot, transport = fetch) {
  const workflow = await github.request(`/repos/${config.coordinator}/actions/workflows/pages.yml`);
  if (!Number.isSafeInteger(workflow?.id) || workflow.id < 1 || workflow.path !== '.github/workflows/pages.yml') throw new Error('Community workflow identity is invalid');
  const listing = await github.request(`/repos/${config.coordinator}/actions/workflows/pages.yml/runs?status=success&branch=main&per_page=1`);
  if (!Array.isArray(listing.workflow_runs) || listing.workflow_runs.length !== 1
    || !Number.isSafeInteger(listing.workflow_runs[0].id) || listing.workflow_runs[0].id < 1) throw new Error('No successful published board run is available');
  const run = await github.request(`/repos/${config.coordinator}/actions/runs/${listing.workflow_runs[0].id}`);
  if (run.id !== listing.workflow_runs[0].id) throw new Error('Published snapshot run changed');
  const response = await transport(`${config.site}/data/board.json`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Published board snapshot is unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error('Published board snapshot exceeds its size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  const board = JSON.parse(bytes.toString('utf8'));
  validatePublishedSnapshot(board, JSON.parse(snapshot.files['data/awards.json']), config, run, workflow.id);
  return { board, provenance: {
    mode: 'retained-published-snapshot', sourceRun: run.id, sourceCommit: run.head_sha,
    stateCommit: snapshot.sha, generatedAt: board.generatedAt,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size,
  } };
}
