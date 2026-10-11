import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyExtends } from '../src/shared-diff.mjs';
import { splitChoices } from '../src/triage.mjs';

const diff = (...lines) => ['--- a/x', '+++ b/x', ...lines].join('\n');

test('a shared file that is only added to (a line comes back extended) is not a change', () => {
  assert.equal(onlyExtends(diff('@@ -3 +3 @@', "-export type IconName = 'cart' | 'heart';", "+export type IconName = 'cart' | 'heart' | 'truck';", '@@ -9,0 +10,1 @@', "+  truck: 'M3 6h11',")), true);
  // a multi-line list: the old last item loses its semicolon to the new last one
  assert.equal(onlyExtends(diff('@@ -23 +23,3 @@', "-  | 'filter';", "+  | 'filter'", "+  | 'truck'", "+  | 'headset';")), true);
  assert.equal(onlyExtends(diff('@@ -3 +3 @@', '-  color: var(--color-primary);', '+  color: var(--color-text);')), false);
  assert.equal(onlyExtends(diff('@@ -3 +2,0 @@', '-  border: 0;')), false);
});

test('choices after a colon become buttons too', () => {
  assert.deepEqual(splitChoices('If you want something different, tell me which:\n1. Wider\n2. Narrower').options, ['Wider', 'Narrower']);
});

test('colour codes the owner never wrote are taken out of messages for them', async () => {
  const { withoutNewColourCodes: plain } = await import('../src/triage.mjs');
  assert.equal(plain("I'll make the header a darker blue—something like #1a2f7a. Shall I go ahead?", ['Make the header #1f3a93']), "I'll make the header a darker blue. Shall I go ahead?");
  assert.equal(plain("I'll darken the header to #152054 for a deeper blue."), "I'll darken the header for a deeper blue.");
  assert.equal(plain('The header is now dark blue (#1f3a93).', ['Make it dark blue (#1F3A93)']), 'The header is now dark blue (#1f3a93).');
});
