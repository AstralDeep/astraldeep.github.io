// Exercises automatic merge credit, historical claim eligibility and idempotent evidence persistence without network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergedAward, reconcileAwards } from '../scripts/awards.mjs';
import { synchronize } from '../scripts/sync.mjs';
import { GitHub } from '../scripts/github.mjs';
import { reconcileClaims } from '../scripts/model.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const repository = 'AstralDeep/AstralPlane';
const author = { ...config.awardApprovers[0], type: 'User' };
const task = { key: `${repository}#20`, repository, number: 20, url: `https://github.com/${repository}/issues/20`, points: 50, state: 'closed', stateReason: 'completed' };
const pr = { html_url: `https://github.com/${repository}/pull/25`, user: author, merged_by: author, created_at: '2026-10-01T13:00:00Z', merged_at: '2026-10-10T14:00:00Z', head: { sha: 'a'.repeat(40) }, merge_commit_sha: 'b'.repeat(40) };
const closure = { id: 'CE_example', createdAt: '2026-10-10T14:00:01Z', closer: { __typename: 'PullRequest', url: pr.html_url } };
const now = '2026-10-10T15:00:00Z';
const claims = { 2: { key: task.key, userId: author.id, login: author.login, status: 'expired', createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-08T12:00:00Z', endedAt: '2026-10-08T12:01:00Z' } };
const assignment = { id: 123, event: 'assigned', created_at: '2026-10-01T12:30:00Z', actor: author, assignee: author };
const credit = (p = pr, c = claims, events = [], close = closure, t = task) => mergedAward(t, p, close, c, events, config, now);
const api = { request: async () => pr, closedBy: async () => closure, pages: async () => [] };

test('maintainer self-merge automatically credits a submitted claim after its lease expires', async () => {
  const award = credit();
  assert.equal(award.points, 50); assert.equal(award.userId, author.id); assert.equal(award.mergedBy, author.id);
  assert.deepEqual(award.claim, { type: 'reservation', id: '2', createdAt: claims[2].createdAt, expiresAt: claims[2].expiresAt });
  assert.equal(award.closureId, closure.id); assert.equal(award.headSha, pr.head.sha);
  const first = await reconcileAwards(api, config, [task], claims, [], now);
  const second = await reconcileAwards(api, config, [task], claims, first.awards, '2026-10-11T00:00:00Z');
  assert.deepEqual(second, first); assert.equal(first.awards.length, 1);
  const renamed = await reconcileAwards({ ...api, request: async () => ({ ...pr, user: { ...author, login: 'renamed' } }) }, config, [task], claims, first.awards, now);
  assert.equal(renamed.awards[0].login, author.login); assert.equal(renamed.verified[0].displayLogin, 'renamed');
});

test('a different contributor earns points when the configured maintainer merges', () => {
  const other = { id: 1234, login: 'contributor', type: 'User' };
  assert.equal(credit({ ...pr, user: other }, { 2: { ...claims[2], userId: other.id } }).userId, other.id);
  assert.equal(credit({ ...pr, user: { ...author, id: 1234 } }), null);
  assert.equal(credit({ ...pr, merged_by: { ...author, id: 1234 } }), null);
  assert.equal(credit({ ...pr, merged_by: { ...author, login: 'renamed-maintainer' } }).points, 50);
});

test('claim admission rejects invalid or late reservations while preserving eligible released history', () => {
  for (const change of [{ key: 'wrong' }, { userId: 5 }, { status: 'rejected' }, { status: 'duplicate' }, { createdAt: pr.merged_at }, { expiresAt: pr.created_at }, { endedAt: claims[2].createdAt }, { createdAt: 'invalid' }]) assert.equal(credit(pr, { 2: { ...claims[2], ...change } }), null);
  assert.equal(credit(pr, { 2: { ...claims[2], status: 'released', releasedBy: 'release' }, release: { source: { commandAt: '2026-10-01T12:59:00Z' } } }), null);
  assert.ok(credit(pr, { 2: { ...claims[2], status: 'released', endedAt: '2026-10-01T14:00:00Z' } }));
  assert.ok(credit(pr, { 2: { ...claims[2], endedAt: undefined } }));
});

test('manual assignment history qualifies only the sole human-assigned author at submission', () => {
  const award = credit(pr, {}, [{ event: 'labeled' }, assignment]);
  assert.deepEqual(award.claim, { type: 'assignment', eventId: 123, actorId: author.id, userId: author.id, createdAt: assignment.created_at });
  for (const events of [[], [{ ...assignment, actor: { ...author, type: 'Bot' } }], [{ ...assignment, id: -1 }], [{ ...assignment, created_at: pr.merged_at }], [assignment, { ...assignment, id: 124, event: 'unassigned' }], [assignment, { ...assignment, id: 124, assignee: { id: 2, login: 'other' } }]]) assert.equal(credit(pr, {}, events), null);
  assert.ok(credit(pr, {}, [{ ...assignment, event: 'unassigned', id: 122 }, assignment]));
  assert.ok(credit(pr, {}, [assignment, { ...assignment, id: 124, event: 'unassigned', created_at: pr.merged_at }]));
  assert.throws(() => credit(pr, {}, [{ ...assignment, created_at: 'bad' }]), /event time/);
});

test('manual overrides and cancellation before submission take precedence over delayed reconciliation', () => {
  const delayed = { 2: { ...claims[2], status: 'superseded', endedAt: '2026-10-01T13:05:00Z' } };
  const intervened = '2026-10-01T12:59:00Z';
  assert.equal(credit(pr, delayed, [{ ...assignment, created_at: intervened, assignee: { id: 99, login: 'other' } }]), null);
  assert.equal(credit(pr, delayed, [{ ...assignment, created_at: intervened, event: 'unassigned' }]), null);
  assert.equal(credit(pr, claims, [{ ...assignment, created_at: intervened, event: 'unassigned', actor: { ...author, type: 'Bot' } }]).points, 50);
  assert.equal(credit(pr, { ...claims, cancel: { key: task.key, userId: author.id, cancellationValid: true, source: { command: 'unclaim', commandAt: intervened } } }), null);
  assert.ok(credit(pr, { ...claims, cancel: { key: task.key, userId: author.id, cancellationValid: false, source: { command: 'unclaim', commandAt: intervened } } }));
  for (const state of ['closed', 'open']) {
    const request = { number: 2, state, user: author, closed_at: intervened, firstClosedAt: state === 'open' ? intervened : undefined, everClosed: state === 'open' };
    const reconciled = reconcileClaims({ 2: { ...claims[2], status: 'active' } }, [request], [{ ...task, assigneeIds: [] }], config, now);
    assert.equal(reconciled[2].endedAt, intervened); assert.equal(credit(pr, reconciled), null);
  }
  const cancel = { id: 'cancel', number: 42, state: 'open', labels: ['claim-request'], user: author, target: { key: task.key }, source: { command: 'unclaim', commandAt: intervened } };
  const reconciled = reconcileClaims(claims, [cancel], [{ ...task, assigneeIds: [] }], config, now);
  assert.equal(reconciled.cancel.cancellationValid, true); assert.equal(credit(pr, reconciled), null);
});

test('only actual completed PR closures with verifiable timestamps and identities qualify', () => {
  for (const close of [null, { ...closure, closer: null }, { ...closure, closer: { __typename: 'Commit', url: pr.html_url } }, { ...closure, closer: { __typename: 'PullRequest', url: pr.html_url + '0' } }]) assert.equal(credit(pr, claims, [], close), null);
  for (const change of [{ state: 'open' }, { stateReason: 'not_planned' }, { repository: 'AstralDeep/LETS' }]) assert.equal(credit(pr, claims, [], closure, { ...task, ...change }), null);
  assert.equal(credit({ ...pr, merged_at: null }), null); assert.equal(credit({ ...pr, user: { ...author, type: 'Bot' } }), null);
  for (const change of [{ created_at: 'bad' }, { created_at: now }, { merged_at: now }, { head: {} }, { merge_commit_sha: 'bad' }, { merged_by: { login: author.login } }]) assert.throws(() => credit({ ...pr, ...change }));
  assert.throws(() => credit(pr, claims, [], { ...closure, id: null }), /closure identity/);
  assert.throws(() => credit(pr, claims, [], { ...closure, createdAt: '2026-10-11T00:00:00Z' }), /dates/);
});

test('ledger refuses changed evidence, unsupported policies and ambiguous duplicate awards', async () => {
  const award = credit();
  for (const change of [{ mergedBy: 1 }, { headSha: 'c'.repeat(40) }, { claim: { type: 'reservation', id: '3' } }, { policy: 'invented' }]) await assert.rejects(reconcileAwards(api, config, [task], claims, [{ ...award, ...change }], now));
  await assert.rejects(reconcileAwards({ ...api, closedBy: async () => null }, config, [task], claims, [award], now), /evidence changed/);
  await assert.rejects(reconcileAwards(api, config, [task], {}, [award], now), /evidence changed/);
  const other = { ...task, number: 21, key: `${repository}#21`, url: task.url.replace('/20', '/21') };
  await assert.rejects(reconcileAwards(api, config, [task, other], { ...claims, 3: { ...claims[2], key: other.key } }, [], now), /multiple eligible/);
  for (const close of [null, { ...closure, closer: { __typename: 'PullRequest', url: 'https://evil.test/pull/25' } }, { ...closure, closer: { __typename: 'PullRequest', url: pr.html_url + '?x=1' } }]) assert.deepEqual((await reconcileAwards({ ...api, closedBy: async () => close }, config, [task], claims, [], now)).awards, []);
  assert.deepEqual((await reconcileAwards(api, config, [task], {}, [], now)).awards, []);
});

test('sync persists automatic awards together with finished claims for the public board', async () => {
  const source = { number: 20, title: 'Task', labels: ['bounty', 'points:50'], assignees: [], state: 'closed', state_reason: 'completed' };
  const live = { ...api, request: async path => path.includes('/pulls/') ? pr : { has_issues: true }, pages: async path => path === `/repos/${repository}/issues?state=all&labels=bounty` ? [source] : [] };
  const result = await synchronize(live, config, claims, [], now);
  assert.equal(result.awards.length, 1); assert.equal(result.board.leaderboard[0].points, 50); assert.equal(result.board.tasks[0].status, 'completed');
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
