/**
 * The editor's HTTP API. Only the Laravel backend calls it (with the shared `x-editor-key`); the merchant's admin
 * page talks to the backend, never to this service.
 *
 *   GET    /stores                     store copies
 *   POST   /stores                     {id, apiUrl, apiKeyEnv?} -> create a copy
 *   GET    /stores/:id
 *   DELETE /stores/:id                 remove the workspace (the branch stays)
 *   POST   /stores/:id/check           run the checks on the copy as it is
 *   POST   /stores/:id/update-starter  merge the starter's latest main (reverted on conflict or failed check)
 *   GET    /stores/:id/budget          this month's limit, spend, what is left, warning / blocked
 *   GET    /stores/:id/chat            messages, the current run (polled while it works), the open draft, budget
 *   GET    /stores/:id/events?ticket=  the same, pushed as server-sent events (browser; signed ticket, no key)
 *   POST   /stores/:id/messages        {text} -> 202 {runId}; 409 busy, 402 out of budget
 *   POST   /stores/:id/draft/approve   merge the draft into the store's copy
 *   POST   /stores/:id/draft/discard   drop the draft
 *   POST   /stores/:id/publish         put the approved copy on the store's website -> 202 (polled in the chat)
 *   POST   /stores/:id/publish/undo    back to the version published before the last one -> 202
 *   GET    /previews
 *   POST   /stores/:id/preview         build and serve the copy
 *   DELETE /stores/:id/preview
 */
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ChangeError, createAgentRunner } from './agent.mjs';
import { loadAiConfig } from './ai-config.mjs';
import { createChats } from './chats.mjs';
import { loadConfig } from './config.mjs';
import { BudgetError, createLedger } from './ledger.mjs';
import { createPreviews, PreviewError } from './preview.mjs';
import { presentChat } from './present.mjs';
import { createPublisher, PublishError } from './publish.mjs';
import { createBrowserPool } from './screenshot.mjs';
import { verifyTicket } from './tickets.mjs';
import { createStores, StoreError } from './stores.mjs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkTriage, createTriage } from './triage.mjs';

const STATUS = {
  busy: 409,
  out_of_budget: 402,
  invalid_id: 422,
  invalid_api_url: 422,
  empty_message: 422,
  message_too_long: 422,
  no_draft: 409,
  exists: 409,
  not_found: 404,
  no_port: 503,
  build_failed: 422,
  serve_failed: 502,
  not_set_up: 409,
  publishing: 409,
  nothing_to_publish: 409,
  nothing_to_undo: 409,
  draft_open: 409,
};
const KNOWN = [StoreError, PreviewError, BudgetError, ChangeError, PublishError];

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1_000_000) throw new StoreError('too_large', 'Body too large.');
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError('invalid_json', 'The body is not JSON.');
  }
}

function keyMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param deps test seams: `triage`, `query` (the Agent SDK's), `log` */
export function createApp(config = loadConfig(), deps = {}) {
  const stores = createStores(config);
  const previews = createPreviews(config, stores);
  const aiConfig = loadAiConfig(config.aiConfigFile ?? loadConfig().aiConfigFile);
  const ledger = createLedger({ file: path.join(config.dataDir, 'ledger.jsonl'), aiConfig });
  const chats = createChats(config.dataDir);
  const triageFor = new Map();
  const triage = deps.triage ?? ((text, recent) => {
    // the triage model is the same for every store today; created on first use so tests and the HTTP API need no key
    const model = aiConfig.forStore('').triageModel;
    // with no API key (local testing), triage goes through the Agent SDK and this machine's Claude Code login
    if (!triageFor.has(model)) triageFor.set(model, process.env.ANTHROPIC_API_KEY ? createTriage({ model }) : createSdkTriage({ query: deps.query ?? sdkQuery, model }));
    return triageFor.get(model)(text, recent);
  });
  const browsers = deps.browsers === undefined ? createBrowserPool() : deps.browsers;
  const log = deps.log ?? ((...a) => console.log(...a));
  const runner = createAgentRunner({ config, stores, previews, ledger, aiConfig, chats, triage, browsers, files: aiConfig.files, ...(deps.query ? { query: deps.query } : {}), log });
  const publisher = createPublisher({ config, stores, chats, isBusy: (id) => ledger.status(id).busy, log });

  /** The publish part of the chat view (null when the store has no website to publish to). */
  async function publishView(id, chat) {
    const store = await stores.get(id);
    if (!store.publish?.siteUrl) return null;
    const approvedCommit = await publisher.branchHead(id).catch(() => null);
    return publisher.view(chat, { siteUrl: store.publish.siteUrl, approvedCommit });
  }

  const routes = [
    ['GET', /^\/stores$/, async () => [200, { stores: await stores.list() }]],
    ['POST', /^\/stores$/, async (req) => {
      const { id, apiUrl, apiKeyEnv } = await body(req);
      return [201, await stores.create(id, { apiUrl, apiKeyEnv })];
    }],
    ['GET', /^\/stores\/([^/]+)$/, async (_req, id) => [200, await stores.get(id)]],
    ['DELETE', /^\/stores\/([^/]+)$/, async (_req, id) => {
      await stores.get(id);
      await previews.stop(id);
      await stores.remove(id);
      return [204, null];
    }],
    ['POST', /^\/stores\/([^/]+)\/check$/, async (_req, id) => {
      await stores.get(id);
      return [200, await stores.check(id)];
    }],
    ['POST', /^\/stores\/([^/]+)\/update-starter$/, async (_req, id) => [200, await stores.updateFromStarter(id)]],
    ['GET', /^\/stores\/([^/]+)\/budget$/, async (_req, id) => {
      await stores.get(id);
      const settings = aiConfig.forStore(id);
      return [200, { ...ledger.status(id), editModel: settings.editModel, allowedModels: settings.allowedModels }];
    }],
    ['GET', /^\/stores\/([^/]+)\/chat$/, async (_req, id) => {
      await stores.get(id);
      const chat = chats.get(id);
      const { messages, run, draft } = chat;
      const preview = previews.list().find((p) => p.id === id) ?? null;
      return [200, { messages, run, draft, preview, budget: ledger.status(id), publish: await publishView(id, chat) }];
    }],
    ['POST', /^\/stores\/([^/]+)\/messages$/, async (req, id) => {
      const { text } = await body(req);
      const { runId } = await runner.send(id, text);
      return [202, { runId }];
    }],
    ['POST', /^\/stores\/([^/]+)\/draft\/approve$/, async (_req, id) => {
      await stores.get(id);
      return [200, await runner.approve(id)];
    }],
    ['POST', /^\/stores\/([^/]+)\/draft\/discard$/, async (_req, id) => {
      await stores.get(id);
      return [200, await runner.discard(id)];
    }],
    ['POST', /^\/stores\/([^/]+)\/publish$/, async (_req, id) => {
      const { commit } = await publisher.publish(id);
      return [202, { started: true, commit }];
    }],
    ['POST', /^\/stores\/([^/]+)\/publish\/undo$/, async (_req, id) => {
      await publisher.undo(id);
      return [202, { started: true }];
    }],
    ['GET', /^\/previews$/, async () => [200, { previews: previews.list() }]],
    ['POST', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, await previews.start(id)]],
    ['DELETE', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, { stopped: await previews.stop(id) }]],
  ];

  /** What the admin page sees (the same shape as the backend's ChatPresenter). */
  const view = async (id, chat) => ({
    ...presentChat(chat, { preview: previews.list().find((p) => p.id === id) ?? null, budget: ledger.status(id) }),
    publish: await publishView(id, chat).catch(() => null),
  });

  /**
   * GET /stores/:id/events?ticket=...: the chat pushed as server-sent events ("chat" on every change, "expired" when
   * the ticket runs out, a comment every 15 s to keep proxies from closing it). Opened by the browser, so it is
   * authorised by the backend's signed ticket, not the service key.
   */
  async function stream(req, res, id) {
    const deny = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(payload));
    };
    const ticket = verifyTicket(config.serviceKey, new URL(req.url, 'http://local').searchParams.get('ticket'), id);
    if (!ticket.ok) return deny(401, { error: 'bad_ticket', message: ticket.reason });
    try {
      await stores.get(id);
    } catch {
      return deny(404, { error: 'not_found', message: 'No such store.' });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    // note: Cloudflare *quick* tunnels (trycloudflare.com) do not pass server-sent events on; the admin page then
    // keeps polling. Named tunnels and normal proxies stream them.
    res.write('retry: 3000\n\n');
    const push = async (chat) => res.write(`event: chat\ndata: ${JSON.stringify(await view(id, chat))}\n\n`);
    push(chats.get(id));
    const unwatch = chats.watch(id, push);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const expiry = setTimeout(() => {
      res.write('event: expired\ndata: {}\n\n');
      res.end();
    }, Math.max(0, ticket.expiresAt * 1000 - Date.now()));
    req.on('close', () => {
      unwatch();
      clearInterval(beat);
      clearTimeout(expiry);
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, payload === null ? {} : { 'content-type': 'application/json' });
      res.end(payload === null ? undefined : JSON.stringify(payload));
    };
    const pathname = new URL(req.url, 'http://local').pathname;
    const events = req.method === 'GET' && pathname.match(/^\/stores\/([^/]+)\/events$/);
    if (events) return stream(req, res, decodeURIComponent(events[1]));
    if (config.serviceKey && !keyMatches(req.headers['x-editor-key'], config.serviceKey)) return send(401, { error: 'unauthorized', message: 'Missing or wrong x-editor-key.' });
    try {
      for (const [method, pattern, handler] of routes) {
        const match = pathname.match(pattern);
        if (match && req.method === method) return send(...(await handler(req, ...match.slice(1).map(decodeURIComponent))));
      }
      send(404, { error: 'not_found', message: 'No such route.' });
    } catch (error) {
      if (KNOWN.some((type) => error instanceof type)) {
        return send(STATUS[error.code] ?? 400, { error: error.code, message: error.message, ...(error.output ? { output: error.output } : {}) });
      }
      console.error(error);
      send(500, { error: 'internal', message: error.message });
    }
  });

  return { server, stores, previews, aiConfig, ledger, chats, runner, publisher, browsers };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const { server, previews, browsers } = createApp(config);
  server.listen(config.port, '127.0.0.1', () => console.log(`storefront-editor on http://127.0.0.1:${config.port}`));
  const shutdown = async () => {
    await browsers?.close();
    await previews.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
