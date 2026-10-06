/**
 * Triage (agent design §2.2 step 1): a cheap model decides what a merchant message is before any code is touched.
 * Only `edit` goes on to the agent; everything else is answered here for the cost of one small call.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const Decision = z.object({
  decision: z.enum(['edit', 'admin_setting', 'needs_backend', 'unclear', 'out_of_scope']),
  large: z.boolean(),
  reply: z.string(),
});

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

Decide one of:
- "edit": a change to how the storefront looks or reads that the AI can make in code.
- "admin_setting": something the owner changes in their dashboard (prices, products, stock, discounts, coupons,
  delivery fees, payment methods, store switches, banners/sliders content, menus content, static pages content).
- "needs_backend": needs data or a rule the storefront does not have (e.g. "show how many people viewed this").
- "unclear": you cannot tell what they want changed or where; ask one short question.
- "out_of_scope": anything else (asking for the code, files, secrets, other stores, general chat).

"large": true when the edit touches several pages or redesigns a whole page; false for a focused tweak.
"reply": for "edit", one short sentence saying what you understood. For the others, the answer to show the owner, short
and friendly, in the language they wrote in; for "admin_setting" say where in the dashboard. Never include code.`;

const FALLBACK = { decision: 'unclear', large: false, reply: 'Could you say a bit more about what you would like to change?' };

const promptFor = (text, recent) =>
  `${recent.length ? `Recent conversation:\n${recent.map((m) => `${m.role}: ${m.text}`).join('\n')}\n\n` : ''}New message from the owner:\n${text}`;

/**
 * Triage through the Agent SDK instead of the API client: no tools, one structured answer. It uses whatever
 * credentials the Agent SDK finds (an API key, or this machine's Claude Code login), so local testing needs no key.
 */
export function createSdkTriage({ query, model }) {
  return async function triage(text, recent = []) {
    let result = null;
    for await (const message of query({
      prompt: promptFor(text, recent),
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
  return async function triage(text, recent = []) {
    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: promptFor(text, recent) }],
      output_config: { format: zodOutputFormat(Decision) },
    });
    const parsed = response.parsed_output ?? FALLBACK;
    return { ...parsed, model, usage: response.usage, costUsd: costOf(model, response.usage) };
  };
}
