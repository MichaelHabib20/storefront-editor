/**
 * The closest Google Font for a font another site uses (v2 plan §5.3). A fixed list of about 40 common families: the
 * storefront can load any of these, so what the owner sees as "we use: X" is always something that exists.
 */

/** name -> kind */
export const GOOGLE_FONTS = {
  Inter: 'sans',
  Roboto: 'sans',
  'Open Sans': 'sans',
  Lato: 'sans',
  Montserrat: 'sans',
  Poppins: 'sans',
  Nunito: 'sans',
  'Nunito Sans': 'sans',
  'Source Sans 3': 'sans',
  'Work Sans': 'sans',
  'DM Sans': 'sans',
  Manrope: 'sans',
  Raleway: 'sans',
  Rubik: 'sans',
  Barlow: 'sans',
  Mulish: 'sans',
  Outfit: 'sans',
  Jost: 'sans',
  Karla: 'sans',
  'PT Sans': 'sans',
  'Playfair Display': 'serif',
  Merriweather: 'serif',
  Lora: 'serif',
  'Libre Baskerville': 'serif',
  'EB Garamond': 'serif',
  'Cormorant Garamond': 'serif',
  'Crimson Text': 'serif',
  'Noto Serif': 'serif',
  'PT Serif': 'serif',
  'DM Serif Display': 'serif',
  'Bebas Neue': 'display',
  Oswald: 'display',
  Anton: 'display',
  'Barlow Condensed': 'display',
  'Roboto Mono': 'mono',
  'JetBrains Mono': 'mono',
  Cairo: 'arabic',
  Tajawal: 'arabic',
  Almarai: 'arabic',
  'Noto Kufi Arabic': 'arabic',
  'IBM Plex Sans Arabic': 'arabic',
};

/** Fonts that are not on Google Fonts, or are system fonts, and the closest family that is. Lower case keys. */
const ALIASES = {
  helvetica: 'Inter',
  'helvetica neue': 'Inter',
  arial: 'Inter',
  'arial nova': 'Inter',
  'sf pro': 'Inter',
  'sf pro text': 'Inter',
  'sf pro display': 'Inter',
  '-apple-system': 'Inter',
  blinkmacsystemfont: 'Inter',
  'system-ui': 'Inter',
  'segoe ui': 'Open Sans',
  verdana: 'Open Sans',
  tahoma: 'Open Sans',
  'trebuchet ms': 'Open Sans',
  calibri: 'Lato',
  'gill sans': 'Lato',
  gotham: 'Montserrat',
  'gotham pro': 'Montserrat',
  'gotham rounded': 'Nunito',
  'proxima nova': 'Nunito Sans',
  avenir: 'Nunito',
  'avenir next': 'Nunito',
  futura: 'Jost',
  'futura pt': 'Jost',
  din: 'Barlow',
  'din next': 'Barlow',
  'din condensed': 'Barlow Condensed',
  'brandon grotesque': 'Raleway',
  'museo sans': 'Nunito Sans',
  graphik: 'Work Sans',
  circular: 'DM Sans',
  'circular std': 'DM Sans',
  'neue haas grotesk': 'Inter',
  akzidenz: 'Inter',
  georgia: 'Lora',
  times: 'Libre Baskerville',
  'times new roman': 'Libre Baskerville',
  garamond: 'EB Garamond',
  'adobe garamond': 'EB Garamond',
  didot: 'Playfair Display',
  bodoni: 'Playfair Display',
  'bodoni mt': 'Playfair Display',
  baskerville: 'Libre Baskerville',
  palatino: 'Lora',
  'palatino linotype': 'Lora',
  cambria: 'Merriweather',
  'courier new': 'Roboto Mono',
  courier: 'Roboto Mono',
  consolas: 'Roboto Mono',
  menlo: 'Roboto Mono',
  monaco: 'Roboto Mono',
  impact: 'Anton',
  'dubai': 'Cairo',
  'droid arabic kufi': 'Noto Kufi Arabic',
  'noto sans arabic': 'Cairo',
  'segoe ui arabic': 'Cairo',
  'din next lt arabic': 'Cairo',
  'frutiger arabic': 'Tajawal',
  'sf arabic': 'Cairo',
};

const GENERIC = { serif: 'Merriweather', 'sans-serif': 'Inter', monospace: 'Roboto Mono', cursive: 'Playfair Display', fantasy: 'Anton' };

const clean = (name) => String(name).trim().replace(/^["']|["']$/g, '').trim();

/** The names of a CSS font-family list, in order, without quotes. */
export function familyNames(stack) {
  return String(stack ?? '')
    .split(',')
    .map(clean)
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * @returns {{ theirs: string, ours: string, exact: boolean }} their first font and the Google Font we use for it
 */
export function mapFont(stack) {
  const names = familyNames(stack);
  const byLower = Object.fromEntries(Object.keys(GOOGLE_FONTS).map((n) => [n.toLowerCase(), n]));
  // their own first font is what the owner reads as "their font"; the closest we have is looked for down the list
  const theirs = names.find((n) => !Object.keys(GENERIC).includes(n.toLowerCase())) ?? names[0] ?? 'sans-serif';
  for (const name of names) {
    const lower = name.toLowerCase();
    if (byLower[lower]) return { theirs, ours: byLower[lower], exact: lower === theirs.toLowerCase() };
    if (ALIASES[lower]) return { theirs, ours: ALIASES[lower], exact: false };
    // "Brandon Grotesque Web", "Montserrat Variable": the same family with a suffix
    const prefix = Object.keys(byLower).find((known) => lower.startsWith(`${known} `) || lower.startsWith(`${known}-`));
    if (prefix) return { theirs, ours: byLower[prefix], exact: false };
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (/arab|kufi|naskh/.test(lower)) return { theirs, ours: 'Cairo', exact: false };
  }
  const generic = [...names].reverse().find((n) => GENERIC[n.toLowerCase()]);
  return { theirs, ours: generic ? GENERIC[generic.toLowerCase()] : 'Inter', exact: false };
}
