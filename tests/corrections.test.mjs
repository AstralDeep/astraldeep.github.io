// Exercises reviewed award corrections: one-award PR resolutions and unavailable-provider-evidence records, with their refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVIDENCE_UNAVAILABLE, loadCorrections } from '../scripts/corrections.mjs';
import { mergedAward, reconcileAwards } from '../scripts/awards.mjs';
import { synchronize } from '../scripts/sync.mjs';

const committed = JSON.parse(readFileSync('data/config.json', 'utf8'));
const [resolution] = committed.awardResolutions;
const repository = resolution.repository;
const prUrl = `https://github.com/${repository}/pull/${resolution.pr}`;
const owner = { id: resolution.userId, login: 'armstrongsam25', type: 'User' };
const pr = { html_url: prUrl, user: owner, merged_by: owner, created_at: '2026-10-11T14:46:19Z', merged_at: '2026-10-12T04:58:30Z', base: { ref: 'main', repo: { full_name: repository } }, head: { sha: resolution.headSha }, merge_commit_sha: resolution.mergeSha };
const now = '2026-10-12T05:00:00Z';
const numbers = [resolution.award, ...resolution.declined];
const tasks = numbers.map(number => ({ key: `${repository}#${number}`, repository, number, url: `https://github.com/${repository}/issues/${number}`, points: resolution.points, state: 'closed', stateReason: 'completed' }));
const closureFor = number => ({ id: number === resolution.award ? resolution.closureId : `CE_${number}`, createdAt: '2026-10-12T04:58:32Z', closer: { __typename: 'PullRequest', url: prUrl } });
const api = { request: async () => pr, closedBy: async (_repository, number) => closureFor(number), pages: async () => { throw new Error('Unexpected scan'); } };
const withCorrections = (change = {}) => ({ ...committed, awardResolutions: [{ ...resolution, ...change }], unavailableAwardEvidence: [] });

test('the committed corrections name exactly the reviewed records', () => {
  const { resolutions, unavailable } = loadCorrections(committed);
  assert.deepEqual(resolutions.map(item => [item.repository, item.pr, item.award, item.declined]), [['AstralDeep/AstralDeep', 397, 217, [218, 262, 311]]]);
  assert.deepEqual(unavailable.map(item => [item.key, item.userId, item.points]), [['AstralDeep/AstralPrimitives#14', 85252765, 50], ['AstralDeep/AstralPrimitives#8', 85252765, 100]]);
  for (const item of [...resolutions, ...unavailable]) { assert.equal(item.approvedBy, 16158892); assert.match(item.reason, /^Owner decision 2026-10-27: /); }
  assert.ok(unavailable.every(item => item.status === EVIDENCE_UNAVAILABLE));
  assert.deepEqual(loadCorrections({ ...committed, awardResolutions: undefined, unavailableAwardEvidence: undefined }), { resolutions: [], unavailable: [] });
});

test('malformed corrections are refused', () => {
  const [entry] = committed.unavailableAwardEvidence;
  for (const change of [{ extra: 1 }, { repository: 'AstralDeep/Other' }, { pr: 0 }, { award: 1.5 }, { declined: [] }, { declined: [218, 218] }, { declined: [resolution.award] }, { declined: ['218'] }, { points: 7 }, { userId: null }, { mergedBy: 0 }, { headSha: 'abc' }, { mergeSha: 1 }, { closureId: ' ' }, { reason: '' }, { approvedBy: 'owner' }]) {
    assert.throws(() => loadCorrections(withCorrections(change)), /Invalid award resolution/);
  }
  const { reason, ...unsigned } = resolution;
  assert.throws(() => loadCorrections({ ...committed, awardResolutions: [unsigned] }), /Invalid award resolution/);
  for (const bad of [[null], ['text'], [[]], {}, 'text', null]) assert.throws(() => loadCorrections({ ...committed, awardResolutions: bad }), /Invalid award resolution/);
  assert.throws(() => loadCorrections({ ...committed, awardResolutions: [resolution, resolution] }), /Invalid award resolution/);
  for (const change of [{ extra: 1 }, { key: 'nonsense' }, { key: 7 }, { key: 'AstralDeep/Other#1' }, { pr: 'https://github.com/AstralDeep/AstralPrimitives/pull/0' }, { pr: 'https://github.com/AstralDeep/AstralPlane/pull/58' }, { pr: 58 }, { userId: 0 }, { points: 7 }, { status: 'verified' }, { reason: ' ' }, { approvedBy: 0 }]) {
    assert.throws(() => loadCorrections({ ...committed, unavailableAwardEvidence: [{ ...entry, ...change }] }), /Invalid award evidence correction/);
  }
  assert.throws(() => loadCorrections({ ...committed, unavailableAwardEvidence: [entry, entry] }), /Invalid award evidence correction/);
  assert.throws(() => loadCorrections({ ...committed, unavailableAwardEvidence: null }), /Invalid award evidence correction/);
});

test('a PR closing several eligible bounties earns exactly the resolved award and logs the others', async () => {
  const first = await reconcileAwards(api, withCorrections(), tasks, {}, [], now);
  assert.deepEqual(first.awards.map(award => award.issue), [tasks[0].url]);
  assert.equal(first.awards[0].points, resolution.points); assert.equal(first.awards[0].userId, resolution.userId); assert.equal(first.awards[0].closureId, resolution.closureId);
  assert.deepEqual(first.unawarded, tasks.slice(1).map(task => ({ issue: task.url, pr: prUrl, reason: resolution.reason })));
  assert.deepEqual(first.unavailable, []);
  const second = await reconcileAwards(api, withCorrections(), [...tasks].reverse(), {}, first.awards, '2026-10-13T00:00:00Z');
  assert.deepEqual(second.awards, first.awards); assert.deepEqual(second.verified.map(award => award.issue), [tasks[0].url]);
  await assert.rejects(reconcileAwards(api, { ...committed, awardResolutions: [] }, tasks, {}, [], now), /multiple eligible/);
  const live = { ...api, request: async path => path.includes('/pulls/') ? pr : { has_issues: true }, pages: async path => path.startsWith(`/repos/${repository}/`) ? tasks.map(task => ({ number: task.number, title: 'Task', labels: ['bounty', `points:${task.points}`], state: 'closed', state_reason: 'completed' })) : [] };
  const synced = await synchronize(live, withCorrections(), {}, [], now);
  assert.equal(synced.awards.length, 1); assert.equal(synced.unawarded.length, 3); assert.deepEqual(synced.unavailable, []);
  assert.deepEqual(synced.board.tasks.map(task => task.status).sort(), ['closed', 'closed', 'closed', 'completed']);
});

test('the resolution is refused when the recorded identities or evidence differ', async () => {
  for (const change of [{ userId: 1 }, { mergedBy: 2 }, { points: 200 }, { headSha: 'c'.repeat(40) }, { mergeSha: 'c'.repeat(40) }, { closureId: 'CE_changed' }]) {
    await assert.rejects(reconcileAwards(api, withCorrections(change), tasks, {}, [], now), /resolution evidence changed/);
  }
  for (const change of [{ merged_by: null }, { merged_at: null }, { head: { sha: 'd'.repeat(40) } }, { merge_commit_sha: 'd'.repeat(40) }, { user: { ...owner, id: 99 } }, { merged_by: { ...owner, id: 99 } }]) {
    await assert.rejects(reconcileAwards({ ...api, request: async () => ({ ...pr, ...change }) }, withCorrections(), tasks, {}, [], now), /resolution evidence changed/);
  }
  await assert.rejects(reconcileAwards(api, withCorrections(), tasks.slice(1), {}, [mergedAward(tasks[1], pr, closureFor(tasks[1].number), now)], now), /Stored award evidence changed/);
});

test('the resolution does not cover other PRs, other issues, or a PR that no longer closes the bounty', async () => {
  const other = { ...pr, html_url: `https://github.com/${repository}/pull/398` };
  const otherClosure = number => ({ ...closureFor(number), closer: { __typename: 'PullRequest', url: other.html_url } });
  const elsewhere = { request: async () => other, closedBy: async (_repository, number) => otherClosure(number), pages: api.pages };
  await assert.rejects(reconcileAwards(elsewhere, withCorrections(), tasks, {}, [], now), /multiple eligible/);
  const extra = { ...tasks[0], number: 219, key: `${repository}#219`, url: `https://github.com/${repository}/issues/219` };
  await assert.rejects(reconcileAwards(api, withCorrections(), [...tasks, extra], {}, [], now), /multiple eligible/);
  await assert.rejects(reconcileAwards(api, withCorrections(), [extra, ...tasks], {}, [], now), /multiple eligible/);
  const commit = { ...api, closedBy: async (_repository, number) => ({ ...closureFor(number), closer: { __typename: 'Commit', url: prUrl } }) };
  assert.deepEqual((await reconcileAwards(commit, withCorrections(), tasks, {}, [], now)).unawarded, []);
});

const primitives = 'AstralDeep/AstralPrimitives';
const entries = committed.unavailableAwardEvidence;
const taskFor = entry => ({ key: entry.key, repository: primitives, number: Number(entry.key.split('#')[1]), url: `https://github.com/${entry.key.replace('#', '/issues/')}`, points: entry.points, state: 'closed', stateReason: 'completed' });
const recordFor = entry => ({ policy: 'main-merge', issue: taskFor(entry).url, pr: entry.pr, userId: entry.userId, login: 'lamkyo', points: entry.points, baseRef: 'main', submittedAt: '2026-10-01T13:00:00Z', mergedBy: 5678, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), mergedAt: '2026-10-10T14:00:00Z', closureId: `CE_${entry.key}`, closedAt: '2026-10-10T14:00:01Z', awardedAt: '2026-10-10T15:00:00Z' });
const gone = { request: async () => { throw new Error('GitHub GET returned 404'); }, closedBy: async () => ({ id: 'CE_gone', createdAt: now, closer: null }), pages: async () => { throw new Error('Unexpected scan'); } };
const unreachable = { request: async () => { throw new Error('Provider must not be called'); }, closedBy: async () => { throw new Error('Provider must not be called'); }, pages: async () => { throw new Error('Provider must not be called'); } };

test('credited awards whose provider evidence was deleted stay credited without provider calls', async () => {
  const ledger = entries.map(recordFor);
  const bytes = JSON.stringify(ledger);
  await assert.rejects(reconcileAwards(gone, { ...committed, unavailableAwardEvidence: [] }, entries.map(taskFor), {}, ledger, now), /evidence changed/);
  const result = await reconcileAwards(unreachable, committed, entries.map(taskFor), {}, ledger, now);
  assert.equal(JSON.stringify(result.awards), bytes); assert.equal(JSON.stringify(ledger), bytes);
  assert.deepEqual(result.verified.map(award => [award.issue, award.displayLogin, award.points]), ledger.map(award => [award.issue, 'lamkyo', award.points]));
  assert.deepEqual(result.unavailable, entries.map((entry, index) => ({ issue: ledger[index].issue, pr: entry.pr, status: EVIDENCE_UNAVAILABLE, reason: entry.reason })));
  assert.deepEqual(result.unawarded, []);
  const live = { ...unreachable, request: async path => path.includes('/pulls/') ? pr : { has_issues: true }, pages: async path => path.startsWith(`/repos/${primitives}/`) ? entries.map(entry => ({ number: taskFor(entry).number, title: 'Task', labels: ['bounty', `points:${entry.points}`], state: 'closed', state_reason: 'completed' })) : [] };
  const synced = await synchronize(live, committed, {}, ledger, now);
  assert.equal(synced.unavailable.length, 2); assert.equal(synced.board.leaderboard[0].points, 150); assert.equal(synced.board.leaderboard[0].login, 'lamkyo');
});

test('the unavailable-evidence correction is refused when the stored record differs and never covers other records', async () => {
  const [first, second] = entries;
  const changed = [{ userId: 1 }, { pr: second.pr }, { points: 400 }].map(change => ({ ...first, ...change }));
  for (const entry of changed) await assert.rejects(reconcileAwards(unreachable, { ...committed, unavailableAwardEvidence: [entry] }, [taskFor(first)], {}, [recordFor(first)], now), /does not match the stored award/);
  await assert.rejects(reconcileAwards(unreachable, { ...committed, unavailableAwardEvidence: [first] }, [taskFor(first)], {}, [{ ...recordFor(first), pr: second.pr }], now), /does not match the stored award/);
  const other = { ...recordFor(second), issue: `https://github.com/${primitives}/issues/9`, pr: `https://github.com/${primitives}/pull/29`, closureId: 'CE_9' };
  const otherTask = { ...taskFor(second), key: `${primitives}#9`, number: 9, url: other.issue };
  await assert.rejects(reconcileAwards(gone, { ...committed, unavailableAwardEvidence: [first] }, [taskFor(first), otherTask], {}, [recordFor(first), other], now), /GitHub GET returned 404|evidence changed/);
  const partial = await reconcileAwards({ ...gone, request: async () => { throw new Error('Provider unavailable'); } }, { ...committed, unavailableAwardEvidence: [first] }, [taskFor(first)], {}, [recordFor(first)], now);
  assert.deepEqual(partial.unavailable.map(item => item.issue), [taskFor(first).url]);
  await assert.rejects(reconcileAwards(gone, { ...committed, unavailableAwardEvidence: [first] }, [taskFor(second)], {}, [recordFor(second)], now), /evidence changed/);
});
