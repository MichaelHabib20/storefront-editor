/**
 * The editor's HTTP API (local, called by the admin chat screen and the agent loop).
 *
 *   GET    /stores                     store copies
 *   POST   /stores                     {id, apiUrl, apiKeyEnv?} -> create a copy
 *   GET    /stores/:id
 *   DELETE /stores/:id                 remove the workspace (the branch stays)
 *   POST   /stores/:id/check           run the checks on the copy as it is
 *   POST   /stores/:id/update-starter  merge the starter's latest main (reverted on conflict or failed check)
 *   GET    /stores/:id/budget          this month's limit, spend, what is left, warning / blocked
 *   GET    /previews
 *   POST   /stores/:id/preview         build and serve the copy
 *   DELETE /stores/:id/preview
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAiConfig } from './ai-config.mjs';
import { loadConfig } from './config.mjs';
import { BudgetError, createLedger } from './ledger.mjs';
import { createPreviews, PreviewError } from './preview.mjs';
import { createStores, StoreError } from './stores.mjs';

const STATUS = { busy: 409, out_of_budget: 402, invalid_id: 422, invalid_api_url: 422, exists: 409, not_found: 404, no_port: 503, build_failed: 422, serve_failed: 502 };

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

export function createApp(config = loadConfig()) {
  const stores = createStores(config);
  const previews = createPreviews(config, stores);
  const aiConfig = loadAiConfig(config.aiConfigFile ?? loadConfig().aiConfigFile);
  const ledger = createLedger({ file: path.join(config.dataDir, 'ledger.jsonl'), aiConfig });

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
    ['GET', /^\/previews$/, async () => [200, { previews: previews.list() }]],
    ['POST', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, await previews.start(id)]],
    ['DELETE', /^\/stores\/([^/]+)\/preview$/, async (_req, id) => [200, { stopped: await previews.stop(id) }]],
  ];

  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, payload === null ? {} : { 'content-type': 'application/json' });
      res.end(payload === null ? undefined : JSON.stringify(payload));
    };
    const pathname = new URL(req.url, 'http://local').pathname;
    try {
      for (const [method, pattern, handler] of routes) {
        const match = pathname.match(pattern);
        if (match && req.method === method) return send(...(await handler(req, ...match.slice(1).map(decodeURIComponent))));
      }
      send(404, { error: 'not_found', message: 'No such route.' });
    } catch (error) {
      if (error instanceof StoreError || error instanceof PreviewError || error instanceof BudgetError) {
        return send(STATUS[error.code] ?? 400, { error: error.code, message: error.message, ...(error.output ? { output: error.output } : {}) });
      }
      console.error(error);
      send(500, { error: 'internal', message: error.message });
    }
  });

  return { server, stores, previews, aiConfig, ledger };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const { server, previews } = createApp(config);
  server.listen(config.port, '127.0.0.1', () => console.log(`storefront-editor on http://127.0.0.1:${config.port}`));
  const shutdown = async () => {
    await previews.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
