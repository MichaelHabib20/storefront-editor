import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askShared } from '../src/agent.mjs';

test('the shared-parts question names the parts in plain words, in the owner\'s language', () => {
  const en = askShared('show 2 cards per row on phones', ['src/components/ui/Rail.module.css', 'src/components/ui/Rail.tsx']);
  assert.match(en.text, /^This change also needs to change the scrolling rows \(products, categories, brands\), which show on many pages/);
  assert.deepEqual(en.options, ['Yes, everywhere', 'No, only where I asked']);
  const both = askShared('x', ['src/app/globals.css', 'src/components/layout/SiteFooter.module.css']);
  assert.match(both.text, /the site colours and styles and the footer/);
  const ar = askShared('اجعل البطاقات اثنتين', ['src/components/layout/SiteHeader.module.css']);
  assert.match(ar.text, /رأس الصفحة/);
  assert.match(askShared('x', ['src/other.css']).text, /parts that are shared across the store/);
});
