import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_V4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10],
  [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 3]
];

/** Only globally routable unicast addresses; reject IPv6 transition mechanisms. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
    return !BLOCKED_V4.some(([base, bits]) =>
      Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (family !== 6 || address.includes('%')) return false;
  // Allow only native 2000::/3 global unicast. This also rejects all mapped
  // IPv4, NAT64, local, multicast and site/link-local IPv6 addresses.
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left).map(word => parseInt(word, 16));
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  // Special-purpose 2001::/23, documentation, 6to4 and AS112 ranges.
  if (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) return false;
  if (words[0] === 0x2002) return false;
  if (words[0] === 0x3fff && words[1] < 0x1000) return false;
  if (words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000) return false;
  // Reject any embedded dotted IPv4 spelling, even in otherwise global IPv6.
  return !address.includes('.');
}

export function validateLinkUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('Invalid hostname');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Blocked address');
  url.hash = '';
  return url;
}

function errorResult(err) {
  const message = String(err.message || 'Unknown error');
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || /ENOTFOUND|getaddrinfo/.test(message)) {
    return { working: false, error: 'Domain not found' };
  }
  if (err.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return { working: false, error: 'Connection refused' };
  }
  if (/CERT|SSL|TLS/.test(`${err.code || ''} ${message}`)) {
    return { working: false, error: 'SSL certificate error' };
  }
  return { working: false, error: message.substring(0, 100) };
}

/** Dependency injection is for offline tests; production uses Node DNS/HTTP. */
export function createSafeLinkChecker({
  dnsLookup = lookup,
  httpRequest: requestHttp = httpRequest,
  httpsRequest: requestHttps = httpsRequest
} = {}) {
  return async function check(input, timeout = MAX_TIMEOUT_MS) {
    const duration = Number.isFinite(timeout)
      ? Math.max(1, Math.min(timeout, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS;
    let stopped = false;
    let activeRequest;
    let activeResponse;
    let timer;
    const ensureActive = () => {
      if (stopped) throw new Error('Timeout');
    };
    const cleanup = () => {
      activeResponse?.destroy();
      activeRequest?.destroy();
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stopped = true;
        reject(new Error('Timeout'));
        cleanup();
      }, duration);
    });

    const run = async () => {
      let url = validateLinkUrl(input);
      let method = 'HEAD';
      let redirects = 0;
      while (true) {
        ensureActive();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const literalFamily = isIP(hostname);
        const addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
          : await new Promise((resolve, reject) => {
            dnsLookup(hostname, { all: true, verbatim: true }, (err, records) =>
              err ? reject(err) : resolve(records));
          });
        ensureActive();
        // Fail closed on mixed public/private answers and invalid DNS records.
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(record =>
          !record || !isPublicAddress(record.address) || isIP(record.address) !== record.family)) {
          throw new Error('Blocked address');
        }
        const pinned = addresses[0];
        const response = await new Promise((resolve, reject) => {
          const request = url.protocol === 'https:' ? requestHttps : requestHttp;
          activeRequest = request({
            protocol: url.protocol,
            hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            method,
            agent: false,
            family: pinned.family,
            autoSelectFamily: false,
            // Keep the original hostname for Host, SNI and certificate validation,
            // but never resolve it again when opening the socket.
            lookup: (_hostname, options, callback) => {
              if (stopped) return callback(new Error('Timeout'));
              if (options?.all) return callback(null, [pinned]);
              callback(null, pinned.address, pinned.family);
            },
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
          }, res => {
            activeResponse = res;
            res.once('error', reject);
            const metadata = { status: res.statusCode, location: res.headers.location };
            // Only headers are needed. Destroy HEAD and GET responses immediately,
            // rather than draining an arbitrarily large or never-ending body.
            cleanup();
            if (stopped) return reject(new Error('Timeout'));
            resolve(metadata);
          });
          activeRequest.once('error', reject);
          activeRequest.end();
        });
        ensureActive();
        if (REDIRECTS.has(response.status) && response.location) {
          if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');
          url = validateLinkUrl(new URL(response.location, url));
          redirects++;
          continue;
        }
        if (response.status === 405 && method === 'HEAD') {
          method = 'GET';
          continue;
        }
        const result = { working: response.status >= 200 && response.status < 400, status: response.status };
        if (redirects) result.redirectUrl = url.href;
        return result;
      }
    };

    try {
      return await Promise.race([deadline, run()]);
    } catch (err) {
      return errorResult(err);
    } finally {
      stopped = true;
      clearTimeout(timer);
      cleanup();
    }
  };
}

export const safeLinkCheck = createSafeLinkChecker();