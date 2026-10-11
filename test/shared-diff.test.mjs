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
