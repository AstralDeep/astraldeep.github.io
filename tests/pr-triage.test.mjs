// Exercises metadata triage, real issue references and maintainer-only exact-head closure with deterministic provider fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { triage, references, standalone, command } = require('../actions/pr-triage/index.cjs');
const sha = 'a'.repeat(40), bot = { id: 41898282, type: 'Bot' };

function fixture(eventName = 'workflow_dispatch') {
  const pr = { number: 7, state: 'open', draft: false, merged: false, body: 'Closes #12', labels: [], head: { sha, repo: { id: 2 } }, base: { ref: 'main', repo: { id: 1 } } };
  const state = { pr, metadata: { id: 1, private: false, archived: false, default_branch: 'main' }, issues: new Map([['LETS#12', { number: 12 }]]), comments: [], labels: new Set(), writes: [], gets: 0, permission: { permission: 'write', user: { id: 5 } }, decision: { id: 17, user: { id: 5, login: 'maintainer', type: 'User' }, created_at: '2026-10-05T18:00:00Z', updated_at: '2026-10-05T18:00:00Z', issue_url: 'https://api.github.com/repos/AstralDeep/LETS/issues/7', body: `/astral-triage close ${sha} no-op\nThe whole reviewed diff adds only assert True and verifies no behavior.` } };
  const missing = () => Object.assign(new Error('Not found'), { status: 404 });
  const write = (name, args) => { state.writes.push([name, args]); };
  const page = (rows, args) => ({ data: rows.slice((args.page - 1) * 100, args.page * 100) });
  const github = { rest: {
    repos: { get: async () => ({ data: state.metadata }), getCollaboratorPermissionLevel: async () => ({ data: state.permission }) },
    pulls: {
      list: async args => page(state.prs ?? [state.pr], args),
      get: async () => { state.gets++; state.onGet?.(state.gets); return { data: structuredClone(state.pr) }; },
      update: async args => { write('state', args); state.onUpdate?.(args); state.pr.state = args.state; return { data: structuredClone(state.pr) }; },
    },
    issues: {
      get: async args => { const value = state.issues.get(`${args.repo}#${args.issue_number}`); if (!value) throw missing(); return { data: value }; },
      getComment: async () => ({ data: structuredClone(state.decision) }),
      listComments: async args => page(state.comments, args),
      createComment: async args => { write('comment', args); const comment = { id: state.comments.length + 30, body: args.body, user: bot }; state.comments.push(comment); return { data: structuredClone(comment) }; },
      updateComment: async args => { write('edit', args); state.comments.find(item => item.id === args.comment_id).body = args.body; return {}; },
      getLabel: async args => { if (!state.labels.has(args.name)) throw missing(); return { data: { name: args.name } }; },
      createLabel: async args => { write('create-label', args); state.labels.add(args.name); return {}; },
      addLabels: async args => { write('label', args); state.pr.labels.push(...args.labels.map(name => ({ name }))); return {}; },
      removeLabel: async args => { write('unlabel', args); state.pr.labels = state.pr.labels.filter(item => item.name !== args.name); return {}; },
    },
  } };
  const context = { repo: { owner: 'AstralDeep', repo: 'LETS' }, ref: 'refs/heads/main', serverUrl: 'https://github.com', apiUrl: 'https://api.github.com', eventName, actor: 'maintainer', payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 17 } } };
  return { state, github, context, run: options => triage({ github, context, ...options }) };
}

test('issue parser bounds scope, deduplicates and excludes fenced and hidden examples', () => {
  assert.deepEqual(references('Closes #12; AstralDeep/LETS#12; AstralDeep/AstralPlane#9; https://github.com/AstralDeep/AstralPlane/issues/9; https://github.com/AstralDeep/LETS/pull/18; Other/Repo#20; ```\n#21\n``` <!-- #22 --> ~~~\n#23\n~~~ `#24`', 'LETS'), [{ repo: 'LETS', number: 12 }, { repo: 'AstralPlane', number: 9 }]);
  assert.deepEqual(references(undefined, 'LETS'), []);
  assert.deepEqual(references('AstralDeep/private#2 #9007199254740993', 'LETS'), []);
  assert.throws(() => references(Array.from({ length: 21 }, (_, i) => `#${i + 1}`).join(' '), 'LETS'), /Too many/);
  assert.equal(standalone('Standalone: This fixes a reproducible independent defect in the request adapter.'), true);
  for (const body of [undefined, 'Standalone: short', 'Standalone: x' + ' '.repeat(50), '<!-- Standalone: ' + 'x'.repeat(60) + ' -->', '```\nStandalone: ' + 'x'.repeat(60) + '\n```']) assert.equal(standalone(body), false);
});

test('only real issues satisfy context; a PR reference requests context without closure', async () => {
  const f = fixture(); await f.run(); assert.deepEqual(f.state.writes, []);
  f.state.issues.set('LETS#12', { number: 12, pull_request: {} });
  assert.equal((await f.run()).results[0].status, 'needs-context');
  assert.deepEqual(f.state.writes.map(item => item[0]), ['comment', 'create-label', 'label']);
  assert.match(f.state.comments[0].body, /does not automatically close/);
  await f.run(); assert.equal(f.state.comments.length, 1); assert.equal(f.state.writes.length, 3);
  f.state.pr.body = 'Standalone: This corrects a reproducible boundary error in the request adapter.';
  await f.run(); assert.equal(f.state.pr.labels.length, 0); assert.match(f.state.comments[0].body, /context is present/);
  await f.run(); assert.equal(f.state.writes.length, 5);
});

test('cross-repository and closed issue context is accepted; 404 is a request', async () => {
  const f = fixture(); f.state.pr.body = 'Related AstralDeep/AstralPlane#9'; f.state.issues.set('AstralPlane#9', { number: 9, state: 'closed' });
  assert.equal((await f.run()).results[0].status, 'context-present');
  f.state.pr.body = 'Closes #999'; assert.equal((await f.run()).results[0].status, 'needs-context');
});

test('missing context dry run has no writes; existing labels and bot comments reconcile', async () => {
  const f = fixture(); f.state.pr.body = null;
  assert.equal((await f.run({ dryRun: 'true' })).results[0].status, 'would-request-context'); assert.deepEqual(f.state.writes, []);
  f.state.labels.add('triage:needs-context'); await f.run(); assert.equal(f.state.writes.filter(item => item[0] === 'create-label').length, 0);
  f.state.comments[0].body += '\nold'; await f.run(); assert.equal(f.state.writes.at(-1)[0], 'edit');
  f.state.pr.body = 'Closes #12'; await f.run({ dryRun: true }); assert.equal(f.state.pr.labels.length, 1);
});

test('spoofed receipts cannot suppress genuine context requests', async () => {
  const f = fixture(); f.state.pr.body = ''; f.state.comments = [{ id: 1, user: { id: 5, type: 'User' }, body: '<!-- astral-pr-triage:v1:7:context -->' }];
  await f.run(); assert.equal(f.state.comments.length, 2);
});

test('drafts, closed PRs, foreign bases and invalid heads are left untouched', async () => {
  for (const mutate of [pr => { pr.draft = true; }, pr => { pr.state = 'closed'; }, pr => { pr.merged = true; }, pr => { pr.base.ref = 'other'; }, pr => { pr.base.repo.id = 2; }, pr => { pr.head.repo = null; }, pr => { pr.head.sha = 'bad'; }]) {
    const f = fixture(); mutate(f.state.pr); assert.equal((await f.run()).results[0].status, 'ineligible'); assert.deepEqual(f.state.writes, []);
  }
});

test('context updates refuse raced heads, bodies and draft state', async () => {
  for (const mutate of [pr => { pr.head.sha = 'b'.repeat(40); }, pr => { pr.body = 'changed'; }, pr => { pr.draft = true; }]) {
    const f = fixture(); f.state.pr.body = ''; f.state.onGet = count => { if (count === 2) mutate(f.state.pr); };
    assert.equal((await f.run()).results[0].status, 'changed'); assert.deepEqual(f.state.writes, []);
  }
});

test('provider failures fail closed but other PRs can still reconcile', async () => {
  const f = fixture(); f.github.rest.issues.get = async () => { throw Object.assign(new Error('rate limited'), { status: 403 }); };
  assert.equal((await f.run()).status, 'incomplete'); assert.deepEqual(f.state.writes, []);
  f.github.rest.issues.get = async () => ({ data: { number: 13 } }); assert.equal((await f.run()).results[0].status, 'needs-context');
  const g = fixture(); g.state.pr.body = ''; g.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  assert.equal((await g.run()).status, 'incomplete'); assert.equal(g.state.pr.state, 'open');
});

test('maintainer closure has public evidence, exact head and one immutable command receipt', async () => {
  const f = fixture('issue_comment'); const result = await f.run();
  assert.equal(result.status, 'closed'); assert.equal(f.state.pr.state, 'closed');
  assert.deepEqual(f.state.writes.map(item => item[0]), ['comment', 'state', 'create-label', 'label', 'edit']);
  assert.match(f.state.comments[0].body, /issuecomment-17/); assert.match(f.state.comments[0].body, /Verified closed/);
  f.state.pr.state = 'open'; assert.equal((await f.run()).status, 'already-recorded'); assert.equal(f.state.writes.length, 5);
});

test('every supported reason accepts maintainer permission and dry run does not write', async () => {
  for (const reason of ['no-op', 'unsupported-completion', 'duplicate', 'superseded']) {
    const f = fixture('issue_comment'); f.state.decision.body = f.state.decision.body.replace('no-op', reason); f.state.permission.permission = reason === 'duplicate' ? 'maintain' : 'admin';
    assert.equal((await f.run({ dryRun: true })).status, 'would-close'); assert.deepEqual(f.state.writes, []);
  }
});

test('commands require a full SHA, supported reason and concrete evidence paragraph', () => {
  assert.equal(command(undefined), null);
  for (const body of ['/astral-triage close main no-op\n' + 'e'.repeat(60), `/astral-triage close ${sha} size\n` + 'e'.repeat(60), `/astral-triage close ${sha} no-op\nshort`, `/astral-triage close ${sha} no-op\n` + ' '.repeat(50), `/astral-triage close ${sha} no-op\n` + 'x'.repeat(4001)]) assert.equal(command(body), null);
  assert.equal(command(`/astral-triage close ${sha} duplicate\r\n` + 'Evidence '.repeat(8)).reason, 'duplicate');
});

test('non-PR events and ordinary contributor comments are ignored', async () => {
  for (const mutate of [f => { f.context.payload.action = 'edited'; }, f => { delete f.context.payload.issue.pull_request; }, f => { f.context.payload.comment.id = '17'; }, f => { f.state.decision.body = 'normal comment'; }]) {
    const f = fixture('issue_comment'); mutate(f); assert.equal((await f.run()).status, 'ignored'); assert.deepEqual(f.state.writes, []);
  }
});

test('closure denies contributors, identity mismatches, bots and edited or foreign comments', async () => {
  for (const mutate of [f => { f.state.permission.permission = 'read'; }, f => { f.state.permission.user.id = 8; }, f => { f.state.decision.user.type = 'Bot'; }, f => { f.context.actor = 'other'; }, f => { f.state.decision.updated_at = 'changed'; }, f => { f.state.decision.issue_url += '0'; }]) {
    const f = fixture('issue_comment'); mutate(f); await assert.rejects(f.run(), /Untrusted|maintainer/); assert.deepEqual(f.state.writes, []);
  }
});

test('head races before or during closure never close unreviewed work', async () => {
  for (const stage of [1, 2, 3]) {
    const f = fixture('issue_comment'); f.state.onGet = count => { if (count === stage) f.state.pr.head.sha = 'b'.repeat(40); };
    assert.equal((await f.run()).status, 'changed'); assert.equal(f.state.pr.state, 'open');
  }
  const f = fixture('issue_comment'); f.state.onGet = count => { if (count === 4) f.state.pr.head.sha = 'b'.repeat(40); };
  await assert.rejects(f.run(), /reopened/); assert.equal(f.state.pr.state, 'open'); assert.match(f.state.comments[0].body, /Reopened/);
});

test('changed or deleted decisions and revoked permissions are denied before closing', async () => {
  for (const mutate of [f => { f.state.decision.body += ' changed'; }, f => { f.state.decision.user.id = 8; }, f => { f.state.decision.user.login = 'other'; }, f => { f.state.decision.user.type = 'Bot'; }, f => { f.state.decision.created_at = 'changed'; }, f => { f.state.decision.updated_at = 'changed'; }, f => { f.state.decision.issue_url += '0'; }, f => { f.state.permission.permission = 'read'; }, f => { f.state.permission.user.id = 8; }]) {
    const f = fixture('issue_comment'); f.state.onGet = count => { if (count === 3) mutate(f); };
    await assert.rejects(f.run(), /changed/); assert.equal(f.state.pr.state, 'open'); assert.equal(f.state.writes.some(item => item[0] === 'state'), false);
  }
  const f = fixture('issue_comment'); let count = 0;
  f.github.rest.issues.getComment = async () => { if (++count === 2) throw Object.assign(new Error('Deleted'), { status: 404 }); return { data: structuredClone(f.state.decision) }; };
  await assert.rejects(f.run(), /Deleted/); assert.equal(f.state.pr.state, 'open');
});

test('unexpected closure results and provider write failure are surfaced and not repeated', async () => {
  const f = fixture('issue_comment'); f.state.onGet = count => { if (count === 4) f.state.pr.merged = true; };
  await assert.rejects(f.run(), /Unable to verify/);
  const g = fixture('issue_comment'); g.github.rest.pulls.update = async () => { throw new Error('permission failure'); };
  await assert.rejects(g.run(), /permission failure/); assert.equal(g.state.pr.state, 'open');
  assert.equal((await g.run()).status, 'already-recorded'); assert.equal(g.state.comments.length, 1);
});

test('close response races and failed readbacks reopen; ambiguous writes are compensated', async () => {
  const f = fixture('issue_comment'); f.state.onUpdate = args => { if (args.state === 'closed') f.state.pr.head.sha = 'b'.repeat(40); };
  await assert.rejects(f.run(), /reopened/); assert.equal(f.state.pr.state, 'open');
  const g = fixture('issue_comment'); const get = g.github.rest.pulls.get;
  g.github.rest.pulls.get = async args => { if (g.state.gets === 3) throw new Error('Readback failed'); return get(args); };
  await assert.rejects(g.run(), /readback failed; reopened/); assert.equal(g.state.pr.state, 'open');
  const h = fixture('issue_comment'); const update = h.github.rest.pulls.update;
  h.github.rest.pulls.update = async args => { if (args.state === 'closed') { await update(args); throw new Error('Lost reply'); } return update(args); };
  await assert.rejects(h.run(), /Close request failed; reopened/); assert.equal(h.state.pr.state, 'open');
  const k = fixture('issue_comment'); k.github.rest.pulls.update = async () => ({ data: { ...structuredClone(k.state.pr), state: 'closed', merged: false, head: { sha: 'b'.repeat(40) } } });
  await assert.rejects(k.run(), /reopening could not be confirmed/);
});

test('draft conversion and base retargeting races require reopening', async () => {
  for (const mutate of [pr => { pr.draft = true; }, pr => { pr.base.ref = 'other'; }, pr => { pr.base.repo.id = 9; }]) {
    for (const phase of ['write', 'readback']) {
      const f = fixture('issue_comment');
      if (phase === 'write') f.state.onUpdate = args => { if (args.state === 'closed') mutate(f.state.pr); };
      else f.state.onGet = count => { if (count === 4) mutate(f.state.pr); };
      await assert.rejects(f.run(), /reopened/); assert.equal(f.state.pr.state, 'open');
    }
  }
});

test('only allowlisted public exact-main controllers can run', async () => {
  for (const mutate of [f => { f.context.repo.owner = 'other'; }, f => { f.context.repo.repo = 'private'; }, f => { f.context.ref = 'refs/heads/branch'; }, f => { f.context.serverUrl = 'https://other'; }, f => { f.context.apiUrl = 'https://other'; }, f => { f.context.eventName = 'pull_request'; }, f => { f.state.metadata.private = true; }, f => { f.state.metadata.archived = true; }, f => { f.state.metadata.default_branch = 'other'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run(), /Untrusted|Unsupported/); assert.deepEqual(f.state.writes, []);
  }
  const f = fixture(); f.context.eventName = 'schedule'; assert.equal((await f.run()).status, 'complete');
});

test('bounded pagination errors are fail closed', async () => {
  const f = fixture(); f.github.rest.pulls.list = async () => ({ data: Array(100).fill({ number: 7 }) }); await assert.rejects(f.run(), /Pagination/);
  const g = fixture(); g.github.rest.pulls.list = async () => ({ data: {} }); await assert.rejects(g.run(), /Invalid provider/);
});

test('composite action executes only pinned trusted code without candidate interpolation', () => {
  const text = readFileSync(new URL('../actions/pr-triage/action.yml', import.meta.url), 'utf8');
  assert.match(text, /actions\/github-script@[a-f0-9]{40}/);
  assert.doesNotMatch(text, /checkout|download-artifact|github\.event|secrets|id-token|contents:|exec\(/);
  assert.match(text, /retries: 0/); assert.match(text, /core\.setFailed/);
});
