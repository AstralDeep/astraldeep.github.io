// Checks retained-snapshot identity, unchanged award records, original freshness, and bounded read-only retrieval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { summarize } from '../scripts/model.mjs';
import { loadPublishedSnapshot, validatePublishedSnapshot } from '../scripts/published-snapshot.mjs';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
function fixture() {
  const tasks = [20, 21].map(number => ({
    key: `AstralDeep/AstralPlane#${number}`, repository: 'AstralDeep/AstralPlane', number,
    url: `https://github.com/AstralDeep/AstralPlane/issues/${number}`, title: 'Approved public task',
    points: 50, state: 'closed', stateReason: 'completed', tracks: ['security'], priority: 'P2'
  }));
  const awards = tasks.map((task, index) => ({
    policy: 'main-merge', issue: task.url, pr: `https://github.com/AstralDeep/AstralPlane/pull/${25 + index}`,
    userId: 1234, login: 'contributor', points: 50, awardedAt: '2026-10-10T12:00:00Z'
  }));
  const board = summarize(tasks, awards.map(award => ({ ...award, displayLogin: 'renamed-contributor' })), '2026-10-11T13:29:54.374Z');
  const run = { id: 17, workflow_id: 22, status: 'completed', conclusion: 'success', head_branch: 'main', path: '.github/workflows/pages.yml', head_sha: 'a'.repeat(40), repository: { full_name: config.coordinator }, head_repository: { full_name: config.coordinator }, created_at: '2026-10-11T13:29:45Z', updated_at: '2026-10-11T13:30:26Z' };
  const snapshot = { sha: 'b'.repeat(40), files: { 'data/awards.json': JSON.stringify([...awards].reverse()) } };
  return { board, awards, run, snapshot };
}

test('retained records may differ in order and display name while all credited bytes and freshness remain unchanged', () => {
  const state = fixture();
  const before = JSON.stringify(state);
  validatePublishedSnapshot(state.board, [...state.awards].reverse(), config, state.run, 22);
  assert.equal(JSON.stringify(state), before);
});

test('workflow identity and its original publication window are mandatory', () => {
  for (const patch of [
    { status: 'in_progress' }, { conclusion: 'failure' }, { head_branch: 'feature' }, { path: '.github/workflows/other.yml' },
    { workflow_id: 23 }, { repository: { full_name: 'other/site' } }, { head_repository: { full_name: 'other/site' } },
    { head_sha: 'main' }, { id: 0 }, { created_at: '2026-10-12T00:00:00Z' }, { updated_at: '2026-10-10T00:00:00Z' }, { created_at: 'bad' }
  ]) {
    const state = fixture();
    assert.throws(() => validatePublishedSnapshot(state.board, state.awards, config, { ...state.run, ...patch }, 22));
  }
});

test('private sources, malformed tasks, changed or duplicate credit, and invented derived totals fail closed', () => {
  for (const mutate of [
    s => { s.board.tasks = null; }, s => { s.board.awards = null; }, s => { s.board.leaderboard = null; },
    s => { s.board.tasks[0].repository = 'private/repo'; }, s => { s.board.tasks[0].number = -1; },
    s => { s.board.tasks[0].key = 'other'; }, s => { s.board.tasks[0].url = 'https://evil.test'; },
    s => { s.board.tasks.push({ ...s.board.tasks[0] }); }, s => { s.board.tasks[0].title = null; },
    s => { s.board.tasks[0].points = 999; }, s => { s.board.tasks[0].state = 'invalid'; },
    s => { s.board.tasks[0].stateReason = 'unknown'; }, s => { s.board.tasks[0].priority = 'P0'; },
    s => { s.board.tasks[0].tracks = null; }, s => { s.board.tasks[0].tracks = ['private']; },
    s => { s.board.awards[0].displayLogin = 'invalid/login'; }, s => { s.board.awards[0].userId = 999; },
    s => { s.board.awards.push({ ...s.board.awards[0] }); }, s => { s.board.leaderboard[0].points++; },
    s => { s.board.tasks[0].status = 'available'; }, s => { s.board.extra = 'not public schema'; }
  ]) {
    const state = fixture(); mutate(state);
    assert.throws(() => validatePublishedSnapshot(state.board, state.awards, config, state.run, 22));
  }
});

test('read-only provider retrieval retains the original board and records its observed digest', async () => {
  const state = fixture();
  const text = JSON.stringify(state.board);
  const paths = [];
  const github = { request: async path => {
    paths.push(path);
    if (path.endsWith('/pages.yml')) return { id: 22, path: '.github/workflows/pages.yml' };
    if (path.includes('/runs?')) return { workflow_runs: [state.run] };
    assert.equal(path, `/repos/${config.coordinator}/actions/runs/17`);
    return state.run;
  } };
  const result = await loadPublishedSnapshot(github, config, state.snapshot, async (url, options) => {
    assert.equal(url, `${config.site}/data/board.json`);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response(text);
  });
  assert.equal(paths.length, 3);
  assert.deepEqual(result.board, state.board);
  assert.equal(result.provenance.generatedAt, state.board.generatedAt);
  assert.equal(result.provenance.stateCommit, state.snapshot.sha);
  assert.equal(result.provenance.sha256, createHash('sha256').update(text).digest('hex'));
  for (const patch of [{ id: 0 }, { path: 'other' }]) {
    await assert.rejects(loadPublishedSnapshot({ request: async () => ({ id: 22, path: '.github/workflows/pages.yml', ...patch }) }, config, state.snapshot));
  }
  for (const listing of [{}, { workflow_runs: [] }, { workflow_runs: [{ ...state.run, id: 18 }] }]) {
    await assert.rejects(loadPublishedSnapshot({ request: async path => path.endsWith('/pages.yml') ? { id: 22, path: '.github/workflows/pages.yml' } : path.includes('/runs?') ? listing : state.run }, config, state.snapshot));
  }
  for (const response of [new Response('', { status: 404 }), new Response('x'.repeat(1048577)), new Response('{')]) {
    await assert.rejects(loadPublishedSnapshot(github, config, state.snapshot, async () => response));
  }
});
