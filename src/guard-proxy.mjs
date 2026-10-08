/**
 * A small forward proxy that the site-reading browser goes through (v2 plan §5.2). It is the one place every request
 * of the page passes — the page itself, its redirects, images, scripts, sockets — so the fetch guard is applied to
 * all of them, and each connection goes to the address the guard checked (a name that answers differently a second
 * time cannot lead inside). A refused connection is simply not made.
 *
 * (The browser's own request interception does not see redirect hops, which is why this is a proxy.)
 */
import http from 'node:http';
import net from 'node:net';

/** `host:port` of a CONNECT target; IPv6 comes as `[::1]:443`. */
function splitTarget(target) {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(String(target));
  return m ? { host: m[1] ?? m[2], port: Number(m[3]) } : null;
}

/** Connects to the first address that answers. */
function dialAny(dial, addresses, port, host) {
  return new Promise((resolve, reject) => {
    const attempt = (i) => {
      if (i >= addresses.length) return reject(new Error('no address answered'));
      const socket = dial(addresses[i], port, host);
      const failed = () => {
        socket.destroy();
        attempt(i + 1);
      };
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.off('error', failed);
        resolve(socket);
      });
    };
    attempt(0);
  });
}

/**
 * @param guard  the fetch guard (`inspect`)
 * @param dial   (ip, port, host) -> socket; the real one connects to the IP (a test seam)
 */
export function createGuardProxy({ guard, dial = (ip, port) => net.connect({ host: ip, port }), log = () => {} }) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const refuse = () => {
      // no answer at all: the browser reports the page as not reachable
      req.socket.destroy();
    };
    let target;
    try {
      target = await guard.inspect(req.url);
    } catch {
      log('refused', req.url);
      return refuse();
    }
    const { url, addresses } = target;
    if (url.protocol !== 'http:') return refuse();
    try {
      const port = Number(url.port || 80);
      const socket = await dialAny(dial, addresses, port, url.hostname);
      const headers = { ...req.headers, host: url.host };
      for (const name of Object.keys(headers)) if (/^proxy-/i.test(name)) delete headers[name];
      const upstream = http.request({ createConnection: () => socket, method: req.method, path: `${url.pathname}${url.search}`, headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', (error) => {
        log('upstream error', error.code, error.message);
        refuse();
      });
      req.pipe(upstream);
    } catch {
      refuse();
    }
  });

  // https (and anything else the browser tunnels): the tunnel goes to a checked address
  server.on('connect', async (req, client, head) => {
    const refuse = () => client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const parsed = splitTarget(req.url);
    if (!parsed) return refuse();
    let addresses;
    try {
      ({ addresses } = await guard.inspect(`${parsed.port === 80 ? 'http' : 'https'}://${parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host}:${parsed.port}/`));
    } catch {
      log('refused', req.url);
      return refuse();
    }
    try {
      const upstream = await dialAny(dial, addresses, parsed.port, parsed.host);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      const close = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.on('error', close);
      client.on('error', close);
      upstream.on('close', close);
      client.on('close', close);
    } catch {
      refuse();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let port = null;
  return {
    /** Starts on a free local port (once) and answers it. */
    async listen() {
      if (port) return port;
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
      return port;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      port = null;
    },
  };
}
