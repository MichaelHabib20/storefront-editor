/**
 * The proxy the site reader's browser goes through: tunnels and plain requests only to checked public addresses,
 * and always to the address that was checked.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { createFetchGuard } from '../src/fetch-guard.mjs';
import { createGuardProxy } from '../src/guard-proxy.mjs';

let echo, proxy, port;
const dialed = [];
let lookups = 0;

before(async () => {
  echo = net.createServer((socket) => socket.on('data', (d) => socket.write(`echo:${d}`)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const guard = createFetchGuard({
    resolve: async (host) => {
      lookups += 1;
      // a name that answers with a public address the first time and an internal one after (DNS rebinding)
      if (host === 'rebind.test') return lookups % 2 ? ['93.184.216.34'] : ['127.0.0.1'];
      return host === 'public.test' ? ['93.184.216.34'] : ['10.0.0.9'];
    },
  });
  proxy = createGuardProxy({
    guard,
    dial: (ip, p, host) => {
      dialed.push({ ip, port: p, host });
      return net.connect({ host: '127.0.0.1', port: echo.address().port });
    },
  });
  port = await proxy.listen();
});

after(async () => {
  await proxy.close();
  echo.close();
});

/** Sends a CONNECT and answers the status line (and what an open tunnel echoes back). */
function connect(target, payload = null) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (payload && data.includes('200') && !data.includes('echo:')) socket.write(payload);
      if (!payload || data.includes('echo:')) socket.end();
    });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

test('a tunnel to a public name is opened and carries data', async () => {
  const answer = await connect('public.test:443', 'hello');
  assert.match(answer, /^HTTP\/1\.1 200/);
  assert.ok(answer.includes('echo:hello'));
});

test('a tunnel to an internal address, an internal name or a bad port is refused (403) and nothing is dialed', async () => {
  dialed.length = 0;
  for (const target of ['127.0.0.1:443', '[::1]:443', '169.254.169.254:80', '192.168.1.1:443', 'internal.test:443', 'public.test:8443', 'public.test:22', 'garbage']) {
    assert.match(await connect(target), /^HTTP\/1\.1 403/, target);
  }
  assert.deepEqual(dialed, []);
});

test('the connection goes to the address that was checked, not to the name', async () => {
  dialed.length = 0;
  await connect('public.test:443', 'x');
  assert.equal(dialed[0].ip, '93.184.216.34');
  assert.equal(dialed[0].host, 'public.test');
});

test('a name that changes its answer after the check cannot lead inside', async () => {
  dialed.length = 0;
  lookups = 0; // the first lookup says public, the next one says internal
  const first = await connect('rebind.test:443');
  assert.match(first, /^HTTP\/1\.1 200/);
  assert.equal(dialed[0].ip, '93.184.216.34', 'only the checked address is dialed');
  const second = await connect('rebind.test:443');
  assert.match(second, /^HTTP\/1\.1 403/, 'the next lookup says internal: refused');
});

test('plain http: an internal target gets no answer at all', async () => {
  const hit = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    socket.on('data', (c) => (data += c));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.write('GET http://127.0.0.1:9/ HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n');
  });
  assert.equal(hit, '');
});
