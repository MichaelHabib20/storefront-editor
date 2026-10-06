/**
 * Live updates (plan step 6): stream tickets, and the chat pushed as server-sent events — in order, in the admin's
 * safe shape, refused without a valid ticket, closed when the ticket runs out.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';
import { signTicket, verifyTicket } from '../src/tickets.mjs';

const KEY = 'stream-test-key';
let dir, app, base;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-'));
  const starter = path.join(dir, 'starter');
  await fs.mkdir(starter, { recursive: true });
  const git = (args) => must('git', args, { cwd: starter });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await fs.writeFile(path.join(starter, 'page.txt'), 'v1');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);
  app = createApp(
    { starterRepo: starter, starterBranch: 'main', workspacesDir: path.join(dir, 'ws'), dataDir: path.join(dir, 'data'), checks: [], previewPorts: [3481, 3489], serviceKey: KEY },
    { browsers: null, log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await app.stores.create('acme', { apiUrl: 'https://api.acme.test' });
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

/** Opens the stream and collects events until `count` arrived or it ends. */
function listen(url, { count = Infinity, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const request = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, events, headers: res.headers }));
        return;
      }
      let buffer = '';
      const finish = () => resolve({ status: 200, events, headers: res.headers, close: () => request.destroy() });
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: JSON.parse(data) });
          if (events.length >= count) {
            clearTimeout(timer);
            finish();
          }
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        finish();
      });
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
    const timer = setTimeout(() => {
      request.destroy();
      resolve({ status: 200, events, timedOut: true });
    }, timeoutMs);
  });
}

test('tickets: only the right store, unexpired, unchanged, with the right key', () => {
  const now = Date.now() / 1000;
  const ticket = signTicket(KEY, 'acme', now + 60);
  assert.equal(verifyTicket(KEY, ticket, 'acme', now).ok, true);
  assert.equal(verifyTicket(KEY, ticket, 'other', now).reason, 'other_store');
  assert.equal(verifyTicket(KEY, ticket, 'acme', now + 61).reason, 'expired');
  assert.equal(verifyTicket('other-key', ticket, 'acme', now).reason, 'bad_signature');
  const [payload, signature] = ticket.split('.');
  const forged = Buffer.from(JSON.stringify({ s: 'acme', e: now + 9999 })).toString('base64url');
  assert.equal(verifyTicket(KEY, `${forged}.${signature}`, 'acme', now).reason, 'bad_signature');
  assert.equal(verifyTicket(KEY, payload, 'acme', now).reason, 'malformed');
  assert.equal(verifyTicket(null, ticket, 'acme', now).reason, 'no_key');
});

test('the stream sends the chat at once and every change after, in order, in the safe shape', async () => {
  const ticket = signTicket(KEY, 'acme', Date.now() / 1000 + 60);
  const listening = listen(`${base}/stores/acme/events?ticket=${encodeURIComponent(ticket)}`, { count: 3 });
  await new Promise((r) => setTimeout(r, 300));
  app.chats.say('acme', 'merchant', 'make the header green');
  app.chats.update('acme', (chat) => {
    chat.run = { id: 'r1', state: 'editing', model: 'claude-sonnet-5-5', costUsd: 0.12, lastFailure: { output: 'src/x.tsx' } };
  });
  const result = await listening;
  result.close?.();

  assert.equal(result.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(result.headers['access-control-allow-origin'], '*');
  assert.deepEqual(result.events.map((e) => e.name), ['chat', 'chat', 'chat']);
  assert.equal(result.events[0].data.messages.length, 0);
  assert.equal(result.events[1].data.messages[0].text, 'make the header green');
  assert.deepEqual(result.events[2].data.run, { id: 'r1', state: 'editing', startedAt: null });
  assert.equal(result.events[2].data.working, true);
  const raw = JSON.stringify(result.events);
  for (const hidden of ['claude', 'costUsd', 'lastFailure', 'src/x.tsx', 'limitUsd', 'spentUsd']) assert.ok(!raw.includes(hidden), hidden);
});

test('a missing, wrong or other-store ticket is refused; the stream needs no service key', async () => {
  assert.equal((await listen(`${base}/stores/acme/events`)).status, 401);
  assert.equal((await listen(`${base}/stores/acme/events?ticket=nope.nope`)).status, 401);
  const other = signTicket(KEY, 'other', Date.now() / 1000 + 60);
  assert.equal((await listen(`${base}/stores/acme/events?ticket=${other}`)).status, 401);
  const unknown = signTicket(KEY, 'ghost', Date.now() / 1000 + 60);
  assert.equal((await listen(`${base}/stores/ghost/events?ticket=${unknown}`)).status, 404);
  // the rest of the API still wants the key
  assert.equal((await fetch(`${base}/stores/acme/chat`)).status, 401);
});

test('the stream says "expired" and ends when its ticket runs out', async () => {
  const ticket = signTicket(KEY, 'acme', Date.now() / 1000 + 1.5);
  const result = await listen(`${base}/stores/acme/events?ticket=${encodeURIComponent(ticket)}`, { timeoutMs: 5000 });
  assert.equal(result.timedOut, undefined, 'the server closed it');
  assert.deepEqual(result.events.map((e) => e.name), ['chat', 'expired']);
});
