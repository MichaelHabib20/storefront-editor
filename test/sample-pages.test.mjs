import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagesFromHome, pagesText } from '../src/sample-pages.mjs';
import { systemPrompt } from '../src/prompt.mjs';

test('the pages to look at come from the home page links; missing kinds are left out', () => {
  const html = '<a href="/en/product/skin-care">Skin</a><a class="ProductCard_link__x" href="/en/jj-bath-500ml">J</a>';
  assert.deepEqual(pagesFromHome(html), { home: '/en', category: '/en/product/skin-care', product: '/en/jj-bath-500ml', cart: '/en/cart', arabicHome: '/ar', arabicProduct: '/ar/jj-bath-500ml' });
  assert.deepEqual(pagesFromHome(''), { home: '/en', cart: '/en/cart', arabicHome: '/ar' });
  assert.match(pagesText(pagesFromHome(html)), /a product page: \/en\/jj-bath-500ml/);
  assert.match(systemPrompt('nowhere', { eyes: true, pages: pagesFromHome(html) }), /Pages of this store to look at[\s\S]*\/ar\/jj-bath-500ml/);
  assert.doesNotMatch(systemPrompt('nowhere', { eyes: false, pages: pagesFromHome(html) }), /Pages of this store/);
});
