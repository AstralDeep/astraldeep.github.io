// Exercises public claim guidance against GitHub API fixtures, including identity, duplicate, and failure boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { replyToClaim } = createRequire(import.meta.url)('../actions/claim-reply/index.cjs');

function fixture() {
  const state = {
    metadata: { private: false, archived: false, has_issues: true },
    comment: { id: 100, body: '/claim', issue_url: 'https://api.github.com/repos/AstralDeep/LETS/issues/71', user: { id: 7, login: 'contributor', type: 'User' } },
    issue: { number: 71, state: 'open', labels: [{ name: 'bounty' }], assignees: [] },
    pages: [[]], calls: [], writes: [],
  };
  const context = { eventName: 'issue_comment', ref: 'refs/heads/main', serverUrl: 'https://github.com', apiUrl: 'https://api.github.com', repo: { owner: 'AstralDeep', repo: 'LETS' }, payload: { action: 'created', comment: { id: 100 }, issue: { number: 71 } } };
  const github = { rest: {
    repos: { get: async args => { state.calls.push(['repo', args]); return { data: state.metadata }; } },
    issues: {
      getComment: async args => { state.calls.push(['comment', args]); return { data: state.comment }; },
      get: async args => { state.calls.push(['issue', args]); return { data: state.issue }; },
      listComments: async args => { state.calls.push(['comments', args]); return { data: state.pages[args.page - 1] ?? [] }; },
      createComment: async args => { state.writes.push(args); return { data: { id: 200, html_url: 'https://github.com/AstralDeep/LETS/issues/71#issuecomment-200', body: args.body } }; },
    },
  } };
  return { state, context, github, run: options => replyToClaim({ github, context, ...options }) };
}

test('unassigned bounty gets a prefilled form without an assignment or reservation write', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'replied');
  assert.equal(f.state.writes.length, 1);
  const { body, owner, repo, issue_number } = f.state.writes[0];
  assert.equal(owner, 'AstralDeep'); assert.equal(repo, 'LETS'); assert.equal(issue_number, 71);
  assert.match(body, /^<!-- astral-claim-help:100 -->\n@contributor/);
  assert.match(body, /This comment alone does not reserve it/);
  const url = new URL(body.match(/\[prefilled claim form\]\(([^)]+)\)/)[1]);
  assert.equal(url.pathname, '/AstralDeep/astraldeep.github.io/issues/new');
  assert.equal(url.searchParams.get('task'), 'https://github.com/AstralDeep/LETS/issues/71');
  assert.equal(url.searchParams.get('title'), '[Claim] AstralDeep/LETS#71');
  assert.equal(url.searchParams.get('template'), 'claim.yml');
});

test('reports own assignment and another assignment without directing a duplicate claim', async () => {
  for (const id of [7, 8]) {
    const f = fixture(); f.state.issue.assignees = [{ id, login: 'assigned' }];
    await f.run();
    assert.match(f.state.writes[0].body, id === 7 ? /already assigned to you/ : /assigned to another contributor/);
    assert.doesNotMatch(f.state.writes[0].body, /prefilled claim form/);
  }
});

test('accepts first-line commands and edited events, ignores quotes, prefixes, bots, PRs and closed/non-bounties', async () => {
  for (const body of ['/CLAIM', ' \n /claim \r\nI can work on this.']) {
    const f = fixture(); f.state.comment.body = body; f.context.payload.action = 'edited'; f.state.issue.labels = ['bounty'];
    assert.equal((await f.run()).status, 'replied');
  }
  for (const mutate of [
    f => { f.state.comment.body = 'I want to /claim'; },
    f => { f.state.comment.body = '```\n/claim\n```'; },
    f => { f.state.comment.body = '/claim-other'; },
    f => { f.state.comment.body = '/claim extra'; },
    f => { f.state.comment.body = null; },
    f => { f.state.comment.user.type = 'Bot'; },
    f => { f.state.comment.user = null; },
    f => { f.state.issue.pull_request = {}; },
    f => { f.state.issue.state = 'closed'; },
    f => { f.state.issue.labels = []; },
    f => { f.context.eventName = 'pull_request'; },
    f => { f.context.payload.action = 'deleted'; },
  ]) {
    const f = fixture(); mutate(f); assert.equal((await f.run()).status, 'ignored'); assert.equal(f.state.writes.length, 0);
  }
});

test('fails closed for invalid repository, event routing and account identities', async () => {
  for (const mutate of [
    f => { f.context.repo.owner = 'other'; },
    f => { f.context.serverUrl = 'https://github.example'; },
    f => { f.context.apiUrl = 'https://api.example'; },
    f => { f.context.ref = 'refs/heads/untrusted'; },
    f => { f.context.payload.comment.id = '100;bad'; },
    f => { f.context.payload.comment = undefined; },
    f => { f.context.payload.comment.id = 9007199254740992; },
    f => { f.state.metadata.private = true; },
    f => { f.state.metadata.archived = true; },
    f => { f.state.metadata.has_issues = false; },
    f => { f.state.comment.id = 101; },
    f => { f.state.comment.user.id = -1; },
    f => { f.state.comment.user.login = 'bad\n@everyone'; },
    f => { f.state.comment.user.login = undefined; },
    f => { f.state.comment.issue_url = 'https://api.github.com/repos/other/LETS/issues/71'; },
    f => { f.state.comment.issue_url = null; },
    f => { f.state.comment.issue_url += '?bad'; },
    f => { f.context.payload.issue.number = 72; },
    f => { f.state.issue.number = 72; },
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.equal(f.state.writes.length, 0);
  }
  const f = fixture(); await assert.rejects(f.run({ dryRun: 'maybe' })); assert.equal(f.state.writes.length, 0);
});

test('dry-run refetches existing comments and reports the intended reply without posting', async () => {
  const f = fixture(); f.context.eventName = 'workflow_dispatch'; f.context.payload = {};
  const result = await f.run({ commentId: '100', dryRun: 'true' });
  assert.equal(result.status, 'dry-run'); assert.match(result.body, /prefilled claim form/); assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.calls.find(([name]) => name === 'comment')[1].comment_id, 100);
  await assert.rejects(f.run({ commentId: '' }));
});

test('deduplicates only trusted bot receipts across pages and ignores forged receipts', async () => {
  const receipt = { user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }, body: '<!-- astral-claim-help:100 -->' };
  for (const forged of [
    { ...receipt, user: { id: 99, login: 'github-actions[bot]', type: 'Bot' } },
    { ...receipt, user: { id: 41898282, login: 'someone', type: 'Bot' } },
    { ...receipt, user: { id: 41898282, login: 'github-actions[bot]', type: 'User' } },
    { ...receipt, body: null },
    { ...receipt, body: '<!-- astral-claim-help:101 -->' },
    { body: receipt.body },
  ]) {
    const f = fixture(); f.state.pages = [[forged]]; assert.equal((await f.run()).status, 'replied');
  }
  const f = fixture(); f.state.pages = [Array(100).fill({}), [receipt]];
  assert.equal((await f.run()).status, 'already-replied'); assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.calls.filter(([name]) => name === 'comments').length, 2);
});

test('API failures, malformed pages and incomplete pagination never produce a reply', async () => {
  for (const method of ['getComment', 'get', 'listComments', 'createComment']) {
    const f = fixture(); f.github.rest.issues[method] = async () => { throw new Error('API denied'); };
    await assert.rejects(f.run(), /API denied/); assert.equal(f.state.writes.length, 0);
  }
  const f = fixture(); f.state.pages = Array(20).fill(Array(100).fill({}));
  await assert.rejects(f.run(), /pagination limit/); assert.equal(f.state.writes.length, 0);
  const g = fixture(); g.state.pages = [{}]; await assert.rejects(g.run(), /Invalid comment page/); assert.equal(g.state.writes.length, 0);
  const h = fixture(); h.github.rest.issues.createComment = async () => ({ data: { id: 200, body: 'unexpected' } });
  await assert.rejects(h.run(), /could not be verified/);
});
