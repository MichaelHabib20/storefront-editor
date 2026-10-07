/**
 * Pictures on a message: the limits (checked again here), saving and serving them, and that triage and the
 * editing AI both receive them (and the fix rounds do not).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { MAX_IMAGE_BYTES, checkImages, promptWithImages } from '../src/images.mjs';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 100) => Buffer.concat([PNG_HEAD, Buffer.alloc(Math.max(0, size - 8), 1)]);
const jpeg = (size = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 2)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(20)]);
const asImage = (bytes, mediaType = 'image/png') => ({ mediaType, data: bytes.toString('base64') });

let dir, starter, app, base;
const git = (args, cwd = starter) => must('git', args, { cwd });
const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));

let triageAnswer;
let triageCalls;
let agentScript;
let agentPrompts;
let total = 0;

const fakeTriage = async (text, recent, context) => {
  triageCalls.push({ text, images: context?.images ?? [] });
  return { refuseKind: 'none', title: '', ...triageAnswer, model: 'claude-haiku-4-5', costUsd: 0.001, usage: {} };
};

async function fakeQuery({ prompt, options }) {
  const blocks = typeof prompt === 'string' ? null : (await prompt[Symbol.asyncIterator]().next()).value.message.content;
  const step = agentScript.shift();
  agentPrompts.push({ text: typeof prompt === 'string' ? prompt : blocks.find((b) => b.type === 'text').text, images: blocks ? blocks.filter((b) => b.type === 'image') : [] });
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    await step?.(options.cwd);
    total += 0.1;
    yield { type: 'result', subtype: 'success', result: 'I changed it.', total_cost_usd: total, modelUsage: {}, session_id: 's1' };
  })();
}

async function call(method, url, payload) {
  const response = await fetch(base + url, { method, headers: payload ? { 'content-type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, type, body: response.status === 204 ? null : type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}

const view = async (chatId) => (await call('GET', `/stores/acme/chats/${chatId}`)).body;
async function sendAndWait(chatId, text, images) {
  const sent = await call('POST', `/stores/acme/chats/${chatId}/messages`, { text, ...(images ? { images } : {}) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  for (let i = 0; i < 300; i++) {
    const v = await view(chatId);
    if (v.run?.id === sent.body.runId && !v.working) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'images-'));
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
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [['node', ['check.mjs']]], build: ['node', ['build.mjs']], serve: ['node', ['serve.mjs', '{port}']], previewMode: 'production', previewPorts: [3521, 3529], aiConfigFile },
    { triage: fakeTriage, query: fakeQuery, log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' });
});

beforeEach(() => {
  triageAnswer = { decision: 'edit', large: false, confirm: false, shared: false, task: 'Make the buttons red pills.', reply: 'On it.', options: [] };
  triageCalls = [];
  agentScript = [];
  agentPrompts = [];
});

after(async () => {
  await app.previews.stopAll();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('checkImages accepts png, jpeg and webp up to 3 and 2 MB', () => {
  assert.equal(checkImages(undefined).length, 0);
  assert.equal(checkImages([asImage(png()), asImage(jpeg(), 'image/jpeg'), asImage(webp(), 'image/webp')]).length, 3);
  assert.equal(checkImages([asImage(png(MAX_IMAGE_BYTES))]).length, 1, 'exactly 2 MB is fine');
});

test('checkImages refuses a 2.5 MB png, a gif, a text file renamed png, a mislabelled picture and 4 images', () => {
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.code;
    }
    return 'no error';
  };
  assert.equal(code(() => checkImages([asImage(png(2.5 * 1024 * 1024))])), 'image_too_large');
  assert.equal(code(() => checkImages([asImage(Buffer.from('GIF89a....'), 'image/gif')])), 'image_type');
  assert.equal(code(() => checkImages([asImage(Buffer.from('this is just text, not a picture'))])), 'image_type');
  assert.equal(code(() => checkImages([asImage(jpeg(), 'image/png')])), 'image_type', 'the bytes must match the declared type');
  assert.equal(code(() => checkImages(Array.from({ length: 4 }, () => asImage(png())))), 'too_many_images');
  assert.equal(code(() => checkImages([{ mediaType: 'image/png', data: 'not base64 !!' }])), 'image_invalid');
  assert.equal(code(() => checkImages('nope')), 'image_invalid');
});

test('the limits answer 422 with a plain message and start nothing', async () => {
  const chat = (await call('POST', '/stores/acme/chats', {})).body.id;
  const cases = [
    [[asImage(png(2.5 * 1024 * 1024))], 'image_too_large'],
    [[asImage(Buffer.from('GIF89a....'), 'image/gif')], 'image_type'],
    [[asImage(Buffer.from('plain text pretending to be a picture'))], 'image_type'],
    [Array.from({ length: 4 }, () => asImage(png())), 'too_many_images'],
  ];
  for (const [images, error] of cases) {
    const sent = await call('POST', `/stores/acme/chats/${chat}/messages`, { text: 'like this', images });
    assert.equal(sent.status, 422, error);
    assert.equal(sent.body.error, error);
    assert.ok(sent.body.message.length > 10);
  }
  assert.deepEqual((await view(chat)).messages, [], 'no message, no run');
  assert.equal(triageCalls.length, 0);
  assert.equal(app.ledger.status('acme').busy, false);
  await call('DELETE', `/stores/acme/chats/${chat}`);
});

test('a message with pictures: saved, shown, served; triage and the editing AI both get them, fix rounds do not', async () => {
  const chat = (await call('POST', '/stores/acme/chats', {})).body.id;
  // a message bigger than the 1,000,000-character limit of other routes
  const big = png(1.5 * 1024 * 1024);
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'red pill')];
  const v = await sendAndWait(chat, 'make the buttons like this', [asImage(big), asImage(jpeg(), 'image/jpeg')]);

  assert.equal(triageCalls[0].images.length, 2);
  assert.equal(triageCalls[0].images[0].data, big.toString('base64'));
  assert.equal(agentPrompts.length, 1);
  assert.equal(agentPrompts[0].images.length, 2, 'the editing AI sees them');
  assert.match(agentPrompts[0].text, /attached 2 pictures/);
  assert.equal(agentPrompts[0].images[0].source.media_type, 'image/png');

  const mine = v.messages.find((m) => m.role === 'merchant');
  assert.equal(mine.images.length, 2);
  assert.match(mine.images[0].url, new RegExp(`^chats/${chat}/images/[0-9a-f-]+-1\\.png$`));
  const served = await call('GET', `/stores/acme/${mine.images[0].url}`);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/png');
  assert.ok(served.body.equals(big));
  assert.equal((await call('GET', `/stores/acme/${mine.images[1].url}`)).type, 'image/jpeg');
  assert.equal((await call('GET', `/stores/acme/chats/${chat}/images/..%2F..%2Fstores.json`)).status, 404);
  assert.equal((await call('GET', `/stores/acme/chats/${chat}/images/nothing-1.png`)).status, 404);
  assert.equal((await call('GET', `/stores/acme/chats/c_nobody123456/images/${mine.images[0].url.split('/').pop()}`)).status, 404, 'another chat cannot read it');

  await call('POST', '/stores/acme/draft/discard', {});
  await call('DELETE', `/stores/acme/chats/${chat}`);
});

test('other routes keep the 1,000,000-character body limit', async () => {
  const response = await call('POST', '/stores/acme/chats', { title: 'x'.repeat(1_200_000) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'too_large');
});

test('a plan made from a picture keeps the picture for the build', async () => {
  const chat = (await call('POST', '/stores/acme/chats', {})).body.id;
  triageAnswer = { decision: 'edit', large: false, confirm: true, shared: false, task: 'Red pill buttons (#e53935).', reply: 'I will make them red (#e53935) pills. Shall I go ahead?', options: ['Yes, go ahead'] };
  const planned = await sendAndWait(chat, 'make the buttons like this', [asImage(png())]);
  assert.equal(planned.messages.at(-1).kind, 'plan');
  assert.equal(agentPrompts.length, 0);

  triageAnswer = { decision: 'go_ahead', reply: 'On it.' };
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'pills')];
  await sendAndWait(chat, 'yes');
  assert.equal(agentPrompts.length, 1);
  assert.equal(agentPrompts[0].images.length, 1, 'the picture of the plan reaches the editing AI');
  await call('POST', '/stores/acme/draft/discard', {});
  await call('DELETE', `/stores/acme/chats/${chat}`);
});

test('a bug report with a picture is answered, not built', async () => {
  const chat = (await call('POST', '/stores/acme/chats', {})).body.id;
  triageAnswer = { decision: 'bug', reply: 'I will look into it.' };
  const v = await sendAndWait(chat, 'this is broken', [asImage(png())]);
  assert.equal(v.messages.at(-1).text, 'I will look into it.');
  assert.equal(app.chats.state.get('acme').run.outcome, 'bug');
  assert.equal(agentPrompts.length, 0);
  await call('DELETE', `/stores/acme/chats/${chat}`);
});

test('the prompt is plain text without pictures and one user message with them', async () => {
  assert.equal(promptWithImages('hello'), 'hello');
  const iterator = promptWithImages('look', [{ mediaType: 'image/png', data: 'AAAA' }])[Symbol.asyncIterator]();
  const { value } = await iterator.next();
  assert.equal(value.type, 'user');
  assert.deepEqual(value.message.content.map((b) => b.type), ['image', 'text']);
  assert.equal((await iterator.next()).done, true);
});
