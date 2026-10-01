// Exercises command receipts, immutable assignments and crash recovery using deterministic GitHub fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { replyToClaim } = require('../actions/claim-reply/index.cjs');
const p = require('../actions/claim-reply/protocol.cjs');
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const now = '2026-10-02T00:00:00.000Z';
const id = p.sourceId('AstralDeep/LETS', 100);

function fixture() {
  const comment = { id: 100, body: '/claim', issue_url: 'https://api.github.com/repos/AstralDeep/LETS/issues/71', created_at: now, updated_at: now, user: { id: 7, node_id: 'U7', login: 'contributor', type: 'User' } };
  const state = {
    metadata: { private: false, archived: false, has_issues: true }, comment,
    issue: { number: 71, node_id: 'I71', state: 'open', labels: [{ name: 'bounty' }], assignees: [] },
    comments: [comment], events: [], claims: {}, activation: { version: 1, enabledAt: '2026-10-01T00:00:00.000Z' },
    calls: [], writes: [], mutations: [], node: { id: 'U7', databaseId: 7, login: 'contributor' }, clock: now,
  };
  const context = { eventName: 'issue_comment', ref: 'refs/heads/main', serverUrl: 'https://github.com', apiUrl: 'https://api.github.com', repo: { owner: 'AstralDeep', repo: 'LETS' }, payload: { action: 'created', comment: { id: 100 }, issue: { number: 71 } } };
  const github = { rest: {
    repos: {
      get: async () => ({ data: state.metadata }),
      getCommit: async () => ({ data: { sha: 'a'.repeat(40) } }),
      getContent: async args => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(args.path.endsWith('claim-protocol.json') ? state.activation : state.claims)).toString('base64') } }),
    },
    issues: {
      getComment: async args => { state.calls.push(['comment', args]); return { data: state.comment }; },
      get: async args => { state.calls.push(['issue', args]); return { data: structuredClone(state.issue) }; },
      listForRepo: async () => ({ data: [state.issue] }),
      listComments: async args => ({ data: state.pages ? state.pages[args.page - 1] ?? [] : state.comments.slice((args.page - 1) * 100, args.page * 100) }),
      listEvents: async () => ({ data: structuredClone(state.events) }),
      createComment: async args => {
        state.writes.push(['create', args]);
        const value = { id: 200 + state.comments.length, body: args.body, user: bot, created_at: now };
        state.comments.push(value); return { data: structuredClone(value) };
      },
      updateComment: async args => {
        state.writes.push(['update', args]);
        const value = state.comments.find(item => item.id === args.comment_id);
        value.body = args.body; return { data: structuredClone(value) };
      },
    },
  }, graphql: async (query, variables) => {
    if (query.startsWith('query')) return { node: state.node };
    state.mutations.push({ query, variables });
    if (query.includes('removeAssignees')) state.issue.assignees = state.issue.assignees.filter(user => user.node_id !== variables.user);
    else state.issue.assignees.push({ id: 7, node_id: variables.user, login: state.node.login });
    state.events.push({ id: state.events.length + 300, event: query.includes('removeAssignees') ? 'unassigned' : 'assigned', assignee: { id: 7 }, actor: comment.user, assigner: bot });
    return {};
  } };
  return { state, github, context, run: options => replyToClaim({ github, context, clock: () => state.clock, ...options }) };
}

function reserve(f, changes = {}) {
  f.state.claims[id] = { source: { repository: 'AstralDeep/LETS', issue: 71, comment: 100, receipt: 201, command: 'claim', commandAt: now }, userId: 7, userNodeId: 'U7', login: 'contributor', key: 'AstralDeep/LETS#71', status: 'active', createdAt: now, expiresAt: '2026-10-09T00:00:00.000Z', ...changes };
}

function reply(f) { return f.state.comments.find(item => p.trustedBot(item.user)); }
function status(result) { return result.results?.[0]?.status ?? result.status; }

test('ownership uses the provider assigner rather than an actor naming the assignee', async () => {
  const f = fixture(); reserve(f); await f.run();
  assert.equal(f.state.events[0].actor.id, 7);
  assert.match(reply(f).body, /astral-assignment:/);
  f.state.clock = '2026-10-10T00:00:00Z';
  await f.run(); assert.equal(f.state.issue.assignees.length, 0);
  const g = fixture(); reserve(g); await g.run();
  g.state.events[0].actor = bot; g.state.events[0].assigner = g.state.comment.user;
  g.state.clock = '2026-10-10T00:00:00Z';
  await g.run(); assert.equal(g.state.issue.assignees.length, 1);
});

test('one claim queues without a form and retries edit the same trusted receipt', async () => {
  const f = fixture();
  assert.equal(status(await f.run()), 'pending');
  assert.match(reply(f).body, /No form or further action/);
  assert.match(reply(f).body, /queued/);
  assert.match(reply(f).body, /^<!-- astral-claim-command:100:7:claim -->/);
  await f.run();
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.mutations.length, 0);
});

test('committed acceptance assigns immutable IDs and updates one receipt without renewing the lease', async () => {
  const f = fixture(); await f.run(); reserve(f);
  const ledger = structuredClone(f.state.claims);
  assert.equal(status(await f.run()), 'reserved');
  assert.match(reply(f).body, /Reserved.*assigned to you/);
  assert.match(reply(f).body, /astral-assignment:/);
  assert.equal(f.state.mutations[0].variables.user, 'U7');
  assert.equal(f.state.issue.assignees[0].id, 7);
  await f.run(); await f.run();
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.writes.filter(([kind]) => kind === 'create').length, 1);
  assert.deepEqual(f.state.claims, ledger);
});

test('a legacy reservation reuses its old guidance reply and respects its existing expiry', async () => {
  const f = fixture(); f.state.comment.updated_at = '2026-09-01T00:00:00Z';
  f.state.comments.push({ id: 201, body: '<!-- astral-claim-help:100 -->\nOld form guidance', user: bot, created_at: now });
  reserve(f); const { source, ...claim } = f.state.claims[id]; f.state.claims = { 2: { ...claim, request: 2 } };
  f.context.eventName = 'schedule';
  await f.run();
  assert.equal(f.state.writes.filter(([kind]) => kind === 'create').length, 0);
  assert.match(reply(f).body, /astral-reservation:2/);
  assert.match(reply(f).body, /2026-10-09/);
  f.state.comments = f.state.comments.filter(comment => comment.id !== 100);
  f.state.claims[2].status = 'expired'; await f.run();
  assert.equal(f.state.issue.assignees.length, 0); assert.match(reply(f).body, /expired/);
});

test('schedule recovers missed events without claiming historical comments or inactive protocol', async () => {
  for (const enabled of [true, false]) {
    const f = fixture(); f.context.eventName = 'schedule';
    if (!enabled) f.state.activation.enabledAt = null;
    await f.run(); assert.equal(f.state.writes.length, enabled ? 1 : 0);
  }
  const f = fixture(); f.state.comment.updated_at = '2026-09-01T00:00:00Z';
  f.state.comments.push({ id: 201, body: '<!-- astral-claim-help:100 -->\nOld form guidance', user: bot });
  assert.equal(status(await f.run()), 'before-rollout'); assert.equal(f.state.writes.length, 0);
});

test('assignment errors preserve a truthful reservation and retry without another receipt', async () => {
  const f = fixture(); reserve(f);
  const graphql = f.github.graphql;
  f.github.graphql = async (query, args) => { if (query.startsWith('mutation')) throw new Error('Assignment denied'); return graphql(query, args); };
  await assert.rejects(f.run(), /Assignment denied/);
  assert.match(reply(f).body, /Reserved/); assert.match(reply(f).body, /assignment is pending/);
  f.github.graphql = graphql; await f.run();
  assert.equal(f.state.writes.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(f.state.mutations.length, 1);
});

test('assignment intent recovers a crash after mutation and expiry removes only the owned assignment', async () => {
  const f = fixture(); reserve(f);
  const update = f.github.rest.issues.updateComment;
  f.github.rest.issues.updateComment = async args => { if (args.body.includes('**Reserved** and assigned')) throw new Error('Receipt failed'); return update(args); };
  await assert.rejects(f.run(), /Receipt failed/);
  assert.equal(f.state.issue.assignees.length, 1);
  assert.doesNotMatch(reply(f).body, /<!-- astral-assignment:/);
  f.github.rest.issues.updateComment = update;
  await f.run(); assert.match(reply(f).body, /<!-- astral-assignment:/);
  f.state.claims[id].status = 'expired'; f.state.issue.assignees.push({ id: 8, node_id: 'U8', login: 'maintainer' });
  await f.run();
  assert.deepEqual(f.state.issue.assignees.map(user => user.id), [8]);
  assert.match(reply(f).body, /expired/);
});

test('pre-existing manual assignments and later human reassignments survive reservation expiry', async () => {
  for (const preexisting of [true, false]) {
    const f = fixture(); reserve(f);
    if (preexisting) f.state.issue.assignees = [{ id: 7, node_id: 'U7', login: 'contributor' }];
    await f.run();
    f.state.events.push({ id: 900, event: 'assigned', assignee: { id: 7 }, assigner: { id: 99, login: 'maintainer', type: 'User' } });
    f.state.claims[id].status = 'released'; await f.run();
    assert.equal(f.state.issue.assignees[0].id, 7);
    assert.equal(f.state.mutations.filter(item => item.query.includes('removeAssignees')).length, 0);
  }
});

test('manual reassignment between recovery reads and revoked reservations before assignment stop writes', async () => {
  const f = fixture(); reserve(f); await f.run(); f.state.claims[id].status = 'released';
  const events = f.github.rest.issues.listEvents; let reads = 0;
  f.github.rest.issues.listEvents = async args => { if (++reads === 2) f.state.events.push({ id: 999, event: 'assigned', assignee: { id: 7 }, assigner: { id: 8, login: 'owner', type: 'User' } }); return events(args); };
  await f.run(); assert.equal(f.state.mutations.length, 1);
  const g = fixture(); reserve(g); const read = g.github.rest.repos.getContent; let ledgerReads = 0;
  g.github.rest.repos.getContent = async args => { if (args.path === 'state/claims.json' && ++ledgerReads === 2) g.state.claims[id].status = 'released'; return read(args); };
  assert.equal(status(await g.run()), 'changed-before-assignment'); assert.equal(g.state.mutations.length, 0);
});

test('manual unassignment does not cause the bot to fight a maintainer', async () => {
  const f = fixture(); reserve(f); await f.run();
  f.state.issue.assignees = [];
  f.state.events.push({ id: 999, event: 'unassigned', assignee: { id: 7 }, assigner: { id: 8, type: 'User', login: 'maintainer' } });
  await f.run();
  assert.equal(f.state.mutations.length, 1); assert.equal(f.state.issue.assignees.length, 0);
  assert.match(reply(f).body, /maintainer removed/);
});

test('renames use the stable node identity and identity mismatches never assign', async () => {
  const f = fixture(); reserve(f); f.state.node.login = 'renamed'; await f.run();
  assert.match(reply(f).body, /@renamed/); assert.equal(f.state.mutations[0].variables.user, 'U7');
  const g = fixture(); reserve(g); g.state.node.databaseId = 8;
  await assert.rejects(g.run(), /identity mismatch/); assert.equal(g.state.mutations.length, 0);
});

test('duplicate receipts share assignment ownership and never undo a manual removal', async () => {
  for (const schedule of [true, false]) {
    const f = fixture(); reserve(f); await f.run();
    const duplicate = { ...f.state.comment, id: 101 };
    f.state.comments.push(duplicate);
    f.state.claims[p.sourceId('AstralDeep/LETS', 101)] = { ...f.state.claims[id], source: { ...f.state.claims[id].source, comment: 101 }, status: 'duplicate', reservation: id };
    f.state.comment = duplicate; f.context.payload.comment.id = 101;
    await f.run();
    f.state.issue.assignees = [];
    f.state.events.push({ id: 999, event: 'unassigned', assignee: { id: 7 }, assigner: { id: 8, type: 'User', login: 'maintainer' } });
    if (schedule) f.context.eventName = 'schedule';
    await f.run();
    assert.equal(f.state.mutations.length, 1);
    assert.equal(f.state.issue.assignees.length, 0);
    assert.match(f.state.comments.find(item => p.receipt(item)?.commentId === 101).body, /maintainer removed/);
  }
});

test('duplicate and rejected decisions preserve the original lease and show their reason', async () => {
  const f = fixture(); reserve(f); const original = f.state.claims[id];
  f.state.claims = { 2: { ...original, source: undefined, request: 2 }, [id]: { ...original, status: 'duplicate', reservation: '2' } };
  await f.run(); assert.match(reply(f).body, /astral-reservation:2/);
  const g = fixture(); reserve(g, { status: 'rejected', reason: 'Finish your existing task first.' }); await g.run();
  assert.match(reply(g).body, /Finish your existing task/); assert.equal(g.state.mutations.length, 0);
});

test('a separate unclaim command queues and reports the committed release', async () => {
  const f = fixture(); f.state.comment.body = '/unclaim'; await f.run();
  assert.match(reply(f).body, /unclaim.*queued/);
  reserve(f, { status: 'released', source: { repository: 'AstralDeep/LETS', issue: 71, comment: 100, receipt: 201, command: 'unclaim' } });
  await f.run(); assert.match(reply(f).body, /released/); assert.equal(f.state.mutations.length, 0);
});

test('edited commands do not switch an existing receipt and deleted accepted comments retain recovery', async () => {
  const f = fixture(); await f.run(); f.state.comment.body = '/unclaim'; await f.run();
  assert.match(reply(f).body, /command was edited/); assert.equal(p.receipt(reply(f)).command, 'claim');
  const g = fixture(); reserve(g); await g.run(); g.state.comments = g.state.comments.filter(item => item.id !== 100);
  g.state.claims[id].status = 'released'; g.context.eventName = 'schedule'; await g.run();
  assert.equal(g.state.issue.assignees.length, 0);
});

test('accepted ledger commands recover even when edited or deleted before the first receipt', async () => {
  for (const deleted of [true, false]) {
    const f = fixture(); reserve(f); f.context.eventName = 'schedule';
    if (deleted) f.state.comments = []; else f.state.comment.body = 'explanatory text only';
    await f.run();
    assert.equal(f.state.issue.assignees[0].id, 7); assert.match(reply(f).body, /Reserved/);
    assert.equal(p.commandTime(reply(f).body), now);
  }
});

test('dry runs inspect commands or all claims without any receipt or assignment writes', async () => {
  for (const commentId of ['100', '']) {
    const f = fixture(); reserve(f); f.context.eventName = 'workflow_dispatch';
    assert.equal(status(await f.run({ commentId, dryRun: 'true' })), 'dry-run');
    assert.equal(f.state.writes.length, 0); assert.equal(f.state.mutations.length, 0);
  }
});

test('only trusted receipts deduplicate; forged or duplicate identities fail safely', async () => {
  const f = fixture(); f.state.comments.push({ id: 201, body: `${p.marker(100, 7, 'claim')}\nFake`, user: { ...bot, id: 99 } });
  await f.run(); assert.equal(f.state.writes.filter(([kind]) => kind === 'create').length, 1);
  const g = fixture(); await g.run(); g.state.comments.push({ ...reply(g), id: 999 });
  await assert.rejects(g.run(), /Duplicate trusted/);
  const h = fixture(); h.state.comments.push({ id: 201, body: `${p.marker(100, 8, 'claim')}\nWrong owner`, user: bot });
  await assert.rejects(h.run(), /owner mismatch/);
});

test('command parsing ignores bots, quotes, arguments and unsupported events', async () => {
  for (const body of ['/CLAIM', ' \n /claim \r\nI can work on this.']) {
    const f = fixture(); f.state.comment.body = body; f.context.payload.action = 'edited'; assert.equal(status(await f.run()), 'pending');
  }
  for (const mutate of [
    f => { f.state.comment.body = 'I want to /claim'; }, f => { f.state.comment.body = '```\n/claim\n```'; },
    f => { f.state.comment.body = '/claim extra'; }, f => { f.state.comment.body = null; },
    f => { f.state.comment.user.type = 'Bot'; }, f => { f.state.comment.user = null; },
    f => { f.context.eventName = 'pull_request'; }, f => { f.context.payload.action = 'deleted'; },
  ]) { const f = fixture(); mutate(f); assert.equal(status(await f.run()), 'ignored'); assert.equal(f.state.writes.length, 0); }
  for (const mutate of [f => { f.state.issue.state = 'closed'; }, f => { f.state.issue.labels = []; }]) {
    const f = fixture(); mutate(f); assert.equal(status(await f.run()), 'ignored');
  }
});

test('routing, identifiers, ledger integrity and API failures fail closed', async () => {
  for (const mutate of [
    f => { f.context.repo.owner = 'other'; }, f => { f.context.ref = 'refs/heads/untrusted'; },
    f => { f.context.serverUrl = 'https://github.example'; }, f => { f.context.apiUrl = 'https://api.example'; },
    f => { f.context.payload.comment.id = '100;bad'; }, f => { f.context.payload.comment = undefined; },
    f => { f.state.metadata.private = true; }, f => { f.state.metadata.archived = true; }, f => { f.state.metadata.has_issues = false; },
    f => { f.state.comment.id = 101; }, f => { f.state.comment.user.id = -1; }, f => { f.state.comment.user.login = 'bad\n@everyone'; },
    f => { f.state.comment.issue_url = 'https://api.github.com/repos/other/LETS/issues/71'; }, f => { f.state.comment.issue_url = null; },
    f => { f.context.payload.issue.number = 72; }, f => { f.state.issue.number = 72; }, f => { f.state.issue.pull_request = {}; },
    f => { f.state.activation.version = 9; }, f => { f.state.activation.enabledAt = 'invalid'; },
    f => { f.state.claims = []; }, f => { reserve(f, { key: 'other/private#1' }); }, f => { reserve(f, { status: 'made-up' }); },
    f => { reserve(f, { expiresAt: 'invalid' }); }, f => { reserve(f, { userNodeId: null }); },
    f => { reserve(f); f.state.claims[id].source.issue = 72; }, f => { f.state.claims = { 3: { request: 2, key: null, status: 'rejected', userId: 7, login: 'contributor' } }; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.equal(f.state.mutations.length, 0); }
  const f = fixture(); await assert.rejects(f.run({ dryRun: 'maybe' }));
  const g = fixture(); g.state.pages = Array(20).fill(Array(100).fill({})); await assert.rejects(g.run(), /Pagination limit/);
  const h = fixture(); h.state.pages = [{}]; await assert.rejects(h.run(), /Invalid GitHub list/);
  const i = fixture(); i.github.rest.issues.createComment = async () => ({ data: { id: 200, body: 'unexpected' } }); await assert.rejects(i.run(), /could not be verified/);
  const j = fixture(); j.github.rest.repos.getCommit = async () => ({ data: { sha: 'bad' } }); await assert.rejects(j.run(), /coordinator head/);
  const k = fixture(); k.github.rest.repos.getContent = async () => ({ data: { type: 'dir' } }); await assert.rejects(k.run(), /state file/);
});
