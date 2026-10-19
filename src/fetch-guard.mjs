/**
 * Safe fetching of other people's websites (v2 plan §5.2). The owner gives a link; this decides whether the editor
 * may open it. A link that reaches an internal address (this machine, the office network, a cloud metadata address,
 * the editor's own preview and tunnel hosts) must never be opened, also not through a redirect or a sub-request of
 * the page: the browser sends every request of a page through the same check (see site-reader.mjs).
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export class UrlRefused extends Error {
  constructor(message) {
    super(message);
    this.code = 'url_refused';
  }
}

const PLAIN = 'This address cannot be read. Please give the link of a public website that starts with https://.';

/** @param {string} ip dotted IPv4 */
const v4 = (ip) => ip.split('.').map(Number);

/** True when `ip` is an address of the public internet (anything private, loopback, link-local, reserved is not). */
export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = v4(ip);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast and reserved (including 255.255.255.255)
    return true;
  }
  if (net.isIPv6(ip)) {
    const text = ip.toLowerCase();
    // an IPv4 address inside an IPv6 one is judged as the IPv4 address
    const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (dotted) return isPublicIp(dotted[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (text === '::' || text === '::1') return false;
    const first = parseInt(text.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (text.startsWith('2001:db8') || text.startsWith('2001:0db8')) return false; // documentation
    if (text.startsWith('64:ff9b:')) return false; // NAT64 can reach IPv4 internals
    return true;
  }
  return false;
}

/**
 * @param resolve  host -> [ip] (a test seam; the real one asks DNS for every address)
 * @param ownHosts host names that are the editor's own (preview and tunnel addresses): never readable; one that
 *   starts with "." is a whole domain
 * @param ports    the only ports allowed besides the scheme's own
 */
export function createFetchGuard({ resolve = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address), ownHosts = [], ports = [80, 443] } = {}) {
  const own = new Set(ownHosts.map((h) => String(h).toLowerCase()));
  // ".preview.example.com": that domain and every name under it
  const ownDomains = [...own].filter((h) => h.startsWith('.'));

  /**
   * Throws `UrlRefused` (with a message fit for the owner) unless `value` may be opened.
   * @returns {Promise<{ url: URL, addresses: string[] }>} the URL and the checked public addresses of its host (IPv4
   *   first): connect to these, not to the name, so the answer of DNS cannot change between the check and the use
   */
  async function inspect(value) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      throw new UrlRefused(PLAIN);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlRefused(PLAIN);
    if (url.username || url.password) throw new UrlRefused(PLAIN);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!ports.includes(port)) throw new UrlRefused(PLAIN);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || own.has(host) || ownDomains.some((d) => host.endsWith(d) || host === d.slice(1))) throw new UrlRefused(PLAIN);
    let addresses;
    if (net.isIP(host)) addresses = [host];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new UrlRefused('That address could not be found.');
      }
    }
    if (!addresses.length || !addresses.every(isPublicIp)) throw new UrlRefused(PLAIN);
    return { url, addresses: [...addresses].sort((x, y) => Number(net.isIPv6(x)) - Number(net.isIPv6(y))) };
  }

  /** Like `inspect`, answers just the URL. */
  async function check(value) {
    return (await inspect(value)).url;
  }

  return { check, inspect };
}

/**
 * The host names of the editor's own preview and tunnel addresses (EDITOR_PREVIEW_PUBLIC_URLS) and this machine; the
 * preview domain (EDITOR_PREVIEW_DOMAIN) as ".<domain>", which covers every name under it.
 */
export function ownHostsOf(config) {
  const hosts = new Set(['localhost']);
  if (config.previewDomain) hosts.add(`.${config.previewDomain.toLowerCase()}`);
  for (const value of Object.values(config.previewPublicUrls ?? {})) {
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // not an address
    }
  }
  return [...hosts];
}
