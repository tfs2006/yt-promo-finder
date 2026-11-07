import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import {
  handleExpiredDomainsSearch,
  parseDeletedDomainsPage,
  parseWaybackHistory,
  normalizeKeyword,
  normalizeTld,
  isQualityCandidate,
  POOL_CACHE_KEY,
  VERIFY_CACHE_PREFIX
} from '../lib/expiredDomainHandlers.js';
import { getCreditsCatalog } from '../lib/credits.js';
import { setCache } from '../utils.js';

// Offline tests for the Expired Domain Finder. global fetch is mocked per
// test, so no ExpiredDomains.net, RDAP, or Wayback access is needed.
// Access is granted through owner demo mode (the same seam
// release.test.js uses), which never deducts credits; the charge itself
// is the shared finalizeToolAccess call with { chargeCredits: true }, the
// same call api/domain.js makes. What these tests prove about charging:
// the success path runs finalize (response carries `access`) and every
// failure path returns before finalize (no `access` in the body).

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    end() {
      return this;
    }
  };
  return res;
}

function mockReq(query = {}) {
  return {
    method: 'GET',
    headers: {
      'x-owner-demo-key': 'synthetic-test-key',
      'x-forwarded-for': '203.0.113.20'
    },
    query: { keyword: 'solar', tld: 'com', ...query },
    socket: {}
  };
}

function setOwnerDemo() {
  process.env.OWNER_DEMO_MODE = 'true';
  process.env.OWNER_DEMO_KEY = 'synthetic-test-key';
  process.env.OWNER_DEMO_IP_ALLOWLIST = '203.0.113.20';
  delete process.env.OWNER_DEMO_ALLOWLIST_IPS;
}

function clearOwnerDemo() {
  delete process.env.OWNER_DEMO_MODE;
  delete process.env.OWNER_DEMO_KEY;
  delete process.env.OWNER_DEMO_IP_ALLOWLIST;
  delete process.env.OWNER_DEMO_ALLOWLIST_IPS;
}

// The handler caches the drop pool and per-domain verification in the
// in-memory cache and in KV (file fallback in tests). Reset both between
// tests so each test starts cold and its mocked fetch is what gets used.
const FIXTURE_DOMAINS = [
  'solarpanels.com',
  'solargarden.net',
  'mysolarkit.com',
  'solarx9.com',
  'keto-plan.com',
  'mxhs4wv.autos',
  'averylongdomainnamethatexceedsthirtycharacterslimit.com',
  '12345.com'
];

function resetExpiredDomainState() {
  setCache(POOL_CACHE_KEY, null, 0);
  for (const domain of FIXTURE_DOMAINS) {
    setCache(VERIFY_CACHE_PREFIX + domain, null, 0);
  }
  for (const file of readdirSync(process.cwd())) {
    if (file.startsWith('cache_expired_domains')) {
      rmSync(file, { force: true });
    }
  }
}

// One list page in the exact shape ExpiredDomains.net serves (real rows
// from the live page, Nov 6 2026, plus synthetic keyword rows). The
// domain name lives in the link title; the visible text truncates long
// names, so the parser must read the title.
const LIST_PAGE_HTML = `
<table>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="solarpanels.com" class="namelinks" id="linksdd-domainsolarpanels">solarpanels.com</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="solargarden.net" class="namelinks" id="linksdd-domainsolargarden">solargarden.net</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="mysolarkit.com" class="namelinks" id="linksdd-domainmysolarkit">mysolarkit.com</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="solarx9.com" class="namelinks" id="linksdd-domainsolarx9">solarx9.com</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="keto-plan.com" class="namelinks" id="linksdd-domainketoplan">keto-plan.com</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="mxhs4wv.autos" class="namelinks" id="linksdd-domainmxhs4wv">mxhs4wv.autos</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="averylongdomainnamethatexceedsthirtycharacterslimit.com" class="namelinks" id="linksdd-domainlong">averylongdomainnamethatexceedsthirty...</a></td></tr>
<tr><td class="field_domain"><a href="/goto/1/naipik/489/" target="_blank" rel="nofollow" title="12345.com" class="namelinks" id="linksdd-domain12345">12345.com</a></td></tr>
</table>
`;

const CDX_HEADER = ['timestamp', 'original', 'statuscode'];

function mockUpstream({ rdap = {}, cdx = {}, listOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const href = String(url);
    if (href.includes('expireddomains.net')) {
      if (!listOk) throw new Error('list fetch failed');
      return { ok: true, status: 200, text: async () => LIST_PAGE_HTML };
    }
    if (href.includes('rdap.org/domain/')) {
      const domain = decodeURIComponent(href.split('/domain/')[1]);
      const status = rdap[domain] ?? 404;
      return { ok: status === 200, status, json: async () => ({}), text: async () => '' };
    }
    if (href.includes('web.archive.org/cdx')) {
      const domain = new URL(href).searchParams.get('url');
      const rows = cdx[domain] ?? [];
      return { ok: true, status: 200, json: async () => [CDX_HEADER, ...rows] };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return calls;
}

const DEFAULT_RDAP = {
  'solarpanels.com': 404,
  'solargarden.net': 404,
  'mysolarkit.com': 200,
  'solarx9.com': 404
};

const DEFAULT_CDX = {
  'solarpanels.com': [
    ['20150101000000', 'http://solarpanels.com/', '200'],
    ['20190601000000', 'http://solarpanels.com/', '200'],
    ['20230601000000', 'http://solarpanels.com/', '200']
  ],
  'solarx9.com': [
    ['20200101000000', 'http://solarx9.com/', '200'],
    ['20210601000000', 'http://solarx9.com/', '200']
  ],
  'solargarden.net': []
};

test('keyword search returns verified available domains with history', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  resetExpiredDomainState();
  const calls = mockUpstream({ rdap: DEFAULT_RDAP, cdx: DEFAULT_CDX });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.keyword, 'solar');
    assert.equal(res.body.tld, 'com');
    assert.equal(res.body.resultCount, 2);
    assert.equal(res.body.checkedCount, 3);
    assert.equal(res.body.searchedPoolSize, FIXTURE_DOMAINS.length);
    // Finalize ran: the response carries the access summary.
    assert.ok(res.body.access, 'success must carry access from finalizeToolAccess');
    assert.equal(res.body.access.mode, 'owner_demo');
    assert.equal(res.body.access.chargedCredits, 0);

    // Sorted by capture count: the longer history first.
    const [first, second] = res.body.results;
    assert.equal(first.domain, 'solarpanels.com');
    assert.equal(first.available, true);
    assert.equal(first.firstCapture, '2015-01-01');
    assert.equal(first.lastCapture, '2023-06-01');
    assert.equal(first.captureCount, 3);
    assert.equal(first.capturesCapped, false);
    assert.equal(first.historyUrl, 'https://web.archive.org/web/solarpanels.com');
    assert.equal(first.rdapUrl, 'https://rdap.org/domain/solarpanels.com');
    assert.equal(second.domain, 'solarx9.com');
    assert.equal(second.captureCount, 2);

    // Still-registered mysolarkit.com is excluded, never shown.
    assert.equal(res.body.excluded.registered, 1);
    assert.equal(res.body.excluded.noHistory, 0);
    assert.ok(res.body.results.every((r) => r.domain !== 'mysolarkit.com'));
    // No traffic or backlink numbers are ever claimed on a result: the
    // only metrics a result carries are capture dates and capture count.
    // (The notes honestly say traffic was not measured; that wording is
    // the disclosure, not a claim.)
    for (const result of res.body.results) {
      assert.equal('traffic' in result, false);
      assert.equal('backlinks' in result, false);
      assert.equal('visitors' in result, false);
      assert.equal('backlinkCount' in result, false);
    }

    // The list, RDAP, and CDX were all actually consulted.
    assert.ok(calls.some((c) => String(c.url).includes('expireddomains.net')));
    assert.ok(calls.some((c) => String(c.url).includes('rdap.org/domain/solarpanels.com')));
    assert.ok(calls.some((c) => String(c.url).includes('web.archive.org/cdx')));
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
    resetExpiredDomainState();
  }
});

test('tld=all includes .net matches and counts no-history exclusions', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  resetExpiredDomainState();
  mockUpstream({ rdap: DEFAULT_RDAP, cdx: DEFAULT_CDX });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq({ tld: 'all' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checkedCount, 4);
    assert.equal(res.body.resultCount, 2);
    // solargarden.net is available but has no archive history: excluded.
    assert.equal(res.body.excluded.noHistory, 1);
    assert.equal(res.body.excluded.registered, 1);
    assert.ok(res.body.notes.some((note) => /no site history/.test(note)));
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
    resetExpiredDomainState();
  }
});

test('zero matches returns 200 with an empty list and a note', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  resetExpiredDomainState();
  mockUpstream({ rdap: DEFAULT_RDAP, cdx: DEFAULT_CDX });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq({ keyword: 'zucchini' }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.results, []);
    assert.equal(res.body.resultCount, 0);
    assert.equal(res.body.checkedCount, 0);
    assert.ok(res.body.notes.some((note) => /No domains in this batch matched/.test(note)));
    assert.ok(res.body.access, 'zero-result success still runs finalize');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
    resetExpiredDomainState();
  }
});

test('parser reads the title attribute, not truncated link text', () => {
  const parsed = parseDeletedDomainsPage(LIST_PAGE_HTML);
  assert.equal(parsed.length, FIXTURE_DOMAINS.length);
  assert.ok(parsed.includes('averylongdomainnamethatexceedsthirtycharacterslimit.com'));
  assert.ok(!parsed.some((d) => d.includes('...')));
  assert.ok(parsed.includes('mxhs4wv.autos'));
});

test('quality gate rejects junk names and odd TLDs', () => {
  assert.equal(isQualityCandidate('solarpanels.com'), true);
  assert.equal(isQualityCandidate('solarx9.com'), true);
  assert.equal(isQualityCandidate('keto-plan.com'), true);
  assert.equal(isQualityCandidate('mxhs4wv.autos'), false);
  assert.equal(isQualityCandidate('12345.com'), false);
  assert.equal(isQualityCandidate('r52de986tz.skin'), false);
  assert.equal(isQualityCandidate('averylongdomainnamethatexceedsthirtycharacterslimit.com'), false);
  assert.equal(isQualityCandidate('a.com'), false);
  assert.equal(isQualityCandidate('solar_panels.com'), false);
});

test('keyword and TLD validation', () => {
  assert.equal(normalizeKeyword('  Solar '), 'solar');
  assert.equal(normalizeKeyword('"solar"'), 'solar');
  assert.equal(normalizeKeyword('a'), '');
  assert.equal(normalizeKeyword('solar panels'), '');
  assert.equal(normalizeKeyword(''), '');
  assert.equal(normalizeTld('.COM'), 'com');
  assert.equal(normalizeTld('all'), 'all');
  assert.equal(normalizeTld(''), 'all');
  assert.equal(normalizeTld('xyz'), '');
});

test('wayback history parsing uses first and last captures', () => {
  const parsed = parseWaybackHistory([
    ['timestamp', 'original', 'statuscode'],
    ['20150101000000', 'http://example.com/', '200'],
    ['20230601000000', 'http://example.com/', '200']
  ]);
  assert.equal(parsed.hasHistory, true);
  assert.equal(parsed.firstCapture, '2015-01-01');
  assert.equal(parsed.lastCapture, '2023-06-01');
  assert.equal(parsed.captureCount, 2);
  assert.equal(parsed.capturesCapped, false);
  assert.equal(parseWaybackHistory([]), null);
  assert.equal(parseWaybackHistory([['timestamp', 'original', 'statuscode']]), null);
});

test('denied access returns 402 with toolCost 10 and no upstream calls', async () => {
  const originalFetch = globalThis.fetch;
  clearOwnerDemo();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq(), res);
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.code, 'AUTH_REQUIRED');
    assert.equal(res.body.toolCost, 10);
    assert.equal(calls.length, 0, 'denied access must not reach any upstream');
    assert.equal(res.body.access, undefined, 'failure must not run finalize');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('missing keyword returns 400 without calling upstream', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  const calls = mockUpstream({ rdap: DEFAULT_RDAP, cdx: DEFAULT_CDX });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq({ keyword: '' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('unsupported TLD returns 400 without calling upstream', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  const calls = mockUpstream({ rdap: DEFAULT_RDAP, cdx: DEFAULT_CDX });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq({ tld: 'xyz' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('feed down with no cache returns 502 and no charge', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  resetExpiredDomainState();
  mockUpstream({ listOk: false });
  try {
    const res = mockRes();
    await handleExpiredDomainsSearch(mockReq(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(res.body.access, undefined, 'feed failure must not run finalize');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
    resetExpiredDomainState();
  }
});

test('expired-domains costs 10 credits', () => {
  assert.equal(getCreditsCatalog().toolCosts['expired-domains'], 10);
});
