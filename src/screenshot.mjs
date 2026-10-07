/**
 * Eyes for the editing AI (plan step 5): screenshots of the store's preview at phone or desktop size, offered to
 * the agent as an in-process tool. Every shot is also saved with the run, for us (debugging, evals).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SCREENSHOT_TOOL = 'mcp__editor__screenshot';

export const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  desktop: { width: 1366, height: 900, isMobile: false, deviceScaleFactor: 1 },
};

/** A path on the preview: "/", "/en", "/en/some-product?x=1". Never another host. */
export function safePreviewPath(value) {
  const p = typeof value === 'string' && value.trim() ? value.trim() : '/';
  if (!p.startsWith('/') || p.startsWith('//') || /[\s\\]/.test(p)) return null;
  return p;
}

/**
 * One headless browser, opened on the first shot and closed after a quiet minute — counted from the end of the last
 * shot, never while one is still running (a page compiling after an edit can take more than a minute).
 */
export function createBrowserPool({ launch = async () => (await import('playwright')).chromium.launch(), idleMs = 60_000 } = {}) {
  let browser = null;
  let timer = null;
  let active = 0;
  return {
    /** Takes the browser for one shot; call release() when the shot is done. */
    async get() {
      clearTimeout(timer);
      active += 1;
      try {
        if (!browser || !browser.isConnected()) browser = await launch();
        return browser;
      } catch (error) {
        active -= 1;
        throw error;
      }
    },
    release() {
      active = Math.max(0, active - 1);
      if (active === 0) {
        clearTimeout(timer);
        timer = setTimeout(() => this.close(), idleMs);
        timer.unref?.();
      }
    },
    async close() {
      clearTimeout(timer);
      const current = browser;
      browser = null;
      await current?.close().catch(() => {});
    },
  };
}

/**
 * Takes one screenshot of `baseUrl + path` and saves it in `saveDir`.
 * @returns {Promise<{ data: string, file: string }>} base64 JPEG and the saved file name
 */
/** Closes the cookie banner if it covers the page (English or Arabic button). */
export async function acceptCookies(page) {
  const button = page.getByRole('button', { name: /^(accept|accept all|قبول|موافق)$/i }).first();
  if (await button.isVisible({ timeout: 1000 }).catch(() => false)) await button.click({ timeout: 2000 }).catch(() => {});
}

export async function takeScreenshot(pool, { baseUrl, path: pagePath, viewport = 'desktop', fullPage = false, scrollTo = null, saveDir, index }) {
  const browser = await pool.get();
  try {
    const shoot = async () => {
      const context = await browser.newContext({ viewport: { width: VIEWPORTS[viewport].width, height: VIEWPORTS[viewport].height }, isMobile: VIEWPORTS[viewport].isMobile, deviceScaleFactor: VIEWPORTS[viewport].deviceScaleFactor });
      try {
        const page = await context.newPage();
        // the content is what counts; images and late scripts get a little longer but never block the shot
        await page.goto(new URL(pagePath, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        await acceptCookies(page);
        if (scrollTo) {
          // the screen around the first element showing this text (e.g. "Add to cart")
          const target = page.getByText(scrollTo, { exact: false }).first();
          await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await page.evaluate(() => window.scrollBy(0, -120)).catch(() => {});
          await page.waitForTimeout(500);
        }
        return await page.screenshot({ type: 'jpeg', quality: 70, fullPage: fullPage && !scrollTo });
      } finally {
        await context.close().catch(() => {});
      }
    };
    // a dev preview may be reloading right after an edit: one more try
    const image = await shoot().catch(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return shoot();
    });
    await fs.mkdir(saveDir, { recursive: true });
    const file = `${String(index).padStart(2, '0')}-${viewport}-${pagePath.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'home'}.jpg`;
    await fs.writeFile(path.join(saveDir, file), image);
    return { data: image.toString('base64'), file };
  } finally {
    pool.release();
  }
}

/**
 * The tool server for one run. `baseUrl()` gives the preview's local address (the preview runs while the agent works).
 * `onShot(file)` is told about every saved screenshot, `onStep(text)` about every look (before it is taken).
 */
export function screenshotServer({ pool, baseUrl, saveDir, onShot = () => {}, onStep = () => {}, shoot = takeScreenshot }) {
  let index = 0;
  return createSdkMcpServer({
    name: 'editor',
    version: '1.0.0',
    // a page compiling after an edit, plus one retry
    timeout: 330_000,
    tools: [
      tool(
        'screenshot',
        'Look at a page of the store preview as the owner will see it. Use it before changing anything and again after your change (both phone and desktop when the layout matters). Only say things about the result that you have seen.',
        {
          path: z.string().describe('Page path on the store, e.g. "/en", "/ar", "/en/some-product" (a product), "/en/product/skin-care" (a category), "/en/cart". Default "/en".').optional(),
          viewport: z.enum(['phone', 'desktop']).describe('Screen size').optional(),
          fullPage: z.boolean().describe('The whole page shrunk into one image (small: details like corners are hard to see)').optional(),
          scrollTo: z.string().describe('Scroll to the first element showing this text and shoot that screen, e.g. "Add to cart" or a section title. Best for checking a detail.').optional(),
        },
        async (args) => {
          const pagePath = safePreviewPath(args.path ?? '/en');
          if (!pagePath) return { content: [{ type: 'text', text: 'Use a path on the store that starts with "/", e.g. "/en".' }], isError: true };
          try {
            index += 1;
            onStep(`Looking at ${pagePath} on ${args.viewport ?? 'desktop'}`);
            const shot = await shoot(pool, { baseUrl: await baseUrl(), path: pagePath, viewport: args.viewport ?? 'desktop', fullPage: !!args.fullPage, scrollTo: args.scrollTo ?? null, saveDir, index });
            onShot(shot.file);
            return {
              content: [
                { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
                { type: 'text', text: `Screenshot of ${pagePath} (${args.viewport ?? 'desktop'}${args.scrollTo ? `, at "${args.scrollTo}"` : ''}).` },
              ],
            };
          } catch (error) {
            return { content: [{ type: 'text', text: `The preview could not be shown: ${String(error.message ?? error).slice(0, 300)}` }], isError: true };
          }
        },
      ),
    ],
  });
}
