/**
 * The guard in front of other people's websites: only public http(s) addresses on the usual ports, nothing internal,
 * also not when a public name points at an internal address.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UrlRefused, createFetchGuard, isPublicIp, ownHostsOf } from '../src/fetch-guard.mjs';

const PUBLIC = '93.184.216.34';
const guard = createFetchGuard({
  resolve: async (host) => {
    if (host === 'shop.example') return [PUBLIC];
    if (host === 'sneaky.example') return ['10.0.0.5'];
    if (host === 'mixed.example') return [PUBLIC, '127.0.0.1'];
    if (host === 'v6.example') return ['2606:2800:220:1:248:1893:25c8:1946'];
    if (host === 'v6internal.example') return ['fd00::1'];
    if (host === 'tunnel.trycloudflare.com') return [PUBLIC];
    throw new Error('ENOTFOUND');
  },
  ownHosts: ownHostsOf({ previewPublicUrls: { 3301: 'https://tunnel.trycloudflare.com' } }),
});
const refused = (value) => assert.rejects(guard.check(value), UrlRefused, value);

test('public and internal addresses', () => {
  for (const ip of [PUBLIC, '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1', 'not an ip']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test('a public https and http address is allowed', async () => {
  assert.equal((await guard.check('https://shop.example/en?x=1')).hostname, 'shop.example');
  assert.equal((await guard.check('http://shop.example:80/')).hostname, 'shop.example');
  assert.equal((await guard.check('https://shop.example:443/')).hostname, 'shop.example');
  assert.equal((await guard.check('https://v6.example/')).hostname, 'v6.example');
  assert.equal((await guard.check(`http://${PUBLIC}/`)).hostname, PUBLIC);
});

test('every address of the plan is refused with a plain message', async () => {
  for (const value of ['http://127.0.0.1:4310', 'http://localhost', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'ftp://example.com', 'http://0.0.0.0', 'http://[fd00::1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/']) {
    await refused(value);
  }
  await assert.rejects(guard.check('http://127.0.0.1:4310'), (error) => error.code === 'url_refused' && /public website/.test(error.message));
});

test('a public name that points inside is refused, also when only one of its addresses does', async () => {
  await refused('https://sneaky.example/');
  await refused('https://mixed.example/');
  await refused('https://v6internal.example/');
});

test('other ports, passwords in the link, odd schemes, nonsense and unknown names are refused', async () => {
  await refused('https://shop.example:8443/');
  await refused('http://shop.example:4310/');
  await refused('https://user:secret@shop.example/');
  await refused('https://user@shop.example/');
  await refused('file:///etc/passwd');
  await refused('javascript:alert(1)');
  await refused('data:text/html,hi');
  await refused('not a url');
  await refused('');
  await assert.rejects(guard.check('https://nowhere.example/'), /could not be found/);
});

test("the editor's own tunnel and preview hosts are refused", async () => {
  await refused('https://tunnel.trycloudflare.com/');
  await refused('http://LOCALHOST/');
});
