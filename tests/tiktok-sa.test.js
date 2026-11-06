// TikTok meta via Scrape Atlas (lib/tiktokHandlers.js handleTikTokMeta).
//
// Mocks global fetch only, so the real saGet in lib/scrapeAtlas.js is
// exercised end to end (endpoint, params, x-api-key header, error mapping).
// Credit gating uses the real lib/credits.js in owner-demo mode: the demo
// key stands in for a signed-in account with credits. Node's test runner
// has no module mocking in this build, so the charge itself is verified at
// its observable boundary: the 200 success path is the ONLY path that
// reaches finalizeToolAccess (chargeCredits: true); every failure path
// (402 gate, 400 no-data, SA 404/429/502) returns before it. No real
// Stripe, Supabase, Redis, or Scrape Atlas calls are made.
import test from 'node:test';
import assert from 'node:assert/strict';

const FAKE_SA_KEY = 'sa_test_key_7f3a9_DO_NOT_LEAK';
process.env.SCRAPE_ATLAS_API_KEY = FAKE_SA_KEY;
process.env.OWNER_DEMO_MODE = 'true';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { handleTikTokMeta } = await import('../lib/tiktokHandlers.js');

const TIKTOK_URL = 'https://www.tiktok.com/@testcreator/video/1234567890123456789';

let fetchCalls = [];
let fetchImpl = null;
const originalFetch = globalThis.fetch;

function installFetch(impl) {
  fetchCalls = [];
  fetchImpl = impl;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return fetchImpl(url, options);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockReqRes({ url = TIKTOK_URL, demoKey = 'test-owner-demo-key', method = 'GET' } = {}) {
  const headers = {};
  if (demoKey) headers['x-owner-demo-key'] = demoKey;
  const req = {
    method,
    headers,
    query: { url },
    socket: { remoteAddress: '203.0.113.10' }
  };
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    end() { return this; }
  };
  return { req, res };
}

function assertNoKeyLeaked(res) {
  assert.ok(
    !JSON.stringify(res.body).includes(FAKE_SA_KEY),
    'response must never contain the Scrape Atlas key'
  );
}

function assertSaCalledOnceWithUrl() {
  assert.equal(fetchCalls.length, 1, 'exactly one Scrape Atlas call');
  const call = fetchCalls[0];
  const called = new URL(call.url);
  assert.equal(`${called.origin}${called.pathname}`, 'https://api.scrapeatlas.com/v1/tiktok/video');
  assert.equal(called.searchParams.get('url'), TIKTOK_URL);
  assert.equal(call.options.headers['x-api-key'], FAKE_SA_KEY);
  assert.ok(!call.url.includes(FAKE_SA_KEY), 'key travels in the header, never the URL');
}

function fullSaBody() {
  return {
    success: true,
    status: 200,
    requestId: 'req_test_full',
    sourceUrl: TIKTOK_URL,
    fetchedAt: '2026-11-06T07:00:00.000Z',
    coverage: { complete: true },
    accounting: { credits: 1 },
    itemInfo: {
      itemStruct: {
        id: '1234567890123456789',
        desc: 'Test caption #tiktok',
        author: {
          nickname: 'Test Creator',
          uniqueId: 'testcreator',
          avatarThumb: 'https://p16-sign-sg.tiktokcdn.com/avatar.jpg'
        },
        video: {
          cover: 'https://p16-sign-sg.tiktokcdn.com/cover.jpg',
          playAddr: 'https://v16m.tiktokcdn.com/play.mp4',
          duration: 15
        },
        music: { title: 'Test Song', author: 'Test Artist', playUrl: 'https://v16m.tiktokcdn.com/music.mp3' },
        stats: { playCount: 100, diggCount: 10, commentCount: 2, shareCount: 1 },
        createTime: 1700000000,
        hashtags: [{ name: 'tiktok' }]
      }
    }
  };
}

test('SA success maps to the exact UI contract', async () => {
  installFetch(() => jsonResponse(200, fullSaBody()));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'access', 'audioUrl', 'author', 'coverUrl', 'sourceUrl', 'title', 'videoUrl'
    ]);
    assert.deepEqual(res.body, {
      title: 'Test caption #tiktok',
      author: 'Test Creator',
      coverUrl: 'https://p16-sign-sg.tiktokcdn.com/cover.jpg',
      videoUrl: 'https://v16m.tiktokcdn.com/play.mp4',
      audioUrl: 'https://v16m.tiktokcdn.com/music.mp3',
      sourceUrl: TIKTOK_URL,
      access: { mode: 'owner_demo', chargedCredits: 0, freeTrialUsed: false }
    });
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('SA success with sparse fields falls back without crashing', async () => {
  const sparse = fullSaBody();
  sparse.itemInfo.itemStruct = {
    id: '1234567890123456789',
    desc: 'Sparse caption',
    author: { uniqueId: 'sparsecreator' },
    video: { playAddr: 'https://v16m.tiktokcdn.com/sparse.mp4' }
  };
  installFetch(() => jsonResponse(200, sparse));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      title: 'Sparse caption',
      author: 'sparsecreator',
      coverUrl: '',
      videoUrl: 'https://v16m.tiktokcdn.com/sparse.mp4',
      audioUrl: '',
      sourceUrl: TIKTOK_URL,
      access: { mode: 'owner_demo', chargedCredits: 0, freeTrialUsed: false }
    });
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('SA success with no usable video data returns 400, no charge path', async () => {
  installFetch(() => jsonResponse(200, {
    success: true, status: 200, requestId: 'req_test_empty',
    sourceUrl: TIKTOK_URL, itemInfo: {}
  }));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Unable to process that TikTok URL.' });
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('SA 404 surfaces as 404, not a generic 500', async () => {
  installFetch(() => jsonResponse(404, {
    success: false,
    failure: { code: 'not_found', message: 'no video for that url' }
  }));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'SA_NOT_FOUND');
    assert.match(res.body.error, /found nothing/);
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('SA 429 surfaces as 429 with the no-charge message', async () => {
  installFetch(() => jsonResponse(429, {
    success: false,
    failure: { code: 'upstream_rate_limited', message: 'slow down' }
  }));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'SA_RATE_LIMITED');
    assert.match(res.body.error, /No credits were charged/);
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('SA 200 with success:false is treated as an upstream failure (502)', async () => {
  installFetch(() => jsonResponse(200, {
    success: false,
    failure: { code: 'upstream_error', message: 'boom' }
  }));
  try {
    const { req, res } = mockReqRes();
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'SA_UPSTREAM_ERROR');
    assertSaCalledOnceWithUrl();
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('blocked caller gets 402 before any Scrape Atlas call', async () => {
  installFetch(() => jsonResponse(200, fullSaBody()));
  try {
    const { req, res } = mockReqRes({ demoKey: null });
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.code, 'AUTH_REQUIRED');
    assert.equal(fetchCalls.length, 0, 'no SA call (and no SA credit) for blocked callers');
    assertNoKeyLeaked(res);
  } finally {
    restoreFetch();
  }
});

test('input validation is unchanged and runs before any SA call', async () => {
  installFetch(() => jsonResponse(200, fullSaBody()));
  try {
    for (const [url, error] of [
      ['https://www.youtube.com/watch?v=x', 'Only TikTok URLs are allowed.'],
      ['https://www.tiktok.com/@x/video/1'.padEnd(601, 'a'), 'URL is too long.'],
      ['', 'TikTok URL is required.']
    ]) {
      const { req, res } = mockReqRes({ url });
      await handleTikTokMeta(req, res);
      assert.equal(res.statusCode, 400, url);
      assert.equal(res.body.error, error, url);
      assertNoKeyLeaked(res);
    }
    assert.equal(fetchCalls.length, 0, 'validation failures never reach Scrape Atlas');
  } finally {
    restoreFetch();
  }
});

test('non-GET is rejected with 405', async () => {
  installFetch(() => jsonResponse(200, fullSaBody()));
  try {
    const { req, res } = mockReqRes({ method: 'POST' });
    await handleTikTokMeta(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(fetchCalls.length, 0);
  } finally {
    restoreFetch();
  }
});
