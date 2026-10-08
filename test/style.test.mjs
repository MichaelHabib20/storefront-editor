/**
 * Read a website (v2 plan §5): the style card from what the reader found, the refusal of a blocked address, "Apply
 * selected" as a plan built from the ticked values only, the build after yes, and Cancel. The reader is a fake here
 * (test/site-reader.test.mjs tests the real one).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { UrlRefused } from '../src/fetch-guard.mjs';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';
import { applyTask, cardRows } from '../src/style-card.mjs';

let dir, starter, app, base;
const git = (args, cwd = starter) => must('git', args, { cwd });
const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));

const STYLE = {
  colours: { primary: { hex: '#e65100', seen: 'buttons' }, background: { hex: '#ffffff', seen: 'page background' }, text: { hex: '#222222', seen: 'body text' } },
  fonts: { heading: { theirs: 'Gotham', ours: 'Montserrat', exact: false }, body: { theirs: 'Inter', ours: 'Inter', exact: true } },
  sizes: { h1: 44, body: 16 },
  shapes: { buttonRadius: 24, buttonFill: 'filled', buttonUppercase: true },
  spacing: 'airy',
};
const LAYOUT = [
  { type: 'header', columns: { desktop: 1, phone: 1 } },
  { type: 'hero_banner', columns: { desktop: 1, phone: 1 } },
  { type: 'product_grid', columns: { desktop: 4, phone: 2 } },
  { type: 'footer', columns: { desktop: 1, phone: 1 } },
];
let readerCalls;
let readerAnswer;
const fakeReader = {
  read: async (request) => {
    readerCalls.push(request);
    if (readerAnswer instanceof Error) throw readerAnswer;
    return readerAnswer;
  },
};
let triageAnswer;
let agentPrompts;
const fakeTriage = async () => ({ refuseKind: 'none', title: '', ...triageAnswer, model: 'claude-haiku-4-5', costUsd: 0.001, usage: {} });
function fakeQuery({ prompt, options }) {
  return (async function* () {
    agentPrompts.push(typeof prompt === 'string' ? prompt : '(stream)');
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    await write(options.cwd, 'src/app/globals.css', ':root { --color-bg: #ffffff; --color-text: #222222; --color-primary: #e65100; }\n');
    yield { type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.1, modelUsage: {}, session_id: 's1' };
  })();
}

async function call(method, url, payload) {
  const response = await fetch(base + url, { method, headers: payload ? { 'content-type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
const view = async (chatId) => (await call('GET', `/stores/acme/chats/${chatId}`)).body;
async function sendAndWait(chatId, text, extra = {}) {
  const sent = await call('POST', `/stores/acme/chats/${chatId}/messages`, { text, ...extra });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  for (let i = 0; i < 300; i++) {
    const v = await view(chatId);
    if (v.run?.id === sent.body.runId && !v.working) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}
const newChat = async () => (await call('POST', '/stores/acme/chats', {})).body.id;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'style-'));
  starter = path.join(dir, 'starter');
  await fs.mkdir(path.join(starter, 'src', 'app'), { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await write(starter, 'check.mjs', '\n');
  await write(starter, 'build.mjs', '\n');
  await write(starter, 'serve.mjs', "import http from 'node:http'; http.createServer((q, s) => s.end('preview')).listen(Number(process.argv[2]), '127.0.0.1');\n");
  await write(starter, 'src/app/globals.css', ':root { --color-bg: #fafafa; --color-text: #000000; }\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);
  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(
    aiConfigFile,
    JSON.stringify({
      defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5'], routing: 'fixed', effort: 'medium', monthlyLimitUsd: 50, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 },
      files: { editable: ['src/**'], locked: [], generated: [], shared: ['src/app/globals.css'] },
    }),
  );
  app = createApp(
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [['node', ['check.mjs']]], build: ['node', ['build.mjs']], serve: ['node', ['serve.mjs', '{port}']], previewMode: 'production', previewPorts: [3551, 3559], aiConfigFile },
    { triage: fakeTriage, query: fakeQuery, browsers: null, siteReader: fakeReader, log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' });
});

beforeEach(() => {
  readerCalls = [];
  readerAnswer = { host: 'shop.example', style: STYLE, layout: LAYOUT, screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  triageAnswer = { decision: 'help', reply: 'ok' };
  agentPrompts = [];
});

after(async () => {
  await app.previews.stopAll();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('Read a website: a style card with the rows, the store\'s current values, and their page as a picture; no triage, no cost', async () => {
  const chat = await newChat();
  const before = app.ledger.status('acme').spentUsd;
  const v = await sendAndWait(chat, 'https://shop.example', { command: 'read_website', url: 'https://shop.example', mode: 'style' });
  assert.deepEqual(readerCalls, [{ url: 'https://shop.example', mode: 'style' }]);
  const card = v.messages.at(-1);
  assert.equal(card.kind, 'style_card');
  assert.match(card.text, /shop\.example/);
  assert.equal(card.card.host, 'shop.example');
  assert.equal(card.card.layout, null, 'style only: no layout');
  const primary = card.card.rows.find((r) => r.id === 'colour_primary');
  assert.deepEqual({ theirs: primary.theirs, ours: primary.ours }, { theirs: '#e65100', ours: null });
  assert.equal(card.card.rows.find((r) => r.id === 'colour_background').ours, '#fafafa', "the store's own value");
  assert.deepEqual(card.card.rows.find((r) => r.id === 'font_heading'), { id: 'font_heading', group: 'font', label: 'heading', theirs: 'Gotham', ours: 'Montserrat' });
  assert.ok(!card.card.rows.some((r) => r.id === 'layout'));
  assert.equal(card.images.length, 1, 'their page, for the owner to look at');
  assert.equal(app.ledger.status('acme').spentUsd, before, 'reading costs nothing');
  assert.equal(agentPrompts.length, 0);
});

test('Style + layout adds the layout row and the sections', async () => {
  const chat = await newChat();
  const v = await sendAndWait(chat, 'https://shop.example', { command: 'read_website', url: 'https://shop.example', mode: 'style_layout' });
  assert.equal(readerCalls[0].mode, 'style_layout');
  assert.deepEqual(v.messages.at(-1).card.layout.map((s) => s.type), ['header', 'hero_banner', 'product_grid', 'footer']);
  assert.ok(v.messages.at(-1).card.rows.some((r) => r.id === 'layout'));
});

test('a blocked address is refused with a plain message and no card', async () => {
  const chat = await newChat();
  readerAnswer = new UrlRefused('This address cannot be read. Please give the link of a public website that starts with https://.');
  const v = await sendAndWait(chat, 'http://127.0.0.1:4310', { command: 'read_website', url: 'http://127.0.0.1:4310', mode: 'style' });
  assert.equal(v.messages.at(-1).kind, 'text');
  assert.match(v.messages.at(-1).text, /public website/);
  assert.equal(app.chats.get('acme', chat).lightRun.outcome, 'url_refused');
});

test('Apply selected: a plan from the ticked values only; after yes it builds as a site-wide change', async () => {
  const chat = await newChat();
  await sendAndWait(chat, 'https://shop.example', { command: 'read_website', url: 'https://shop.example', mode: 'style' });
  const cardId = app.chats.get('acme', chat).messages.findLast((m) => m.kind === 'style_card').id;
  const planned = await sendAndWait(chat, 'Apply selected', { command: 'apply_style', cardId, selected: ['colour_primary', 'font_heading', 'made_up_row'] });
  const plan = planned.messages.at(-1);
  assert.equal(plan.kind, 'plan');
  assert.match(plan.text, /#e65100/);
  assert.match(plan.text, /Montserrat/);
  assert.deepEqual(plan.options, ['Yes, go ahead', 'No, cancel']);
  const pending = app.chats.get('acme', chat).pending;
  assert.equal(pending.shared, true);
  assert.match(pending.task, /primary colour .*#e65100/);
  assert.match(pending.task, /Google Font "Montserrat"/);
  assert.ok(!/Inter|#222222|airy|24px/.test(pending.task), 'only the ticked rows');
  assert.equal(planned.messages.findLast((m) => m.kind === 'style_card').card.used, 'applied');

  triageAnswer = { decision: 'go_ahead', reply: 'On it.' };
  const built = await sendAndWait(chat, 'Yes, go ahead');
  assert.equal(app.chats.state.get('acme').run.outcome, 'preview');
  assert.match(agentPrompts[0], /#e65100/);
  assert.match(agentPrompts[0], /store-wide part: changing it is expected/);
  assert.ok(built.draft);
  await call('POST', '/stores/acme/draft/discard', {});

  // the card cannot be applied twice
  const again = await sendAndWait(chat, 'Apply selected', { command: 'apply_style', cardId, selected: ['colour_primary'] });
  assert.match(again.messages.at(-1).text, /not available any more/);
});

test('Apply with nothing ticked asks to tick something; Cancel keeps the store as it is', async () => {
  const chat = await newChat();
  await sendAndWait(chat, 'https://shop.example', { command: 'read_website', url: 'https://shop.example', mode: 'style' });
  const cardId = app.chats.get('acme', chat).messages.findLast((m) => m.kind === 'style_card').id;
  const none = await sendAndWait(chat, 'Apply selected', { command: 'apply_style', cardId, selected: [] });
  assert.match(none.messages.at(-1).text, /Tick at least one/);
  assert.equal(app.chats.get('acme', chat).pending, null);
  const cancelled = await sendAndWait(chat, 'Cancel', { command: 'style_cancel', cardId });
  assert.equal(cancelled.messages.findLast((m) => m.kind === 'style_card').card.used, 'cancelled');
  assert.match(cancelled.messages.at(-1).text, /stays as it is/);
});

test('the job for the editing AI: tokens only, and the layout with existing sections', () => {
  const rows = cardRows(STYLE, LAYOUT).filter((r) => ['colour_primary', 'shape_button_radius', 'layout'].includes(r.id));
  const task = applyTask(rows, LAYOUT);
  assert.match(task, /DESIGN TOKENS only/);
  assert.match(task, /src\/app\/globals\.css/);
  assert.match(task, /corner radius of buttons: 24px/);
  assert.match(task, /EXISTING section components/);
  assert.match(task, /product_grid \(desktop 4 columns, phone 2\)/);
  assert.ok(!/Gotham|Inter/.test(task));
});
