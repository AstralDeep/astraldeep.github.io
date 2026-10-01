// Exercises bounty admission, reservation conflicts, lifecycle transitions, and evidence-bound point awards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskKey, parseTask, taskFromIssue, claimTarget, reconcileClaims, validateAwards, verifyAwardEvidence, summarize } from '../scripts/model.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const now = '2026-10-01T00:00:00.000Z';
const repository = 'AstralDeep/LETS';
const url = `https://github.com/${repository}/issues/1`;
const user = (login, id = { alice: 1, bob: 2, mallory: 3, bot: 4 }[login.toLowerCase()]) => ({ id, login, type: 'User' });
const issue = (number = 1, changes = {}) => ({ number, title: '<script>test</script>', labels: [{ name: 'bounty' }, { name: 'points:100' }, { name: 'track:security' }, { name: 'priority:P1' }], assignees: [], state: 'open', ...changes });
const task = (number = 1, changes = {}) => taskFromIssue(repository, issue(number, changes), config);
const request = (number = 10, login = 'alice', changes = {}) => ({ number, labels: [{ name: 'claim-request' }], state: 'open', body: `### Task\n\n${url}\n\n### Contribution agreement\n\n- [x] Yes`, user: user(login), ...changes });
const reconcile = (previous = {}, requests = [request()], tasks = [task()], time = now) => reconcileClaims(previous, requests, tasks, config, time);
const award = { issue: url, pr: `https://github.com/${repository}/pull/2`, login: 'alice', userId: 1, points: 100, review: 3, awardedAt: now };
const pr = { html_url: award.pr, merged_at: now, user: user('alice'), head: { sha: 'abc' } };
const review = { id: 3, state: 'APPROVED', user: user('maintainer', 9), submitted_at: now, commit_id: 'abc', body: `Bounty-issue: ${url}` };

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
  assert.equal(task(1, { labels: ['bounty', 'points:25'], assignees: [user('alice')] }).priority, 'P3');
  assert.deepEqual(task(1, { assignees: [user('alice')] }).assigneeIds, [1]);
});

test('claims serialize by issue number and enforce exclusive task and person ownership', () => {
  const claims = reconcile({}, [request(11, 'bob'), request(10)]);
  assert.equal(claims[10].status, 'active');
  assert.match(claims[11].reason, /already/);
  const duplicateUser = request(12, 'ALICE', { body: `### Task\n${url.replace('/1', '/2')}` });
  assert.match(reconcile(claims, [request(), duplicateUser], [task(), task(2)])[12].reason, /existing/);
  assert.match(reconcile({}, [request()], [task(), task(2, { assignees: [user('Alice')] })])[10].reason, /existing/);
  assert.match(reconcile({}, [request()], [task(1, { assignees: [user('bob')] })])[10].reason, /another/);
  assert.equal(reconcile({}, [request()], [task(1, { assignees: [user('alice')] })])[10].status, 'active');
});

test('unapproved tasks, malformed requests, PRs and bot claims cannot reserve work', () => {
  assert.equal(reconcile({}, [request(1, 'bot', { user: { ...user('bot'), type: 'Bot' } })])[1].status, 'rejected');
  assert.equal(reconcile({}, [request(2, 'alice', { body: '' })])[2].status, 'rejected');
  assert.equal(reconcile({}, [request()], [task(1, { state: 'closed' })])[10].status, 'rejected');
  assert.deepEqual(reconcile({}, [request(1, 'alice', { pull_request: {} }), request(2, 'alice', { labels: [] }), request(3, 'alice', { state: 'closed' })]), {});
  assert.throws(() => reconcile({}, [], [], 'not-a-time'), /time/);
});

test('expiry and release are terminal; edits and reopen never hijack a frozen claim', () => {
  const first = reconcile();
  assert.deepEqual(reconcile(first, [request(10, 'alice', { body: 'bad' })]), first);
  assert.equal(reconcile(first, [request(10, 'alice', { state: 'closed' })])[10].status, 'released');
  assert.equal(reconcile(first, [request(10, 'alice', { everClosed: true })])[10].status, 'released');
  assert.match(reconcile({}, [request(10, 'alice', { everClosed: true })])[10].reason, /cannot be reused/);
  assert.equal(reconcile(first, [])[10].status, 'released');
  assert.equal(reconcile(first, [request()], [], now)[10].status, 'finished');
  assert.equal(reconcile(first, [request()], [task(1, { state: 'closed' })])[10].status, 'finished');
  assert.equal(reconcile(first, [request()], [task(1, { assignees: [user('bob')] })])[10].status, 'superseded');
  const expired = reconcile(first, [request()], [task()], '2026-10-08T00:00:00.000Z');
  assert.equal(expired[10].status, 'expired');
  assert.equal(reconcile(expired)[10].status, 'expired');
  assert.equal(first[10].status, 'active');
});

test('stable account IDs preserve exclusivity and display identity across renames', () => {
  const first = reconcile();
  const renamed = request(10, 'new-name', { user: user('new-name', 1) });
  const second = request(11, 'new-name', { user: user('new-name', 1), body: `### Task\n${url.replace('/1', '/2')}` });
  const next = reconcile(first, [renamed, second], [task(), task(2)]);
  assert.equal(next[10].userId, 1);
  assert.equal(next[10].login, 'new-name');
  assert.equal(next[10].key, first[10].key);
  assert.equal(next[11].status, 'rejected');
  assert.match(next[11].reason, /existing/);
  assert.equal(first[10].login, 'alice');
  const reusedLogin = request(12, 'alice', { user: user('alice', 8), body: second.body });
  assert.equal(reconcile(first, [renamed, reusedLogin], [task(), task(2)])[12].status, 'active');
  const terminal = reconcile(first, [request(10, 'alice', { state: 'closed' })]);
  const refreshed = reconcile(terminal, [{ ...renamed, state: 'closed' }]);
  assert.equal(refreshed[10].status, 'released');
  assert.equal(refreshed[10].login, 'new-name');
  assert.throws(() => reconcile(first, [request(10, 'mallory')]), /owner does not match/);
});

test('source assignments compare immutable account IDs rather than reused logins', () => {
  const renamed = request(10, 'new-name', { user: user('new-name', 1) });
  assert.equal(reconcile({}, [renamed], [task(1, { assignees: [user('alice')] })])[10].status, 'active');
  assert.match(reconcile({}, [renamed], [task(), task(2, { assignees: [user('alice')] })])[10].reason, /existing/);
  assert.match(reconcile({}, [request()], [task(1, { assignees: [user('alice', 8)] })])[10].reason, /another/);
  const first = reconcile();
  assert.equal(reconcile(first, [renamed], [task(1, { assignees: [user('alice')] })])[10].status, 'active');
  assert.equal(reconcile(first, [request()], [task(1, { assignees: [user('alice', 8)] })])[10].status, 'superseded');
});

test('invalid or missing account identities fail reconciliation closed', () => {
  for (const account of [null, {}, { ...user('alice'), id: undefined }, user('alice', 0), user('alice', -1), user('alice', 1.5), user('alice', '1'), user('alice', Number.MAX_SAFE_INTEGER + 1), { ...user('alice'), login: null }, user('a/b', 1)]) {
    assert.throws(() => reconcile({}, [request(10, 'alice', { user: account })]), /identity/);
    assert.throws(() => task(1, { assignees: [account] }));
  }
  assert.throws(() => reconcile({ 10: { ...reconcile()[10], userId: undefined } }), /identity/);
  assert.equal(task(1, { assignees: [{ id: 20, login: 'assistant[bot]', type: 'Bot' }] }).assigneeIds[0], 20);
});

test('award ledger rejects duplicates, uncompleted tasks, wrong points, identities and URLs', () => {
  const complete = task(1, { state: 'closed', state_reason: 'completed' });
  validateAwards([award], [complete], config);
  assert.throws(() => validateAwards([award], [task()], config), /completed/);
  assert.throws(() => validateAwards([award], [task(1, { state: 'closed', state_reason: 'not_planned' })], config), /completed/);
  assert.throws(() => validateAwards([award, award], [complete], config), /Duplicate/);
  const second = task(2, { state: 'closed', state_reason: 'completed' });
  assert.throws(() => validateAwards([award, { ...award, issue: second.url }], [complete, second], config), /PR can/);
  for (const change of [{ points: 25 }, { points: -1 }, { login: 'a/b' }, { login: 'assistant[bot]' }, { review: 0 }, { review: 1.5 }, { pr: 'https://evil.test/pull/2' }, { awardedAt: 'bad' }]) assert.throws(() => validateAwards([{ ...award, ...change }], [complete], config));
  for (const userId of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateAwards([{ ...award, userId }], [complete], config), /identity/);
  for (const approver of ['maintainer', { login: 'maintainer' }, { id: 0, login: 'maintainer' }]) assert.throws(() => validateAwards([], [], { ...config, awardApprovers: [approver] }), /identity/);
});

test('award evidence binds contributor, approved exact head, configured reviewer and merge time', () => {
  verifyAwardEvidence(award, pr, review, [user('maintainer', 9)]);
  for (const change of [{ merged_at: null }, { html_url: 'https://evil.test' }, { user: user('bob') }]) assert.throws(() => verifyAwardEvidence(award, { ...pr, ...change }, review, [user('maintainer', 9)]));
  for (const change of [{ id: 4 }, { state: 'DISMISSED' }, { user: user('alice') }, { user: user('outsider', 10) }, { submitted_at: '2026-10-02T00:00:00Z' }, { commit_id: 'old' }]) assert.throws(() => verifyAwardEvidence(award, pr, { ...review, ...change }, [user('maintainer', 9)]));
  assert.throws(() => verifyAwardEvidence({ ...award, awardedAt: '2026-09-01T00:00:00Z' }, pr, review, [user('maintainer', 9)]));
});

test('award review requires exactly one unambiguous own-line bounty attestation', () => {
  for (const body of [review.body, `Accepted implementation.\n\n${review.body}\nAll checks passed.`, `Accepted.\r\n${review.body}\r\n`]) verifyAwardEvidence(award, pr, { ...review, body }, [user('maintainer', 9)]);
  for (const body of [undefined, null, 7, '', url, `Closes ${url}`, `See ${review.body}`, `> ${review.body}`, ` ${review.body}`, `${review.body} `, `${review.body}/extra`, `${review.body}?x=1`, review.body.replace('/issues/1', '/issues/2'), `bounty-issue: ${url}`, `Bounty-issue:${url}`, `${review.body}\n${review.body}`, `${review.body}\nBounty-issue: https://github.com/AstralDeep/LETS/issues/2`, `${review.body}\n  bounty-issue : ${url}`]) {
    assert.throws(() => verifyAwardEvidence(award, pr, { ...review, body }, [user('maintainer', 9)]), /attestation/);
  }
});

test('award author and reviewer identity follow account IDs through renames', () => {
  const original = structuredClone(award);
  const renamedPR = { ...pr, user: user('new-alice', 1) };
  const renamedReview = { ...review, user: user('new-maintainer', 9) };
  const verified = verifyAwardEvidence(award, renamedPR, renamedReview, [user('maintainer', 9)]);
  assert.equal(verified.userId, 1);
  assert.equal(verified.login, 'alice');
  assert.equal(verified.displayLogin, 'new-alice');
  assert.deepEqual(award, original);
  assert.equal(verifyAwardEvidence({ ...award, displayLogin: 'forged' }, renamedPR, renamedReview, [user('maintainer', 9)]).displayLogin, 'new-alice');
  assert.throws(() => verifyAwardEvidence(award, { ...pr, user: user('alice', 8) }, review, [user('maintainer', 9)]), /credited contributor/);
  assert.throws(() => verifyAwardEvidence(award, pr, { ...review, user: user('maintainer', 8) }, [user('maintainer', 9)]), /configured/);
  assert.throws(() => verifyAwardEvidence(award, renamedPR, { ...review, user: user('old-alice', 1) }, [user('old-alice', 1)]), /independent/);
  for (const invalid of [null, { login: 'alice' }, user('alice', '1')]) {
    assert.throws(() => verifyAwardEvidence(award, { ...pr, user: invalid }, review, [user('maintainer', 9)]), /identity/);
    assert.throws(() => verifyAwardEvidence(award, pr, { ...review, user: invalid }, [user('maintainer', 9)]), /identity/);
  }
  assert.throws(() => verifyAwardEvidence(award, pr, review, [{ login: 'maintainer' }]), /identity/);
});

test('leaderboard groups verified stable account IDs with current display logins and stable ties', () => {
  const first = reconcile();
  const board = summarize([task(), task(2), task(3, { state: 'closed' }), task(4, { assignees: [user('bob')] })], first, [], now);
  assert.deepEqual(board.tasks.map(item => item.status), ['claimed', 'available', 'closed', 'claimed']);
  assert.deepEqual(board.leaderboard, []);
  const awards = [{ ...award, displayLogin: 'new-alice' }, { ...award, login: 'ALICE', displayLogin: 'new-alice', points: 25 }, { ...award, userId: 2, login: 'bob', displayLogin: 'bob', points: 125 }, { ...award, userId: 3, login: 'carol', displayLogin: 'carol', points: 50 }];
  const ranked = summarize([task()], first, awards, now);
  assert.equal(ranked.tasks[0].status, 'completed');
  assert.deepEqual(ranked.leaderboard.map(person => person.rank), [1, 1, 3]);
  assert.equal(ranked.leaderboard[0].completed, 2);
  assert.equal(ranked.leaderboard[0].userId, 1);
  assert.equal(ranked.leaderboard[0].login, 'new-alice');
  assert.equal(summarize([task()], first, [], '2026-11-01T00:00:00Z').tasks[0].claim, null);
  assert.equal(summarize([], {}, [{ ...award, userId: 1, displayLogin: 'z' }, { ...award, userId: 2, displayLogin: 'a' }], now).leaderboard[0].login, 'a');
  const reused = summarize([], {}, [{ ...award, displayLogin: 'renamed-alice' }, { ...award, userId: 8, displayLogin: 'alice' }], now);
  assert.equal(reused.leaderboard.length, 2);
  assert.deepEqual(reused.leaderboard.map(person => person.userId).sort((a, b) => a - b), [1, 8]);
  assert.throws(() => summarize([], {}, [award], now), /identity/);
});
