// Tests pagination completeness and API failures without network calls or live credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../scripts/github.mjs';
import { synchronize } from '../scripts/sync.mjs';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
test('API bounds routes, redirects, status handling and token placement', async () => {
  const api = new GitHub('test-only', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/AstralDeep/LETS');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    assert.equal(options.body, '{"test":true}');
    return { ok: true, status: 204 };
  });
  assert.equal(await api.request('/repos/AstralDeep/LETS', 'POST', { test: true }), null);
  for (const path of ['https://evil.test', '/repos/../secret', '/repos/a\nb']) await assert.rejects(api.request(path), /Invalid/);
  await assert.rejects(new GitHub('', async () => ({ ok: false, status: 403 })).request('/repos/a'), /403/);
  const publicApi = new GitHub('', async (url, options) => { assert.equal(options.headers.Authorization, undefined); return { ok: true, status: 200, json: async () => ({ id: 1 }) }; });
  assert.deepEqual(await publicApi.request('/repos/a'), { id: 1 });
  assert.equal(new GitHub().token, '');
});

test('pagination follows all pages and refuses malformed or truncated responses', async () => {
  const api = new GitHub();
  const paths = [];
  api.request = async path => { paths.push(path); return path.endsWith('page=1') ? Array(100).fill({}) : [1]; };
  assert.equal((await api.pages('/repos/a/issues')).length, 101);
  assert.match(paths[0], /\?per_page/);
  await api.pages('/repos/a/issues?state=all');
  assert.match(paths[2], /&per_page/);
  api.request = async () => ({});
  await assert.rejects(api.pages('/repos/a'), /paginated/);
  api.request = async () => Array(100).fill({});
  await assert.rejects(api.pages('/repos/a'), /limit/);
});

test('sync verifies the public repository allowlist and emits a true empty board', async () => {
  const api = { request: async () => ({ private: false, archived: false, has_issues: true }), pages: async () => [] };
  const result = await synchronize(api, config, {}, [], '2026-10-01T00:00:00Z');
  assert.deepEqual(result.board.tasks, []);
  assert.deepEqual(result.claims, {});
  for (const metadata of [{ private: true }, { archived: true }, { has_issues: false }]) await assert.rejects(synchronize({ ...api, request: async () => metadata }, config, {}, [], '2026-10-01T00:00:00Z'), /active public/);
});

test('sync validates merged PR and review evidence before including an award', async () => {
  const repository = config.repositories[0];
  const url = `https://github.com/${repository}`;
  const now = '2026-10-01T00:00:00Z';
  const award = { issue: `${url}/issues/1`, pr: `${url}/pull/2`, points: 25, userId: 1, login: 'alice', review: 3, awardedAt: now };
  const api = {
    request: async path => path.includes('/reviews/') ? { id: 3, state: 'APPROVED', user: { ...config.awardApprovers[0] }, commit_id: 'abc', submitted_at: now, body: `Bounty-issue: ${award.issue}` } : path.includes('/pulls/') ? { html_url: award.pr, merged_at: now, user: { id: 1, login: 'current-alice' }, head: { sha: 'abc' } } : { has_issues: true },
    pages: async path => path.startsWith(`/repos/${repository}/issues?`) ? [{ number: 1, title: 'Task', labels: ['bounty', 'points:25'], assignees: [], state: 'closed', state_reason: 'completed' }] : [],
  };
  const result = await synchronize(api, config, {}, [award], now);
  assert.equal(result.board.leaderboard[0].points, 25);
  assert.equal(result.board.leaderboard[0].userId, 1);
  assert.equal(result.board.leaderboard[0].login, 'current-alice');
  assert.equal(result.board.awards[0].login, 'alice');
  assert.equal(result.board.awards[0].displayLogin, 'current-alice');
  assert.equal(award.login, 'alice');
  assert.equal(award.displayLogin, undefined);
  const badReview = { request: async path => { const value = await api.request(path); return path.includes('/reviews/') ? { ...value, body: `Bounty-issue: ${url}/issues/99` } : value; }, pages: api.pages };
  await assert.rejects(synchronize(badReview, config, {}, [award], now), /attestation/);
});

test('sync checks close history so a close/reopen race cannot resurrect a claim', async () => {
  const base = `/repos/${config.coordinator}/issues`;
  const api = {
    request: async () => ({ has_issues: true }),
    pages: async path => path === `${base}?state=all&labels=claim-request` ? [
      { number: 1, state: 'open', labels: ['claim-request'], user: { id: 1, login: 'alice', type: 'User' } },
      { number: 2, state: 'closed' }, { number: 3, state: 'open', pull_request: {} }, { number: 4, state: 'open', user: { id: 4, login: 'bob', type: 'User' } },
    ] : path.endsWith('/events') ? [{ event: 'reopened' }, { event: 'closed' }] : [],
  };
  const result = await synchronize(api, config, { 4: { status: 'expired', userId: 4, login: 'bob' } }, [], '2026-10-01T00:00:00Z');
  assert.equal(result.claims[1].status, 'rejected');
  assert.match(result.claims[1].reason, /cannot be reused/);
});

test('sync retains stable claimant IDs and rejects malformed source-assignee identities', async () => {
  const repository = config.repositories[0];
  const base = `https://github.com/${repository}`;
  const now = '2026-10-01T00:00:00Z';
  const previous = { 1: { request: 1, userId: 7, login: 'old-name', key: `${repository}#1`, status: 'active', expiresAt: '2026-10-08T00:00:00Z' } };
  const tasks = [1, 2].map(number => ({ number, title: 'Task', labels: ['bounty', 'points:25'], assignees: [], state: 'open' }));
  const api = {
    request: async () => ({ has_issues: true }),
    pages: async path => path.startsWith(`/repos/${repository}/issues?`) ? tasks : path === `/repos/${config.coordinator}/issues?state=all&labels=claim-request` ? [1, 2].map(number => ({ number, state: 'open', labels: ['claim-request'], user: { id: 7, login: 'new-name', type: 'User' }, body: `### Task\n${base}/issues/${number}` })) : [],
  };
  const result = await synchronize(api, config, previous, [], now);
  assert.equal(result.claims[1].login, 'new-name');
  assert.equal(result.claims[1].userId, 7);
  assert.equal(result.claims[2].status, 'rejected');
  tasks[0].assignees = [{ login: 'new-name' }];
  await assert.rejects(synchronize(api, config, previous, [], now), /identity/);
});
