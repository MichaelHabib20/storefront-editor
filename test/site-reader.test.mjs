/**
 * The site reader against a local fixture "shop" (served under a made-up public name that the test's browser maps to
 * the local server): the values it reads from computed styles, the sections it finds, and that no internal address is
 * ever requested — not directly, not through a redirect, not by the page's own images, scripts or sockets.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { createFetchGuard, UrlRefused } from '../src/fetch-guard.mjs';
import { mapFont } from '../src/fonts.mjs';
import { createBrowserPool } from '../src/screenshot.mjs';
import { createSiteReader } from '../src/site-reader.mjs';

const PUBLIC_IP = '93.184.216.34';
let shop, spy, pool, reader, spyPort;
const spyHits = [];

const page = ({ announce = true } = {}) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture Shop</title>
<style>
  body { margin: 0; background: #ffffff; color: #222222; font: 400 16px/1.5 "Inter", sans-serif; }
  h1 { font: 700 44px/1.1 "Playfair Display", Georgia, serif; color: #111111; margin: 0 0 12px; }
  h2 { font: 600 28px/1.2 "Playfair Display", serif; margin: 0 0 8px; }
  a { color: #0066cc; }
  .announcement-bar { background: #e65100; color: #fff; text-align: center; padding: 8px; font-size: 13px; }
  header { background: #111111; color: #fff; padding: 18px 24px; display: flex; gap: 24px; }
  header a { color: #fff; }
  section { padding: 80px 32px; }
  .hero { background: #fafafa; min-height: 320px; }
  .btn { display: inline-block; background: #e65100; color: #fff; border: 0; border-radius: 24px; padding: 14px 28px; text-transform: uppercase; text-decoration: none; font-weight: 600; margin-right: 12px; }
  .btn-outline { background: transparent; color: #e65100; border: 2px solid #e65100; }
  .categories .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .tile { height: 120px; background: #eee; border-radius: 8px; }
  .product-grid .items { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 12px; }
  .card img { width: 100%; height: 100px; background: #ddd; }
  .sale { color: #d50000; font-weight: 700; }
  .brands .row { display: flex; gap: 24px; }
  .brands img { width: 90px; height: 40px; background: #ccc; }
  .newsletter input { border: 1px solid #999; border-radius: 6px; padding: 10px; }
  footer { background: #111111; color: #ccc; padding: 40px 32px; }
  @media (max-width: 600px) { .product-grid .items { grid-template-columns: repeat(2, 1fr); } .categories .tiles { grid-template-columns: 1fr; } section { padding: 40px 16px; } }
</style></head><body>
${announce ? '<div class="announcement-bar">Free delivery this week</div>' : ''}
<header><a href="/">Shop</a><a href="/a">Women</a><a href="/b">Men</a></header>
<main>
  <section class="hero"><h1>Spring is here</h1><p>New season, new looks.</p><a class="btn" href="/new">Shop now</a><a class="btn btn-outline" href="/sale">See the sale</a></section>
  <section class="categories"><h2>Shop by category</h2><div class="tiles"><div class="tile"></div><div class="tile"></div><div class="tile"></div></div></section>
  <section class="product-grid"><h2>Bestsellers</h2><div class="items">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<div class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><a href="/p/${n}">Product ${n}</a><div class="sale">-20%</div></div>`).join('')}</div></section>
  <section class="brands"><h2>Our brands</h2><div class="row">${[1, 2, 3, 4, 5].map(() => '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">').join('')}</div></section>
  <section class="newsletter"><h2>Stay in touch</h2><input type="email" placeholder="Email"> <button class="btn">Subscribe</button></section>
</main>
<footer><p>Contact us</p><a href="/terms">Terms</a></footer>
<img src="http://127.0.0.1:${spyPort}/tracking-pixel.gif" alt="">
<script>try { fetch('http://127.0.0.1:${spyPort}/from-script'); new WebSocket('ws://127.0.0.1:${spyPort}/socket'); } catch (e) {}</script>
</body></html>`;

before(async () => {
  spy = http.createServer((req, res) => {
    spyHits.push(req.url);
    res.end('hit');
  });
  await new Promise((r) => spy.listen(0, '127.0.0.1', r));
  spyPort = spy.address().port;
  shop = http.createServer((req, res) => {
    if (req.url === '/go-inside') {
      res.writeHead(302, { location: `http://127.0.0.1:${spyPort}/redirected` });
      return res.end();
    }
    if (req.url === '/redirect-to-name') {
      res.writeHead(302, { location: `http://sneaky.test/` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page());
  });
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));
  const shopPort = shop.address().port;
  // the made-up public names are reached through the local servers; the guard believes they are public
  pool = createBrowserPool({ launch: async () => (await import('playwright')).chromium.launch({ proxy: { server: 'per-context' } }) });
  const guard = createFetchGuard({ resolve: async (host) => (host === 'fixture.test' ? [PUBLIC_IP] : host === 'sneaky.test' ? ['10.1.2.3'] : []) });
  const dial = (ip, port, host) => net.connect({ host: '127.0.0.1', port: host === 'fixture.test' ? shopPort : spyPort });
  reader = createSiteReader({ pool, guard, dial, timeoutMs: 120_000 });
});

after(async () => {
  await reader.close();
  await pool.close();
  shop.close();
  spy.close();
});

test('style: colours, fonts, sizes, shapes and spacing come from computed styles', async () => {
  const seen = await reader.read({ url: 'http://fixture.test/', mode: 'style' });
  const { style } = seen;
  assert.equal(seen.host, 'fixture.test');
  assert.deepEqual(style.colours.primary, { hex: '#e65100', seen: 'buttons' });
  assert.equal(style.colours.background.hex, '#ffffff');
  assert.equal(style.colours.text.hex, '#222222');
  assert.ok(style.colours.accent, 'a vivid colour is found (the sale labels)');
  assert.equal(style.colours.accent.hex, '#d50000');
  assert.deepEqual(style.fonts.heading, { theirs: 'Playfair Display', ours: 'Playfair Display', exact: true });
  assert.equal(style.fonts.body.theirs, 'Inter');
  assert.equal(style.sizes.h1, 44);
  assert.equal(style.sizes.h2, 28);
  assert.equal(style.sizes.body, 16);
  assert.equal(style.sizes.lineHeight, 1.5);
  assert.equal(style.shapes.buttonRadius, 24);
  assert.equal(style.shapes.inputRadius, 6);
  assert.equal(style.shapes.cardRadius, 12);
  assert.equal(style.shapes.buttonFill, 'filled');
  assert.equal(style.shapes.buttonUppercase, true);
  assert.equal(style.shapes.buttonPaddingV, 14);
  assert.equal(style.shapes.buttonPaddingH, 28);
  assert.equal(style.spacing, 'airy');
  assert.equal(seen.layout, null, 'no layout unless asked');
  assert.ok(seen.screenshot.length > 1000 && seen.screenshot[0] === 0xff, 'a screenshot for the owner');
});

test('layout: the sections top to bottom as types only, with columns on desktop and phone', async () => {
  const { layout } = await reader.read({ url: 'http://fixture.test/', mode: 'style_layout' });
  assert.deepEqual(layout.map((s) => s.type), ['announcement_bar', 'header', 'hero_banner', 'category_tiles', 'product_grid', 'brand_logos', 'newsletter', 'footer']);
  assert.deepEqual(layout.find((s) => s.type === 'product_grid').columns, { desktop: 4, phone: 2 });
  assert.deepEqual(layout.find((s) => s.type === 'category_tiles').columns, { desktop: 3, phone: 1 });
  assert.ok(JSON.stringify(layout).length < 1500, 'types and numbers, no text');
  assert.ok(!JSON.stringify(layout).includes('Bestsellers'));
});

test('nothing the page says is returned: no text, only validated values', async () => {
  const seen = await reader.read({ url: 'http://fixture.test/', mode: 'style_layout' });
  const text = JSON.stringify({ ...seen, screenshot: null });
  for (const phrase of ['Spring is here', 'Free delivery', 'Bestsellers', 'Contact us', 'New season', 'Product 1']) assert.ok(!text.includes(phrase), phrase);
  assert.match(seen.style.colours.primary.hex, /^#[0-9a-f]{6}$/);
});

test('blocked addresses are refused and no request reaches them', async () => {
  const before = spyHits.length;
  for (const url of [`http://127.0.0.1:${spyPort}/`, 'http://localhost', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'ftp://example.com']) {
    await assert.rejects(reader.read({ url, mode: 'style' }), UrlRefused, url);
  }
  assert.equal(spyHits.length, before, 'the counting server saw nothing');
});

test('a public address that redirects inside is stopped at the redirect', async () => {
  const before = spyHits.length;
  await assert.rejects(reader.read({ url: 'http://fixture.test/go-inside', mode: 'style' }), /could not be opened/);
  await assert.rejects(reader.read({ url: 'http://fixture.test/redirect-to-name', mode: 'style' }), /could not be opened/);
  assert.equal(spyHits.length, before, 'no request reached the internal address');
});

test("the page's own images, scripts and sockets cannot reach an internal address either", async () => {
  spyHits.length = 0;
  await reader.read({ url: 'http://fixture.test/', mode: 'style' });
  assert.deepEqual(spyHits, [], 'the tracking pixel, the script fetch and the socket never arrived');
});

test('closest Google Font: exact, aliased, generic and Arabic', () => {
  assert.deepEqual(mapFont('"Playfair Display", Georgia, serif'), { theirs: 'Playfair Display', ours: 'Playfair Display', exact: true });
  assert.equal(mapFont('"Helvetica Neue", Helvetica, Arial, sans-serif').ours, 'Inter');
  assert.equal(mapFont('Gotham, sans-serif').ours, 'Montserrat');
  assert.equal(mapFont('"Proxima Nova", sans-serif').ours, 'Nunito Sans');
  assert.equal(mapFont('"Brandon Text Web", Georgia, serif').ours, 'Lora', 'a name we do not know falls to the next known one');
  assert.equal(mapFont('SomethingRare, serif').ours, 'Merriweather');
  assert.equal(mapFont('SomethingRare, monospace').ours, 'Roboto Mono');
  assert.equal(mapFont('"Montserrat Variable", sans-serif').ours, 'Montserrat');
  assert.equal(mapFont('"My Arabic Kufi", sans-serif').ours, 'Cairo');
  assert.equal(mapFont('Cairo, sans-serif').exact, true);
  assert.equal(mapFont('').ours, 'Inter');
  assert.equal(mapFont('SomethingRare').theirs, 'SomethingRare');
});
