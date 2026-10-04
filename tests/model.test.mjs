// Exercises public task admission and preserved historical award identity and review evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountId, taskKey, parseTask, taskFromIssue, validateAwards, verifyAwardEvidence, summarize } from '../scripts/model.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const now = '2026-10-01T00:00:00.000Z';
const repository = 'AstralDeep/LETS';
const url = `https://github.com/${repository}/issues/1`;
const user = (login, id = { alice: 1, bob: 2 }[login]) => ({ id, login, type: 'User' });
const issue = (number = 1, changes = {}) => ({ number, title: '<script>test</script>', labels: [{ name: 'bounty' }, { name: 'points:100' }, { name: 'track:security' }, { name: 'priority:P1' }], state: 'open', ...changes });
const task = (number = 1, changes = {}) => taskFromIssue(repository, issue(number, changes), config);
const award = { issue: url, pr: `https://github.com/${repository}/pull/2`, login: 'alice', userId: 1, points: 100, review: 3, awardedAt: now };
const pr = { html_url: award.pr, merged_at: now, base: { ref: 'main', repo: { full_name: repository } }, user: user('alice'), head: { sha: 'abc' } };
const review = { id: 3, state: 'APPROVED', user: user('maintainer', 9), submitted_at: now, commit_id: 'abc', body: `Bounty-issue: ${url}` };

test('task identities admit exact allowlisted issue URLs only', () => {
  assert.equal(taskKey(repository, 1), `${repository}#1`);
  assert.equal(parseTask(url, config).number, 1);
  for (const bad of [url + '?x=1', url + '/x', url.replace('github.com', 'github.com.evil'), url.replace('/1', '/0'), url.replace('/1', '/9007199254740992'), url.replace('/LETS/', '/private/'), 'javascript:alert(1)']) assert.equal(parseTask(bad, config), null);
});

test('task extraction rejects PRs, missing bounty labels, and ambiguous points', () => {
  assert.equal(taskFromIssue(repository, issue(1, { pull_request: {} }), config), null);
  assert.equal(taskFromIssue(repository, issue(1, { labels: [] }), config), null);
  for (const labels of [['bounty'], ['bounty', 'points:999'], ['bounty', 'points:100', 'points:25']]) assert.throws(() => taskFromIssue(repository, issue(1, { labels }), config), /points/);
  assert.equal(task().priority, 'P1'); assert.deepEqual(task().tracks, ['security']);
  assert.equal(task(1, { labels: ['bounty', 'points:25'] }).priority, 'P3');
  assert.equal('assignees' in task(1, { assignees: [user('bob')] }), false);
});

test('numeric contributor identities reject missing, unsafe, and malformed account values', () => {
  for (const value of [null, {}, user('alice', 0), user('alice', -1), user('alice', 1.5), user('alice', '1'), user('alice', Number.MAX_SAFE_INTEGER + 1), user('a/b', 1), { id: 1, login: null }]) assert.throws(() => accountId(value), /identity/);
  assert.equal(accountId(user('assistant[bot]', 20)), 20);
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
  for (const userId of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateAwards([{ ...award, userId }], [complete], config), /identity/);
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


test('leaderboard ranks stable account IDs and open tasks ignore existing source assignments', () => {
  const board = summarize([task(), task(2), task(3, { state: 'closed' }), task(4, { assignees: [user('bob')] })], [], now);
  assert.deepEqual(board.tasks.map(item => item.status), ['available', 'available', 'closed', 'available']);
  assert.equal('claims' in board, false); assert.deepEqual(board.leaderboard, []);
  const awards = [{ ...award, displayLogin: 'new-alice' }, { ...award, displayLogin: 'new-alice', points: 25 }, { ...award, userId: 2, displayLogin: 'bob', points: 125 }, { ...award, userId: 3, displayLogin: 'carol', points: 50 }];
  const ranked = summarize([task()], awards, now);
  assert.equal(ranked.tasks[0].status, 'completed');
  assert.deepEqual(ranked.leaderboard.map(person => person.rank), [1, 1, 3]);
  assert.equal(ranked.leaderboard[0].completed, 2); assert.equal(ranked.leaderboard[0].userId, 1); assert.equal(ranked.leaderboard[0].login, 'new-alice');
  assert.equal(summarize([], [{ ...award, userId: 1, displayLogin: 'z' }, { ...award, userId: 2, displayLogin: 'a' }], now).leaderboard[0].login, 'a');
  const reused = summarize([], [{ ...award, displayLogin: 'renamed-alice' }, { ...award, userId: 8, displayLogin: 'alice' }], now);
  assert.equal(reused.leaderboard.length, 2);
  assert.throws(() => summarize([], [award], now), /identity/);
});
