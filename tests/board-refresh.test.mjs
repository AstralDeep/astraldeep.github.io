// Exercises source-issue links, contribution prompts, and snapshot refreshes against the actual renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture() {
  const node = () => ({ children: [], textContent: '', value: '', options: [], listeners: {}, classList: { toggle() {}, add() {} }, append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(event, callback) { this.listeners[event] = callback; }, showModal() { this.open = true; } });
  const nodes = Object.fromEntries(['tasks', 'task-count', 'search', 'repo-filter', 'track-filter', 'status-filter', 'sync-status', 'agent-prompt', 'copy-status', 'agent-dialog'].map(id => [id, node()]));
  const task = { key: 'AstralDeep/LETS#71', repository: 'AstralDeep/LETS', number: 71, title: 'Small task', priority: 'P3', tracks: [], points: 25, status: 'available', url: 'https://github.com/AstralDeep/LETS/issues/71' };
  const snapshot = { generatedAt: '2026-10-01T00:00:00Z', repositories: ['AstralDeep/LETS'], coordinator: 'AstralDeep/astraldeep.github.io', tasks: [task], awards: [], leaderboard: [] };
  let next = structuredClone(snapshot);
  let fetches = 0;
  const document = { visibilityState: 'visible', documentElement: { dataset: {} }, querySelector: () => ({ textContent: JSON.stringify(snapshot) }), getElementById: id => nodes[id], createElement: node, addEventListener() {} };
  const context = { document, location: { href: 'http://localhost/bounties.html', origin: 'http://localhost', search: '' }, URL, URLSearchParams, setInterval() {}, fetch: async () => { fetches++; if (next instanceof Error) throw next; return { ok: next !== null, json: async () => next }; } };
  runInNewContext(`${readFileSync('site/app.js', 'utf8')}\nglobalThis.refresh = refreshBoard;`, context);
  return { nodes, document, task, snapshot, context, update: value => { next = value; }, fetches: () => fetches };
}

test('open tasks link to source issues and prompts award the author on main merge without commands', async () => {
  const f = fixture(); await new Promise(setImmediate);
  const actions = f.nodes.tasks.children[0].children[2];
  assert.equal(actions.children[0].href, f.task.url); assert.equal(actions.children[0].textContent, 'View issue');
  actions.children[1].listeners.click();
  assert.equal(f.nodes['agent-dialog'].open, true); assert.match(f.nodes['agent-prompt'].value, /Closes #71/); assert.match(f.nodes['agent-prompt'].value, /merge into main/); assert.match(f.nodes['agent-prompt'].value, /PR author automatically/);
  assert.doesNotMatch(f.nodes['agent-prompt'].value, /claim|reservation|assignment/);
  f.nodes.search.value = 'Small'; f.nodes['repo-filter'].value = f.task.repository;
  f.update({ ...f.snapshot, generatedAt: '2026-10-02T00:00:00Z', tasks: [{ ...f.task, status: 'completed' }] });
  await f.context.refresh();
  assert.equal(f.nodes.tasks.children[0].children[2].children[1].textContent, 'completed');
  assert.equal(f.nodes.search.value, 'Small'); assert.equal(f.nodes['repo-filter'].value, f.task.repository);
  f.update(f.snapshot); await f.context.refresh();
  assert.equal(f.nodes.tasks.children[0].children[2].children[1].textContent, 'completed');
});

test('failed refreshes retain the last board, show a warning, and hidden tabs do not poll', async () => {
  const f = fixture(); await new Promise(setImmediate);
  for (const response of [new Error('network'), null, { generatedAt: 'invalid' }]) {
    f.update(response); await f.context.refresh(); assert.equal(f.nodes.tasks.children.length, 1);
    assert.equal(f.nodes.tasks.children[0].children[2].children[0].href, f.task.url); assert.match(f.nodes['sync-status'].textContent, /refresh unavailable/);
  }
  f.document.visibilityState = 'hidden'; const before = f.fetches(); await f.context.refresh(); assert.equal(f.fetches(), before);
  f.document.visibilityState = 'visible'; f.update(f.snapshot); await f.context.refresh(); assert.doesNotMatch(f.nodes['sync-status'].textContent, /refresh unavailable/);
});
