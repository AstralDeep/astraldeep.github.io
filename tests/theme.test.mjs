// Verifies dark-default appearance, saved preferences, and storage-denial behavior before page paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('appearance defaults to dark and honors only an explicit light preference', () => {
  const source = readFileSync('site/theme.js', 'utf8');
  for (const preference of [null, 'dark', 'light', 'invalid']) {
    const document = { documentElement: { dataset: {} } };
    runInNewContext(source, { document, localStorage: { getItem: () => preference } });
    assert.equal(document.documentElement.dataset.theme || 'dark', preference === 'light' ? 'light' : 'dark');
  }
  const document = { documentElement: { dataset: {} } };
  runInNewContext(source, { document, localStorage: { getItem: () => { throw new Error('blocked'); } } });
  assert.equal(document.documentElement.dataset.theme, 'dark');
});
