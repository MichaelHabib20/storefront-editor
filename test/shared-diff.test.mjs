import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyExtends } from '../src/shared-diff.mjs';
import { splitChoices } from '../src/triage.mjs';

test('a shared file that is only added to (a line comes back extended) is not a change', () => {
  const extended = "--- a/x\n+++ b/x\n@@ -3 +3 @@\n-export type IconName = 'cart' | 'heart';\n+export type IconName = 'cart' | 'heart' | 'truck';\n@@ -9,0 +10,3 @@\n+  truck: 'M3 6h11',\n";
  assert.equal(onlyExtends(extended), true);
  const changed = "--- a/x\n+++ b/x\n@@ -3 +3 @@\n-  color: var(--color-primary);\n+  color: var(--color-text);\n";
  assert.equal(onlyExtends(changed), false);
  const removed = "--- a/x\n+++ b/x\n@@ -3 +2,0 @@\n-  border: 0;\n";
  assert.equal(onlyExtends(removed), false);
});

test('choices after a colon become buttons too', () => {
  assert.deepEqual(splitChoices('If you want something different, tell me which:\n1. Wider\n2. Narrower').options, ['Wider', 'Narrower']);
});
