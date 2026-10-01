// Verifies source-command ingestion and global reservation decisions without live API writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceRequests } from '../scripts/source-claims.mjs';
import { reconcileClaims, summarize } from '../scripts/model.mjs';
import { synchronize } from '../scripts/sync.mjs';
import p from '../actions/claim-reply/protocol.cjs';
const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const now = '2026-10-02T00:00:00.000Z';
const enabledAt = '2026-10-01T00:00:00.000Z';
const repository = 'AstralDeep/LETS';
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const user = id => ({ id, node_id: `U${id}`, login: `user-${id}`, type: 'User' });
const task = (number = 71, repo = repository) => ({ key: `${repo}#${number}`, repository: repo, number, title: 'Task', url: `https://github.com/${repo}/issues/${number}`, state: 'open', assigneeIds: [], assignees: [], points: 25 });
function request(comment = 100, userId = 7, action = 'claim', target = task()) {
  return { id: p.sourceId(target.repository, comment), number: comment, state: 'open', labels: ['claim-request'], user: user(userId), created_at: now, target,
    source: { repository: target.repository, issue: target.number, comment, receipt: comment + 1000, command: action, commandAt: now } };
}
function fixture() {
  const original = { id: 100, user: user(7), body: '/claim', created_at: now, updated_at: now };
  const reply = { id: 1100, user: bot, body: `${p.marker(100, 7, 'claim')}\nQueued`, created_at: now };
  const state = { comments: [original, reply], events: [] };
  const api = { pages: async path => path.endsWith('/events') ? state.events : state.comments };
  return { state, api, original, reply };
}

test('a trusted source receipt becomes a reservation with frozen numeric and node identities', async () => {
  const f = fixture(); const tasks = [task()];
  const requests = await sourceRequests(f.api, tasks, {}, enabledAt);
  const claims = reconcileClaims({}, requests, tasks, config, now);
  const claim = claims[request().id];
  assert.equal(claim.status, 'active'); assert.equal(claim.userId, 7); assert.equal(claim.userNodeId, 'U7');
  assert.equal(claim.source.comment, 100); assert.equal(claim.source.receipt, 1100);
  assert.equal(claim.expiresAt, '2026-10-09T00:00:00.000Z');
  assert.equal(summarize(tasks, claims, [], now).tasks[0].managedAssignments, undefined);
});

test('concurrent commands across repositories have one task and one contributor winner', () => {
  const first = task(); const second = task(20, 'AstralDeep/AstralPlane');
  const a = request(100, 7, 'claim', first); const b = request(101, 8, 'claim', first); const c = request(102, 7, 'claim', second);
  const claims = reconcileClaims({}, [c, b, a], [first, second], config, now);
  assert.equal(claims[a.id].status, 'active'); assert.equal(claims[b.id].status, 'rejected'); assert.equal(claims[c.id].status, 'rejected');
  assert.match(claims[c.id].reason, /existing bounty/);
  c.created_at = '2026-10-01T23:59:59Z';
  const reordered = reconcileClaims({}, [a, c], [first, second], config, now);
  assert.equal(reordered[c.id].status, 'active'); assert.equal(reordered[a.id].status, 'rejected');
});

test('repeated claims reference the original and edits or deletion cannot extend or retarget it', () => {
  const a = request(); const tasks = [task(), task(72)];
  const previous = reconcileClaims({}, [a], tasks, config, now);
  const duplicate = request(101); const changed = { ...a, target: tasks[1], changedCommand: true };
  const later = '2026-10-03T00:00:00Z';
  const claims = reconcileClaims(previous, [changed, duplicate], tasks, config, later);
  assert.equal(claims[duplicate.id].status, 'duplicate'); assert.equal(claims[duplicate.id].reservation, a.id);
  assert.equal(claims[a.id].key, task().key); assert.equal(claims[a.id].expiresAt, previous[a.id].expiresAt);
  assert.equal(reconcileClaims(previous, [], tasks, config, later)[a.id].status, 'active');
  assert.equal(reconcileClaims(previous, [], [], config, later)[a.id].status, 'finished');
});

test('only a new unclaim by the reservation owner releases it, with history retained', () => {
  const a = request(); const tasks = [task(), task(72)]; const previous = reconcileClaims({}, [a], tasks, config, now);
  const stranger = request(101, 8, 'unclaim'); const owner = request(102, 7, 'unclaim'); const next = request(103, 7, 'claim', tasks[1]);
  const claims = reconcileClaims(previous, [next, owner, stranger], tasks, config, now);
  assert.equal(claims[stranger.id].status, 'rejected'); assert.equal(claims[owner.id].status, 'released');
  assert.equal(claims[a.id].status, 'released'); assert.equal(claims[a.id].releasedBy, owner.id);
  assert.equal(claims[next.id].status, 'active'); assert.equal(previous[a.id].status, 'active');
  const edited = reconcileClaims(previous, [{ ...owner, changedCommand: true }], tasks, config, now);
  assert.equal(edited[owner.id].status, 'rejected'); assert.equal(edited[a.id].status, 'active');
});

test('a delayed duplicate cannot renew an expired lease but a new post-expiry claim can', () => {
  const first = request(); const tasks = [task()];
  const previous = reconcileClaims({}, [first], tasks, config, now);
  const delayed = request(101);
  delayed.created_at = delayed.source.commandAt = '2026-10-08T23:59:00Z';
  const result = reconcileClaims(previous, [delayed], tasks, config, '2026-10-09T00:01:00Z');
  assert.equal(result[first.id].status, 'expired');
  assert.equal(result[delayed.id].status, 'duplicate');
  assert.equal(result[delayed.id].reservation, first.id);
  const fresh = request(102);
  fresh.created_at = fresh.source.commandAt = '2026-10-09T00:02:00Z';
  assert.equal(reconcileClaims(result, [fresh], tasks, config, '2026-10-09T00:03:00Z')[fresh.id].status, 'active');
  const release = request(103, 7, 'unclaim');
  release.created_at = release.source.commandAt = '2026-10-03T00:00:00Z';
  const released = reconcileClaims(previous, [release], tasks, config, '2026-10-03T00:01:00Z');
  const again = request(104);
  again.created_at = again.source.commandAt = '2026-10-03T00:00:30Z';
  assert.equal(reconcileClaims(released, [again], tasks, config, '2026-10-03T00:02:00Z')[again.id].status, 'active');
});

test('a later unclaim cancels a skipped or late-discovered earlier claim', async () => {
  const f = fixture();
  const later = { ...f.original, id: 101, body: '/unclaim', updated_at: '2026-10-02T00:00:01Z' };
  f.state.comments = [later];
  const released = reconcileClaims({}, await sourceRequests(f.api, [task()], {}, enabledAt), [task()], config, now);
  f.state.comments = [f.original, later];
  const result = reconcileClaims(released, await sourceRequests(f.api, [task()], released, enabledAt), [task()], config, now);
  assert.equal(result[request().id].status, 'released');
  assert.equal(Object.values(result).filter(claim => claim.status === 'active').length, 0);
  const together = reconcileClaims({}, await sourceRequests(f.api, [task()], {}, enabledAt), [task()], config, now);
  assert.equal(together[request().id].status, 'released');
});

test('rejected edited unclaim commands do not cancel legitimate work', () => {
  const release = request(101, 7, 'unclaim'); release.changedCommand = true;
  const previous = reconcileClaims({}, [release], [task()], config, now);
  assert.equal(previous[release.id].cancellationValid, false);
  const a = request(); assert.equal(reconcileClaims(previous, [a], [task()], config, now)[a.id].status, 'active');
});

test('editing explanatory text cannot reorder a receipted claim after a later unclaim', async () => {
  const f = fixture(); f.reply.body += `\n<!-- astral-command-time:${now} -->`;
  f.original.updated_at = '2026-10-02T00:00:03Z';
  f.state.comments.push({ ...f.original, id: 101, body: '/unclaim', updated_at: '2026-10-02T00:00:02Z' });
  const commands = await sourceRequests(f.api, [task()], {}, enabledAt);
  assert.equal(commands.find(item => item.id === request().id).source.commandAt, now);
  assert.equal(reconcileClaims({}, commands, [task()], config, now)[request().id].status, 'released');
});

test('expired managed assignments delay replacement instead of permanently rejecting it', () => {
  const a = request(); const oldTask = task(); const tasks = [oldTask, task(72)];
  const previous = reconcileClaims({}, [a], tasks, config, now);
  oldTask.assigneeIds = [7]; oldTask.assignees = ['user-7']; oldTask.managedAssignments = [{ id: a.id, userId: 7 }];
  const replacement = request(101, 8); const other = request(102, 7, 'claim', tasks[1]);
  const later = '2026-10-10T00:00:00Z';
  const waiting = reconcileClaims(previous, [replacement, other], tasks, config, later);
  assert.equal(waiting[a.id].status, 'expired'); assert.equal(waiting[replacement.id], undefined); assert.equal(waiting[other.id], undefined);
  oldTask.assigneeIds = []; oldTask.assignees = []; oldTask.managedAssignments = [];
  const cleared = reconcileClaims(waiting, [replacement, other], tasks, config, later);
  assert.equal(cleared[replacement.id].status, 'active'); assert.equal(cleared[other.id].status, 'active');
});

test('legacy requests retain issue-number identity and coexist with source commands', () => {
  const legacy = { id: 987654321, number: 2, state: 'open', labels: ['claim-request'], user: user(7), body: `### Task\n${task().url}` };
  const previous = reconcileClaims({}, [legacy], [task()], config, now);
  assert.equal(previous[2].request, 2); assert.equal(previous[legacy.id], undefined);
  const duplicate = request();
  const claims = reconcileClaims(previous, [legacy, duplicate], [task()], config, now);
  assert.equal(claims[2].status, 'active'); assert.equal(claims[duplicate.id].reservation, '2');
  const renamed = { ...duplicate, user: { ...user(7), login: 'new-name' } };
  assert.equal(reconcileClaims(claims, [legacy, renamed], [task()], config, now)[duplicate.id].login, 'new-name');
  assert.throws(() => reconcileClaims(claims, [{ ...duplicate, user: user(8) }], [task()], config, now), /owner/);
});

test('ingestion uses human commands after activation even when acknowledgement is delayed', async () => {
  const f = fixture(); assert.deepEqual(await sourceRequests(f.api, [task()], {}, null), []);
  for (const mutate of [
    g => { g.state.comments = [g.reply]; },
    g => { g.original.updated_at = '2026-09-01T00:00:00Z'; }, g => { g.original.user.type = 'Bot'; },
    g => { g.original.body = 'not a command'; },
  ]) { const g = fixture(); mutate(g); assert.deepEqual(await sourceRequests(g.api, [task()], {}, enabledAt), []); }
  for (const mutate of [g => { g.state.comments = [g.original]; }, g => { g.reply.user = { ...bot, id: 9 }; }, g => { g.reply.body = 'quoted\n' + g.reply.body; }]) {
    const g = fixture(); mutate(g); assert.equal((await sourceRequests(g.api, [task()], {}, enabledAt)).length, 1);
  }
  const g = fixture(); g.original.body = '/unclaim';
  const requests = await sourceRequests(g.api, [task()], {}, enabledAt);
  assert.equal(requests[0].changedCommand, true);
  assert.equal(reconcileClaims({}, requests, [task()], config, now)[request().id].status, 'rejected');
});

test('invalid source identity, immutable node, receipt time and duplicate trusted receipts fail closed', async () => {
  for (const mutate of [
    f => { f.original.user.id = 8; }, f => { f.original.user.node_id = null; },
    f => { f.reply.id = -1; },
    f => { f.state.comments.push({ ...f.reply, id: 1101 }); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(sourceRequests(f.api, [task()], {}, enabledAt)); }
  assert.throws(() => p.marker(1, 2, 'other'));
  assert.throws(() => p.annotation('<!-- astral-assignment:a:9007199254740993 -->', 'assignment'));
  assert.throws(() => p.annotation('<!-- astral-reservation:a -->\n<!-- astral-reservation:b -->', 'reservation'));
});

test('assignment event evidence distinguishes owned assignments from manual overrides', async () => {
  for (const intent of [false, true]) {
    const f = fixture(); const a = request(); const target = task(); target.assigneeIds = [7];
    const previous = reconcileClaims({}, [a], [task()], config, now);
    f.reply.body += `\n<!-- astral-${intent ? 'assignment-intent' : 'assignment'}:${encodeURIComponent(a.id)}:${intent ? 299 : 300} -->`;
    f.state.events = [{ id: 300, event: 'assigned', assignee: { id: 7 }, actor: bot }];
    await sourceRequests(f.api, [target], previous, enabledAt);
    assert.deepEqual(target.managedAssignments, [{ id: a.id, userId: 7 }]);
    f.state.events.push({ id: 301, event: 'assigned', assignee: { id: 7 }, actor: user(99) });
    await sourceRequests(f.api, [target], previous, enabledAt); assert.deepEqual(target.managedAssignments, []);
    f.state.events.push({ id: 302, event: 'unassigned', assignee: { id: 7 }, actor: user(99) }); target.assigneeIds = [];
    const requests = await sourceRequests(f.api, [target], previous, enabledAt);
    assert.equal(reconcileClaims(previous, requests, [target], config, now)[a.id].status, 'superseded');
  }
});

test('synchronization collects source commands while retaining the existing legacy path', async () => {
  const f = fixture();
  const api = {
    request: async () => ({ private: false, archived: false, has_issues: true }),
    pages: async path => path === `/repos/${repository}/issues?state=all&labels=bounty`
      ? [{ number: 71, title: 'Task', labels: ['bounty', 'points:25'], assignees: [], state: 'open' }]
      : path === `/repos/${repository}/issues/71/comments` ? f.state.comments : [],
  };
  const result = await synchronize(api, config, {}, [], now, enabledAt);
  assert.equal(result.claims[request().id].status, 'active'); assert.equal(result.board.tasks[0].status, 'claimed');
});
