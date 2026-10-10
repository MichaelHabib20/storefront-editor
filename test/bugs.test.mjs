/**
 * Fix a bug (v2 plan §4): the diagnosis card for each cause, "Undo the change" as an ordinary draft whose diff is
 * exactly the revert, "Fix it instead", the re-check in a real browser, team reports and their closed doors.
 * The diagnosing AI is a fake that answers with a prepared JSON; the browser for the re-check is real.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';

const TEAM = 'team-secret-key';
const AI = ['-c', 'user.name=AI Designer', '-c', 'user.email=ai-designer@supercommerce.local'];
const STARTER_AUTHOR = ['-c', 'user.name=Starter', '-c', 'user.email=starter@local'];
let dir, starter, app, base, workspace;
const git = (args, cwd = starter) => must('git', args, { cwd });
const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));

let triageAnswer;
let triageCalls;
let diagnosisAnswer;
let agentScript;
let agentPrompts;

const fakeTriage = async (text) => {
  triageCalls.push(text);
  return { refuseKind: 'none', title: 'Checkout button', ...triageAnswer, model: 'claude-haiku-4-5', costUsd: 0.001, usage: {} };
};

function fakeQuery({ prompt, options }) {
  const step = agentScript.shift();
  return (async function* () {
    agentPrompts.push({ diagnose: !!options.outputFormat, tools: options.tools, allowed: options.allowedTools, text: typeof prompt === 'string' ? prompt : '(stream)' });
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    await step?.(options.cwd);
    yield { type: 'result', subtype: 'success', result: 'Fixed it.', ...(options.outputFormat ? { structured_output: diagnosisAnswer } : {}), total_cost_usd: 0.1, modelUsage: {}, session_id: 's1' };
  })();
}

async function call(method, url, payload, headers = {}) {
  const response = await fetch(base + url, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, type, body: response.status === 204 ? null : type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const team = (method, url, payload) => call(method, url, payload, { 'x-editor-team-key': TEAM });

const view = async (chatId) => (await call('GET', `/stores/acme/chats/${chatId}`)).body;
async function sendAndWait(chatId, text, extra = {}) {
  const sent = await call('POST', `/stores/acme/chats/${chatId}/messages`, { text, ...extra });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  for (let i = 0; i < 600; i++) {
    const v = await view(chatId);
    if (v.run?.id === sent.body.runId && !v.working) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}
const newChat = async () => (await call('POST', '/stores/acme/chats', {})).body.id;
const spent = () => app.ledger.status('acme').spentUsd;
const rawCard = (chatId) => app.chats.get('acme', chatId).messages.findLast((m) => m.kind === 'bug_report');

/** A commit on the store's branch (as the AI Designer, or as the starter's own author). */
async function commitOnStore(file, content, title, who = AI) {
  await write(workspace, file, content);
  await git(['add', '-A'], workspace);
  await git([...who, 'commit', '-q', '-m', title], workspace);
  return (await git(['rev-parse', '--short', 'HEAD'], workspace)).trim();
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bugs-'));
  starter = path.join(dir, 'starter');
  await fs.mkdir(path.join(starter, 'src'), { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await write(starter, 'check.mjs', '\n');
  await write(starter, 'build.mjs', '\n');
  await write(starter, 'serve.mjs', [
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    'http.createServer((q, s) => {',
    "  const css = fs.existsSync('src/shop.css') ? fs.readFileSync('src/shop.css', 'utf8') : '';",
    "  s.writeHead(200, { 'content-type': 'text/html' });",
    '  s.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>shop</title><style>${css}</style><h1>Cart</h1><a href="/x">Checkout</a>`);',
    "}).listen(Number(process.argv[2]), '127.0.0.1');",
    '',
  ].join('\n'));
  await write(starter, 'src/shop.css', 'h1 { color: black; }\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);
  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(
    aiConfigFile,
    JSON.stringify({
      defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5'], routing: 'fixed', effort: 'medium', monthlyLimitUsd: 50, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 },
      files: { editable: ['src/**'], locked: [], generated: [], shared: ['src/shop.css'] },
    }),
  );
  app = createApp(
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [['node', ['check.mjs']]], build: ['node', ['build.mjs']], serve: ['node', ['serve.mjs', '{port}']], previewMode: 'production', previewPorts: [3531, 3539], aiConfigFile, teamKey: TEAM },
    { triage: fakeTriage, query: fakeQuery, log: (...a) => process.env.BUGLOG && console.error('LOG', ...a.map((x) => (x instanceof Error ? x.stack : x))) },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  workspace = (await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' })).body.workspace;
});

beforeEach(async () => {
  triageAnswer = { decision: 'bug', reply: 'I will look into it.' };
  triageCalls = [];
  agentScript = [];
  agentPrompts = [];
  diagnosisAnswer = null;
  // every test starts from the store's approved state with no draft
  if (app.chats.state.get('acme').draft) await call('POST', '/stores/acme/draft/discard', {});
});

after(async () => {
  await app.previews.stopAll();
  await app.browsers?.close();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

const diagnosis = (fields) => ({ reproduced: true, cause: 'store_change', summary: 'The Checkout button is hidden on phones.', steps: ['Open /en/cart on phone', 'Look for Checkout'], suspectCommit: null, adminPlace: null, fixPlan: null, recheck: null, ...fields });
const recheckFor = (viewport = 'phone') => ({ path: '/en/cart', viewport, steps: [], expectVisible: { role: 'link', name: 'Checkout', text: null }, expectNoError: null });

test('store_changes lists the AI Designer commits only (a starter-author commit is not one of them)', async () => {
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  const starterLike = await commitOnStore('src/other.css', 'p {}\n', 'Starter: tidy', STARTER_AUTHOR);
  const changes = await app.diagnoser.storeChanges('acme');
  assert.deepEqual(changes.map((c) => c.commit), [hide]);
  assert.equal(changes[0].title, 'Hide the checkout button on phone');
  assert.deepEqual(changes[0].files, ['src/shop.css']);
  assert.ok(!changes.some((c) => c.commit === starterLike));
  await git(['reset', '-q', '--hard', 'HEAD~2'], workspace);
});

test('the diagnosing AI gets read-only tools plus the browser tools, never the editing tools', async () => {
  const chat = await newChat();
  diagnosisAnswer = diagnosis({ reproduced: false, cause: 'not_reproduced', summary: 'I could not see it.' });
  await sendAndWait(chat, 'the checkout button is missing on my phone');
  const call1 = agentPrompts[0];
  assert.equal(call1.diagnose, true);
  assert.deepEqual(call1.tools, ['Read', 'Glob', 'Grep']);
  assert.ok(call1.allowed.includes('mcp__editor__open_page') && call1.allowed.includes('mcp__editor__act') && call1.allowed.includes('mcp__editor__store_changes'));
  assert.ok(!call1.allowed.some((t) => ['Edit', 'Write'].includes(t)));
  assert.match(call1.text, /missing on my phone/);
});

test('store change: Undo / Fix cards, a hidden-fields view, and nothing is built by the diagnosis', async () => {
  const chat = await newChat();
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  diagnosisAnswer = diagnosis({ suspectCommit: hide, fixPlan: 'Remove the rule that hides links on phones.', recheck: recheckFor('phone') });
  const before = spent();
  const v = await sendAndWait(chat, 'the checkout button is missing on my phone');
  const card = v.messages.at(-1);
  assert.equal(card.kind, 'bug_report');
  assert.equal(card.text, 'The Checkout button is hidden on phones.');
  assert.equal(card.card.cause, 'store_change');
  assert.deepEqual(card.card.actions, ['undo', 'fix']);
  assert.equal(card.card.suspectTitle, 'Hide the checkout button on phone');
  assert.deepEqual(card.card.steps, ['Open /en/cart on phone', 'Look for Checkout']);
  assert.equal(app.chats.state.get('acme').run.outcome, 'bug_found');
  assert.equal(app.chats.state.get('acme').draft, null);
  assert.ok(spent() > before + 0.05, 'a diagnosis that found the problem is charged');
  const raw = JSON.stringify(v);
  for (const hidden of [hide, 'fixPlan', 'Remove the rule', 'recheck', 'expectVisible', 'claude']) assert.ok(!raw.includes(hidden), hidden);
  await git(['reset', '-q', '--hard', 'HEAD~1'], workspace);
});

test('Undo the change: a draft whose diff is exactly the revert; Approve and Discard work; the re-check says fixed', async () => {
  const chat = await newChat();
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  diagnosisAnswer = diagnosis({ suspectCommit: hide, fixPlan: 'Remove the rule.', recheck: recheckFor('phone') });
  await sendAndWait(chat, 'the checkout button is missing on my phone');
  const cardId = rawCard(chat).id;
  triageCalls.length = 0;

  const v = await sendAndWait(chat, 'Undo the change "Hide the checkout button on phone"', { command: 'bug_undo', cardId });
  assert.equal(triageCalls.length, 0, 'a button needs no triage');
  assert.equal(app.chats.state.get('acme').run.outcome, 'preview');
  assert.equal(agentPrompts.length, 1, 'the undo made no AI call');
  assert.equal(v.draft.chatId, chat);
  const expected = await git(['diff', hide, `${hide}^`], workspace);
  assert.equal(await git(['diff', 'store/acme', 'draft/acme'], workspace), expected, 'the draft is exactly the revert of that commit');
  assert.ok(expected.includes('-@media'));
  assert.equal(v.messages.findLast((m) => m.kind === 'bug_report').card.used, 'undo');
  assert.deepEqual(v.messages.findLast((m) => m.kind === 'bug_report').card.actions, []);
  const texts = v.messages.map((m) => m.text);
  assert.ok(texts.some((t) => /undid "Hide the checkout button on phone"/.test(t)));
  assert.ok(texts.includes('Checked again: fixed.'), texts.join(' | '));
  const author = (await git(['log', '-1', '--format=%an', 'draft/acme'], workspace)).trim();
  assert.equal(author, 'AI Designer');

  // the same button cannot be used twice
  const again = await sendAndWait(chat, 'Undo the change', { command: 'bug_undo', cardId });
  assert.match(again.messages.at(-1).text, /not available any more/);

  assert.equal((await call('POST', '/stores/acme/draft/approve', {})).status, 200);
  // (a Windows checkout may end its lines with CRLF)
  assert.equal((await fs.readFile(path.join(workspace, 'src/shop.css'), 'utf8')).replace(/\r\n/g, '\n'), 'h1 { color: black; }\n');
});

test('Undo that cannot be reverted by itself changes nothing and says so', async () => {
  const chat = await newChat();
  const first = await commitOnStore('src/shop.css', 'h1 { color: red; }\n', 'AI Designer: Red heading');
  await commitOnStore('src/shop.css', 'h1 { color: green; }\n', 'AI Designer: Green heading');
  diagnosisAnswer = diagnosis({ suspectCommit: first, fixPlan: 'x' });
  await sendAndWait(chat, 'the heading colour is wrong');
  const v = await sendAndWait(chat, 'Undo the change', { command: 'bug_undo', cardId: rawCard(chat).id });
  assert.match(v.messages.at(-1).text, /could not undo that change by itself/);
  assert.equal(app.chats.state.get('acme').run.outcome, 'undo_conflict');
  assert.equal(app.chats.state.get('acme').draft, null);
  assert.equal(await git(['status', '--porcelain'], workspace), '');
  await git(['reset', '-q', '--hard', 'HEAD~2'], workspace);
});

test('Fix it instead: an edit run with the fix plan, then the re-check', async () => {
  const chat = await newChat();
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  diagnosisAnswer = diagnosis({ suspectCommit: hide, fixPlan: 'Remove the rule that hides links on phones.', recheck: recheckFor('phone') });
  await sendAndWait(chat, 'the checkout button is missing on my phone');
  agentScript = [(cwd) => write(cwd, 'src/shop.css', 'h1 { color: black; }\n')];
  const v = await sendAndWait(chat, 'Fix it instead', { command: 'bug_fix', cardId: rawCard(chat).id });
  assert.equal(app.chats.state.get('acme').run.outcome, 'preview');
  const edit = agentPrompts.at(-1);
  assert.equal(edit.diagnose, false);
  assert.match(edit.text, /Remove the rule that hides links on phones/);
  assert.match(edit.text, /store-wide part: changing it is expected/);
  assert.ok(v.messages.map((m) => m.text).includes('Checked again: fixed.'));
  assert.equal(v.messages.findLast((m) => m.kind === 'bug_report').card.used, 'fix');
  await call('POST', '/stores/acme/draft/discard', {});
  await git(['reset', '-q', '--hard', 'HEAD~1'], workspace);
});

test('a re-check that still sees the problem says so', async () => {
  const chat = await newChat();
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  diagnosisAnswer = diagnosis({ suspectCommit: hide, fixPlan: 'Change the heading colour.', recheck: recheckFor('phone') });
  await sendAndWait(chat, 'the checkout button is missing on my phone');
  agentScript = [(cwd) => write(cwd, 'src/other.css', 'p {}\n')];
  const v = await sendAndWait(chat, 'Fix it instead', { command: 'bug_fix', cardId: rawCard(chat).id });
  assert.ok(v.messages.map((m) => m.text).includes('Checked again: it still happens.'));
  await call('POST', '/stores/acme/draft/discard', {});
  await git(['reset', '-q', '--hard', 'HEAD~1'], workspace);
});

test('a re-check that cannot open the page tells the owner instead of staying silent', async () => {
  const chat = await newChat();
  const hide = await commitOnStore('src/shop.css', 'h1 { color: black; }\n@media (max-width: 500px) { a { display: none; } }\n', 'AI Designer: Hide the checkout button on phone');
  diagnosisAnswer = diagnosis({ suspectCommit: hide, fixPlan: 'Remove the rule.', recheck: { ...recheckFor('phone'), path: 'nope' } });
  await sendAndWait(chat, 'the checkout button is missing on my phone');
  const v = await sendAndWait(chat, 'Undo the change', { command: 'bug_undo', cardId: rawCard(chat).id });
  assert.ok(v.messages.map((m) => m.text).includes('I could not check it again myself. Please look at the preview.'));
  await call('POST', '/stores/acme/draft/discard', {});
  await git(['reset', '-q', '--hard', 'HEAD~1'], workspace);
});

test('platform bug: a report for our team is made at once and the card says it was sent', async () => {
  const chat = await newChat();
  await commitOnStore('src/cart.css', 'h2 {}\n', 'Starter: heading shows a raw key', STARTER_AUTHOR);
  diagnosisAnswer = diagnosis({ cause: 'platform', summary: 'The cart heading shows a raw text key.', steps: ['Open /en/cart'] });
  const v = await sendAndWait(chat, 'the cart heading looks weird');
  const card = v.messages.at(-1);
  assert.equal(card.card.cause, 'platform');
  assert.deepEqual(card.card.report, { status: 'new' });
  assert.deepEqual(card.card.actions, []);
  const mine = (await call('GET', '/stores/acme/reports')).body.reports;
  assert.equal(mine.length >= 1, true);
  const report = (await team('GET', '/team/reports?status=new&store=acme')).body.reports.find((r) => r.summary === 'The cart heading shows a raw text key.');
  assert.ok(report && /^r_[a-f0-9]{12}$/.test(report.id));
  assert.equal((await call('GET', '/stores/acme/reports')).body.reports.some((r) => r.id === report.id), true);
  const full = (await team('GET', `/team/reports/${report.id}`)).body;
  assert.equal(full.ownerText, 'the cart heading looks weird');
  assert.deepEqual(full.steps, ['Open /en/cart']);
  assert.equal(full.chatId, chat);

  // our team changes the status: the owner's chat hears when it is fixed
  assert.equal((await team('PATCH', `/team/reports/${report.id}`, { status: 'in_progress', note: 'Looking at it' })).body.notes[0].text, 'Looking at it');
  assert.equal((await view(chat)).messages.at(-1).card.report.status, 'in_progress');
  assert.equal((await team('PATCH', `/team/reports/${report.id}`, { status: 'fixed' })).status, 200);
  assert.equal((await view(chat)).messages.at(-1).text, 'Our team fixed the problem you reported: The cart heading shows a raw text key.');
  assert.equal((await team('PATCH', `/team/reports/${report.id}`, { status: 'fixed' })).status, 200);
  assert.equal((await view(chat)).messages.filter((m) => /Our team fixed/.test(m.text)).length, 1, 'told once');
  assert.equal((await team('PATCH', `/team/reports/${report.id}`, { status: 'nonsense' })).status, 422);
  await git(['reset', '-q', '--hard', 'HEAD~1'], workspace);
});

test('team routes are closed without the team key, with a wrong one, and when no team key is set', async () => {
  const report = app.reports.create({ storeId: 'acme', chatId: 'c_main', summary: 'closed doors' });
  assert.equal((await call('GET', '/team/reports')).status, 404);
  assert.equal((await call('GET', '/team/reports', null, { 'x-editor-team-key': 'wrong' })).status, 404);
  assert.equal((await call('GET', `/team/reports/${report.id}`, null, { 'x-editor-team-key': 'wrong' })).status, 404);
  assert.equal((await call('PATCH', `/team/reports/${report.id}`, { status: 'fixed' }, { 'x-editor-team-key': 'wrong' })).status, 404);
  assert.equal(app.reports.get(report.id).status, 'new');
  assert.equal((await team('GET', '/team/reports')).status, 200);

  const closed = createApp(
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [], previewPorts: [3541, 3549], aiConfigFile: path.join(dir, 'ai.json') },
    { browsers: null, log: () => {} },
  );
  await new Promise((resolve) => closed.server.listen(0, '127.0.0.1', resolve));
  const open = await fetch(`http://127.0.0.1:${closed.server.address().port}/team/reports`, { headers: { 'x-editor-team-key': TEAM } });
  assert.equal(open.status, 404, 'no EDITOR_TEAM_KEY, no team routes');
  await new Promise((resolve) => closed.server.close(resolve));
});

test('report files: a screenshot or picture is served to the team only, by a checked name', async () => {
  const shot = path.join(dir, 'shot.jpg');
  await fs.writeFile(shot, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const report = app.reports.create({ storeId: 'acme', chatId: 'c_main', summary: 'with a picture', files: { screenshots: [{ path: shot, name: 'a.jpg' }] } });
  assert.deepEqual(app.reports.get(report.id).screenshots, ['shot-1.jpg']);
  const served = await team('GET', `/team/reports/${report.id}/files/shot-1.jpg`);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/jpeg');
  assert.equal((await team('GET', `/team/reports/${report.id}/files/..%2Fx.json`)).status, 404);
  assert.equal((await call('GET', `/team/reports/${report.id}/files/shot-1.jpg`)).status, 404, 'no team key');
});

test('data or setting: where to change it, no buttons, no draft', async () => {
  const chat = await newChat();
  diagnosisAnswer = diagnosis({ cause: 'data_or_setting', summary: 'The price comes from your product data.', adminPlace: 'Dashboard → Products → Prices' });
  const v = await sendAndWait(chat, 'the price of Panadol is wrong');
  const card = v.messages.at(-1).card;
  assert.equal(card.cause, 'data_or_setting');
  assert.equal(card.adminPlace, 'Dashboard → Products → Prices');
  assert.deepEqual(card.actions, []);
  assert.equal(app.chats.state.get('acme').draft, null);
  assert.equal(card.report, undefined, 'nothing is sent to the team');
});

test('not reproduced: asks for more detail, and the diagnosis is refunded', async () => {
  const chat = await newChat();
  diagnosisAnswer = diagnosis({ reproduced: false, cause: 'not_reproduced', summary: 'I tried on phone and desktop and all looked right.' });
  const before = spent();
  const v = await sendAndWait(chat, 'something is wrong on my phone');
  assert.deepEqual(v.messages.at(-1).card.actions, ['more_detail']);
  assert.equal(app.chats.state.get('acme').run.outcome, 'bug_not_reproduced');
  assert.equal(Math.round((spent() - before) * 1e6) / 1e6, 0.001, 'only the triage is charged');
});

test('Fix a bug button: no triage, the chat is titled from the text, and a diagnosis that gave no answer is refunded', async () => {
  const chat = await newChat();
  diagnosisAnswer = null;
  const before = spent();
  const v = await sendAndWait(chat, 'The Checkout button does nothing on the cart page', { command: 'fix_bug' });
  assert.equal(triageCalls.length, 0);
  assert.equal(v.chat.title, 'The Checkout button does nothing on the');
  assert.equal(agentPrompts[0].diagnose, true);
  assert.match(v.messages.at(-1).text, /could not make this change safely/);
  assert.equal(spent(), before, 'nothing charged');
});

test('a bug asked while another chat builds is still looked at (a diagnosis only reads)', async () => {
  const builder = await newChat();
  const asker = await newChat();
  let release;
  triageAnswer = { decision: 'edit', large: false, confirm: false, shared: false, task: 'Make a change.', reply: 'On it.', options: [] };
  agentScript = [async (cwd) => {
    await new Promise((resolve) => (release = resolve));
    await write(cwd, 'src/late.css', 'p {}\n');
  }];
  const first = await call('POST', `/stores/acme/chats/${builder}/messages`, { text: 'slow change' });
  for (let i = 0; i < 300 && !release; i++) await new Promise((r) => setTimeout(r, 25));
  triageAnswer = { decision: 'bug', reply: 'I will look into it.' };
  diagnosisAnswer = diagnosis({ reproduced: false, cause: 'not_reproduced', summary: 'Could not see it.' });
  const v = await sendAndWait(asker, 'checkout is broken');
  assert.equal(v.messages.at(-1).kind, 'bug_report');
  assert.deepEqual(v.otherChatBuilding && Object.keys(v.otherChatBuilding).sort(), ['chatId', 'title']);
  release();
  for (let i = 0; i < 300 && (await view(builder)).working; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(first.status === 202);
});

test('a first request only our team can build sends nothing yet and offers "Send it to our team"', async () => {
  const chat = await newChat();
  const before = (await team('GET', '/team/reports')).body.reports.length;
  triageAnswer = { decision: 'needs_backend', reply: 'This needs a change on our side. I can send it to our team.' };
  let v = await sendAndWait(chat, 'add a tax number box to checkout');
  assert.deepEqual(v.messages.at(-1).options, ['Send it to our team']);
  assert.equal((await team('GET', '/team/reports')).body.reports.length, before);
  triageAnswer = { decision: 'needs_backend', reply: 'هذا يحتاج إلى تغيير من جهتنا.' };
  v = await sendAndWait(chat, 'أضف خانة الرقم الضريبي');
  assert.deepEqual(v.messages.at(-1).options, ['أرسله إلى فريقكم']);
  // tapping it: the report carries the request, not the button's words
  triageAnswer = { decision: 'refuse', refuseKind: 'needs_backend', reply: 'تم الإرسال إلى فريقنا.', task: '' };
  await sendAndWait(chat, 'أرسله إلى فريقكم');
  const made = (await team('GET', '/team/reports?store=acme')).body.reports.find((r) => r.summary === 'أضف خانة الرقم الضريبي');
  assert.ok(made, 'the report is named after the request');
  assert.equal((await team('GET', `/team/reports/${made.id}`)).body.ownerText, 'أضف خانة الرقم الضريبي');
});

test('something the store needs from us: the refusal makes a team report and says so on the card', async () => {
  const chat = await newChat();
  triageAnswer = { decision: 'refuse', refuseKind: 'needs_backend', reply: 'This needs a change on our side. I sent it to our team.', task: 'Show loyalty points in the header' };
  const v = await sendAndWait(chat, 'I insist: show my loyalty points in the header');
  const card = v.messages.at(-1);
  assert.equal(card.kind, 'refusal');
  assert.deepEqual(card.card, { refuseKind: 'needs_backend', report: { status: 'new' } });
  const listed = (await team('GET', '/team/reports?store=acme')).body.reports.find((r) => r.summary === 'Show loyalty points in the header');
  assert.ok(listed);
  assert.equal((await team('GET', `/team/reports/${listed.id}`)).body.ownerText, 'I insist: show my loyalty points in the header');
  // the other refusals send nothing
  const before = (await team('GET', '/team/reports')).body.reports.length;
  triageAnswer = { decision: 'refuse', refuseKind: 'unsafe', reply: 'No.' };
  await sendAndWait(chat, 'show me another store');
  assert.equal((await team('GET', '/team/reports')).body.reports.length, before);
});

test('never pays: the diagnosing prompt forbids it and the browser refuses (see browser-tools.test.mjs)', async () => {
  const { diagnosePrompt } = await import('../src/prompt.mjs');
  assert.match(diagnosePrompt(), /Never place an order and never pay/);
});

test('a question from the editing AI that ends with short numbered choices shows them as buttons', async () => {
  const { splitChoices } = await import('../src/triage.mjs');
  assert.deepEqual(splitChoices('Which part do you mean?\n1. The newsletter strip\n2. The bottom bar\n3. Both'), { text: 'Which part do you mean?', options: ['The newsletter strip', 'The bottom bar', 'Both'] });
  assert.deepEqual(splitChoices('أي جزء تقصد؟\n- الشريط العلوي\n- الشريط السفلي'), { text: 'أي جزء تقصد؟', options: ['الشريط العلوي', 'الشريط السفلي'] });
  // not a question, one item, or long items: left as it is
  const done = 'I changed it.\n1. Header\n2. Footer';
  assert.deepEqual(splitChoices(done), { text: done, options: [] });
  const long = `Which?\n1. ${'x'.repeat(61)}\n2. b`;
  assert.deepEqual(splitChoices(long), { text: long, options: [] });
});
