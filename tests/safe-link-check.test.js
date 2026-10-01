import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSafeLinkChecker, isPublicAddress, validateLinkUrl } from '../lib/safeLinkCheck.js';

function harness(steps = [], records = [{ address: '93.184.216.34', family: 4 }]) {
  const requests = [];
  const responses = [];
  const lookups = [];
  const dnsLookup = (hostname, options, callback) => {
    lookups.push({ hostname, options });
    queueMicrotask(() => callback(null, typeof records === 'function' ? records(hostname) : records));
  };
  const request = (options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      const step = steps[requests.indexOf(req)];
      if (!step || step.hang) return;
      if (step.error) return req.emit('error', step.error);
      const res = new EventEmitter();
      res.statusCode = step.status;
      res.headers = step.location ? { location: step.location } : {};
      res.destroyed = false;
      res.destroy = () => { res.destroyed = true; };
      res.resume = () => assert.fail('Must not download/drain unbounded body');
      responses.push(res);
      callback(res);
    });
    req.options = options;
    requests.push(req);
    return req;
  };
  return {
    check: createSafeLinkChecker({ dnsLookup, httpRequest: request, httpsRequest: request }),
    requests, responses, lookups
  };
}

test('IPv4 validator blocks private, loopback, link-local and reserved ranges', () => {
  for (const address of [
    '0.0.0.0', '0.8.1.2', '10.1.2.3', '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.0.0.9', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255', 'not-an-ip'
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('IPv6 validator blocks local, reserved, mapped and transition addresses', () => {
  for (const address of [
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::127.0.0.1',
    '64:ff9b::a9fe:a9fe', '100::1', '2001::1', '2001:2::1', '2001:10::1',
    '2001:db8::1', '2002:7f00:1::', '3fff::1', '2620:4f:8000::1', '4000::1'
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('URL validation restricts schemes, credentials and alternate IP spellings', () => {
  for (const url of [
    'file:///etc/passwd', 'ftp://example.com', 'data:text/plain,hello', 'not a URL',
    'https://user@example.com', 'https://:pass@example.com', 'https://user:pass@example.com',
    'https://u%73er@example.com', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://[::1]', 'http://[::ffff:127.0.0.1]'
  ]) assert.throws(() => validateLinkUrl(url), undefined, url);
  assert.equal(validateLinkUrl('https://example.com/path#fragment').href, 'https://example.com/path');
});

test('unsafe URLs fail before DNS or request', async () => {
  const h = harness();
  for (const url of ['http://10.0.0.1', 'https://user@example.com', 'file:///tmp/file']) {
    assert.equal((await h.check(url)).working, false);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.lookups.length, 0);
});

test('DNS rejects private, mixed, empty and malformed answers', async () => {
  for (const records of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '::ffff:7f00:1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [], [{ address: '8.8.8.8', family: 6 }], [{ address: 'invalid', family: 4 }], [null]
  ]) {
    const h = harness([], records);
    assert.deepEqual(await h.check('https://example.com'), { working: false, error: 'Blocked address' });
    assert.equal(h.requests.length, 0);
  }
});

test('DNS is pinned without a second lookup, preserving hostname and TLS defaults', async () => {
  const h = harness([{ status: 200 }], () => h.lookups.length === 1
    ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  assert.deepEqual(await h.check('https://example.com:8443/path?q=1'), { working: true, status: 200 });
  const options = h.requests[0].options;
  assert.equal(options.hostname, 'example.com');
  assert.equal(options.port, '8443');
  assert.equal(options.path, '/path?q=1');
  assert.equal(options.method, 'HEAD');
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  assert.notEqual(options.rejectUnauthorized, false);
  options.lookup('example.com', {}, (err, address) => {
    // The checker has completed, so later socket lookup must be disallowed.
    assert.match(err.message, /Timeout/);
    assert.equal(address, undefined);
  });
  assert.equal(h.lookups.length, 1);
  assert.ok(h.requests.every(req => req.destroyed));
  assert.ok(h.responses.every(res => res.destroyed));
});

test('socket lookup returns the validated address while request is active', async () => {
  for (const pinned of [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ]) {
    let dnsCalls = 0;
    const check = createSafeLinkChecker({
      dnsLookup: (_host, _options, cb) => { dnsCalls++; cb(null, [pinned]); },
      httpsRequest: (options, cb) => {
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          options.lookup('example.com', {}, (err, address, family) => {
            assert.equal(err, null);
            assert.equal(address, pinned.address);
            assert.equal(family, pinned.family);
          });
          options.lookup('example.com', { all: true }, (err, records) => {
            assert.equal(err, null);
            assert.deepEqual(records, [pinned]);
          });
          const res = new EventEmitter();
          res.statusCode = 204;
          res.headers = {};
          res.destroy = () => {};
          cb(res);
        };
        return req;
      }
    });
    assert.deepEqual(await check('https://example.com'), { working: true, status: 204 });
    assert.equal(dnsCalls, 1);
  }
});

test('public IP literals need no DNS and IPv6 hostname is unbracketed', async () => {
  const h = harness([{ status: 200 }, { status: 200 }]);
  assert.equal((await h.check('http://8.8.8.8')).working, true);
  assert.equal((await h.check('https://[2606:4700:4700::1111]')).working, true);
  assert.equal(h.lookups.length, 0);
  assert.equal(h.requests[1].options.hostname, '2606:4700:4700::1111');
});

test('relative and cross-host redirects are resolved and validated separately', async () => {
  const h = harness([
    { status: 302, location: '/next' },
    { status: 307, location: 'http://other.example/final' },
    { status: 200 }
  ]);
  assert.deepEqual(await h.check('https://example.com/start'), {
    working: true, status: 200, redirectUrl: 'http://other.example/final'
  });
  assert.deepEqual(h.lookups.map(record => record.hostname), ['example.com', 'example.com', 'other.example']);
  assert.ok(h.responses.every(res => res.destroyed));
});

test('redirects cannot reach private literals, credentials or non-HTTP schemes', async () => {
  for (const location of [
    'http://169.254.169.254/latest', '//127.0.0.1/admin', 'http://[::1]',
    'http://[::ffff:a9fe:a9fe]', 'https://user:pass@example.com', 'file:///etc/passwd'
  ]) {
    const h = harness([{ status: 302, location }]);
    assert.equal((await h.check('https://example.com')).working, false, location);
    assert.equal(h.requests.length, 1);
  }
});

test('redirect DNS and same-host rebinding are checked again before connection', async () => {
  for (const location of ['https://private.example/', '/next']) {
    const h = harness([{ status: 301, location }], () => [
      { address: h.lookups.length === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }
    ]);
    assert.deepEqual(await h.check('https://example.com'), { working: false, error: 'Blocked address' });
    assert.equal(h.requests.length, 1);
  }
});

test('at most five redirects are followed including loops', async () => {
  const redirects = Array.from({ length: 5 }, () => ({ status: 302, location: '/next' }));
  const allowed = harness([...redirects, { status: 200 }]);
  assert.equal((await allowed.check('https://example.com')).working, true);
  assert.equal(allowed.requests.length, 6);
  const blocked = harness([...redirects, { status: 302, location: '/next' }]);
  assert.deepEqual(await blocked.check('https://example.com'), { working: false, error: 'Too many redirects' });
  assert.equal(blocked.requests.length, 6);
});

test('HEAD 405 falls back to GET at current URL and destroys body immediately', async () => {
  const h = harness([
    { status: 302, location: '/next' }, { status: 405 }, { status: 200 }
  ]);
  assert.deepEqual(await h.check('https://example.com'), {
    working: true, status: 200, redirectUrl: 'https://example.com/next'
  });
  assert.deepEqual(h.requests.map(req => req.options.method), ['HEAD', 'HEAD', 'GET']);
  assert.deepEqual(h.requests.map(req => req.options.path), ['/', '/next', '/next']);
  assert.ok(h.responses.every(res => res.destroyed));
  assert.ok(h.requests.every(req => req.destroyed));
});

test('GET redirects remain validated and share the redirect budget', async () => {
  const blocked = harness([{ status: 405 }, { status: 302, location: 'http://10.0.0.1' }]);
  assert.deepEqual(await blocked.check('https://example.com'), { working: false, error: 'Blocked address' });
  const h = harness([
    ...Array.from({ length: 5 }, () => ({ status: 302, location: '/next' })),
    { status: 405 }, { status: 302, location: '/next' }
  ]);
  assert.deepEqual(await h.check('https://example.com'), { working: false, error: 'Too many redirects' });
  assert.equal(h.requests.length, 7);
});

test('non-working HTTP statuses and GET 405 retain the existing result shape', async () => {
  for (const status of [404, 500]) {
    assert.deepEqual(await harness([{ status }]).check('https://example.com'), { working: false, status });
  }
  const h = harness([{ status: 405 }, { status: 405 }]);
  assert.deepEqual(await h.check('https://example.com'), { working: false, status: 405 });
  assert.equal(h.requests.length, 2);
});

test('request timeout destroys the outstanding request', async () => {
  const h = harness([{ hang: true }]);
  assert.deepEqual(await h.check('https://example.com', 10), { working: false, error: 'Timeout' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].destroyed, true);
});

test('DNS timeout prevents a late lookup callback from starting a request', async () => {
  let finishDns;
  let requests = 0;
  const check = createSafeLinkChecker({
    dnsLookup: (_host, _options, callback) => { finishDns = callback; },
    httpsRequest: () => { requests++; assert.fail('Request after deadline'); }
  });
  assert.deepEqual(await check('https://example.com', 10), { working: false, error: 'Timeout' });
  finishDns(null, [{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});

test('one deadline spans DNS, redirects and GET fallback without timer resets', async () => {
  const h = harness([{ status: 302, location: '/next' }, { status: 405 }, { hang: true }]);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const cleared = [];
  try {
    globalThis.setTimeout = (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    };
    globalThis.clearTimeout = timer => cleared.push(timer);
    const pending = h.check('https://example.com', 25);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.requests.map(req => req.options.method), ['HEAD', 'HEAD', 'GET']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 25);
    timers[0].callback();
    assert.deepEqual(await pending, { working: false, error: 'Timeout' });
    assert.ok(h.requests.every(req => req.destroyed));
    assert.deepEqual(cleared, [timers[0]]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('timeout is bounded and cleared on successful completion', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays = [];
  let clears = 0;
  try {
    globalThis.setTimeout = (_callback, delay) => { delays.push(delay); return {}; };
    globalThis.clearTimeout = () => { clears++; };
    for (const timeout of [Infinity, NaN, 999999, -1]) {
      assert.equal((await harness([{ status: 200 }]).check('http://example.com', timeout)).working, true);
    }
    assert.deepEqual(delays, [10000, 10000, 10000, 1]);
    assert.equal(clears, 4);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('DNS, connection and certificate errors retain familiar messages', async () => {
  const dnsCheck = createSafeLinkChecker({
    dnsLookup: (_host, _options, callback) => callback(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }))
  });
  assert.deepEqual(await dnsCheck('https://example.com'), { working: false, error: 'Domain not found' });
  for (const [code, error] of [['ECONNREFUSED', 'Connection refused'], ['CERT_HAS_EXPIRED', 'SSL certificate error']]) {
    const h = harness([{ error: Object.assign(new Error('request failed'), { code }) }]);
    assert.deepEqual(await h.check('https://example.com'), { working: false, error });
    assert.ok(h.requests[0].destroyed);
  }
});