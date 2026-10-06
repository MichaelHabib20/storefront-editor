/**
 * Eyes for the editing AI (plan step 5): screenshots of the store's preview at phone or desktop size, offered to
 * the agent as an in-process tool. Every shot is also saved with the run, for us (debugging, evals).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SCREENSHOT_TOOL = 'mcp__editor__screenshot';

const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  desktop: { width: 1366, height: 900, isMobile: false, deviceScaleFactor: 1 },
};

/** A path on the preview: "/", "/en", "/en/p/slug?x=1". Never another host. */
export function safePreviewPath(value) {
  const p = typeof value === 'string' && value.trim() ? value.trim() : '/';
  if (!p.startsWith('/') || p.startsWith('//') || /[\s\\]/.test(p)) return null;
  return p;
}

/** One headless browser, opened on the first shot and closed after a quiet minute. */
export function createBrowserPool({ launch = async () => (await import('playwright')).chromium.launch(), idleMs = 60_000 } = {}) {
  let browser = null;
  let timer = null;
  return {
    async get() {
      clearTimeout(timer);
      if (!browser || !browser.isConnected()) browser = await launch();
      timer = setTimeout(() => this.close(), idleMs);
      timer.unref?.();
      return browser;
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
export async function takeScreenshot(pool, { baseUrl, path: pagePath, viewport = 'desktop', fullPage = false, saveDir, index }) {
  const browser = await pool.get();
  const context = await browser.newContext({ viewport: { width: VIEWPORTS[viewport].width, height: VIEWPORTS[viewport].height }, isMobile: VIEWPORTS[viewport].isMobile, deviceScaleFactor: VIEWPORTS[viewport].deviceScaleFactor });
  try {
    const page = await context.newPage();
    await page.goto(new URL(pagePath, baseUrl).toString(), { waitUntil: 'load', timeout: 120_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const image = await page.screenshot({ type: 'jpeg', quality: 70, fullPage });
    await fs.mkdir(saveDir, { recursive: true });
    const file = `${String(index).padStart(2, '0')}-${viewport}-${pagePath.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'home'}.jpg`;
    await fs.writeFile(path.join(saveDir, file), image);
    return { data: image.toString('base64'), file };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The tool server for one run. `baseUrl()` gives the preview's local address (the preview runs while the agent works).
 * `onShot(file)` is told about every saved screenshot.
 */
export function screenshotServer({ pool, baseUrl, saveDir, onShot = () => {}, shoot = takeScreenshot }) {
  let index = 0;
  return createSdkMcpServer({
    name: 'editor',
    version: '1.0.0',
    tools: [
      tool(
        'screenshot',
        'Look at a page of the store preview as the owner will see it. Use it before changing anything and again after your change (both phone and desktop when the layout matters). Only say things about the result that you have seen.',
        {
          path: z.string().describe('Page path on the store, e.g. "/en", "/ar", "/en/p/some-product", "/en/cart". Default "/en".').optional(),
          viewport: z.enum(['phone', 'desktop']).describe('Screen size').optional(),
          fullPage: z.boolean().describe('The whole page instead of the first screen').optional(),
        },
        async (args) => {
          const pagePath = safePreviewPath(args.path ?? '/en');
          if (!pagePath) return { content: [{ type: 'text', text: 'Use a path on the store that starts with "/", e.g. "/en".' }], isError: true };
          try {
            index += 1;
            const shot = await shoot(pool, { baseUrl: baseUrl(), path: pagePath, viewport: args.viewport ?? 'desktop', fullPage: !!args.fullPage, saveDir, index });
            onShot(shot.file);
            return {
              content: [
                { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
                { type: 'text', text: `Screenshot of ${pagePath} (${args.viewport ?? 'desktop'}).` },
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
