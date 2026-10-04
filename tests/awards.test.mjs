// Exercises automatic main-merge credit, immutable historical evidence, and failure-safe reconciliation without network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergedAward, reconcileAwards } from '../scripts/awards.mjs';
import { synchronize } from '../scripts/sync.mjs';
import { GitHub } from '../scripts/github.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const repository = 'AstralDeep/AstralPlane';
const author = { id: 1234, login: 'contributor', type: 'User' };
const merger = { id: 5678, login: 'other-maintainer', type: 'User' };
const task = { key: `${repository}#20`, repository, number: 20, url: `https://github.com/${repository}/issues/20`, points: 50, state: 'closed', stateReason: 'completed' };
const pr = { html_url: `https://github.com/${repository}/pull/25`, user: author, merged_by: merger, created_at: '2026-10-01T13:00:00Z', merged_at: '2026-10-10T14:00:00Z', base: { ref: 'main', repo: { full_name: repository } }, head: { sha: 'a'.repeat(40) }, merge_commit_sha: 'b'.repeat(40) };
const closure = { id: 'CE_example', createdAt: '2026-10-10T14:00:01Z', closer: { __typename: 'PullRequest', url: pr.html_url } };
const now = '2026-10-10T15:00:00Z';
const credit = (p = pr, close = closure, t = task) => mergedAward(t, p, close, now);
const api = { request: async () => pr, closedBy: async () => closure, pages: async () => { throw new Error('New awards must not scan comments or assignments'); } };

test('main merges automatically credit the author without claims, assignments, or configured merger', async () => {
  const award = credit();
  assert.equal(award.policy, 'main-merge'); assert.equal(award.points, 50); assert.equal(award.userId, author.id); assert.equal(award.mergedBy, merger.id);
  assert.equal(award.baseRef, 'main'); assert.equal('claim' in award, false); assert.equal(award.closureId, closure.id); assert.equal(award.headSha, pr.head.sha);
  const first = await reconcileAwards(api, config, [task], {}, [], now);
  const second = await reconcileAwards(api, config, [task], { other: { status: 'active', userId: 999 } }, first.awards, '2026-10-11T00:00:00Z');
  assert.deepEqual(second, first); assert.equal(first.awards.length, 1);
  assert.equal(credit({ ...pr, merged_by: author }).userId, author.id);
  assert.equal(credit({ ...pr, user: { ...author, type: 'Bot', login: 'contributor[bot]' } }).userId, author.id);
  const renamed = await reconcileAwards({ ...api, request: async () => ({ ...pr, user: { ...author, login: 'renamed' } }) }, config, [task], {}, first.awards, now);
  assert.equal(renamed.awards[0].login, author.login); assert.equal(renamed.verified[0].displayLogin, 'renamed');
});

test('only same-repository completed main merges with actual PR closure evidence qualify', () => {
  for (const close of [null, { ...closure, closer: null }, { ...closure, closer: { __typename: 'Commit', url: pr.html_url } }, { ...closure, closer: { __typename: 'PullRequest', url: pr.html_url + '0' } }]) assert.equal(credit(pr, close), null);
  for (const change of [{ state: 'open' }, { stateReason: 'not_planned' }, { repository: 'AstralDeep/LETS' }]) assert.equal(credit(pr, closure, { ...task, ...change }), null);
  for (const change of [{ merged_at: null }, { base: { ref: 'release', repo: { full_name: repository } } }, { base: { ref: 'main', repo: { full_name: 'contributor/AstralPlane' } } }, { base: null }]) assert.equal(credit({ ...pr, ...change }), null);
  for (const change of [{ created_at: 'bad' }, { created_at: now }, { merged_at: now }, { head: {} }, { merge_commit_sha: 'bad' }, { merged_by: { login: merger.login } }, { user: { login: author.login } }]) assert.throws(() => credit({ ...pr, ...change }));
  assert.throws(() => credit(pr, { ...closure, id: null }), /closure identity/);
  assert.throws(() => credit(pr, { ...closure, createdAt: '2026-10-11T00:00:00Z' }), /dates/);
});

test('ledger refuses changed provider evidence, unsupported policies, and duplicate award scope', async () => {
  const award = credit();
  for (const change of [{ userId: 1 }, { mergedBy: 1 }, { headSha: 'c'.repeat(40) }, { mergeSha: 'c'.repeat(40) }, { baseRef: 'release' }, { closureId: 'changed' }, { policy: 'invented' }]) await assert.rejects(reconcileAwards(api, config, [task], {}, [{ ...award, ...change }], now));
  for (const close of [null, { ...closure, closer: { __typename: 'PullRequest', url: 'https://evil.test/pull/25' } }, { ...closure, closer: { __typename: 'PullRequest', url: pr.html_url + '?x=1' } }]) {
    assert.deepEqual((await reconcileAwards({ ...api, closedBy: async () => close }, config, [task], {}, [], now)).awards, []);
    await assert.rejects(reconcileAwards({ ...api, closedBy: async () => close }, config, [task], {}, [award], now), /evidence changed/);
  }
  const other = { ...task, number: 21, key: `${repository}#21`, url: task.url.replace('/20', '/21') };
  await assert.rejects(reconcileAwards(api, config, [task, other], {}, [], now), /multiple eligible/);
  await assert.rejects(reconcileAwards({ ...api, request: async () => { throw new Error('Provider unavailable'); } }, config, [task], {}, [], now), /Provider unavailable/);
});

test('historical reservation awards preserve recorded bytes and require original immutable evidence', async () => {
  const previous = { ...config.historicalAwardApprovers[0], type: 'User' };
  const oldPR = { ...pr, user: previous, merged_by: previous };
  const claim = { type: 'reservation', id: '2', createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-08T12:00:00Z' };
  const record = { key: task.key, userId: previous.id, createdAt: claim.createdAt, expiresAt: claim.expiresAt };
  const { baseRef, ...merge } = credit(oldPR);
  const saved = { ...merge, policy: 'maintainer-merge', claim };
  const bytes = JSON.stringify(saved);
  const historicalApi = { ...api, request: async () => oldPR };
  const result = await reconcileAwards(historicalApi, config, [task], { 2: record }, [saved], now);
  assert.equal(JSON.stringify(result.awards[0]), bytes); assert.equal(JSON.stringify(saved), bytes);
  for (const change of [{ key: 'other' }, { userId: 1 }, { createdAt: 'bad' }, { expiresAt: 'bad' }]) await assert.rejects(reconcileAwards(historicalApi, config, [task], { 2: { ...record, ...change } }, [saved], now), /reservation evidence/);
  await assert.rejects(reconcileAwards(historicalApi, config, [task], {}, [saved], now), /reservation evidence/);
  await assert.rejects(reconcileAwards(historicalApi, config, [task], { 2: record }, [{ ...saved, claim: null }], now), /claim evidence/);
  await assert.rejects(reconcileAwards(historicalApi, { ...config, historicalAwardApprovers: [] }, [task], { 2: record }, [saved], now), /Historical award merger/);
});

test('historical assignment awards verify the bound human assignment event', async () => {
  const previous = { ...config.historicalAwardApprovers[0], type: 'User' };
  const oldPR = { ...pr, merged_by: previous };
  const event = { id: 123, event: 'assigned', assigner: previous, assignee: author, created_at: '2026-10-01T12:00:00Z' };
  const { baseRef, ...merge } = credit(oldPR);
  const saved = { ...merge, policy: 'maintainer-merge', claim: { type: 'assignment', eventId: 123, assignerId: previous.id, userId: author.id, createdAt: event.created_at } };
  const historicalApi = { ...api, request: async () => oldPR, pages: async () => [event] };
  assert.deepEqual((await reconcileAwards(historicalApi, config, [task], {}, [saved], now)).awards, [saved]);
  for (const events of [[], [{ ...event, event: 'unassigned' }], [{ ...event, assigner: { ...previous, type: 'Bot' } }], [{ ...event, assignee: { ...author, id: 99 } }], [{ ...event, created_at: now }]]) await assert.rejects(reconcileAwards({ ...historicalApi, pages: async () => events }, config, [task], {}, [saved], now), /assignment evidence/);
});

test('sync ignores reservation history and assignments and automatically credits completed bounties', async () => {
  const source = { number: 20, title: 'Task', labels: ['bounty', 'points:50'], assignees: [{ id: 999, login: 'other' }], state: 'closed', state_reason: 'completed' };
  const calls = [];
  const live = { ...api, request: async path => path.includes('/pulls/') ? pr : { has_issues: true }, pages: async path => {
    calls.push(path); if (!path.endsWith('/issues?state=all&labels=bounty')) throw new Error('Unexpected source scan');
    return path.startsWith(`/repos/${repository}/`) ? [source] : [];
  } };
  const claims = { rejected: { key: task.key, userId: author.id, status: 'rejected' }, competing: { key: task.key, userId: 999, status: 'active' } };
  const original = structuredClone(claims);
  const result = await synchronize(live, config, claims, [], now);
  assert.equal(result.awards.length, 1); assert.equal(result.board.leaderboard[0].points, 50); assert.equal(result.board.tasks[0].status, 'completed');
  assert.equal('claims' in result.board, false); assert.equal('claim' in result.board.tasks[0], false); assert.deepEqual(claims, original); assert.equal(calls.length, 5);
});

test('closure lookup sends a bounded read-only query and fails on missing provider evidence', async () => {
  const good = { data: { repository: { issue: { timelineItems: { nodes: [closure] } } } } };
  const client = new GitHub('test-only', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-only');
    const body = JSON.parse(options.body); assert.match(body.query, /last:1/); assert.ok(!body.query.includes('mutation')); assert.deepEqual(body.variables, { owner: 'AstralDeep', name: 'AstralPlane', number: 20 });
    return { ok: true, json: async () => good };
  });
  assert.deepEqual(await client.closedBy(repository, 20), closure);
  for (const [repo, number] of [['bad', 20], [repository, -1], [repository, 1.5]]) await assert.rejects(client.closedBy(repo, number), /target/);
  await assert.rejects(new GitHub('', async () => ({ ok: false, status: 403 })).closedBy(repository, 20), /403/);
  for (const body of [{ errors: [{ message: 'no access' }], ...good }, { data: {} }]) await assert.rejects(new GitHub('', async () => ({ ok: true, json: async () => body })).closedBy(repository, 20), /Incomplete/);
  good.data.repository.issue.timelineItems.nodes = [];
  assert.equal(await client.closedBy(repository, 20), null);
});
