/**
 * The style card (v2 plan §5.4): what was read from a website as rows the owner ticks, and the job for the editing AI
 * that "Apply selected" turns into. The job is built only from validated values (hex colours, numbers, font names of a
 * fixed list, section types) — never from anything the other site said.
 */
import fs from 'node:fs';
import path from 'node:path';

const LAYOUT_TYPES = ['announcement_bar', 'header', 'hero_banner', 'category_tiles', 'product_rail', 'product_grid', 'brand_logos', 'text_block', 'newsletter', 'footer', 'other'];

/** The store's own tokens we can show as "ours" (a store without them just shows no current value). */
function currentTokens(workspace) {
  try {
    const css = fs.readFileSync(path.join(workspace, 'src/app/globals.css'), 'utf8');
    const root = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? '';
    const get = (name) => new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`).exec(root)?.[1]?.toLowerCase() ?? null;
    return { background: get('color-bg'), text: get('color-text'), primary: get('color-primary') ?? get('primary'), accent: get('color-accent') ?? get('accent') };
  } catch {
    return {};
  }
}

const SIZES = [
  ['size_h1', 'h1'],
  ['size_h2', 'h2'],
  ['size_body', 'body'],
];

/** Rows of the card, in the order the owner reads them. */
export function cardRows(style, layout, workspace = null) {
  const ours = workspace ? currentTokens(workspace) : {};
  const rows = [];
  for (const key of ['primary', 'secondary', 'accent', 'background', 'text']) {
    const colour = style.colours?.[key];
    if (colour) rows.push({ id: `colour_${key}`, group: 'colour', label: key, theirs: colour.hex, ours: ours[key] ?? null, seen: colour.seen });
  }
  for (const key of ['heading', 'body']) {
    const font = style.fonts?.[key];
    if (font) rows.push({ id: `font_${key}`, group: 'font', label: key, theirs: font.theirs, ours: font.ours });
  }
  for (const [id, key] of SIZES) if (style.sizes?.[key] !== undefined) rows.push({ id, group: 'size', label: key, theirs: `${style.sizes[key]}px`, ours: null });
  for (const [id, key, label] of [['shape_button_radius', 'buttonRadius', 'button_radius'], ['shape_input_radius', 'inputRadius', 'input_radius'], ['shape_card_radius', 'cardRadius', 'card_radius']]) {
    if (style.shapes?.[key] !== undefined) rows.push({ id, group: 'shape', label, theirs: `${Math.min(style.shapes[key], 999)}px`, ours: null });
  }
  if (style.shapes?.buttonFill) {
    rows.push({ id: 'shape_button_style', group: 'shape', label: 'button_style', theirs: [style.shapes.buttonFill, style.shapes.buttonUppercase ? 'uppercase' : 'normal case'].join(', '), ours: null });
  }
  if (style.spacing) rows.push({ id: 'spacing', group: 'spacing', label: 'spacing', theirs: style.spacing, ours: null });
  if (layout?.length) rows.push({ id: 'layout', group: 'layout', label: 'layout', theirs: `${layout.length}`, ours: null });
  return rows;
}

const WORD = {
  colour_primary: 'primary colour (the main buttons and highlights)',
  colour_secondary: 'secondary colour',
  colour_accent: 'accent colour (sale labels, highlights)',
  colour_background: 'page background colour',
  colour_text: 'body text colour',
  font_heading: 'heading font',
  font_body: 'body font',
  size_h1: 'size of the main heading',
  size_h2: 'size of section headings',
  size_body: 'size of body text',
  shape_button_radius: 'corner radius of buttons',
  shape_input_radius: 'corner radius of inputs',
  shape_card_radius: 'corner radius of cards',
  shape_button_style: 'button style',
  spacing: 'spacing between sections',
};

/** `selected`: ids ticked by the owner. Returns only rows that exist on the card. */
export function chosenRows(card, selected) {
  const wanted = new Set((Array.isArray(selected) ? selected : []).map(String));
  return card.rows.filter((row) => wanted.has(row.id));
}

/** The plan text the owner reads before saying yes, in their language. */
export function planText(rows, arabic) {
  const list = rows.map((r) => (r.id === 'layout' ? (arabic ? 'ترتيب أقسام الصفحة الرئيسية' : 'the section order of the home page') : `${arabic ? labelAr(r.id) : WORD[r.id]}: ${r.theirs}${r.group === 'font' ? ` → ${r.ours}` : ''}`)).join(arabic ? '، ' : '; ');
  return arabic ? `سأطبّق هذه التغييرات: ${list}. هل أتابع؟` : `I will apply these: ${list}. Shall I go ahead?`;
}

const AR = {
  colour_primary: 'اللون الأساسي',
  colour_secondary: 'اللون الثانوي',
  colour_accent: 'لون التمييز',
  colour_background: 'لون الخلفية',
  colour_text: 'لون النص',
  font_heading: 'خط العناوين',
  font_body: 'خط النص',
  size_h1: 'حجم العنوان الرئيسي',
  size_h2: 'حجم عناوين الأقسام',
  size_body: 'حجم النص',
  shape_button_radius: 'تدوير زوايا الأزرار',
  shape_input_radius: 'تدوير زوايا الحقول',
  shape_card_radius: 'تدوير زوايا البطاقات',
  shape_button_style: 'شكل الأزرار',
  spacing: 'المسافات بين الأقسام',
};
const labelAr = (id) => AR[id] ?? id;

/** The job for the editing AI, built from validated values only. English. */
export function applyTask(rows, layout) {
  const tokens = rows.filter((r) => r.id !== 'layout');
  const lines = tokens.map((r) => `- ${WORD[r.id]}: ${r.theirs}${r.group === 'font' ? ` (use the Google Font "${r.ours}")` : ''}`);
  const parts = [];
  if (lines.length) {
    parts.push(
      `Apply a look taken from another website as DESIGN TOKENS only. Change only these values, in the site design tokens (the CSS variables in src/app/globals.css; if a chosen font must be loaded, change only its loading line), not in single components:\n${lines.join('\n')}\nDo not change anything else and do not copy anything else from that website.`,
    );
  }
  if (rows.some((r) => r.id === 'layout') && layout?.length) {
    const order = layout
      .filter((s) => LAYOUT_TYPES.includes(s.type))
      .map((s) => `${s.type} (desktop ${s.columns.desktop} columns, phone ${s.columns.phone})`)
      .join(', ');
    parts.push(`Rearrange the home page into these sections, top to bottom, using the EXISTING section components of the store with the store's own products, categories and texts (inspiration only, no copying of another brand): ${order}.`);
  }
  return parts.join('\n\n');
}

/**
 * Whether the store's main buttons have a colour token of their own (`--color-primary` in globals.css). Without one,
 * a "primary colour" cannot go into the tokens alone (the starter paints its main buttons with the text colour).
 */
export function hasButtonToken(workspace) {
  try {
    const css = fs.readFileSync(path.join(workspace, 'src/app/globals.css'), 'utf8');
    return /--color-primary\s*:/.test(/:root\s*{([^}]*)}/.exec(css)?.[1] ?? '');
  } catch {
    return false;
  }
}

/** The one-time job before a primary colour: the main buttons get their own token, with nothing looking different. */
export function buttonTokenTask() {
  return `Give the store's main buttons their own colour design token, WITHOUT changing how anything looks:
- In the :root of src/app/globals.css add \`--color-primary\` and \`--color-on-primary\`, set to exactly the colours the
  filled main buttons use today (their background and their text colour).
- Change the filled main buttons (for example "Add to cart", "Checkout", the main call-to-action buttons) to use
  var(--color-primary) for their background and var(--color-on-primary) for their text, instead of the text colour.
- Do not change any colour value, any other element, or plain text colours. After this change the store must look exactly
  the same as before.`;
}
