/**
 * Triage (agent design §2.2 step 1): a cheap model decides what a merchant message is before any code is touched.
 * Only `edit` goes on to the agent; everything else is answered here for the cost of one small call.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const Decision = z.object({
  decision: z.enum(['edit', 'go_ahead', 'help', 'admin_setting', 'needs_backend', 'unclear', 'out_of_scope']),
  large: z.boolean(),
  /** For "edit": show the plan and wait for the owner's OK instead of building now. */
  confirm: z.boolean(),
  /** For "edit": the request is about something the same across the whole store (site colours, header, an icon everywhere). */
  shared: z.boolean(),
  /** For "edit": the job for the AI that edits, resolved against the whole conversation. */
  task: z.string(),
  reply: z.string(),
  /** Short answers the owner can tap instead of typing (for questions and plans). */
  options: z.array(z.string()),
});

/** At most 4 non-empty, distinct, short options. */
export function cleanOptions(options) {
  const seen = new Set();
  const out = [];
  for (const option of Array.isArray(options) ? options : []) {
    if (typeof option !== 'string') continue;
    const text = option.trim().slice(0, 60);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === 4) break;
  }
  return out;
}

// the engine rejects the draft 2020-12 `$schema` header zod adds
const { $schema, ...SCHEMA } = z.toJSONSchema(Decision);

/** $ per million tokens, for the triage model's own call (the agent's cost comes from the SDK). */
const PRICES = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
};

export function costOf(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return 0;
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1e6
  );
}

const SYSTEM = `You sort messages a shop owner sends to the AI that edits their online store's look.
The AI can change anything visual in the storefront: layout, colours, fonts, spacing, wording of buttons and headings,
which blocks appear where, new visual sections built from existing data, images placement, mobile vs desktop look.
It cannot change business data or rules.

Where the owner is (facts; answer from them, never send the owner to someone else):
- The owner IS the store's admin. They are chatting on the "AI Designer" page of their own dashboard
  (Storefront > AI Designer). There is no other admin to ask.
- After each change, the preview of their store appears on the right side of this page, and an "Open the preview"
  link appears under the AI's reply (it opens the preview in a new tab, also on a phone).
- Changes are only in the preview until the owner presses "Approve" at the top of this page; "Discard" drops them.
  Nothing reaches the live store before that.
- The bar at the top shows how much of this month's AI Designer allowance is used.

Decide one of:
- "edit": a change to how the storefront looks or reads that the AI can make in code.
- "go_ahead": a plan is waiting for the owner's OK (see "Plan waiting" below) and this message accepts it as it is
  ("yes", "go ahead", "ok do it", "تمام", "نعم"). If they accept but also change something, that is a new "edit".
- "help": a question about using the AI Designer itself (where is the preview, how to see a change, how to approve
  or undo, what it can do, the allowance). Answer it from the facts above, short.
- "admin_setting": something the owner changes in their dashboard (prices, products, stock, discounts, coupons,
  delivery fees, payment methods, store switches, banners/sliders content, menus content, static pages content).
- "needs_backend": needs data or a rule the storefront does not have (e.g. "show how many people viewed this").
- "unclear": you cannot tell what they want changed or where; ask one short question.
- "out_of_scope": anything else (asking for the code, files, secrets, other stores, general chat). When they ask for
  the code, files or secrets: say kindly that the AI Designer does not share code or files, and offer to change how
  the store looks instead. Never suggest another place or person to get the code from.

"large": true when the edit touches several pages or redesigns a whole page; false for a focused tweak.
"confirm": for "edit" only. false ONLY when the request names exactly one thing in one place and leaves no choice
open (e.g. "make the header green", "make the add to cart buttons on the product cards rounded"). true for everything
else: vague wording ("a new design", "make it nicer"), more than one element or page, anything site-wide (colours,
fonts, icons used in many places), or when you had to guess. When true, "reply" is the plan: what you will change and
where, what stays as it is, ending with a short "Shall I go ahead?" (in the owner's language).
"task": for "edit" only (empty otherwise): the job for the AI that edits the code, in English, 1-3 sentences, resolved
against the WHOLE conversation (the owner's latest message is often a short answer to an earlier question, e.g. "make it
an icon" after asking about the Add to Cart button means the Add to Cart button). Say exactly what changes, where
(which page, which element, e.g. "the Add to Cart buttons on the product cards in listings and rails") and what must
stay as it is. Never leave out the element the conversation is about.
"shared": for "edit" only. true when the owner asks for something that is the same across the whole store: the main
or brand colours, fonts, an icon everywhere it appears, and ANY element of the page frame that shows on every page — the
header and anything in it (logo, search box, header icons), the announcement bar, the menus, the footer and anything in
it. false when the request is about elements inside pages (e.g. "the add to cart buttons on the product cards", "the
category tiles on the home page"), even if a site-wide change could also do it.
"options": short answers the owner can tap instead of typing, in their language, each under 40 characters:
- "unclear": 2-4 concrete choices that answer your question (e.g. "Product cards", "Product page", "Both").
- "edit" with "confirm": true: "Yes, go ahead" plus 1-2 alternatives when there is an obvious one.
- otherwise: [].
"reply": for "edit", one short sentence saying what you understood. For the others, the answer to show the owner, short
and friendly, in the language they wrote in; for "admin_setting" say where in the dashboard. Never include code.`;

const FALLBACK = { decision: 'unclear', large: false, confirm: true, shared: false, task: '', reply: 'Could you say a bit more about what you would like to change?', options: [] };

const promptFor = (text, recent, { pending = null } = {}) =>
  `${recent.length ? `Recent conversation:\n${recent.map((m) => `${m.role}: ${m.text}`).join('\n')}\n\n` : ''}${
    pending ? `Plan waiting for the owner's OK: ${pending.task}\n\n` : 'No plan is waiting for the owner\'s OK.\n\n'
  }New message from the owner:\n${text}`;

/**
 * Triage through the Agent SDK instead of the API client: no tools, one structured answer. It uses whatever
 * credentials the Agent SDK finds (an API key, or this machine's Claude Code login), so local testing needs no key.
 */
export function createSdkTriage({ query, model }) {
  return async function triage(text, recent = [], context = {}) {
    let result = null;
    for await (const message of query({
      prompt: promptFor(text, recent, context),
      options: {
        model,
        systemPrompt: SYSTEM,
        tools: [],
        maxTurns: 3,
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: SCHEMA },
      },
    })) {
      if (message.type === 'result') result = message;
    }
    const parsed = Decision.safeParse(result?.structured_output);
    return { ...(parsed.success ? parsed.data : FALLBACK), model, usage: result?.modelUsage ?? null, costUsd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : 0 };
  };
}

export function createTriage({ client = new Anthropic(), model }) {
  return async function triage(text, recent = [], context = {}) {
    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: promptFor(text, recent, context) }],
      output_config: { format: zodOutputFormat(Decision) },
    });
    const parsed = response.parsed_output ?? FALLBACK;
    return { ...parsed, model, usage: response.usage, costUsd: costOf(model, response.usage) };
  };
}
