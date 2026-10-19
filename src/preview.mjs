/**
 * Previews (design §3): a store copy is built and served on its own port with the store's API settings, so
 * the merchant sees the change before it is published. One preview per store; starting again rebuilds.
 *
 * Behind a proxy with a preview domain (config.previewDomain), a store's preview is https://<label>.<domain>, where the
 * label is a secret of that store (an HMAC of its id with the service key): the address is the permission, as the admin
 * shows it in an iframe on the store's own domain, where a cookie of ours would be a third-party cookie. The proxy asks
 * `route(host)` which port to send a request to; a host that is not a running preview's gets nothing.
 */
import { execFile, spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { baseEnv, sandboxed } from './child-env.mjs';
import { run } from './run.mjs';

export class PreviewError extends Error {
  constructor(code, message, output = '') {
    super(message);
    this.code = code;
    this.output = output;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Resolves true once the server answers at all. Redirects are not followed: the answer to `/` is the locale
 * redirect, which comes back at once, while rendering a page in dev mode takes seconds (compile + API calls).
 */
function waitForHttp(url, timeoutMs, isAlive) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = async () => {
      if (!isAlive()) return resolve(false);
      try {
        await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
        return resolve(true);
      } catch {
        if (Date.now() > until) return resolve(false);
        setTimeout(attempt, 300);
      }
    };
    attempt();
  });
}

/** Opens the home page once so a dev server compiles it before the merchant looks; a slow or failed load is fine. */
async function warm(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    // the preview is up; the merchant's own load will compile it
  }
}

/** The processes below `pid` (children, their children, ...), from one `ps` listing. */
function descendants(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (error, stdout) => {
      if (error) return resolve([]);
      const children = new Map();
      for (const line of stdout.split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (child) children.set(parent, [...(children.get(parent) ?? []), child]);
      }
      const found = [];
      const todo = [pid];
      while (todo.length) {
        for (const child of children.get(todo.pop()) ?? []) {
          found.push(child);
          todo.push(child);
        }
      }
      resolve(found);
    });
  });
}

/**
 * Stops a server and everything it started; resolves once it is gone (so its port is free again). `npx` and the shell
 * under it do not pass a stop on, so `next dev` would live on: every process below is stopped by `stopAll` (pids), as
 * the user they run as.
 */
async function killTree(child, stopAll) {
  if (child.exitCode !== null) return;
  const gone = new Promise((resolve) => {
    child.once('close', resolve);
    setTimeout(resolve, 10_000).unref?.();
  });
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else {
    const below = await descendants(child.pid);
    child.kill();
    if (below.length) await stopAll(below);
  }
  return gone;
}

/** The secret first label of a store's preview host: 32 hex characters (128 bits). */
export function previewLabel(key, storeId) {
  return createHmac('sha256', key).update(`preview:${storeId}`).digest('hex').slice(0, 32);
}

export function createPreviews(config, stores, env = process.env) {
  /** id -> { port, child, startedAt, commit } */
  const running = new Map();
  const domain = config.previewDomain && config.serviceKey ? config.previewDomain : null;
  const urlFor = (id, port) =>
    domain ? `https://${previewLabel(config.serviceKey, id)}.${domain}` : config.previewPublicUrls?.[String(port)] ?? `http://localhost:${port}`;
  /** How long a running dev server may take to answer before it counts as hung and is restarted. */
  const checkMs = config.previewCheckMs ?? 20_000;

  function storeEnv(store) {
    const key = store.apiKeyEnv ? env[store.apiKeyEnv] : undefined;
    return { SC_API_URL: store.apiUrl, ...(key ? { SC_API_KEY: key } : {}) };
  }

  async function freePort() {
    const used = new Set([...running.values()].map((p) => p.port));
    const [from, to] = config.previewPorts;
    for (let port = from; port <= to; port++) if (!used.has(port) && (await portFree(port))) return port;
    throw new PreviewError('no_port', 'No free preview port.');
  }

  async function stop(id) {
    const preview = running.get(id);
    if (!preview) return false;
    running.delete(id);
    // through the sandbox: the editor's user may not signal the store user's processes
    await killTree(preview.child, (pids) => run(...sandboxed(config.sandbox, id, 'kill', ['-TERM', ...pids.map(String)]), { cwd: stores.workspaceOf(id) }));
    return true;
  }

  return {
    list() {
      return [...running.entries()].map(([id, p]) => ({ id, port: p.port, mode: p.mode, url: urlFor(id, p.port), startedAt: p.startedAt, commit: p.commit }));
    },

    /** The port of the running preview `host` (as the browser sent it) belongs to, or null. */
    route(host) {
      const name = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (!domain || !name.endsWith(`.${domain}`)) return null;
      const label = Buffer.from(name.slice(0, -domain.length - 1));
      for (const [id, preview] of running) {
        const expected = Buffer.from(previewLabel(config.serviceKey, id));
        if (label.length === expected.length && timingSafeEqual(label, expected) && preview.child.exitCode === null) return preview.port;
      }
      return null;
    },

    stop,

    async stopAll() {
      for (const id of [...running.keys()]) await stop(id);
    },

    /**
     * Shows the store's copy as it is now; resolves once the preview answers.
     * `dev` mode: one dev server per store, kept running; it picks up edits itself, so a running one is reused.
     * `production` mode (or `production: true`): build, then serve; restarts every time.
     */
    /**
     * The local port of the store's dev preview, after a quick check that it answers; a missing or hung one is
     * (re)started. Used before every screenshot.
     */
    async ensure(id) {
      const current = running.get(id);
      if (current?.mode === 'dev' && current.child.exitCode === null && (await waitForHttp(`http://127.0.0.1:${current.port}/`, checkMs, () => current.child.exitCode === null))) {
        return current.port;
      }
      const { port } = await this.start(id, { production: false });
      return port;
    },

    async start(id, { production = config.previewMode === 'production' } = {}) {
      const store = await stores.get(id);
      const cwd = stores.workspaceOf(id);
      const envFor = storeEnv(store);
      const current = running.get(id);
      if (!production && current?.mode === 'dev' && current.child.exitCode === null) {
        // already serving this folder — if it still answers: a hung dev server is restarted below
        const answers = await waitForHttp(`http://127.0.0.1:${current.port}/`, checkMs, () => current.child.exitCode === null);
        if (answers) {
          // open the home page so the edit is compiled before the merchant looks
          await warm(`http://127.0.0.1:${current.port}/`);
          current.commit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).output.trim();
          return { id, port: current.port, url: urlFor(id, current.port), commit: current.commit };
        }
      }
      await stop(id);

      if (production) {
        const [buildCommand, buildArgs] = config.build;
        const built = await run(...sandboxed(config.sandbox, id, buildCommand, buildArgs), { cwd, env: envFor });
        if (built.code !== 0) throw new PreviewError('build_failed', 'The preview build failed.', built.output.slice(-20_000));
      }

      const port = await freePort();
      const [serveCommand, serveArgs] = production ? config.serve : config.devServe ?? config.serve;
      const child = spawn(...sandboxed(config.sandbox, id, serveCommand, serveArgs.map((a) => a.replaceAll('{port}', String(port)))), {
        cwd,
        env: { ...baseEnv(), ...envFor, PORT: String(port) },
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      let output = '';
      const keep = (chunk) => {
        output = (output + chunk.toString()).slice(-20_000);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('close', () => {
        if (running.get(id)?.child === child) running.delete(id);
      });

      const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).output.trim();
      running.set(id, { port, child, mode: production ? 'production' : 'dev', startedAt: new Date().toISOString(), commit });
      const up = await waitForHttp(`http://127.0.0.1:${port}/`, 120_000, () => child.exitCode === null);
      if (!up) {
        await stop(id);
        throw new PreviewError('serve_failed', 'The preview did not start.', output);
      }
      if (!production) await warm(`http://127.0.0.1:${port}/`);
      return { id, port, url: urlFor(id, port), commit };
    },
  };
}
