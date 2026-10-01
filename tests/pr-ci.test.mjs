// Verifies current-head CI notifications, fork identity, path filters and recovery with deterministic provider fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { coordinate, applies, glob, receipt } = require('../actions/pr-ci/index.cjs');
const sha = 'a'.repeat(40), bot = { id: 41898282, type: 'Bot', login: 'github-actions[bot]' };

function fixture(repo = 'LETS') {
  const metadata = { id: 100, private: false, archived: false, default_branch: 'main' };
  const pr = { number: 7, state: 'open', draft: false, changed_files: 1, user: { id: 5, login: 'contributor' }, head: { sha, ref: 'fix', repo: { id: 200 } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 100 } }, requested_reviewers: [] };
  const workflow = 'on:\n  pull_request:\n  push:\n    branches: [main]\n';
  const files = [{ filename: 'src/fix.py' }];
  const makeRun = (id, path = '.github/workflows/ci.yml', changes = {}) => ({ id, workflow_id: id + 100, name: path, path, repository: { id: 100 }, head_repository: { id: 200 }, head_sha: sha, head_branch: 'fix', event: 'pull_request', status: 'completed', conclusion: 'success', run_attempt: 1, ...changes });
  const state = { metadata, pr, files, workflows: {}, runs: [makeRun(1), ...(repo === 'LETS' ? [makeRun(2, '.github/workflows/security.yml')] : [])], comments: [], jobs: [], reviews: [], writes: [], getCount: 0 };
  const github = { rest: {
    repos: { get: async () => ({ data: state.metadata }), getContent: async args => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(state.workflows[args.path] ?? workflow).toString('base64') } }) },
    pulls: {
      list: async args => ({ data: args.page === 1 ? [state.pr] : [] }),
      get: async () => { state.getCount++; return { data: structuredClone(state.pr) }; },
      listFiles: async args => ({ data: state.files.slice((args.page - 1) * 100, args.page * 100) }),
      listReviews: async args => ({ data: state.reviews.slice((args.page - 1) * 100, args.page * 100) }),
      requestReviewers: async args => { state.writes.push(['review', args]); state.pr.requested_reviewers.push({ id: 16158892 }); return { data: state.pr }; },
    },
    actions: {
      listWorkflowRunsForRepo: async args => ({ data: { workflow_runs: state.runs.slice((args.page - 1) * 100, args.page * 100) } }),
      listJobsForWorkflowRun: async args => ({ data: { jobs: state.jobs.slice((args.page - 1) * 100, args.page * 100) } }),
    },
    issues: {
      listComments: async args => ({ data: state.comments.slice((args.page - 1) * 100, args.page * 100) }),
      createComment: async args => { state.writes.push(['comment', args]); const comment = { id: state.comments.length + 10, body: args.body, user: bot }; state.comments.push(comment); return { data: structuredClone(comment) }; },
      updateComment: async args => { state.writes.push(['edit', args]); state.comments.find(comment => comment.id === args.comment_id).body = args.body; return {}; },
    },
    users: { getByUsername: async () => ({ data: { id: 16158892 } }) },
  } };
  const context = { repo: { owner: 'AstralDeep', repo }, eventName: 'workflow_dispatch', ref: 'refs/heads/main', serverUrl: 'https://github.com', apiUrl: 'https://api.github.com', payload: {} };
  return { state, github, context, makeRun, run: options => coordinate({ github, context, ...options }) };
}

test('all LETS workflows must pass before one review request; retries are silent', async () => {
  const f = fixture(); f.state.runs[1].status = 'in_progress'; f.state.runs[1].conclusion = null;
  assert.equal((await f.run()).results[0].status, 'pending'); assert.equal(f.state.writes.length, 0);
  f.state.runs[1].status = 'completed'; f.state.runs[1].conclusion = 'success';
  assert.equal((await f.run()).results[0].status, 'passed');
  assert.deepEqual(f.state.writes.map(item => item[0]), ['comment', 'review', 'edit']);
  assert.match(f.state.comments[0].body, /All applicable/);
  await f.run(); assert.equal(f.state.writes.length, 3);
});

test('failure mentions author with failed job and step links, then edits one receipt', async () => {
  const f = fixture(); f.state.runs[0].conclusion = 'failure';
  f.state.jobs = [{ id: 3, name: 'Lint @evil <script>', conclusion: 'failure', steps: [{ name: 'Ruff', conclusion: 'failure' }] }];
  assert.equal((await f.run()).results[0].status, 'failed');
  assert.match(f.state.comments[0].body, /@contributor, CI needs fixes/);
  assert.match(f.state.comments[0].body, /actions\/runs\/1\/job\/3/);
  assert.match(f.state.comments[0].body, /Ruff/); assert.doesNotMatch(f.state.comments[0].body, /@evil|<script>/);
  await f.run(); assert.equal(f.state.comments.length, 1); assert.equal(f.state.writes.length, 1);
  f.state.jobs[0].steps[0].name = 'Changed'; await f.run();
  assert.equal(f.state.writes[1][0], 'edit'); assert.equal(f.state.comments.length, 1);
  f.state.runs[0].conclusion = 'success'; await f.run();
  assert.equal(f.state.writes.at(-3)[0], 'review'); assert.equal(f.state.comments.length, 2);
});

test('a new successful head while review is pending sends a fresh maintainer mention', async () => {
  const f = fixture(); await f.run();
  f.state.pr.head.sha = 'c'.repeat(40); f.state.runs.forEach(run => { run.head_sha = f.state.pr.head.sha; });
  await f.run(); assert.equal(f.state.writes.filter(item => item[0] === 'review').length, 1);
  assert.match(f.state.comments[1].body, /@armstrongsam25/);
  await f.run(); assert.equal(f.state.comments.length, 2);
});

test('drafts suppress readiness but still report failure; becoming ready is recovered', async () => {
  const f = fixture(); f.state.pr.draft = true;
  assert.equal((await f.run()).results[0].status, 'draft'); assert.equal(f.state.writes.length, 0);
  f.state.runs[0].conclusion = 'failure'; await f.run(); assert.equal(f.state.comments.length, 1);
  f.state.runs[0].conclusion = 'success'; f.state.pr.draft = false; await f.run();
  assert.equal(f.state.comments.length, 2);
});

test('self-authored PR never requests an impossible self review', async () => {
  const f = fixture(); f.state.pr.user = { id: 16158892, login: 'armstrongsam25' };
  await f.run(); assert.deepEqual(f.state.writes.map(item => item[0]), ['comment']);
});

test('already requested reviewers get a mention without duplicate review requests', async () => {
  const f = fixture(); f.state.pr.requested_reviewers = [{ id: 16158892 }]; await f.run();
  assert.equal(f.state.writes[0][0], 'comment'); assert.match(f.state.comments[0].body, /@armstrongsam25/);
});

for (const [field, value] of [['head_sha', 'c'.repeat(40)], ['head_branch', 'other'], ['event', 'push'], ['head_repository', { id: 999 }], ['repository', { id: 999 }], ['path', '.github/workflows/release.yml']]) {
  test(`foreign or stale ${field} cannot qualify or report failure`, async () => {
    const f = fixture(); f.state.runs[0][field] = value; f.state.runs[0].conclusion = 'failure';
    assert.equal((await f.run()).results[0].status, 'pending'); assert.equal(f.state.writes.length, 0);
  });
}

for (const conclusion of ['action_required', 'neutral', 'skipped', null]) {
  test(`${conclusion} does not notify or approve`, async () => {
    const f = fixture(); f.state.runs[0].conclusion = conclusion; await f.run(); assert.equal(f.state.writes.length, 0);
  });
}

test('latest run supersedes earlier failure; cancelled current runs request repairs', async () => {
  const f = fixture(); f.state.runs[0].conclusion = 'failure'; f.state.runs.push(f.makeRun(3)); await f.run();
  assert.equal(f.state.writes[1][0], 'review');
  const g = fixture(); g.state.runs[0].conclusion = 'cancelled'; await g.run(); assert.match(g.state.comments[0].body, /cancelled/);
});

test('empty fork pull_requests arrays are supported by immutable repo, branch and SHA', async () => {
  const f = fixture(); f.state.runs.forEach(run => { run.pull_requests = []; }); await f.run(); assert.equal(f.state.writes[1][0], 'review');
});

test('Projection ignores path-inapplicable native lanes and requires applicable ones', async () => {
  const f = fixture('AstralProjection');
  for (const name of ['android-ci.yml', 'apple-ci.yml']) f.state.workflows['.github/workflows/' + name] = `on:\n  pull_request:\n    paths:\n      - '${name.startsWith('android') ? 'android-client/**' : 'scripts/**'}'\n  push:\n`;
  await f.run(); assert.equal(f.state.writes[1][0], 'review');
  const g = fixture('AstralProjection'); g.state.workflows = f.state.workflows; g.state.files = [{ filename: 'scripts/fix.py' }];
  await g.run(); assert.equal(g.state.writes.length, 0);
  g.state.runs.push(g.makeRun(3, '.github/workflows/apple-ci.yml')); await g.run(); assert.equal(g.state.writes[1][0], 'review');
});

test('renamed and removed files participate in path filters', async () => {
  const f = fixture('AstralProjection');
  f.state.workflows['.github/workflows/android-ci.yml'] = "on:\n  pull_request:\n    paths:\n      - 'android-client/**'\n";
  f.state.workflows['.github/workflows/apple-ci.yml'] = "on:\n  pull_request:\n    paths:\n      - 'apple-clients/**'\n";
  f.state.files = [{ filename: 'src/fix.py', previous_filename: 'android-client/Old.kt' }];
  await f.run(); assert.equal(f.state.writes.length, 0);
});

test('human forged receipts and malformed bot receipts never suppress notifications', async () => {
  const f = fixture(); await f.run(); const body = f.state.comments[0].body;
  const g = fixture(); g.state.comments = [{ id: 1, body, user: { id: 5, type: 'User' } }, { id: 2, body: '<!-- astral-pr-ci:v1:bad -->', user: bot }];
  await g.run(); assert.equal(g.state.writes[1][0], 'review');
  assert.equal(receipt({ body, user: bot }, { number: 8, head: { sha } }), null);
});

test('dry run neither comments nor requests reviews', async () => {
  const f = fixture(); assert.equal((await f.run({ dryRun: 'true' })).results[0].status, 'would-passed'); assert.equal(f.state.writes.length, 0);
  f.state.runs[0].conclusion = 'failure'; await f.run({ dryRun: true }); assert.equal(f.state.writes.length, 0);
});

test('paginated file/run/comment/job inventories are complete', async () => {
  const f = fixture(); f.state.pr.changed_files = 101; f.state.files = Array.from({ length: 101 }, (_, i) => ({ filename: `src/${i}.py` }));
  f.state.runs.push(...Array.from({ length: 101 }, (_, i) => f.makeRun(100 + i, '.github/workflows/irrelevant.yml')));
  f.state.comments = Array.from({ length: 101 }, (_, i) => ({ id: i, body: 'hello', user: { id: 5 } }));
  f.state.runs[0].conclusion = 'failure'; f.state.jobs = Array.from({ length: 101 }, (_, i) => ({ id: i, name: 'test', conclusion: i === 100 ? 'failure' : 'success' }));
  await f.run(); assert.match(f.state.comments.at(-1).body, /job\/100/);
});

test('missing job details use the failed workflow log link', async () => {
  const f = fixture(); f.state.runs[0].conclusion = 'startup_failure'; await f.run(); assert.match(f.state.comments[0].body, /actions\/runs\/1\)/);
});

test('head changes or closure immediately before notification prevent writes', async () => {
  for (const change of [pr => { pr.head.sha = 'c'.repeat(40); }, pr => { pr.state = 'closed'; }, pr => { pr.draft = true; }]) {
    const f = fixture(); const get = f.github.rest.pulls.get;
    f.github.rest.pulls.get = async args => { if (f.state.getCount === 1) change(f.state.pr); return get(args); };
    assert.equal((await f.run()).results[0].status, 'superseded'); assert.equal(f.state.writes.length, 0);
  }
});

test('incomplete file inventory and maintainer identity mismatches fail closed', async () => {
  const f = fixture(); f.state.pr.changed_files = 2; assert.match((await f.run()).errors[0].message, /Incomplete/);
  const g = fixture(); g.github.rest.users.getByUsername = async () => ({ data: { id: 5 } }); assert.match((await g.run()).errors[0].message, /identity mismatch/);
});

for (const mutate of [f => { f.context.ref = 'refs/heads/candidate'; }, f => { f.context.repo.owner = 'other'; }, f => { f.context.repo.repo = 'other'; }, f => { f.context.serverUrl = 'https://other'; }, f => { f.context.apiUrl = 'https://other'; }, f => { f.context.eventName = 'pull_request'; }, f => { f.state.metadata.private = true; }, f => { f.state.metadata.archived = true; }, f => { f.state.metadata.default_branch = 'other'; }]) {
  test('untrusted controller context and unsupported repository state fail closed', async () => { const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.equal(f.state.writes.length, 0); });
}

test('non-PR completion events are ignored and schedule reconciles open PRs', async () => {
  const f = fixture(); f.context.eventName = 'workflow_run'; f.context.payload.workflow_run = { event: 'push' }; assert.equal((await f.run()).status, 'ignored');
  f.context.payload.workflow_run.event = 'pull_request'; await f.run(); assert.equal(f.state.writes[1][0], 'review');
  const g = fixture(); g.context.eventName = 'schedule'; await g.run(); assert.equal(g.state.writes[1][0], 'review');
});

test('closed, deleted-head and foreign-base PRs are ineligible', async () => {
  for (const mutate of [pr => { pr.state = 'closed'; }, pr => { pr.base.ref = 'other'; }, pr => { pr.base.repo.id = 999; }, pr => { pr.head.repo = null; }, pr => { pr.head.sha = 'bad'; }]) {
    const f = fixture(); mutate(f.state.pr); assert.equal((await f.run()).results[0].status, 'ineligible'); assert.equal(f.state.writes.length, 0);
  }
});

test('path filters reject unsupported exclusions and match safe GitHub globs', () => {
  assert.equal(glob('scripts/*.py', 'scripts/foo.py'), true); assert.equal(glob('scripts/*.py', 'scripts/deep/foo.py'), false);
  assert.equal(glob('a?.json', 'ab.json'), true); assert.equal(glob('file.[x]', 'file.[x]'), true);
  assert.equal(glob('**/*.py', 'file.py'), true); assert.equal(glob('**/*.py', 'deep/file.py'), true);
  assert.equal(applies("on:\n  pull_request:\n    paths:\n      - 'apple/**'\n  push:\n    paths:\n      - 'web/**'\n", ['web/index.js']), false);
  assert.throws(() => applies('on:\n  push:\n', []), /no pull_request/);
  assert.throws(() => applies('on:\n  pull_request:\n    paths-ignore:\n      - x\n', []), /exclusions/);
  assert.throws(() => applies('on:\n  pull_request:\n    paths:\n', []), /Empty/);
});

test('same-head reruns and newer runs invalidate a pending notification', async () => {
  for (const mutate of [state => { state.runs[0].status = 'in_progress'; state.runs[0].conclusion = null; state.runs[0].run_attempt = 2; }, (state, f) => { state.runs.push(f.makeRun(5, '.github/workflows/ci.yml', { status: 'queued', conclusion: null })); }]) {
    const f = fixture(); let count = 0; const list = f.github.rest.actions.listWorkflowRunsForRepo;
    f.github.rest.actions.listWorkflowRunsForRepo = async args => { if (++count === 2) mutate(f.state, f); const value = await list(args); return structuredClone(value); };
    assert.equal((await f.run()).results[0].status, 'superseded'); assert.equal(f.state.writes.length, 0);
  }
});

test('same-head success failure success resolves failure without a duplicate review request', async () => {
  const f = fixture(); await f.run(); f.state.runs[0].conclusion = 'failure'; f.state.runs[0].run_attempt = 2;
  await f.run(); f.state.runs[0].conclusion = 'success'; f.state.runs[0].run_attempt = 3; await f.run();
  assert.match(f.state.comments[1].body, /resolved/);
  assert.equal(f.state.writes.filter(item => item[0] === 'review').length, 1); await f.run(); assert.equal(f.state.writes.filter(item => item[0] === 'edit').length, 2);
});

test('one PR provider error does not suppress other PR notifications', async () => {
  const f = fixture(); const second = structuredClone(f.state.pr); second.number = 8;
  f.github.rest.pulls.list = async () => ({ data: [f.state.pr, second] });
  f.github.rest.pulls.get = async args => { if (args.pull_number === 7) throw new Error('Unavailable'); return { data: second }; };
  const result = await f.run(); assert.equal(result.status, 'incomplete'); assert.equal(result.errors[0].number, 7); assert.equal(result.results[0].number, 8); assert.equal(f.state.writes[1][0], 'review');
});

test('partial writes and ambiguous HTTP timeouts recover without a second maintainer notification', async () => {
  for (const method of ['createComment', 'requestReviewers', 'updateComment']) {
    const f = fixture(); const owner = method === 'requestReviewers' ? f.github.rest.pulls : f.github.rest.issues;
    const original = owner[method]; let fail = true;
    owner[method] = async args => { const result = await original(args); if (fail) { fail = false; throw new Error('Response lost after server write'); } return result; };
    assert.equal((await f.run()).status, 'incomplete'); await f.run(); await f.run();
    assert.equal(f.state.comments.length, 1); assert.doesNotMatch(f.state.comments[0].body, /@armstrongsam25/);
    assert.equal(f.state.writes.filter(item => item[0] === 'review').length, 1);
    assert.equal(receipt(f.state.comments[0], f.state.pr).status, 'passed');
  }
});

test('a completed current-head review consumes a pending request without re-requesting', async () => {
  const f = fixture(); const original = f.github.rest.pulls.requestReviewers;
  f.github.rest.pulls.requestReviewers = async args => { await original(args); f.state.pr.requested_reviewers = []; f.state.reviews.push({ user: { id: 16158892 }, commit_id: sha, submitted_at: '2026-10-01T17:00:00Z' }); throw new Error('Response lost'); };
  await f.run(); await f.run(); assert.equal(f.state.writes.filter(item => item[0] === 'review').length, 1); assert.equal(receipt(f.state.comments[0], f.state.pr).status, 'passed');
});
