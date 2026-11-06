import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import handler from '../api/domain.js';

// Domain search on Scrape Atlas. global fetch is mocked so no live SA
// calls happen. The SA key below is a fake placeholder that only flips
// isScrapeAtlasConfigured() on; it is not a real credential and must
// never appear in any response body (asserted in the tests).
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const FAKE_KEY = process.env.SCRAPE_ATLAS_API_KEY;
const OWNER_KEY = process.env.OWNER_DEMO_KEY;

const originalFetch = global.fetch;
let ipCounter = 0;
let fetchCalls = [];

function mockFetch(pages) {
  fetchCalls = [];
  let callIndex = 0;
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const page = pages[Math.min(callIndex, pages.length - 1)];
    callIndex++;
    if (page instanceof Error) throw page;
    if (page && page.__http) {
      return {
        ok: false,
        status: page.__http,
        json: async () => page.body
      };
    }
    return { ok: true, status: 200, json: async () => page };
  };
  return () => fetchCalls;
}

function makeReq(domain, ip) {
  return {
    method: 'GET',
    query: { domain },
    headers: {
      'x-owner-demo-key': OWNER_KEY,
      'x-forwarded-for': ip || `10.0.0.${++ipCounter}`
    },
    socket: {}
  };
}

function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end() {}
  };
}

async function callHandler(domain) {
  const req = makeReq(domain);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function saVideo(overrides) {
  return {
    id: 'vid-x',
    url: 'https://www.youtube.com/watch?v=vid-x',
    title: 'Untitled',
    thumbnail: 'https://i.ytimg.com/vi/vid-x/default.jpg',
    channel: { id: 'UCtest', title: 'Test Channel', handle: '@test', thumbnail: '' },
    viewCountText: '1K views',
    viewCountInt: 100,
    publishedTimeText: '1 month ago',
    publishedTime: '2026-10-01T00:00:00Z',
    lengthText: '10:00',
    lengthSeconds: 600,
    badges: [],
    description: null,
    commentCountInt: 0,
    likeCountInt: 0,
    publishDate: '2026-10-01T00:00:00Z',
    genre: '',
    durationMs: 600000,
    ...overrides
  };
}

function cleanLedgerFiles() {
  for (const file of fs.readdirSync(process.cwd())) {
    if (file.startsWith('cache_sa_ledger_')) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

test.afterEach(() => {
  global.fetch = originalFetch;
  cleanLedgerFiles();
});

test('description filter, title-only fallback, and UI response shape', async () => {
  const page1 = {
    success: true,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    continuationToken: 'tok2',
    videos: [
      saVideo({ id: 'vid-a', title: 'Great product walkthrough', description: 'Check out example.com for deals', viewCountInt: 500 }),
      saVideo({ id: 'vid-b', title: 'Visit example.com now', description: 'Nothing relevant here at all', viewCountInt: 900 }),
      saVideo({ id: 'vid-c', title: 'My example.com review', description: null, viewCountInt: 700 }),
      saVideo({ id: 'vid-d', title: 'Unrelated video', description: null, viewCountInt: 800 }),
      saVideo({ id: 'vid-e', title: 'Links below', description: 'Grab it at www.example.com today', viewCountInt: 100 })
    ]
  };
  const page2 = {
    success: true,
    fetchedAt: '2026-11-06T07:00:01Z',
    coverage: { complete: true, warnings: [] },
    videos: [
      // No publishDate: publishedAt must fall back to publishedTime.
      saVideo({ id: 'vid-f', title: 'Sponsor spot', description: 'Thanks to example.com for sponsoring', viewCountInt: 2000, publishDate: undefined, publishedTime: '2026-09-15T00:00:00Z' })
    ]
  };
  mockFetch([page1, page2]);

  const res = await callHandler('example.com');
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // UI contract: exact existing fields, sorted by views desc.
  assert.equal(body.domain, 'example.com');
  assert.equal(body.videoCount, 4);
  assert.equal(body.totalFound, 4);
  assert.deepEqual(body.videos.map((v) => v.videoId), ['vid-f', 'vid-c', 'vid-a', 'vid-e']);
  for (const v of body.videos) {
    assert.deepEqual(Object.keys(v).sort(), ['channelId', 'channelTitle', 'publishedAt', 'thumbnail', 'title', 'videoId', 'viewCount']);
  }
  assert.equal(body.videos[0].publishedAt, '2026-09-15T00:00:00Z');
  assert.equal(body.videos[0].channelTitle, 'Test Channel');
  assert.equal(body.videos[0].viewCount, 2000);

  // Description filter: vid-b has the domain in the title only while a
  // real description exists, so it is excluded. vid-d has neither.
  assert.ok(!body.videos.some((v) => v.videoId === 'vid-b'));
  assert.ok(!body.videos.some((v) => v.videoId === 'vid-d'));

  // Partial description coverage is disclosed, never hidden.
  assert.deepEqual(body.descriptionCoverage, { withDescription: 4, total: 6 });
  assert.match(body.coverageNote, /Descriptions were available for 4 of 6 videos/);
  assert.equal(body.fetchedAt, '2026-11-06T07:00:01Z');

  // Two SA pages fetched = 2 SA credits for this run.
  assert.equal(body.saCreditsUsed, 2);
  assert.equal(fetchCalls.length, 2);

  // The search itself: quoted domain, videos only, popular, extras on.
  const url1 = new URL(fetchCalls[0].url);
  assert.equal(url1.pathname, '/v1/youtube/search');
  assert.equal(url1.searchParams.get('query'), '"example.com"');
  assert.equal(url1.searchParams.get('type'), 'videos');
  assert.equal(url1.searchParams.get('sortBy'), 'popular');
  assert.equal(url1.searchParams.get('includeExtras'), 'true');
  assert.equal(url1.searchParams.get('continuationToken'), null);
  const url2 = new URL(fetchCalls[1].url);
  assert.equal(url2.searchParams.get('continuationToken'), 'tok2');

  // No credential anywhere in the response.
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(body).includes(OWNER_KEY));
});

test('title-only fallback does not fire when a description exists', async () => {
  // Same video shape as above but every video has a description: a title
  // mention without a description mention must not match.
  mockFetch([{
    success: true,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    videos: [
      saVideo({ id: 'vid-g', title: 'example.org is great', description: 'A video about something else entirely', viewCountInt: 10 })
    ]
  }]);
  const res = await callHandler('example.org');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videoCount, 0);
  assert.equal(res.body.totalFound, 0);
  assert.deepEqual(res.body.descriptionCoverage, { withDescription: 1, total: 1 });
  assert.equal(res.body.coverageNote, null);
});

test('paging stops at 3 pages', async () => {
  const endlessPage = {
    success: true,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    continuationToken: 'tok-next',
    videos: [
      saVideo({ id: 'vid-p', title: 'paging.example.com mention', description: 'See paging.example.com', viewCountInt: 5 })
    ]
  };
  mockFetch([endlessPage, endlessPage, endlessPage, endlessPage, endlessPage]);
  const res = await callHandler('paging.example.com');
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 3);
  assert.equal(res.body.saCreditsUsed, 3);
  assert.equal(res.body.videoCount, 3);
});

test('Scrape Atlas failure returns an error and charges nothing', async () => {
  mockFetch([{
    __http: 500,
    body: { success: false, failure: { code: 'busy', message: 'overloaded' } }
  }]);
  const res = await callHandler('fail.example.com');
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, 'string');
  // The error path returns via handleApiError before finalizeToolAccess
  // is ever reached: no access block, no videos, no charge.
  assert.equal(res.body.access, undefined);
  assert.equal(res.body.videos, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY));
});

test('Scrape Atlas failure on a later page also charges nothing', async () => {
  const goodPage = {
    success: true,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    continuationToken: 'tok2',
    videos: [
      saVideo({ id: 'vid-h', title: 'ok', description: 'late.example.com here', viewCountInt: 50 })
    ]
  };
  mockFetch([goodPage, {
    __http: 503,
    body: { success: false, failure: { code: 'busy', message: 'overloaded' } }
  }]);
  const res = await callHandler('late.example.com');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.access, undefined);
  assert.equal(res.body.videos, undefined);
  assert.equal(fetchCalls.length, 2);
});

test('unconfigured Scrape Atlas returns 500 without calling the API', async () => {
  const saved = process.env.SCRAPE_ATLAS_API_KEY;
  delete process.env.SCRAPE_ATLAS_API_KEY;
  try {
    global.fetch = async () => { throw new Error('fetch must not be called'); };
    const res = await callHandler('noconfig.example.com');
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Scrape Atlas is not configured on this site yet.');
  } finally {
    process.env.SCRAPE_ATLAS_API_KEY = saved;
  }
});

test('cache hit returns fromCache and makes no Scrape Atlas call', async () => {
  mockFetch([{
    success: true,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    videos: [
      saVideo({ id: 'vid-i', title: 'cached', description: 'cache.example.com here', viewCountInt: 42 })
    ]
  }]);
  const first = await callHandler('cache.example.com');
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.fromCache, undefined);
  assert.equal(fetchCalls.length, 1);

  const second = await callHandler('cache.example.com');
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(second.body.videoCount, 1);
  assert.equal(fetchCalls.length, 1);
});

test('invalid domain is rejected before any upstream call', async () => {
  global.fetch = async () => { throw new Error('fetch must not be called'); };
  const res = await callHandler('not a domain!!');
  assert.equal(res.statusCode, 400);
  assert.equal(typeof res.body.error, 'string');
});
