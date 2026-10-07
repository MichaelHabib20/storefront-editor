/**
 * Many chats per store: the migration of an old single-chat file, separate chats and sessions, one build at a time,
 * the chat routes, titles, refusals, live steps.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createChats } from '../src/chats.mjs';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';
import { signTicket } from '../src/tickets.mjs';

const KEY = 'chats-test-key';
let dir, starter, app, base;
const git = (args, cwd = starter) => must('git', args, { cwd });
const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));

let triageAnswer;
let agentScript;
let sessions = 0;
let total = 0;
const fakeTriage = async () => ({ refuseKind: 'none', title: '', ...triageAnswer, model: 'claude-haiku-4-5', costUsd: 0.001, usage: {} });

function fakeQuery({ options }) {
  const step = agentScript.shift();
  return (async function* () {
    const session = options.resume ?? `session-${++sessions}`;
    yield { type: 'system', subtype: 'init', session_id: session };
    await step?.(options.cwd);
    total += 0.1;
    yield { type: 'result', subtype: 'success', result: 'I changed it.', total_cost_usd: total, modelUsage: {}, session_id: session };
  })();
}

async function call(method, url, payload) {
  const response = await fetch(base + url, { method, headers: { 'x-editor-key': KEY, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

const view = async (chatId) => (await call('GET', `/stores/acme/chats/${chatId}`)).body;
async function finished(chatId, runId) {
  for (let i = 0; i < 300; i++) {
    const v = await view(chatId);
    if (v.run?.id === runId && !v.working) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}
async function sendAndWait(chatId, text) {
  const sent = await call('POST', `/stores/acme/chats/${chatId}/messages`, { text });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  return finished(chatId, sent.body.runId);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-'));
  starter = path.join(dir, 'starter');
  await fs.mkdir(path.join(starter, 'src'), { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await write(starter, 'check.mjs', '\n');
  await write(starter, 'build.mjs', '\n');
  await write(starter, 'serve.mjs', "import http from 'node:http'; http.createServer((q, s) => s.end('preview')).listen(Number(process.argv[2]), '127.0.0.1');\n");
  await write(starter, 'src/page.txt', 'v1');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);
  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(
    aiConfigFile,
    JSON.stringify({
      defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5'], routing: 'fixed', effort: 'medium', monthlyLimitUsd: 50, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 },
      files: { editable: ['src/**'], locked: [], generated: [], shared: [] },
    }),
  );
  app = createApp(
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [['node', ['check.mjs']]], build: ['node', ['build.mjs']], serve: ['node', ['serve.mjs', '{port}']], previewMode: 'production', previewPorts: [3511, 3519], aiConfigFile, serviceKey: KEY },
    { triage: fakeTriage, query: fakeQuery, log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' });
});

beforeEach(() => {
  triageAnswer = { decision: 'edit', large: false, confirm: false, shared: false, task: 'Make it v2.', reply: 'On it.', options: [] };
  agentScript = [];
});

after(async () => {
  await app.previews.stopAll();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('an old single-chat file is split: nothing is lost, the old file is kept as .migrated', async () => {
  const data = path.join(dir, 'migrate');
  await fs.mkdir(path.join(data, 'chats'), { recursive: true });
  const old = {
    storeId: 'seif',
    sessionId: 'sess-9',
    sessionCostUsd: 1.5,
    pending: { task: 'Do the thing', large: false, shared: false, at: '2026-10-01T00:00:00Z' },
    messages: [
      { id: '1', role: 'merchant', text: 'hello', at: '2026-10-01T00:00:00Z' },
      { id: '2', role: 'assistant', text: 'hi there', at: '2026-10-01T00:00:01Z' },
      { id: '3', role: 'system', text: 'Approved.', at: '2026-10-01T00:00:02Z' },
    ],
    run: { id: 'r1', state: 'done', outcome: 'preview' },
    draft: { branch: 'draft/seif', commit: 'abc', updatedAt: '2026-10-01T00:00:02Z' },
    publish: { state: 'idle', history: [{ id: 'p1', kind: 'publish', ok: true }] },
  };
  await fs.writeFile(path.join(data, 'chats', 'seif.json'), JSON.stringify(old));
  const chats = createChats(data);
  const main = chats.get('seif', 'c_main');
  assert.equal(main.messages.length, 3);
  assert.equal(main.sessionId, 'sess-9');
  assert.deepEqual(main.pending, old.pending);
  assert.equal(main.title, 'First chat');
  const state = chats.state.get('seif');
  assert.equal(state.run.id, 'r1');
  assert.equal(state.draft.commit, 'abc');
  assert.equal(state.draft.chatId, 'c_main');
  assert.deepEqual(state.publish, old.publish);
  assert.ok(await fs.stat(path.join(data, 'chats', 'seif.json.migrated')));
  await assert.rejects(fs.stat(path.join(data, 'chats', 'seif.json')));
  // a second start does nothing more
  assert.equal(createChats(data).get('seif', 'c_main').messages.length, 3);
});

test('the first chat of an Arabic store is titled in Arabic', async () => {
  const data = path.join(dir, 'migrate-ar');
  await fs.mkdir(path.join(data, 'chats'), { recursive: true });
  await fs.writeFile(path.join(data, 'chats', 's.json'), JSON.stringify({ storeId: 's', messages: [{ id: '1', role: 'merchant', text: 'غيّر اللون' }, { id: '2', role: 'assistant', text: 'تمام' }] }));
  assert.equal(createChats(data).get('s', 'c_main').title, 'المحادثة الأولى');
});

test('chat routes: create, list, rename, view, delete; bad ids are 404', async () => {
  const a = (await call('POST', '/stores/acme/chats', {})).body;
  assert.match(a.id, /^c_[a-f0-9]{12}$/);
  assert.equal(a.title, 'New chat');
  const b = (await call('POST', '/stores/acme/chats', { title: 'Header colour' })).body;
  assert.equal(b.title, 'Header colour');
  assert.equal((await call('PATCH', `/stores/acme/chats/${a.id}`, { title: 'Cart button' })).body.title, 'Cart button');
  assert.equal((await call('PATCH', `/stores/acme/chats/${a.id}`, { title: '   ' })).status, 422);
  assert.equal((await call('PATCH', `/stores/acme/chats/${a.id}`, { title: 'x'.repeat(100) })).body.title.length, 40);
  const list = (await call('GET', '/stores/acme/chats')).body.chats;
  assert.ok(list.some((c) => c.id === a.id) && list.some((c) => c.id === b.id));
  assert.deepEqual(Object.keys(list[0]).sort(), ['building', 'id', 'lastText', 'title', 'updatedAt']);
  const v = await view(a.id);
  assert.equal(v.chat.id, a.id);
  assert.deepEqual(v.messages, []);
  assert.equal(v.otherChatBuilding, null);
  assert.equal((await call('GET', '/stores/acme/chats/c_nothere1')).status, 404);
  assert.equal((await call('GET', '/stores/acme/chats/..%2Fx')).status, 404);
  assert.equal((await call('DELETE', `/stores/acme/chats/${b.id}`)).status, 204);
  assert.equal((await call('GET', `/stores/acme/chats/${b.id}`)).status, 404);
  await call('DELETE', `/stores/acme/chats/${a.id}`);
});

test('two chats keep their own messages and their own AI sessions', async () => {
  const a = (await call('POST', '/stores/acme/chats', {})).body.id;
  const b = (await call('POST', '/stores/acme/chats', {})).body.id;
  triageAnswer = { decision: 'help', reply: 'Alpha answer', title: 'Alpha chat' };
  await sendAndWait(a, 'alpha question');
  triageAnswer = { decision: 'help', reply: 'Beta answer', title: 'Beta chat' };
  await sendAndWait(b, 'beta question');
  const va = await view(a);
  const vb = await view(b);
  assert.deepEqual(va.messages.map((m) => m.text), ['alpha question', 'Alpha answer']);
  assert.deepEqual(vb.messages.map((m) => m.text), ['beta question', 'Beta answer']);
  assert.equal(va.chat.title, 'Alpha chat', 'the first message titles the chat');
  assert.equal(vb.chat.title, 'Beta chat');
  // sessions: each chat resumes only its own
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'a1')];
  triageAnswer = { decision: 'edit', large: false, confirm: false, shared: false, task: 't', reply: 'On it.', options: [] };
  await sendAndWait(a, 'change a');
  await call('POST', '/stores/acme/draft/discard', { chatId: a });
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'b1')];
  await sendAndWait(b, 'change b');
  const sa = app.chats.get('acme', a).sessionId;
  const sb = app.chats.get('acme', b).sessionId;
  assert.ok(sa && sb && sa !== sb, `${sa} vs ${sb}`);
  await call('POST', '/stores/acme/draft/discard', { chatId: b });
  await call('DELETE', `/stores/acme/chats/${a}`);
  await call('DELETE', `/stores/acme/chats/${b}`);
});

test('one build at a time: another chat gets busy_other_chat, keeps the plan, can still ask questions', async () => {
  const a = (await call('POST', '/stores/acme/chats', { title: 'Header colour' })).body.id;
  const b = (await call('POST', '/stores/acme/chats', {})).body.id;
  let release;
  agentScript = [async (cwd) => {
    await new Promise((resolve) => (release = resolve));
    await write(cwd, 'src/page.txt', 'a-build');
  }];
  const first = await call('POST', `/stores/acme/chats/${a}/messages`, { text: 'slow change' });
  assert.equal(first.status, 202);
  for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 25));

  // while A builds: the list says so, B's view names A, A's steps are live
  assert.equal((await call('GET', '/stores/acme/chats')).body.chats.find((c) => c.id === a).building, true);
  let vb = await view(b);
  assert.deepEqual(vb.otherChatBuilding, { chatId: a, title: 'Header colour' });
  const va = await view(a);
  assert.equal(va.run.here, true);
  assert.deepEqual(va.run.steps.map((s) => s.text).slice(0, 2), ['Reading your request', 'Changing files']);

  // a build request in B: answered as a message, not an error; the plan waits
  const asked = await sendAndWait(b, 'make the footer green');
  assert.equal(asked.messages.at(-1).text, 'Another change is being made in "Header colour". You can keep planning here; I will build this when it is finished.');
  assert.equal(app.chats.get('acme', b).pending.task, 'Make it v2.');
  assert.equal(app.chats.get('acme', b).lightRun.outcome, 'busy_other_chat');
  // a question in B: a normal answer
  triageAnswer = { decision: 'help', reply: 'The preview is on the right.' };
  const question = await sendAndWait(b, 'where is the preview?');
  assert.equal(question.messages.at(-1).text, 'The preview is on the right.');
  // the same chat cannot start a second build; the store's actions wait
  assert.equal((await call('POST', `/stores/acme/chats/${a}/messages`, { text: 'again' })).status, 409);
  assert.equal((await call('POST', '/stores/acme/draft/approve')).status, 409);
  // B cannot be deleted while A builds, A cannot either
  assert.equal((await call('DELETE', `/stores/acme/chats/${a}`)).body.error, 'chat_busy');

  release();
  await finished(a, first.body.runId);
  // the draft names the chat that made it; that chat cannot be deleted while the draft is open
  const draftView = await view(b);
  assert.deepEqual(draftView.draft.chatId, a);
  assert.equal(draftView.draft.chatTitle, 'Header colour');
  assert.equal((await call('DELETE', `/stores/acme/chats/${a}`)).body.error, 'chat_busy');

  // B says go ahead once A is finished: it builds now (the draft stays under A)
  triageAnswer = { decision: 'go_ahead', reply: 'On it.' };
  agentScript = [(cwd) => write(cwd, 'src/footer.txt', 'green')];
  const built = await sendAndWait(b, 'go ahead');
  assert.equal(built.messages.at(-1).previewUrl !== null, true);
  assert.equal(app.chats.get('acme', b).pending, null);

  // approve in B: both chats get the note
  assert.equal((await call('POST', '/stores/acme/draft/approve', { chatId: b })).status, 200);
  assert.equal((await view(a)).messages.at(-1).text, 'Approved.');
  assert.equal((await view(b)).messages.at(-1).text, 'Approved.');
  assert.equal((await call('DELETE', `/stores/acme/chats/${a}`)).status, 204);
  assert.equal((await call('DELETE', `/stores/acme/chats/${b}`)).status, 204);
});

test('the live steps grow with the phases and hold no file names', async () => {
  const a = (await call('POST', '/stores/acme/chats', {})).body.id;
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'steps')];
  await sendAndWait(a, 'make steps');
  const v = await view(a);
  const texts = app.chats.state.get('acme').run.steps.map((s) => s.text);
  assert.deepEqual(texts, ['Reading your request', 'Changing files', 'Checking everything still works', 'Preparing the preview', 'Done']);
  assert.equal(v.run.steps.length, 5);
  assert.ok(!JSON.stringify(v.run.steps).includes('.txt'));
  await call('POST', '/stores/acme/draft/discard', { chatId: a });
  await call('DELETE', `/stores/acme/chats/${a}`);
});

test('a refusal is a refusal card with its kind; unknown kinds fall back to unsafe', async () => {
  const a = (await call('POST', '/stores/acme/chats', {})).body.id;
  triageAnswer = { decision: 'refuse', refuseKind: 'business_logic', reply: 'This is a business rule, not the look. Change it in Dashboard → Coupons.' };
  const v = await sendAndWait(a, 'give everyone 20% off in the code');
  const last = v.messages.at(-1);
  assert.equal(last.kind, 'refusal');
  assert.deepEqual(last.card, { refuseKind: 'business_logic' });
  assert.equal(app.chats.state.get('acme').run.outcome, 'refuse');
  triageAnswer = { decision: 'refuse', refuseKind: 'none', reply: 'No.' };
  assert.equal((await sendAndWait(a, 'x')).messages.at(-1).card.refuseKind, 'unsafe');
  await call('DELETE', `/stores/acme/chats/${a}`);
});

test('the old single-chat routes still work on chat c_main', async () => {
  triageAnswer = { decision: 'help', reply: 'Old route answer' };
  const sent = await call('POST', '/stores/acme/messages', { text: 'old question' });
  assert.equal(sent.status, 202);
  let chat;
  for (let i = 0; i < 200; i++) {
    chat = (await call('GET', '/stores/acme/chat')).body;
    if (chat.run?.id === sent.body.runId && chat.run.state === 'done') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(chat.messages.at(-1).text, 'Old route answer');
  assert.equal((await view('c_main')).messages.at(-1).text, 'Old route answer');
});

test('the stream follows the chat named in ?chat=', async () => {
  const a = (await call('POST', '/stores/acme/chats', { title: 'Stream me' })).body.id;
  const ticket = signTicket(KEY, 'acme', Date.now() / 1000 + 60);
  const first = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/stores/acme/events?ticket=${encodeURIComponent(ticket)}&chat=${a}`, (res) => {
      res.once('data', (chunk) => {
        request.destroy();
        resolve(String(chunk));
      });
    });
    request.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.ok(first.includes('retry: 3000'));
  const events = await new Promise((resolve, reject) => {
    let text = '';
    const request = http.get(`${base}/stores/acme/events?ticket=${encodeURIComponent(ticket)}&chat=${a}`, (res) => {
      res.on('data', (chunk) => {
        text += chunk;
        if (text.includes('event: chat')) {
          request.destroy();
          resolve(text);
        }
      });
    });
    request.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.ok(events.includes('"title":"Stream me"'));
  const missing = await new Promise((resolve) => http.get(`${base}/stores/acme/events?ticket=${encodeURIComponent(ticket)}&chat=c_nothere1`, (res) => resolve(res.statusCode)));
  assert.equal(missing, 404);
  await call('DELETE', `/stores/acme/chats/${a}`);
});
