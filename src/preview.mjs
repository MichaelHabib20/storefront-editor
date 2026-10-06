/**
 * Previews (design §3): a store copy is built and served on its own port with the store's API settings, so
 * the merchant sees the change before it is published. One preview per store; starting again rebuilds.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
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

/** Stops a server and everything it started; resolves once it is gone (so its port is free again). */
function killTree(child) {
  if (child.exitCode !== null) return Promise.resolve();
  const gone = new Promise((resolve) => {
    child.once('close', resolve);
    setTimeout(resolve, 10_000).unref?.();
  });
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill();
  return gone;
}

export function createPreviews(config, stores, env = process.env) {
  /** id -> { port, child, startedAt, commit } */
  const running = new Map();
  const urlFor = (port) => config.previewPublicUrls?.[String(port)] ?? `http://localhost:${port}`;
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
    await killTree(preview.child);
    return true;
  }

  return {
    list() {
      return [...running.entries()].map(([id, p]) => ({ id, port: p.port, mode: p.mode, url: urlFor(p.port), startedAt: p.startedAt, commit: p.commit }));
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
          return { id, port: current.port, url: urlFor(current.port), commit: current.commit };
        }
      }
      await stop(id);

      if (production) {
        const [buildCommand, buildArgs] = config.build;
        const built = await run(buildCommand, buildArgs, { cwd, env: envFor });
        if (built.code !== 0) throw new PreviewError('build_failed', 'The preview build failed.', built.output.slice(-20_000));
      }

      const port = await freePort();
      const [serveCommand, serveArgs] = production ? config.serve : config.devServe ?? config.serve;
      const child = spawn(serveCommand, serveArgs.map((a) => a.replaceAll('{port}', String(port))), {
        cwd,
        env: { ...process.env, ...envFor, PORT: String(port) },
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
      return { id, port, url: urlFor(port), commit };
    },
  };
}
