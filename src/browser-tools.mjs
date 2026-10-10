/**
 * Browser tools for finding bugs (v2 plan §4.2): the diagnosing AI can open a page of the store's preview, click
 * through it like a customer and read the page's console errors and failed requests. In-process MCP server like
 * screenshot.mjs, on the same browser pool.
 *
 * Safety:
 *  - only the store's own preview origin: a navigation to any other host is refused (sub-requests, like the store's
 *    own API calls, go through, so errors in them can be read);
 *  - `act` never presses a place-order / pay button: it stops and says so, so a diagnosis can never create an order;
 *  - the test customer's login comes from the editor's environment and is typed by the editor, never given to the AI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { VIEWPORTS, acceptCookies, safePreviewPath, waitForContent } from './screenshot.mjs';

export const OPEN_PAGE_TOOL = 'mcp__editor__open_page';
export const ACT_TOOL = 'mcp__editor__act';
export const STORE_CHANGES_TOOL = 'mcp__editor__store_changes';
export const BROWSER_TOOLS = [OPEN_PAGE_TOOL, ACT_TOOL, STORE_CHANGES_TOOL];

/** Buttons `act` never presses. */
export const PAY_BLOCK = /place order|pay|confirm order|تأكيد الطلب|ادفع|إتمام/i;
export const STOPPED_BEFORE_PAYING = 'Stopped before paying';

const MAX_STEPS = 15;
const MAX_LIST = 20;
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const looseName = (text) => new RegExp(escape(text), 'i');

/** A request's address for the report: no query string (it can carry keys), the host only when it is not the preview. */
function shortPath(url, origin) {
  try {
    const u = new URL(url);
    return u.origin === origin ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return String(url).slice(0, 120);
  }
}

/**
 * Waits until the page has loaded and gone quiet (a dev preview compiles a page on its first visit and only then
 * hydrates it: a click before that does nothing), then a moment for it to react.
 */
async function settle(page, networkMs, activity, minMs = 0) {
  const start = Date.now();
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  // quiet = no request in flight for 700 ms (Playwright's "network idle" gives up too early on a slow server action)
  const until = start + networkMs;
  while (Date.now() < until && (activity.inflight > 0 || Date.now() - activity.last < 700 || Date.now() - start < minMs)) await page.waitForTimeout(100);
}

function locate(page, step, { forFill = false, visibleOnly = false } = {}) {
  // visibleOnly: a hidden copy (e.g. in a closed mini-cart) must not hide the one on the page
  const pick = (locator) => (visibleOnly ? locator.filter({ visible: true }) : locator).first();
  // a link and a button are the same thing to a customer (the store shows one or the other by state): either matches
  const alike = { button: 'link', link: 'button' };
  if (step.role && step.name && alike[step.role]) {
    return pick(page.getByRole(step.role, { name: looseName(step.name) }).or(page.getByRole(alike[step.role], { name: looseName(step.name) })));
  }
  if (step.role && step.name) return pick(page.getByRole(step.role, { name: looseName(step.name) }));
  if (step.role) return pick(page.getByRole(step.role));
  const label = step.name ?? step.text;
  if (!label) return null;
  if (forFill) return pick(page.getByLabel(looseName(label)).or(page.getByPlaceholder(looseName(label))));
  return pick(page.getByText(looseName(label)));
}

/** Signs in with the test customer at the store's own sign-in page. Never returns or logs the values. */
async function signIn(page, origin, creds) {
  if (!creds?.identifier || !creds?.password) throw new Error('No test customer is set up');
  const locale = /^\/(en|ar)(\/|$)/.exec(new URL(page.url()).pathname)?.[1] ?? 'en';
  await page.goto(`${origin}/${locale}/session/signin`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[name="identifier"]').first().fill(creds.identifier, { timeout: 10_000 });
  await page.locator('input[name="password"]').first().fill(creds.password, { timeout: 10_000 });
  await page.locator('form:has(input[name="password"]) button[type="submit"]').first().click({ timeout: 10_000 });
  await page.waitForURL((url) => !/\/session\/signin/.test(url.pathname), { timeout: 20_000 }).catch(() => {});
  if (/\/session\/signin/.test(new URL(page.url()).pathname)) throw new Error('Signing in did not work');
}

/**
 * One visit: open `pagePath`, do the steps, look at the result.
 * @returns {Promise<{ visible: boolean | null, title: string, atPath: string, steps: { do: string, ok: boolean, reason?: string }[], stoppedBeforePaying: boolean, consoleErrors: string[], failedRequests: object[], image: Buffer }>}
 */
export async function browse(pool, { baseUrl, path: pagePath, viewport = 'desktop', steps = [], login = null, expectVisible = null }) {
  const safe = safePreviewPath(pagePath ?? '/en');
  if (!safe) throw new Error('Use a path on the store that starts with "/", e.g. "/en".');
  if (steps.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps at a time.`);
  const origin = new URL(baseUrl).origin;
  const browser = await pool.get();
  const context = await browser.newContext({ viewport: { width: VIEWPORTS[viewport].width, height: VIEWPORTS[viewport].height }, isMobile: VIEWPORTS[viewport].isMobile, deviceScaleFactor: VIEWPORTS[viewport].deviceScaleFactor });
  try {
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.length < MAX_LIST && consoleErrors.push(m.text().slice(0, 300)));
    page.on('pageerror', (e) => consoleErrors.length < MAX_LIST && consoleErrors.push(String(e.message ?? e).slice(0, 300)));
    page.on('response', (r) => {
      if (r.status() >= 400 && failedRequests.length < MAX_LIST) failedRequests.push({ method: r.request().method(), path: shortPath(r.url(), origin), status: r.status() });
    });
    page.on('requestfailed', (r) => {
      // a navigation we refused (or a request a page change cancelled) is not a failure of the store
      if (/ERR_ABORTED/.test(r.failure()?.errorText ?? '') || failedRequests.length >= MAX_LIST) return;
      failedRequests.push({ method: r.method(), path: shortPath(r.url(), origin), status: 0 });
    });
    const activity = { inflight: 0, last: Date.now() };
    page.on('request', () => {
      activity.inflight += 1;
      activity.last = Date.now();
    });
    const done = () => {
      activity.inflight = Math.max(0, activity.inflight - 1);
      activity.last = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    // only the store's own preview: a page that sends the browser to another site is stopped there (204: the page
    // stays where it is)
    let leftTheStore = false;
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && new URL(request.url()).origin !== origin) {
        leftTheStore = true;
        return route.fulfill({ status: 204 });
      }
      return route.continue();
    });

    await page.goto(new URL(safe, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await settle(page, 15_000, activity);
    await waitForContent(page);
    await acceptCookies(page);

    const results = [];
    let stoppedBeforePaying = false;
    for (const step of steps) {
      const result = { do: step.do, ok: true };
      try {
        if (step.do === 'goto') {
          const target = safePreviewPath(step.path);
          if (!target) throw new Error('Use a path on the store that starts with "/".');
          await page.goto(new URL(target, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page, 10_000, activity);
        } else if (step.do === 'wait') {
          await page.waitForTimeout(Math.min(Math.max(Number(step.ms) || 500, 0), 5000));
        } else if (step.do === 'login') {
          await signIn(page, origin, login?.());
        } else if (step.do === 'press') {
          // Enter on a pay button would place the order: same rule as a click
          const focused = await page.evaluate(() => `${document.activeElement?.innerText ?? ''} ${document.activeElement?.getAttribute?.('aria-label') ?? ''}`).catch(() => '');
          if (step.value === 'Enter' && PAY_BLOCK.test(focused)) {
            stoppedBeforePaying = true;
            result.ok = false;
            result.reason = STOPPED_BEFORE_PAYING;
          } else await page.keyboard.press(String(step.value ?? 'Enter'));
        } else if (step.do === 'click' || step.do === 'fill') {
          const target = locate(page, step, { forFill: step.do === 'fill' });
          if (!target) throw new Error('Say which element: a role and name, or a text.');
          if (step.do === 'click') {
            const label = [step.name, step.text, await target.getAttribute('aria-label', { timeout: 3000 }).catch(() => null), await target.innerText({ timeout: 3000 }).catch(() => '')].filter(Boolean).join(' ');
            if (PAY_BLOCK.test(label)) {
              stoppedBeforePaying = true;
              result.ok = false;
              result.reason = STOPPED_BEFORE_PAYING;
            } else {
              // a fixed bottom bar, a cookie banner or a chat bubble can sit on top of the button: then the tap is
              // sent to the button itself (the pay check above has already run)
              await target.click({ timeout: 8000 }).catch(async (error) => {
                if (!(await target.isVisible().catch(() => false))) throw error;
                await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await target.dispatchEvent('click');
              });
            }
          } else await target.fill(String(step.value ?? ''), { timeout: 8000 });
        } else throw new Error(`Unknown step "${step.do}".`);
        // a tap often saves its result a moment later with no request at first (e.g. a cart kept in the browser):
        // leaving the page at once would lose it
        if (result.ok) await settle(page, 8000, activity, step.do === 'click' ? 1500 : 0);
        if (result.ok && leftTheStore) {
          result.ok = false;
          result.reason = 'That leaves the store preview, so it was not opened.';
        }
      } catch (error) {
        result.ok = false;
        result.reason = String(error.message ?? error).split('\n')[0].slice(0, 200);
      }
      results.push(result);
      if (!result.ok) break;
    }

    // the re-check of a fixed bug: is the thing that was missing there now?
    let visible = null;
    if (expectVisible && results.every((r) => r.ok)) {
      // a page often fills in after it loads (a cart is fetched by the browser): give it a moment to appear
      const target = locate(page, expectVisible, { visibleOnly: true });
      visible = target ? await target.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false) : null;
    }
    // a phone view shifted sideways (the store's rails spill) shows nearly nothing: back to where a shopper starts
    await page.evaluate(() => window.scrollTo(0, window.scrollY)).catch(() => {});
    const image = await page.screenshot({ type: 'jpeg', quality: 70 });
    return { visible, title: (await page.title().catch(() => '')).slice(0, 120), atPath: new URL(page.url()).pathname, steps: results, stoppedBeforePaying, consoleErrors, failedRequests, image };
  } finally {
    await context.close().catch(() => {});
    pool.release();
  }
}

const StepSchema = z.object({
  do: z.enum(['click', 'fill', 'press', 'goto', 'wait', 'login']),
  text: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  ms: z.number().optional(),
});

/**
 * The tool server for one diagnosing run.
 * `storeChanges()` answers the AI Designer's commits on the store since the starter; `onShot(file)` is told about
 * every saved screenshot, `onStep(text)` about every look or try (plain words, before it happens), `onSeen` about the
 * errors a page showed (they go into a team report).
 */
export function browserToolsServer({ pool, baseUrl, saveDir, storeChanges, login = null, onShot = () => {}, onStep = () => {}, onSeen = () => {}, visit = browse }) {
  let index = 0;
  const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
  const fail = (message) => ({ content: [text(message)], isError: true });

  async function run(args, steps) {
    const pagePath = safePreviewPath(args.path ?? '/en');
    if (!pagePath) return fail('Use a path on the store that starts with "/", e.g. "/en".');
    const viewport = args.viewport ?? 'phone';
    try {
      index += 1;
      onStep(steps.length ? `Trying the steps on ${pagePath} on ${viewport}` : `Opening ${pagePath} on ${viewport}`);
      const seen = await visit(pool, { baseUrl: await baseUrl(), path: pagePath, viewport, steps, login });
      await fs.mkdir(saveDir, { recursive: true });
      const file = `${String(index).padStart(2, '0')}-${viewport}-${pagePath.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'home'}.jpg`;
      await fs.writeFile(path.join(saveDir, file), seen.image);
      onShot(file);
      onSeen({ consoleErrors: seen.consoleErrors, failedRequests: seen.failedRequests });
      const report = {
        title: seen.title,
        now_at: seen.atPath,
        ...(steps.length ? { steps: seen.steps } : {}),
        ...(seen.stoppedBeforePaying ? { note: `${STOPPED_BEFORE_PAYING}: the diagnosis never places an order.` } : {}),
        console_errors: seen.consoleErrors,
        failed_requests: seen.failedRequests,
      };
      return { content: [{ type: 'image', data: seen.image.toString('base64'), mimeType: 'image/jpeg' }, text(report)] };
    } catch (error) {
      return fail(`The page could not be opened: ${String(error.message ?? error).slice(0, 300)}`);
    }
  }

  return createSdkMcpServer({
    name: 'editor',
    version: '1.0.0',
    timeout: 330_000,
    tools: [
      tool(
        'open_page',
        'Open a page of the store preview in a browser (like a customer on that screen) and look at it. Returns a screenshot, the page title, the console errors and the failed requests of the page.',
        { path: z.string().describe('Page path, e.g. "/en", "/en/cart"').optional(), viewport: z.enum(['phone', 'desktop']).optional() },
        async (args) => run(args, []),
      ),
      tool(
        'act',
        `Open a page and do up to ${MAX_STEPS} steps like a customer (click, fill, press, goto, wait, login), then look at the result. Each step answers ok or failed with the reason. A fresh browser is used every time, so repeat what you need (e.g. add a product to the cart) in the steps. It never presses a place-order or pay button. {do:"login"} signs in with the test customer.`,
        {
          path: z.string().describe('Where to start, e.g. "/en"').optional(),
          viewport: z.enum(['phone', 'desktop']).optional(),
          steps: z.array(StepSchema).max(MAX_STEPS),
        },
        async (args) => run(args, args.steps ?? []),
      ),
      tool('store_changes', "The changes the AI Designer made to this store since the starter: commit, date, title and files, newest first (at most 30). Use it to see whether a store change could have caused the bug.", {}, async () => {
        try {
          return { content: [text(await storeChanges())] };
        } catch (error) {
          return fail(`The changes could not be listed: ${String(error.message ?? error).slice(0, 200)}`);
        }
      }),
    ],
  });
}
