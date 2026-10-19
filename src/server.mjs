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
 *   GET    /stores/:id/chats           the store's chats, newest first
 *   POST   /stores/:id/chats           {title?} -> the new chat
 *   PATCH  /stores/:id/chats/:chatId   {title}
 *   DELETE /stores/:id/chats/:chatId   409 chat_busy while it builds or holds the open draft
 *   GET    /stores/:id/chats/:chatId   the chat view (polled while it works)
 *   POST   /stores/:id/chats/:chatId/messages  {text} -> 202 {runId}; 409 busy, 402 out of budget
 *   GET    /stores/:id/reports         this store's bug reports to our team (id, date, status, summary)
 *   GET    /team/reports?status=&store=   all reports (also needs x-editor-team-key = EDITOR_TEAM_KEY; else 404)
 *   GET    /team/reports/:id              one report with the steps, errors and notes
 *   PATCH  /team/reports/:id              {status?, note?}; "fixed" tells the owner's chat
 *   GET    /team/reports/:id/files/:file  a screenshot or picture of a report
 *   GET    /stores/:id/events?ticket=&chat=  the chat view pushed as server-sent events (browser; signed ticket, no key)
 *   GET    /stores/:id/chat            the first chat as raw data (the old single-chat route)
 *   POST   /stores/:id/messages        {text} -> 202 {runId}, into the first chat (the old single-chat route)
 *   POST   /stores/:id/draft/approve   merge the draft into the store's copy ({chatId?}: the chat the owner pressed it in)
 *   POST   /stores/:id/draft/discard   drop the draft
 *   POST   /stores/:id/publish         put the approved copy on the store's website -> 202 (polled in the chat)
 *   POST   /stores/:id/publish/undo    back to the version published before the last one -> 202
 *   GET    /previews
 *   POST   /stores/:id/preview         build and serve the copy
 *   DELETE /stores/:id/preview
 *   GET    /preview-route              (the preview proxy; no key) x-preview-host -> 204 x-preview-port, or 403
 */
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ChangeError, createAgentRunner } from './agent.mjs';
import { loadAiConfig } from './ai-config.mjs';
import { ChatError, MAIN_CHAT, createChats } from './chats.mjs';
import { createDiagnoser } from './diagnose.mjs';
import { createFetchGuard, ownHostsOf } from './fetch-guard.mjs';
import { createSiteReader } from './site-reader.mjs';
import { ImageError, readImage } from './images.mjs';
import { ReportError, createReports } from './reports.mjs';
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
  chat_busy: 409,
  busy_other_chat: 409,
  invalid_title: 422,
  invalid_status: 422,
  too_many_images: 422,
  image_too_large: 422,
  image_type: 422,
  image_invalid: 422,
};
const KNOWN = [StoreError, PreviewError, BudgetError, ChangeError, PublishError, ChatError, ImageError, ReportError];

/** A message with pictures is bigger: 3 pictures of 2 MB are about 8,000,000 characters of base64. */
const PICTURE_BODY_LIMIT = 12_000_000;

async function body(request, limit = 1_000_000) {
  let text = '';
  let seen = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    seen += chunk.length;
    // a body over the limit is read to its end and thrown away (answering early can wedge the connection), but
    // never without end
    if (seen > limit * 4) {
      request.destroy();
      throw new StoreError('too_large', 'Body too large.');
    }
    if (tooLarge) continue;
    text += chunk;
    if (text.length > limit) {
      tooLarge = true;
      text = '';
    }
  }
  if (tooLarge) throw new StoreError('too_large', 'Body too large.');
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
  const triage = deps.triage ?? ((text, recent, context) => {
    // the triage model is the same for every store today; created on first use so tests and the HTTP API need no key
    const model = aiConfig.forStore('').triageModel;
    // with no API key (local testing), triage goes through the Agent SDK and this machine's Claude Code login
    if (!triageFor.has(model)) triageFor.set(model, process.env.ANTHROPIC_API_KEY ? createTriage({ model }) : createSdkTriage({ query: deps.query ?? sdkQuery, model }));
    return triageFor.get(model)(text, recent, context);
  });
  const browsers = deps.browsers === undefined ? createBrowserPool() : deps.browsers;
  const log = deps.log ?? ((...a) => console.log(...a));
  const reports = createReports({
    dataDir: config.dataDir,
    onFixed: (report) => chats.note(report.storeId, report.chatId, 'system', `Our team fixed the problem you reported: ${report.summary}`),
  });
  const diagnoser = browsers ? createDiagnoser({ config, stores, previews, chats, reports, browsers, ...(deps.query ? { query: deps.query } : {}), log }) : null;
  // reading other people's websites: its own browser (every page goes through the guard proxy), only for public addresses
  const siteReader =
    deps.siteReader !== undefined
      ? deps.siteReader
      : browsers
        ? createSiteReader({
            pool: createBrowserPool({ launch: async () => (await import('playwright')).chromium.launch({ proxy: { server: 'per-context' }, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }) }),
            guard: createFetchGuard({ ownHosts: ownHostsOf(config) }),
          })
        : null;
  const runner = createAgentRunner({ config, stores, previews, ledger, aiConfig, chats, triage, browsers, diagnoser, reports, siteReader, files: aiConfig.files, ...(deps.query ? { query: deps.query } : {}), log });
  const publisher = createPublisher({ config, stores, chats, isBusy: (id) => ledger.status(id).busy, log });

  /** The publish part of the chat view (null when the store has no website to publish to). */
  async function publishView(id, state) {
    const store = await stores.get(id);
    if (!store.publish?.siteUrl) return null;
    const approvedCommit = await publisher.branchHead(id).catch(() => null);
    return publisher.view(state, { siteUrl: store.publish.siteUrl, approvedCommit });
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
    ['POST', /^\/stores\/([^/]+)\/update-starter$/, async (_req, id) => {
      // a running dev preview rewrites its build files while the checks read them; it restarts on the next change
      await previews.stop(id);
      return [200, await stores.updateFromStarter(id)];
    }],
    ['GET', /^\/stores\/([^/]+)\/budget$/, async (_req, id) => {
      await stores.get(id);
      const settings = aiConfig.forStore(id);
      return [200, { ...ledger.status(id), editModel: settings.editModel, allowedModels: settings.allowedModels }];
    }],
    ['GET', /^\/stores\/([^/]+)\/chat$/, async (_req, id) => {
      await stores.get(id);
      const state = chats.state.get(id);
      const { messages } = chats.get(id, MAIN_CHAT);
      const preview = previews.list().find((p) => p.id === id) ?? null;
      return [200, { messages, run: state.run, draft: state.draft, preview, budget: ledger.status(id), publish: await publishView(id, state) }];
    }],
    ['GET', /^\/stores\/([^/]+)\/reports$/, async (_req, id) => {
      await stores.get(id);
      return [200, { reports: reports.listForStore(id) }];
    }],
    ['GET', /^\/stores\/([^/]+)\/chats$/, async (_req, id) => {
      await stores.get(id);
      return [200, { chats: chats.list(id) }];
    }],
    ['POST', /^\/stores\/([^/]+)\/chats$/, async (req, id) => {
      await stores.get(id);
      const { title } = await body(req);
      const chat = chats.create(id, { title });
      return [201, { id: chat.id, title: chat.title }];
    }],
    ['PATCH', /^\/stores\/([^/]+)\/chats\/([^/]+)$/, async (req, id, chatId) => {
      await stores.get(id);
      const { title } = await body(req);
      const chat = chats.rename(id, chatId, title);
      return [200, { id: chat.id, title: chat.title }];
    }],
    ['DELETE', /^\/stores\/([^/]+)\/chats\/([^/]+)$/, async (_req, id, chatId) => {
      await stores.get(id);
      chats.remove(id, chatId);
      return [204, null];
    }],
    ['GET', /^\/stores\/([^/]+)\/chats\/([^/]+)$/, async (_req, id, chatId) => {
      await stores.get(id);
      return [200, await view(id, chatId)];
    }],
    ['GET', /^\/stores\/([^/]+)\/chats\/([^/]+)\/images\/([^/]+)$/, async (_req, id, chatId, file) => {
      await stores.get(id);
      chats.get(id, chatId);
      const image = readImage(config.dataDir, id, chatId, file);
      if (!image) throw new ChatError('not_found', 'No such picture.');
      return [200, image.bytes, image.mediaType];
    }],
    ['POST', /^\/stores\/([^/]+)\/chats\/([^/]+)\/messages$/, async (req, id, chatId) => {
      const { text, images, command, cardId, url, mode, selected } = await body(req, PICTURE_BODY_LIMIT);
      const { runId } = await runner.send(id, text, { chatId, images, command, cardId, url, mode, selected });
      return [202, { runId }];
    }],
    ['POST', /^\/stores\/([^/]+)\/messages$/, async (req, id) => {
      const { text } = await body(req);
      const { runId } = await runner.send(id, text);
      return [202, { runId }];
    }],
    ['POST', /^\/stores\/([^/]+)\/draft\/approve$/, async (req, id) => {
      await stores.get(id);
      return [200, await runner.approve(id, { chatId: (await body(req)).chatId })];
    }],
    ['POST', /^\/stores\/([^/]+)\/draft\/discard$/, async (req, id) => {
      await stores.get(id);
      return [200, await runner.discard(id, { chatId: (await body(req)).chatId })];
    }],
    ['POST', /^\/stores\/([^/]+)\/publish$/, async (req, id) => {
      const { commit } = await publisher.publish(id, { chatId: (await body(req)).chatId });
      return [202, { started: true, commit }];
    }],
    ['POST', /^\/stores\/([^/]+)\/publish\/undo$/, async (req, id) => {
      await publisher.undo(id, { chatId: (await body(req)).chatId });
      return [202, { started: true }];
    }],
    ['GET', /^\/previews$/, async () => [200, { previews: previews.list() }]],
    ['POST', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, await previews.start(id)]],
    ['DELETE', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, { stopped: await previews.stop(id) }]],
  ];

  /** What the admin page sees (the same shape as the backend's ChatPresenter). */
  /** A bug report's status for the card in the chat (null when there is none). */
  const reportStatus = (reportId) => {
    try {
      return reports.get(reportId).status;
    } catch {
      return null;
    }
  };

  async function view(id, chatId) {
    const state = chats.state.get(id);
    const titleOf = (other) => {
      try {
        return chats.get(id, other).title;
      } catch {
        return '';
      }
    };
    return {
      ...presentChat(chats.get(id, chatId), { state, titleOf, reportStatus,  preview: previews.list().find((p) => p.id === id) ?? null, budget: ledger.status(id) }),
      publish: await publishView(id, state).catch(() => null),
    };
  }

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
    const chatId = new URL(req.url, 'http://local').searchParams.get('chat') || MAIN_CHAT;
    try {
      await stores.get(id);
      chats.get(id, chatId);
    } catch (error) {
      return deny(404, { error: 'not_found', message: error instanceof ChatError ? 'No such chat.' : 'No such store.' });
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
    // views take a moment to build (git is asked about the website): a slower, older one must never arrive after a
    // newer one, or the page shows the past (e.g. Approve still there after Approve)
    let latest = 0;
    const push = async () => {
      const mine = ++latest;
      try {
        const current = await view(id, chatId);
        if (mine !== latest) return;
        res.write(`event: chat\ndata: ${JSON.stringify(current)}\n\n`);
      } catch {
        // the chat was deleted while open: the page notices on its next list refresh
      }
    };
    push();
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

  /** /team/reports...: the list, one report, its status and notes, its files. */
  async function teamRoute(req, pathname, send) {
    const params = new URL(req.url, 'http://local').searchParams;
    let match;
    if (req.method === 'GET' && pathname === '/team/reports') return send(200, { reports: reports.list({ status: params.get('status'), store: params.get('store') }) });
    if ((match = pathname.match(/^\/team\/reports\/([^/]+)$/))) {
      const id = decodeURIComponent(match[1]);
      if (req.method === 'GET') return send(200, reports.get(id));
      if (req.method === 'PATCH') {
        const { status, note } = await body(req);
        return send(200, reports.patch(id, { status, note }));
      }
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/team\/reports\/([^/]+)\/files\/([^/]+)$/))) {
      const file = reports.file(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      return send(200, file.bytes, file.mediaType);
    }
    return send(404, { error: 'not_found', message: 'No such route.' });
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, payload, binaryType = null) => {
      if (Buffer.isBuffer(payload)) {
        res.writeHead(status, { 'content-type': binaryType, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
        return res.end(payload);
      }
      res.writeHead(status, payload === null ? {} : { 'content-type': 'application/json' });
      res.end(payload === null ? undefined : JSON.stringify(payload));
    };
    const pathname = new URL(req.url, 'http://local').pathname;
    const events = req.method === 'GET' && pathname.match(/^\/stores\/([^/]+)\/events$/);
    if (events) return stream(req, res, decodeURIComponent(events[1]));
    // the preview proxy's question (nginx auth_request): which port is this preview host? Only a running preview's
    // secret host gets one, so it needs no key; 403 is the answer auth_request passes on as it is
    if (req.method === 'GET' && pathname === '/preview-route') {
      const port = previews.route(req.headers['x-preview-host']);
      res.writeHead(port ? 204 : 403, port ? { 'x-preview-port': String(port) } : {});
      return res.end();
    }
    if (config.serviceKey && !keyMatches(req.headers['x-editor-key'], config.serviceKey)) return send(401, { error: 'unauthorized', message: 'Missing or wrong x-editor-key.' });
    try {
      if (pathname.startsWith('/team/')) {
        // our team's routes need a second key; without one set, or a wrong one, they are simply not there
        if (!config.teamKey || !keyMatches(req.headers['x-editor-team-key'], config.teamKey)) return send(404, { error: 'not_found', message: 'No such route.' });
        return await teamRoute(req, pathname, send);
      }
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

  return { server, stores, previews, aiConfig, ledger, chats, runner, publisher, browsers, reports, diagnoser, siteReader };
}

/** Why the service must not start with this configuration, or null. */
export function startProblem(config) {
  if (!config.serviceKey && !config.allowNoKey) {
    return 'EDITOR_SERVICE_KEY is not set: anyone who reaches the service could use it. Set it (the backend\'s STOREFRONT_EDITOR_KEY), or EDITOR_ALLOW_NO_KEY=1 on your own computer.';
  }
  if (config.previewDomain && !config.serviceKey) return 'EDITOR_PREVIEW_DOMAIN needs EDITOR_SERVICE_KEY: the preview addresses are signed with it.';
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const problem = startProblem(config);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (!config.serviceKey) console.warn('No EDITOR_SERVICE_KEY (EDITOR_ALLOW_NO_KEY=1): every request is accepted. Your own computer only.');
  const { server, previews, browsers, siteReader } = createApp(config);
  server.listen(config.port, '127.0.0.1', () => console.log(`storefront-editor on http://127.0.0.1:${config.port}`));
  const shutdown = async () => {
    await siteReader?.close?.();
    await browsers?.close();
    await previews.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
