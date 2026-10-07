#!/usr/bin/env node
/**
 * Makes the two fixed test pictures for the picture checks (v2 plan §3) in evals/images/:
 *   red-pill-button.png  one red (#e53935), fully rounded "BUY NOW" button on white
 *   broken-cart.png      the store's cart page with a big red box drawn over the Checkout button
 *
 *   node scripts/make-eval-images.mjs [--only red-pill-button|broken-cart]
 *
 * The cart picture needs the eval store copy (EVAL_SC_API_URL, like scripts/eval.mjs); its preview is started on
 * ports 3601+ and stopped again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evals', 'images');
fs.mkdirSync(out, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const browser = await chromium.launch();

if (!only || only === 'red-pill-button') {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
  await page.setContent(`<body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh">
    <button style="background:#e53935;color:#fff;border:0;border-radius:999px;padding:18px 56px;font:700 22px Arial,sans-serif;letter-spacing:1px">BUY NOW</button></body>`);
  await page.screenshot({ path: path.join(out, 'red-pill-button.png') });
  await page.close();
  console.log('red-pill-button.png');
}

if (!only || only === 'broken-cart') {
  if (!process.env.EVAL_SC_API_URL) throw new Error('Set EVAL_SC_API_URL (the store API the eval store copy uses).');
  const config = { ...loadConfig(), dataDir: path.join(root, 'evals', 'data'), previewMode: 'dev', previewPorts: [3601, 3650] };
  const app = createApp(config, { browsers: null, log: () => {} });
  try {
    const { url } = await app.previews.start('eval');
    const base = url.replace(/\/$/, '');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/en`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const accept = page.getByRole('button', { name: /^(accept|accept all)$/i }).first();
    if (await accept.isVisible({ timeout: 1500 }).catch(() => false)) await accept.click().catch(() => {});
    // put one product in the cart, then open the cart page
    await page.getByRole('button', { name: /add to cart/i }).first().click({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.goto(`${base}/en/cart`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const checkout = page.getByRole('link', { name: /checkout/i }).or(page.getByRole('button', { name: /checkout/i })).first();
    await checkout.waitFor({ state: 'visible', timeout: 20_000 });
    const box = await checkout.boundingBox();
    if (!box) throw new Error('no Checkout button on the cart page');
    // a big red box over the Checkout button (and a bit around it)
    await page.evaluate(({ x, y, width, height }) => {
      const mark = document.createElement('div');
      mark.style.cssText = `position:absolute;left:${x - 24 + window.scrollX}px;top:${y - 18 + window.scrollY}px;width:${width + 48}px;height:${height + 36}px;background:rgba(229,57,53,0.55);border:4px solid #b71c1c;border-radius:6px;z-index:2147483647;pointer-events:none`;
      document.body.appendChild(mark);
    }, box);
    await page.screenshot({ path: path.join(out, 'broken-cart.png') });
    console.log('broken-cart.png');
    await context.close();
  } finally {
    await app.previews.stopAll();
  }
}
await browser.close();
