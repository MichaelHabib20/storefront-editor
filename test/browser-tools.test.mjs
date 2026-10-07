/**
 * The bug-finding browser against a local test store: it reads console errors and failed requests, acts like a
 * customer, never places an order, never leaves the preview's origin and never shows the test login.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { PAY_BLOCK, STOPPED_BEFORE_PAYING, browse } from '../src/browser-tools.mjs';
import { createBrowserPool } from '../src/screenshot.mjs';

const hits = { orders: 0, outside: 0, signins: [] };
let store, outsider, base, pool;

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test store</title></head><body>${body}</body></html>`;

before(async () => {
  outsider = http.createServer((req, res) => {
    hits.outside += 1;
    res.end(page('<h1>Outside</h1>'));
  });
  await new Promise((r) => outsider.listen(0, '127.0.0.1', r));
  const outsideUrl = `http://127.0.0.1:${outsider.address().port}/`;
  store = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (html, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(html);
    };
    if (url.pathname === '/order' && req.method === 'POST') {
      hits.orders += 1;
      res.writeHead(200);
      return res.end('ok');
    }
    if (url.pathname === '/api/broken') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (url.pathname === '/en/session/signin' && req.method === 'POST') {
      let data = '';
      req.on('data', (c) => (data += c));
      return req.on('end', () => {
        hits.signins.push(data);
        res.writeHead(303, { location: '/en/account' });
        res.end();
      });
    }
    if (url.pathname === '/en/session/signin') {
      return send(page('<form method="post"><input name="identifier"><input name="password" type="password"><button type="submit">Sign in</button></form>'));
    }
    if (url.pathname === '/en/account') return send(page('<h1>My account</h1>'));
    if (url.pathname === '/en/cart') {
      return send(
        page(`<style>@media (max-width: 500px) { #checkout { display: none } }</style>
        <h1>Cart</h1>
        <a id="checkout" href="/en/checkout">Checkout</a>
        <button onclick="document.title='added'">Add one</button>
        <button id="pay" onclick="fetch('/order',{method:'POST'})">Place order</button>
        <a href="${outsideUrl}">Our other site</a>
        <script>console.error('cart widget failed'); fetch('/api/broken?key=SECRET123');</script>`),
      );
    }
    return send(page('<h1>Not found</h1>'), 404);
  });
  await new Promise((r) => store.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${store.address().port}`;
  pool = createBrowserPool();
});

after(async () => {
  await pool.close();
  store.close();
  outsider.close();
});

test('open_page: the title, the console errors and the failed requests (without query strings), and a picture', async () => {
  const seen = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop' });
  assert.equal(seen.title, 'Test store');
  assert.ok(seen.consoleErrors.some((e) => /cart widget failed/.test(e)));
  const broken = seen.failedRequests.find((r) => r.path === '/api/broken');
  assert.deepEqual(broken, { method: 'GET', path: '/api/broken', status: 404 });
  assert.ok(!JSON.stringify(seen.failedRequests).includes('SECRET123'), 'no query strings');
  assert.ok(seen.image.length > 500 && seen.image[0] === 0xff, 'a JPEG');
});

test('the phone and the desktop screen differ (the Checkout link is hidden on the phone only)', async () => {
  const visible = async (viewport) => {
    const seen = await browse(pool, { baseUrl: base, path: '/en/cart', viewport, steps: [{ do: 'click', role: 'link', name: 'Checkout' }] });
    return seen.steps[0].ok;
  };
  assert.equal(await visible('desktop'), true);
  assert.equal(await visible('phone'), false);
});

test('act: each step answers ok or failed with the reason, and stops at the first failure', async () => {
  const seen = await browse(pool, {
    baseUrl: base,
    path: '/en/cart',
    viewport: 'desktop',
    steps: [{ do: 'click', text: 'Add one' }, { do: 'click', text: 'A button that is not there' }, { do: 'click', text: 'Add one' }],
  });
  assert.equal(seen.steps.length, 2);
  assert.equal(seen.steps[0].ok, true);
  assert.equal(seen.steps[1].ok, false);
  assert.ok(seen.steps[1].reason.length > 3);
  assert.equal(seen.title, 'added');
});

test('act never presses a place-order button: it stops before paying and no order is made', async () => {
  assert.ok(PAY_BLOCK.test('Place order') && PAY_BLOCK.test('Pay now') && PAY_BLOCK.test('Confirm order') && PAY_BLOCK.test('تأكيد الطلب') && PAY_BLOCK.test('ادفع الآن') && PAY_BLOCK.test('إتمام الطلب'));
  const byText = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop', steps: [{ do: 'click', text: 'Add one' }, { do: 'click', text: 'Place order' }] });
  assert.equal(byText.stoppedBeforePaying, true);
  assert.equal(byText.steps.at(-1).reason, STOPPED_BEFORE_PAYING);
  const byRole = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop', steps: [{ do: 'click', role: 'button', name: 'place' }] });
  assert.equal(byRole.stoppedBeforePaying, true);
  // pressing Enter while the pay button has the focus is the same thing
  const byKey = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop', steps: [{ do: 'press', value: 'Tab' }, { do: 'press', value: 'Tab' }, { do: 'press', value: 'Tab' }, { do: 'press', value: 'Enter' }] });
  assert.ok(byKey.stoppedBeforePaying || hits.orders === 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits.orders, 0, 'the order counter stays 0');
});

test('only the preview origin: a link to another site is not followed, a goto must be a path', async () => {
  const seen = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop', steps: [{ do: 'click', text: 'Our other site' }] });
  assert.equal(hits.outside, 0, 'no request reached the other site');
  assert.equal(seen.atPath, '/en/cart');
  assert.equal(seen.steps[0].ok, false);
  assert.match(seen.steps[0].reason, /leaves the store/);
  const bad = await browse(pool, { baseUrl: base, path: '/en/cart', viewport: 'desktop', steps: [{ do: 'goto', path: `//127.0.0.1:${outsider.address().port}/` }] });
  assert.equal(bad.steps[0].ok, false);
  assert.equal(hits.outside, 0);
  await assert.rejects(browse(pool, { baseUrl: base, path: 'http://evil.test/', viewport: 'phone' }), /starts with/);
});

test('login: the editor types the test customer in; the values never appear in the answer; without them it says so', async () => {
  const seen = await browse(pool, { baseUrl: base, path: '/en', viewport: 'desktop', steps: [{ do: 'login' }], login: () => ({ identifier: '01000000000', password: 'hunter2-secret' }) });
  assert.equal(seen.steps[0].ok, true, JSON.stringify(seen.steps));
  assert.equal(seen.atPath, '/en/account');
  assert.match(hits.signins.at(-1), /identifier=01000000000/);
  assert.ok(!JSON.stringify({ ...seen, image: null }).includes('hunter2-secret'));

  const none = await browse(pool, { baseUrl: base, path: '/en', viewport: 'desktop', steps: [{ do: 'login' }], login: () => null });
  assert.equal(none.steps[0].ok, false);
  assert.equal(none.steps[0].reason, 'No test customer is set up');
});

test('at most 15 steps', async () => {
  await assert.rejects(browse(pool, { baseUrl: base, path: '/en/cart', steps: Array.from({ length: 16 }, () => ({ do: 'wait', ms: 1 })) }), /At most 15/);
});
