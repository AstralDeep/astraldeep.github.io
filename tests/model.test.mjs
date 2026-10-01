// Exercises bounty admission, reservation conflicts, lifecycle transitions, and evidence-bound point awards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskKey, parseTask, taskFromIssue, claimTarget, reconcileClaims, validateAwards, verifyAwardEvidence, summarize } from '../scripts/model.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const now = '2026-10-01T00:00:00.000Z';
const repository = 'AstralDeep/LETS';
const url = `https://github.com/${repository}/issues/1`;
const issue = (number = 1, changes = {}) => ({ number, title: '<script>test</script>', labels: [{ name: 'bounty' }, { name: 'points:100' }, { name: 'track:security' }, { name: 'priority:P1' }], assignees: [], state: 'open', ...changes });
const task = (number = 1, changes = {}) => taskFromIssue(repository, issue(number, changes), config);
const request = (number = 10, login = 'alice', changes = {}) => ({ number, labels: [{ name: 'claim-request' }], state: 'open', body: `### Task\n\n${url}\n\n### Contribution agreement\n\n- [x] Yes`, user: { login, type: 'User' }, ...changes });
const reconcile = (previous = {}, requests = [request()], tasks = [task()], time = now) => reconcileClaims(previous, requests, tasks, config, time);
const award = { issue: url, pr: `https://github.com/${repository}/pull/2`, login: 'alice', points: 100, review: 3, awardedAt: now };
const pr = { html_url: award.pr, merged_at: now, user: { login: 'alice' }, head: { sha: 'abc' } };
const review = { id: 3, state: 'APPROVED', user: { login: 'maintainer' }, submitted_at: now, commit_id: 'abc' };

test('task identities only admit exact public allowlisted issue URLs', () => {
  assert.equal(taskKey(repository, 1), `${repository}#1`);
  assert.equal(parseTask(url, config).number, 1);
  for (const bad of [url + '?x=1', url + '/x', url.replace('github.com', 'github.com.evil'), url.replace('/1', '/0'), url.replace('/1', '/9007199254740992'), url.replace('/LETS/', '/private/'), 'javascript:alert(1)']) assert.equal(parseTask(bad, config), null);
  assert.equal(claimTarget('bad', config), null);
  assert.equal(claimTarget(`### Task\n${url}\n### Task\n${url}`, config), null);
  assert.equal(claimTarget(request().body, config).key, task().key);
});

test('task extraction rejects PRs and missing labels, fails closed for ambiguous points', () => {
  assert.equal(taskFromIssue(repository, issue(1, { pull_request: {} }), config), null);
  assert.equal(taskFromIssue(repository, issue(1, { labels: [] }), config), null);
  for (const labels of [['bounty'], ['bounty', 'points:999'], ['bounty', 'points:100', 'points:25']]) assert.throws(() => taskFromIssue(repository, issue(1, { labels }), config), /points/);
  assert.equal(task().priority, 'P1');
  assert.deepEqual(task().tracks, ['security']);
  assert.equal(task(1, { labels: ['bounty', 'points:25'], assignees: [{ login: 'alice' }] }).priority, 'P3');
});

test('claims serialize by issue number and enforce exclusive task and person ownership', () => {
  const claims = reconcile({}, [request(11, 'bob'), request(10)]);
  assert.equal(claims[10].status, 'active');
  assert.match(claims[11].reason, /already/);
  const duplicateUser = request(12, 'ALICE', { body: `### Task\n${url.replace('/1', '/2')}` });
  assert.match(reconcile(claims, [request(), duplicateUser], [task(), task(2)])[12].reason, /existing/);
  assert.match(reconcile({}, [request()], [task(), task(2, { assignees: [{ login: 'Alice' }] })])[10].reason, /existing/);
  assert.match(reconcile({}, [request()], [task(1, { assignees: [{ login: 'bob' }] })])[10].reason, /another/);
  assert.equal(reconcile({}, [request()], [task(1, { assignees: [{ login: 'alice' }] })])[10].status, 'active');
});

test('unapproved tasks, malformed requests, PRs and bot claims cannot reserve work', () => {
  assert.equal(reconcile({}, [request(1, 'bot', { user: { login: 'bot', type: 'Bot' } })])[1].status, 'rejected');
  assert.equal(reconcile({}, [request(2, 'alice', { body: '' })])[2].status, 'rejected');
  assert.equal(reconcile({}, [request()], [task(1, { state: 'closed' })])[10].status, 'rejected');
  assert.deepEqual(reconcile({}, [request(1, 'alice', { pull_request: {} }), request(2, 'alice', { labels: [] }), request(3, 'alice', { state: 'closed' })]), {});
  assert.throws(() => reconcile({}, [], [], 'not-a-time'), /time/);
});

test('expiry and release are terminal; edits and reopen never hijack a frozen claim', () => {
  const first = reconcile();
  assert.deepEqual(reconcile(first, [request(10, 'mallory', { body: 'bad' })]), first);
  assert.equal(reconcile(first, [request(10, 'alice', { state: 'closed' })])[10].status, 'released');
  assert.equal(reconcile(first, [request(10, 'alice', { everClosed: true })])[10].status, 'released');
  assert.match(reconcile({}, [request(10, 'alice', { everClosed: true })])[10].reason, /cannot be reused/);
  assert.equal(reconcile(first, [])[10].status, 'released');
  assert.equal(reconcile(first, [request()], [], now)[10].status, 'finished');
  assert.equal(reconcile(first, [request()], [task(1, { state: 'closed' })])[10].status, 'finished');
  assert.equal(reconcile(first, [request()], [task(1, { assignees: [{ login: 'bob' }] })])[10].status, 'superseded');
  const expired = reconcile(first, [request()], [task()], '2026-10-08T00:00:00.000Z');
  assert.equal(expired[10].status, 'expired');
  assert.equal(reconcile(expired)[10].status, 'expired');
  assert.equal(first[10].status, 'active');
});

test('award ledger rejects duplicates, uncompleted tasks, wrong points, identities and URLs', () => {
  const complete = task(1, { state: 'closed', state_reason: 'completed' });
  validateAwards([award], [complete], config);
  assert.throws(() => validateAwards([award], [task()], config), /completed/);
  assert.throws(() => validateAwards([award], [task(1, { state: 'closed', state_reason: 'not_planned' })], config), /completed/);
  assert.throws(() => validateAwards([award, award], [complete], config), /Duplicate/);
  const second = task(2, { state: 'closed', state_reason: 'completed' });
  assert.throws(() => validateAwards([award, { ...award, issue: second.url }], [complete, second], config), /PR can/);
  for (const change of [{ points: 25 }, { points: -1 }, { login: 'a/b' }, { review: 0 }, { review: 1.5 }, { pr: 'https://evil.test/pull/2' }, { awardedAt: 'bad' }]) assert.throws(() => validateAwards([{ ...award, ...change }], [complete], config));
});

test('award evidence binds contributor, approved exact head, configured reviewer and merge time', () => {
  verifyAwardEvidence(award, pr, review, ['maintainer']);
  for (const change of [{ merged_at: null }, { html_url: 'https://evil.test' }, { user: { login: 'bob' } }]) assert.throws(() => verifyAwardEvidence(award, { ...pr, ...change }, review, ['maintainer']));
  for (const change of [{ id: 4 }, { state: 'DISMISSED' }, { user: { login: 'alice' } }, { user: { login: 'outsider' } }, { submitted_at: '2026-10-02T00:00:00Z' }, { commit_id: 'old' }]) assert.throws(() => verifyAwardEvidence(award, pr, { ...review, ...change }, ['maintainer']));
  assert.throws(() => verifyAwardEvidence({ ...award, awardedAt: '2026-09-01T00:00:00Z' }, pr, review, ['maintainer']));
});

test('leaderboard uses only accepted awards, stable ties and case-insensitive identities', () => {
  const first = reconcile();
  const board = summarize([task(), task(2), task(3, { state: 'closed' }), task(4, { assignees: [{ login: 'bob' }] })], first, [], now);
  assert.deepEqual(board.tasks.map(item => item.status), ['claimed', 'available', 'closed', 'claimed']);
  assert.deepEqual(board.leaderboard, []);
  const awards = [award, { ...award, login: 'ALICE', points: 25 }, { ...award, login: 'bob', points: 125 }, { ...award, login: 'carol', points: 50 }];
  const ranked = summarize([task()], first, awards, now);
  assert.equal(ranked.tasks[0].status, 'completed');
  assert.deepEqual(ranked.leaderboard.map(person => person.rank), [1, 1, 3]);
  assert.equal(ranked.leaderboard[0].completed, 2);
  assert.equal(summarize([task()], first, [], '2026-11-01T00:00:00Z').tasks[0].claim, null);
  assert.equal(summarize([], {}, [{ ...award, login: 'z' }, { ...award, login: 'a' }], now).leaderboard[0].login, 'a');
});
