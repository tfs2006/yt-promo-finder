import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdLibrariesSearch } from '../lib/adLibraryHandlers.js';
import { getCreditsCatalog } from '../lib/credits.js';

// Offline tests for the real Meta Ads Library handler. global fetch is
// mocked per test, so no Scrape Atlas key or network is needed. Access is
// granted through owner demo mode (the same seam release.test.js uses),
// which never deducts credits; the charge itself is the shared
// finalizeToolAccess call with { chargeCredits: true }, the same call
// api/domain.js makes. What these tests prove about charging: the
// success path runs finalize (response carries `access`) and every
// failure path returns before finalize (no `access` in the body).

const FAKE_SA_KEY = 'test-sa-key-DO-NOT-USE-abcdef12345';

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
    query: { query: 'nike', region: 'US', ...query },
    socket: {}
  };
}

function setOwnerDemo() {
  process.env.SCRAPE_ATLAS_API_KEY = FAKE_SA_KEY;
  process.env.OWNER_DEMO_MODE = 'true';
  process.env.OWNER_DEMO_KEY = 'synthetic-test-key';
  process.env.OWNER_DEMO_IP_ALLOWLIST = '203.0.113.20';
  delete process.env.OWNER_DEMO_ALLOWLIST_IPS;
}

function clearOwnerDemo() {
  delete process.env.SCRAPE_ATLAS_API_KEY;
  delete process.env.OWNER_DEMO_MODE;
  delete process.env.OWNER_DEMO_KEY;
  delete process.env.OWNER_DEMO_IP_ALLOWLIST;
  delete process.env.OWNER_DEMO_ALLOWLIST_IPS;
}

function mockSaSuccess(body) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

function mockSaFailure(status, failureCode) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: false,
      status,
      json: async () => ({ success: false, failure: { code: failureCode, message: 'upstream says no' } })
    };
  };
  return calls;
}

const SA_SUCCESS_BODY = {
  success: true,
  status: 'ok',
  requestId: 'req-test-1',
  sourceUrl: 'https://www.facebook.com/ads/library/?q=nike',
  fetchedAt: '2026-11-06T07:00:00.000Z',
  coverage: { source: 'meta_ad_library', complete: true, warnings: [] },
  accounting: { creditsCharged: 1 },
  ads: [
    {
      ad_archive_id: '123456789',
      page_id: '111',
      is_active: true,
      snapshot: {
        page_name: 'Acme Co',
        ad_creative_body: 'Try our new widget today.',
        ad_creative_link_title: 'Shop now',
        ad_delivery_start_time: '2026-10-01',
        publisher_platforms: ['facebook', 'instagram'],
        images: [{ original_image_url: 'https://example.com/img.jpg' }],
        videos: [{ video_url: 'https://example.com/vid.mp4' }],
        ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=123456789'
      }
    },
    {
      ad_archive_id: '987654321',
      page_id: '222',
      is_active: false,
      snapshot: { page_name: 'Sparse Brand' }
    }
  ],
  searchResultsCount: 2
};

test('returns trimmed real ads and runs finalize only on success', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  const calls = mockSaSuccess(SA_SUCCESS_BODY);
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.query, 'nike');
    assert.equal(res.body.region, 'US');
    assert.equal(res.body.adCount, 2);
    assert.equal(res.body.searchResultsCount, 2);
    assert.equal(res.body.fetchedAt, '2026-11-06T07:00:00.000Z');
    assert.equal(res.body.coverage.complete, true);
    assert.equal(res.body.sourceUrl, 'https://www.facebook.com/ads/library/?q=nike');
    // Finalize ran: the response carries the access summary.
    assert.ok(res.body.access, 'success must carry access from finalizeToolAccess');
    assert.equal(res.body.access.mode, 'owner_demo');
    assert.equal(res.body.access.chargedCredits, 0);

    // The SA request used the right endpoint, country, and status.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/facebook\/adLibrary\/search\/ads/);
    assert.match(calls[0].url, /query=nike/);
    assert.match(calls[0].url, /country=US/);
    assert.match(calls[0].url, /status=ALL/);
    assert.equal(calls[0].options.headers['x-api-key'], FAKE_SA_KEY);

    // The key is never in the response, and raw SA JSON is never forwarded.
    assert.doesNotMatch(JSON.stringify(res.body), /test-sa-key-DO-NOT-USE/);
    assert.equal(res.body.requestId, undefined);
    assert.equal(res.body.accounting, undefined);
    assert.equal('libraries' in res.body, false);

    const [full, sparse] = res.body.ads;
    assert.equal(full.id, '123456789');
    assert.equal(full.pageId, '111');
    assert.equal(full.pageName, 'Acme Co');
    assert.equal(full.text, 'Try our new widget today.');
    assert.equal(full.headline, 'Shop now');
    assert.equal(full.startDate, '2026-10-01');
    assert.equal(full.isActive, true);
    assert.deepEqual(full.platforms, ['facebook', 'instagram']);
    assert.equal(full.imageUrl, 'https://example.com/img.jpg');
    assert.equal(full.videoUrl, 'https://example.com/vid.mp4');
    assert.equal(full.snapshotUrl, 'https://www.facebook.com/ads/library/?id=123456789');
    assert.equal(full.libraryUrl, 'https://www.facebook.com/ads/library/?id=123456789');
    assert.equal(full.snapshot, undefined);

    // Sparse snapshot: missing fields become empty values, never a crash.
    assert.equal(sparse.id, '987654321');
    assert.equal(sparse.pageName, 'Sparse Brand');
    assert.equal(sparse.text, '');
    assert.equal(sparse.headline, '');
    assert.equal(sparse.startDate, '');
    assert.equal(sparse.isActive, false);
    assert.deepEqual(sparse.platforms, []);
    assert.equal(sparse.imageUrl, '');
    assert.equal(sparse.videoUrl, '');
    assert.equal(sparse.snapshotUrl, '');
    assert.equal(sparse.libraryUrl, 'https://www.facebook.com/ads/library/?id=987654321');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('object and array snapshot bodies render as text, never "[object Object]"', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  mockSaSuccess({
    ...SA_SUCCESS_BODY,
    ads: [
      {
        ad_archive_id: '555',
        page_id: '333',
        is_active: true,
        snapshot: {
          page_name: 'Object Body Brand',
          // Live shape (Nov 6 2026): the body field is an object, not a string.
          ad_creative_body: { text: 'Real body text from an object.' },
          ad_creative_link_title: 'Real headline',
          ad_delivery_start_time: 1752044400,
          publisher_platforms: ['facebook']
        }
      },
      {
        ad_archive_id: '556',
        page_id: '334',
        is_active: true,
        snapshot: {
          page_name: 'Array Body Brand',
          ad_creative_bodies: ['First body line.', 'Second body line.'],
          // A bare Meta dynamic-creative template must not render as a title.
          ad_creative_link_title: '{{product.name}}',
          title: 'Fallback headline',
          ad_delivery_start_time: '1736469600',
          publisher_platforms: ['instagram']
        }
      },
      {
        ad_archive_id: '557',
        page_id: '335',
        is_active: true,
        snapshot: {
          page_name: 'Placeholder Only Brand',
          ad_creative_body: '{{product.name}}',
          ad_creative_link_title: '{{product.name}}',
          ad_delivery_start_time: '2026-10-01',
          publisher_platforms: []
        }
      }
    ],
    searchResultsCount: 3
  });
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);

    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /\[object Object\]/);
    assert.doesNotMatch(JSON.stringify(res.body), /\{\{product\.name\}\}/);

    const [objectBody, arrayBody, placeholderOnly] = res.body.ads;
    assert.equal(objectBody.text, 'Real body text from an object.');
    assert.equal(objectBody.headline, 'Real headline');
    // Unix epoch seconds become an ISO date.
    assert.equal(objectBody.startDate, '2025-07-09');

    assert.equal(arrayBody.text, 'First body line. Second body line.');
    // Placeholder title is skipped, the next field supplies the headline.
    assert.equal(arrayBody.headline, 'Fallback headline');
    assert.equal(arrayBody.startDate, '2025-01-10');

    // Placeholder-only values become empty, never rendered text.
    assert.equal(placeholderOnly.text, '');
    assert.equal(placeholderOnly.headline, '');
    // ISO date strings still pass through unchanged.
    assert.equal(placeholderOnly.startDate, '2026-10-01');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('surrounding quotes are stripped from the query before search and echo', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  const calls = mockSaSuccess(SA_SUCCESS_BODY);
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq({ query: '"nike"' }), res);

    assert.equal(res.statusCode, 200);
    // The echoed query carries no quotes, so the page header reads
    // Found 2 ads for "nike", not ""nike"".
    assert.equal(res.body.query, 'nike');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /query=nike(&|$)/);
    assert.doesNotMatch(calls[0].url, /%22/);
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('zero ads returns an empty list with a note, not an error', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  mockSaSuccess({ ...SA_SUCCESS_BODY, ads: [], searchResults: [], searchResultsCount: 0 });
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.ads, []);
    assert.equal(res.body.adCount, 0);
    assert.ok(res.body.notes.some((note) => /No ads found/.test(note)));
    assert.ok(res.body.access, 'zero-result success still runs finalize');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('partial coverage is surfaced as a note and passed through', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  mockSaSuccess({
    ...SA_SUCCESS_BODY,
    coverage: { source: 'meta_ad_library', complete: false, warnings: ['partial page data'] }
  });
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.coverage.complete, false);
    assert.ok(res.body.notes.some((note) => /Some ad data may be incomplete/.test(note)));
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('SA 429 returns 429 with no charge', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  mockSaFailure(429, 'upstream_rate_limited');
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'SA_RATE_LIMITED');
    assert.match(res.body.error, /rate limited/i);
    assert.equal(res.body.access, undefined, 'failure must not run finalize');
    assert.doesNotMatch(JSON.stringify(res.body), /test-sa-key-DO-NOT-USE/);
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('SA 404 returns 404 with no charge', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  mockSaFailure(404, 'not_found');
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'SA_NOT_FOUND');
    assert.equal(res.body.access, undefined, 'failure must not run finalize');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('denied access returns 402 without calling Scrape Atlas', async () => {
  const originalFetch = globalThis.fetch;
  clearOwnerDemo();
  process.env.SCRAPE_ATLAS_API_KEY = FAKE_SA_KEY;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => SA_SUCCESS_BODY };
  };
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq(), res);
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.code, 'AUTH_REQUIRED');
    assert.equal(res.body.toolCost, 2);
    assert.equal(calls.length, 0, 'denied access must not reach Scrape Atlas');
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('missing query returns 400 without calling Scrape Atlas', async () => {
  const originalFetch = globalThis.fetch;
  setOwnerDemo();
  const calls = mockSaSuccess(SA_SUCCESS_BODY);
  try {
    const res = mockRes();
    await handleAdLibrariesSearch(mockReq({ query: '' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearOwnerDemo();
  }
});

test('ad-libraries costs 2 credits', () => {
  assert.equal(getCreditsCatalog().toolCosts['ad-libraries'], 2);
});
