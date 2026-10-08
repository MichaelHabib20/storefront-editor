/**
 * Read a website (v2 plan §5.3): opens a public page in the headless browser and reads how it LOOKS from computed
 * styles — colours, fonts, sizes, corner radii, spacing, and (optionally) the sections of the page as types only.
 * Nothing the page says (its text) is ever returned: only validated, structured values (hex colours, numbers, font
 * names from a fixed list, section types). That is what keeps another site's words away from the editing AI.
 *
 * Every request of the page goes through the fetch guard (src/guard-proxy.mjs: the browser's only way out), so a link, a
 * redirect or a script cannot make it reach an internal address.
 */
import { z } from 'zod';
import { mapFont } from './fonts.mjs';
import { UrlRefused } from './fetch-guard.mjs';
import { createGuardProxy } from './guard-proxy.mjs';
import { VIEWPORTS, acceptCookies } from './screenshot.mjs';

export const SECTION_TYPES = ['announcement_bar', 'header', 'hero_banner', 'category_tiles', 'product_rail', 'product_grid', 'brand_logos', 'text_block', 'newsletter', 'footer', 'other'];
const SEEN = ['buttons', 'links', 'headings', 'header background', 'page background', 'body text', 'sale labels'];

export class SiteReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---- what the page gives us, and what we keep of it ----

const Hex = z.string().regex(/^#[0-9a-f]{6}$/);
const Colour = z.object({ hex: Hex, seen: z.enum(SEEN) });
const Px = (min, max) => z.number().min(min).max(max).transform((n) => Math.round(n * 100) / 100);
const Layout = z.array(z.object({ type: z.enum(SECTION_TYPES), columns: z.object({ desktop: z.number().int().min(1).max(12), phone: z.number().int().min(1).max(12) }) })).min(1).max(30);

const Style = z.object({
  colours: z.object({ background: Colour, text: Colour, primary: Colour, secondary: Colour, accent: Colour }).partial(),
  fonts: z.object({ heading: z.object({ theirs: z.string().max(60), ours: z.string().max(40), exact: z.boolean() }), body: z.object({ theirs: z.string().max(60), ours: z.string().max(40), exact: z.boolean() }) }).partial(),
  sizes: z.object({ h1: Px(10, 160), h2: Px(10, 120), body: Px(8, 40), lineHeight: Px(0.8, 3) }).partial(),
  shapes: z
    .object({
      buttonRadius: Px(0, 999),
      inputRadius: Px(0, 999),
      cardRadius: Px(0, 999),
      buttonFill: z.enum(['filled', 'outlined']),
      buttonUppercase: z.boolean(),
      buttonPaddingV: Px(0, 80),
      buttonPaddingH: Px(0, 160),
    })
    .partial(),
  spacing: z.enum(['tight', 'normal', 'airy']).nullable(),
});

const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const distance = (a, b) => {
  const x = fromHex(a);
  const y = fromHex(b);
  return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
};
const saturation = (hex) => {
  const { r, g, b } = fromHex(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
const median = (list) => {
  const sorted = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** Counts hex colours, most common first. */
function tally(list) {
  const counts = new Map();
  for (const hex of list) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex, count]) => ({ hex, count }));
}

// ---- in the page (these functions run inside the browser; they use nothing from this file) ----

/** Styles of the visible parts of the page. Returns plain strings and numbers. */
function collectStyle() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && r.top < 7000 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  /** any CSS colour (rgb, hsl, oklch, lab, color-mix...) as { r, g, b, a } */
  const rgba = (value) => {
    if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? (parseFloat(x) / 100) : parseFloat(x)));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    } catch {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
  };
  const px = (v) => {
    if (typeof v === 'string' && v.endsWith('%')) return 999;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const bodyStyle = getComputedStyle(document.body);
  const htmlStyle = getComputedStyle(document.documentElement);
  let page = rgba(bodyStyle.backgroundColor);
  if (page.a < 0.5) page = rgba(htmlStyle.backgroundColor);
  if (page.a < 0.5) page = { r: 255, g: 255, b: 255, a: 1 };

  const first = (selector) => [...document.querySelectorAll(selector)].find(visible) ?? null;
  const textStyle = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const size = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? size * 1.2 : px(cs.lineHeight);
    return { family: cs.fontFamily, size, lineHeight: lh && size ? lh / size : null, colour: rgba(cs.color) };
  };
  const h1 = first('h1') ?? first('h2');
  const h2 = [...document.querySelectorAll('h2')].filter(visible)[h1?.tagName === 'H2' ? 1 : 0] ?? null;

  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i]')]
    .filter(visible)
    .slice(0, 80)
    .map((el) => {
      const cs = getComputedStyle(el);
      return {
        bg: rgba(cs.backgroundColor),
        colour: rgba(cs.color),
        border: rgba(cs.borderTopColor),
        borderWidth: px(cs.borderTopWidth) ?? 0,
        radius: px(cs.borderTopLeftRadius),
        upper: cs.textTransform === 'uppercase',
        padV: px(cs.paddingTop),
        padH: px(cs.paddingLeft),
        w: el.getBoundingClientRect().width,
      };
    })
    .filter((b) => b.w >= 40);
  const links = [...document.querySelectorAll('a')].filter(visible).slice(0, 120).map((el) => rgba(getComputedStyle(el).color));
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 30).map((el) => rgba(getComputedStyle(el).color));
  const sale = [...document.querySelectorAll('[class*="sale" i], [class*="badge" i], [class*="discount" i], [class*="promo" i], [class*="offer" i], [class*="price" i]')]
    .filter(visible)
    .slice(0, 50)
    .flatMap((el) => {
      const cs = getComputedStyle(el);
      return [rgba(cs.backgroundColor), rgba(cs.color)];
    });
  const header = first('header') ?? first('[role="banner"]');
  const headerBg = header ? rgba(getComputedStyle(header).backgroundColor) : null;
  const inputs = [...document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], input[type="tel"], select, textarea')].filter(visible).slice(0, 20).map((el) => px(getComputedStyle(el).borderTopLeftRadius));
  const cards = [...document.querySelectorAll('[class*="card" i], [class*="product" i], [class*="tile" i]')]
    .filter((el) => visible(el) && el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().width < 700)
    .slice(0, 30)
    .map((el) => px(getComputedStyle(el).borderTopLeftRadius));
  const images = [...document.querySelectorAll('img')].filter((el) => visible(el) && el.getBoundingClientRect().width > 100).slice(0, 20).map((el) => px(getComputedStyle(el).borderTopLeftRadius));

  return {
    page,
    text: rgba(bodyStyle.color),
    body: textStyle(document.body),
    h1: textStyle(h1),
    h2: textStyle(h2),
    buttons,
    links,
    headings,
    sale,
    headerBg,
    inputs,
    cards: cards.length ? cards : images,
  };
}

/** The sections of the page, top to bottom, as types and column counts. Uses structure and class names only; returns no text. */
function collectLayout() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const sig = (el) => `${el.tagName} ${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('role') ?? ''}`.toLowerCase().slice(0, 300);
  const heightOf = (el) => el.getBoundingClientRect().height;
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  const header = document.querySelector('header') ?? document.querySelector('[role="banner"]') ?? null;
  const footer = document.querySelector('footer') ?? document.querySelector('[role="contentinfo"]') ?? null;
  let root = document.querySelector('main') ?? document.body;
  // wrappers: go into the one big child until there are several blocks side by side
  for (let depth = 0; depth < 4; depth++) {
    const kids = [...root.children].filter((el) => visible(el) && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName));
    if (kids.length >= 3) break;
    const big = kids.sort((a, b) => b.children.length - a.children.length)[0];
    if (!big || big.children.length < 2) break;
    root = big;
  }
  const blocks = [...root.children].filter((el) => visible(el) && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'DIALOG'].includes(el.tagName) && heightOf(el) >= 40 && getComputedStyle(el).position !== 'fixed');
  const inRoot = (el) => el && blocks.some((b) => b === el || b.contains(el));
  const list = [];
  const top = [...document.body.querySelectorAll('[class*="announcement" i], [class*="promo-bar" i], [class*="topbar" i], [class*="top-bar" i], [class*="notice-bar" i], [class*="ticker" i]')].find((el) => visible(el) && el.getBoundingClientRect().top < 120 && heightOf(el) < 120);
  if (top && !(header && top.contains(header))) list.push({ el: top, forced: 'announcement_bar' });
  if (header && !inRoot(header)) list.push({ el: header, forced: 'header' });
  for (const el of blocks) {
    if (list.some((x) => x.el === el || x.el.contains(el) || el.contains(x.el))) continue;
    list.push({ el, forced: null });
  }
  if (footer && !list.some((x) => x.el === footer || x.el.contains(footer) || footer.contains(x.el))) list.push({ el: footer, forced: 'footer' });

  const columnsOf = (section) => {
    let best = 1;
    let bestScore = 0;
    const containers = [section, ...section.querySelectorAll('ul, ol, div, section')].slice(0, 200);
    for (const container of containers) {
      const kids = [...container.children].filter(visible);
      if (kids.length < 2 || kids.length > 40) continue;
      const widths = kids.map((k) => k.getBoundingClientRect().width);
      const mid = widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)];
      const alike = kids.filter((k) => Math.abs(k.getBoundingClientRect().width - mid) <= mid * 0.2);
      if (alike.length < 2) continue;
      const rowTop = alike[0].getBoundingClientRect().top;
      const inRow = alike.filter((k) => Math.abs(k.getBoundingClientRect().top - rowTop) < 6).length;
      const score = alike.length * 10 + inRow;
      if (score > bestScore) {
        bestScore = score;
        best = inRow;
      }
    }
    return Math.max(1, Math.min(12, best));
  };

  const classify = (el, index) => {
    const s = sig(el);
    const imgs = el.querySelectorAll('img, picture, video').length;
    const links = el.querySelectorAll('a').length;
    const paragraphs = el.querySelectorAll('p').length;
    const hasEmail = !!el.querySelector('input[type="email"], input[name*="email" i]');
    const scrolls = [el, ...el.querySelectorAll('*')].slice(0, 150).some((x) => {
      const cs = getComputedStyle(x);
      return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && x.scrollWidth > x.clientWidth + 20;
    });
    const h = heightOf(el);
    if (el.tagName === 'FOOTER' || /footer|contentinfo/.test(s)) return 'footer';
    if (el.tagName === 'HEADER' || /(^|\W)(site-)?header(\W|$)|banner/.test(s) && index === 0 && h < 260) return 'header';
    if (/announce|promo-?bar|top-?bar|notice-?bar|ticker/.test(s) && h < 120) return 'announcement_bar';
    if (hasEmail || /newsletter|subscribe|signup/.test(s)) return 'newsletter';
    if (/brand|logo|partner|as-seen|trusted/.test(s) && imgs >= 3) return 'brand_logos';
    if (/categor|collection|shop-by|department/.test(s)) return 'category_tiles';
    if (/hero|banner|masthead|jumbotron|slideshow|slider|main-slide/.test(s) || (index <= 3 && h >= 300 && imgs <= 3 && links <= 4)) return 'hero_banner';
    if (/product|best-?sell|featured|trending|new-arriv|arrivals|deals|recommend|rail|carousel|swiper/.test(s)) return scrolls || /carousel|slider|rail|swiper/.test(s) ? 'product_rail' : 'product_grid';
    if (imgs >= 6 && links >= 6) return scrolls ? 'product_rail' : 'product_grid';
    if (imgs <= 1 && (paragraphs >= 1 || (el.textContent || '').length > 150)) return 'text_block';
    return 'other';
  };

  const sections = list.map(({ el, forced }, index) => {
    const type = forced ?? classify(el, index);
    const cs = getComputedStyle(el);
    return { type, columns: ['header', 'footer', 'announcement_bar'].includes(type) ? 1 : columnsOf(el), padding: px(cs.paddingTop) + px(cs.paddingBottom), height: heightOf(el) };
  });
  // a hero needs to be the first big thing; later ones are something else
  let seenHero = false;
  for (const s of sections) {
    if (s.type !== 'hero_banner') continue;
    if (seenHero) s.type = 'other';
    seenHero = true;
  }
  return sections;
}

// ---- reading ----

const withTimeout = (promise, ms, message) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new SiteReadError('timeout', message)), ms))]);

/**
 * @param pool     a browser pool whose browser is launched with `proxy: { server: 'per-context' }` (src/screenshot.mjs
 *                 `createBrowserPool`): the reader gives each page its own way out, the guard proxy
 * @param guard    the fetch guard (src/fetch-guard.mjs)
 * @param dial     how the proxy connects to a checked address (a test seam)
 */
export function createSiteReader({ pool, guard, dial, timeoutMs = 90_000 }) {
  const proxy = createGuardProxy({ guard, ...(dial ? { dial } : {}) });

  /** Opens `url` safely at `viewport`; calls `read(page)` and answers its result. */
  async function visit(url, viewport, read, { screenshot = false } = {}) {
    const proxyPort = await proxy.listen();
    const browser = await pool.get();
    const context = await browser.newContext({
      // loopback is not exempt: nothing leaves the browser except through the guard
      proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' },
      viewport: { width: VIEWPORTS[viewport].width, height: VIEWPORTS[viewport].height },
      isMobile: VIEWPORTS[viewport].isMobile,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    try {
      // a page has no use for live sockets
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (response && response.status() >= 400) throw new Error(`status ${response.status()}`);
      } catch {
        throw new SiteReadError('unreachable', 'That website could not be opened.');
      }
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await acceptCookies(page);
      // lazy parts of the page appear while it is scrolled
      for (const fraction of [0.35, 0.7, 1]) {
        await page.evaluate((f) => window.scrollTo(0, document.body.scrollHeight * f), fraction).catch(() => {});
        await page.waitForTimeout(500);
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(400);
      const finalUrl = new URL(page.url());
      const result = await read(page);
      const image = screenshot ? await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null) : null;
      return { result, image, host: finalUrl.hostname };
    } finally {
      await context.close().catch(() => {});
      pool.release();
    }
  }

  /** Turns what the page gave into the checked style. Anything that fails its check is left out. */
  function shape(raw) {
    const hex = (c) => toHex(c);
    const opaque = (c) => c && c.a >= 0.9;
    const page = hex(raw.page);
    const farFromPage = (c) => distance(hex(c), page) > 40;

    const colours = {};
    colours.background = { hex: page, seen: 'page background' };
    colours.text = { hex: hex(raw.text), seen: 'body text' };

    // primary: the most common filled button colour (else the most common link colour)
    const filled = raw.buttons.filter((b) => opaque(b.bg) && farFromPage(b.bg));
    const fromButtons = tally(filled.map((b) => hex(b.bg)));
    const fromLinks = tally(raw.links.filter((c) => opaque(c)).map(hex)).filter((c) => distance(c.hex, hex(raw.text)) > 40 && distance(c.hex, page) > 40);
    // a site with only outlined buttons: their border colour
    const fromOutlines = tally(raw.buttons.filter((b) => b.borderWidth >= 1 && opaque(b.border) && farFromPage(b.border)).map((b) => hex(b.border)));
    const primary = fromButtons[0] ? { hex: fromButtons[0].hex, seen: 'buttons' } : fromOutlines[0] ? { hex: fromOutlines[0].hex, seen: 'buttons' } : fromLinks[0] ? { hex: fromLinks[0].hex, seen: 'links' } : null;
    if (primary) colours.primary = primary;

    // secondary and accent: other colours the page uses, most common / most vivid
    const used = [
      ...fromButtons.map((c) => ({ ...c, seen: 'buttons' })),
      ...fromLinks.map((c) => ({ ...c, seen: 'links' })),
      ...tally(raw.headings.filter(opaque).map(hex)).map((c) => ({ ...c, seen: 'headings' })),
      ...(raw.headerBg && opaque(raw.headerBg) ? [{ hex: hex(raw.headerBg), count: 1, seen: 'header background' }] : []),
    ].filter((c) => !primary || distance(c.hex, primary.hex) > 60);
    const secondary = used.find((c) => distance(c.hex, page) > 40 && saturation(c.hex) < 0.9 || c.seen === 'header background');
    if (secondary) colours.secondary = { hex: secondary.hex, seen: secondary.seen };
    const vividOf = (list) =>
      list
        .filter((c) => saturation(c.hex) > 0.45 && distance(c.hex, page) > 60 && (!primary || distance(c.hex, primary.hex) > 60) && (!secondary || distance(c.hex, secondary.hex) > 60))
        .sort((a, b) => saturation(b.hex) - saturation(a.hex) || b.count - a.count)[0];
    // the colour of the sale labels says "accent" more than a link colour does
    const vivid = vividOf(tally(raw.sale.filter(opaque).map(hex)).map((c) => ({ ...c, seen: 'sale labels' }))) ?? vividOf(used);
    if (vivid) colours.accent = { hex: vivid.hex, seen: vivid.seen };

    const fonts = {};
    if (raw.h1?.family) fonts.heading = mapFont(raw.h1.family);
    if (raw.body?.family) fonts.body = mapFont(raw.body.family);

    const sizes = {};
    if (raw.h1?.size) sizes.h1 = raw.h1.size;
    if (raw.h2?.size) sizes.h2 = raw.h2.size;
    if (raw.body?.size) sizes.body = raw.body.size;
    if (raw.body?.lineHeight) sizes.lineHeight = raw.body.lineHeight;

    const shapes = {};
    const buttonRadius = median(raw.buttons.filter((b) => opaque(b.bg) || b.borderWidth > 0).map((b) => b.radius));
    if (buttonRadius !== null) shapes.buttonRadius = Math.min(buttonRadius, 999);
    const inputRadius = median(raw.inputs);
    if (inputRadius !== null) shapes.inputRadius = Math.min(inputRadius, 999);
    const cardRadius = median(raw.cards);
    if (cardRadius !== null) shapes.cardRadius = Math.min(cardRadius, 999);
    const styled = raw.buttons.filter((b) => (opaque(b.bg) && farFromPage(b.bg)) || b.borderWidth >= 1);
    if (styled.length) {
      shapes.buttonFill = styled.filter((b) => opaque(b.bg) && farFromPage(b.bg)).length >= styled.length / 2 ? 'filled' : 'outlined';
      shapes.buttonUppercase = styled.filter((b) => b.upper).length >= styled.length / 2;
      const v = median(styled.map((b) => b.padV));
      const h = median(styled.map((b) => b.padH));
      if (v !== null) shapes.buttonPaddingV = v;
      if (h !== null) shapes.buttonPaddingH = h;
    }

    // every part is checked by itself: a part that fails is dropped, not the whole reading
    const kept = {};
    for (const [name, schema] of Object.entries(Style.shape)) {
      const value = name === 'spacing' ? raw.spacing ?? null : { colours, fonts, sizes, shapes }[name];
      if (name === 'spacing') {
        kept.spacing = schema.safeParse(value).success ? value : null;
        continue;
      }
      const whole = schema.safeParse(value);
      if (whole.success) {
        kept[name] = whole.data;
        continue;
      }
      kept[name] = {};
      for (const [key, part] of Object.entries(schema.shape)) {
        const one = part.safeParse(value?.[key]);
        if (one.success) kept[name][key] = one.data;
      }
    }
    return kept;
  }

  return {
    /** Stops the proxy (the editor's shutdown). */
    close: () => proxy.close(),

    /**
     * @param {{ url: string, mode: 'style' | 'style_layout' }} request
     * @returns {Promise<{ host: string, style: object, layout: object[] | null, screenshot: Buffer | null }>}
     */
    async read({ url, mode = 'style' }) {
      const checked = await guard.check(url); // throws UrlRefused: nothing is opened
      return withTimeout(
        (async () => {
          // one visit reads both the style and the sections (the sections' padding gives the spacing)
          const desktop = await visit(checked.toString(), 'desktop', async (page) => ({ style: await page.evaluate(collectStyle), layout: await page.evaluate(collectLayout) }), { screenshot: true });
          const raw = desktop.result.style;
          const sections = desktop.result.layout;
          const padding = sections.filter((s) => !['header', 'footer', 'announcement_bar'].includes(s.type)).map((s) => s.padding);
          raw.spacing = padding.length ? (median(padding) < 24 ? 'tight' : median(padding) > 64 ? 'airy' : 'normal') : null;
          const style = shape(raw);
          let layout = null;
          if (mode === 'style_layout') {
            const phone = await visit(checked.toString(), 'phone', (page) => page.evaluate(collectLayout)).catch(() => null);
            const phoneByType = {};
            for (const s of phone?.result ?? []) (phoneByType[s.type] ??= []).push(s.columns);
            const used = {};
            const parsed = Layout.safeParse(
              sections.map((s) => {
                const n = (used[s.type] = (used[s.type] ?? -1) + 1);
                return { type: s.type, columns: { desktop: s.columns, phone: phoneByType[s.type]?.[n] ?? 1 } };
              }),
            );
            layout = parsed.success ? parsed.data : null;
          }
          return { host: desktop.host, style, layout, screenshot: desktop.image };
        })(),
        timeoutMs,
        'That website took too long to read.',
      );
    },
  };
}

export { UrlRefused };
