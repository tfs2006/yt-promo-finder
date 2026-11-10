import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handler loads.
process.env.YOUTUBE_API_KEY = 'test-youtube-key-DO-NOT-USE';
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { default: collabHandler } = await import('../api/collab.js');

// Collab finder on Scrape Atlas (Phase C). global fetch is mocked so
// no live SA calls happen. The SA key below is a fake placeholder
// that only flips isScrapeAtlasConfigured() on; it is not a real
// credential and must never appear in any response body (asserted in
// the tests).
//
// Side-by-side evidence for this migration (Nov 10 2026,
// @boyandascanner + @DavidJWoodbury, live SA vs live YouTube API):
// @mention sets from SA descriptions matched the YouTube API on 102
// of 102 shared videos, while SA descriptions truncate long URLs, so
// Analyze / Compare / Saturation stay on the YouTube API and only
// Collab moves. See the header comment in api/collab.js.

const FAKE_KEY = process.env.SCRAPE_ATLAS_API_KEY;
const OWNER_KEY = process.env.OWNER_DEMO_KEY;
const originalFetch = global.fetch;
let ipCounter = 0;
let fetchCalls = [];

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; return this; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    end() { return this; }
  };
}

function mockReq(url) {
  return {
    method: 'GET',
    query: { url },
    headers: {
      'x-owner-demo-key': OWNER_KEY,
      'x-forwarded-for': `10.0.0.${++ipCounter}`
    },
    socket: {}
  };
}

function channelUrl(seed) {
  // Distinct 24-char UC id per test so the in-memory result cache never
  // leaks one test's payload into another.
  const id = `UC${String(seed).padEnd(22, 'x').slice(0, 22)}`;
  return `https://www.youtube.com/channel/${id}`;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function saChannelRecord(overrides = {}) {
  return {
    success: true,
    status: 'success',
    channelId: 'UCtestchannel',
    name: 'Test Channel',
    handle: '@testchannel',
    subscriberCount: 42000,
    videoCount: 120,
    viewCount: 1500000,
    fetchedAt: '2026-11-06T07:00:00Z',
    avatar: { image: { sources: [{ url: 'https://example.com/thumb.jpg', width: 160, height: 160 }] } },
    coverage: { complete: true, warnings: [] },
    ...overrides
  };
}

function saVideo(overrides = {}) {
  return {
    type: 'video',
    id: 'vid-x',
    title: 'Test Video',
    description: 'A plain description with no mentions.',
    publishDate: daysAgo(9),
    publishedTime: daysAgo(9),
    viewCountInt: 10000,
    likeCountInt: 400,
    commentCountInt: 50,
    durationMs: 390000,
    lengthSeconds: 390,
    ...overrides
  };
}

function saVideosPage(videos, continuationToken) {
  return {
    success: true,
    status: 'success',
    videos,
    ...(continuationToken ? { continuationToken } : { continuationToken: null }),
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] }
  };
}

// Seven recent videos carrying @mentions in their descriptions:
// @Alpha 3x, @Beta 2x, @Gamma 1x, a UC channel id 1x, a /c/ custom
// name 1x, and @Missing 1x (no such channel: the resolve 404s).
const COLLAB_VIDEOS = [
  saVideo({ id: 'vid-collab-1', title: 'Collab Video 1', description: 'Collab with @Alpha and @Beta! Also youtube.com/@Gamma', publishDate: daysAgo(9) }),
  saVideo({ id: 'vid-collab-2', title: 'Collab Video 2', description: 'Thanks @Alpha for having me on.', publishDate: daysAgo(18) }),
  saVideo({ id: 'vid-collab-3', title: 'Collab Video 3', description: 'See youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa for the full build.', publishDate: daysAgo(27) }),
  saVideo({ id: 'vid-collab-4', title: 'Collab Video 4', description: 'No mentions here at all.', publishDate: daysAgo(36) }),
  saVideo({ id: 'vid-collab-5', title: 'Collab Video 5', description: 'With @Alpha again and @Missing, who does not exist.', publishDate: daysAgo(45) }),
  saVideo({ id: 'vid-collab-6', title: 'Collab Video 6', description: '@Beta once more, what a legend.', publishDate: daysAgo(54) }),
  saVideo({ id: 'vid-collab-7', title: 'Collab Video 7', description: 'Also check youtube.com/c/CustomShop for gear.', publishDate: daysAgo(63) })
];

const RESOLVE_RECORDS = {
  '@Alpha': saChannelRecord({ channelId: 'UCalpha0000000000000001', name: 'Alpha Channel', handle: '@Alpha', subscriberCount: 120000 }),
  '@Beta': saChannelRecord({ channelId: 'UCbeta00000000000000002', name: 'Beta Channel', handle: '@Beta', subscriberCount: 8000 }),
  '@Gamma': saChannelRecord({ channelId: 'UCgamma0000000000000003', name: 'Gamma Channel', handle: '@Gamma', subscriberCount: 45000 }),
  'UCaaaaaaaaaaaaaaaaaaaaaa': saChannelRecord({ channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'UC Channel', handle: '@ucchannel', subscriberCount: 1000 }),
  'CustomShop': saChannelRecord({ channelId: 'UCcustomshop000000000004', name: 'Custom Shop', handle: '@CustomShop', subscriberCount: 2100 })
};

// Mock fetch routing SA calls: channel-videos must be matched before
// channel (its path contains the channel path as a prefix). The main
// channel record and the first video page are fetched in parallel by
// the handler, so both land in fetchCalls before any continuation
// page or mention resolve. Mention resolves hit /v1/youtube/channel
// with a handle, channelId or /c/ url param; unknown mentions 404.
function mockSa({ channel = saChannelRecord(), pages = [saVideosPage([])] } = {}) {
  fetchCalls = [];
  let pageIndex = 0;
  global.fetch = async (url) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.includes('/v1/youtube/channel-videos')) {
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex++;
      if (page instanceof Error) throw page;
      if (page && page.__http) {
        return { ok: false, status: page.__http, json: async () => page.body };
      }
      return { ok: true, status: 200, json: async () => page };
    }
    if (u.includes('/v1/youtube/channel')) {
      if (channel instanceof Error) throw channel;
      if (channel && channel.__http) {
        return { ok: false, status: channel.__http, json: async () => channel.body };
      }
      const parsed = new URL(u);
      const handle = parsed.searchParams.get('handle');
      const channelId = parsed.searchParams.get('channelId');
      const urlParam = parsed.searchParams.get('url') || '';
      const custom = urlParam.match(/\/c\/([^/?]+)/)?.[1];
      if (handle) {
        // Mention resolve by @handle; unknown handles 404.
        if (RESOLVE_RECORDS[handle]) {
          return { ok: true, status: 200, json: async () => RESOLVE_RECORDS[handle] };
        }
        return { ok: false, status: 404, json: async () => ({ success: false, failure: { code: 'not_found', message: 'no channel' } }) };
      }
      if (custom) {
        // Mention resolve by /c/ custom name; unknown names 404.
        if (RESOLVE_RECORDS[custom]) {
          return { ok: true, status: 200, json: async () => RESOLVE_RECORDS[custom] };
        }
        return { ok: false, status: 404, json: async () => ({ success: false, failure: { code: 'not_found', message: 'no channel' } }) };
      }
      if (channelId && RESOLVE_RECORDS[channelId]) {
        // Mention resolve by UC id.
        return { ok: true, status: 200, json: async () => RESOLVE_RECORDS[channelId] };
      }
      // Main channel resolve (by channel id, handle-less URL or
      // forUsername): return the canned channel record.
      return { ok: true, status: 200, json: async () => channel };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
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

function assertNoKeyLeak(body) {
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY), 'response must not leak the SA key');
  assert.ok(!JSON.stringify(body).includes(OWNER_KEY), 'response must not leak the owner demo key');
}

test('collab: same response shape as the YouTube version, mentions resolved via SA', async () => {
  mockSa({ pages: [saVideosPage(COLLAB_VIDEOS)] });
  const res = mockRes();
  await collabHandler(mockReq(channelUrl('collab-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // UI contract: same fields as the YouTube version.
  assert.equal(body.channelId, 'UCtestchannel');
  assert.equal(body.videosAnalyzed, 7);
  assert.equal(body.collaborations.length, 5);

  // Sorted by mention count, most first; @Missing dropped.
  assert.deepEqual(
    body.collaborations.map((c) => [c.title, c.mentionCount]),
    [['Alpha Channel', 3], ['Beta Channel', 2], ['Gamma Channel', 1], ['UC Channel', 1], ['Custom Shop', 1]]
  );
  const alpha = body.collaborations[0];
  assert.deepEqual(Object.keys(alpha).sort(), ['channelId', 'handle', 'mentionCount', 'subscriberCount', 'thumbnail', 'title', 'videos']);
  assert.equal(alpha.channelId, 'UCalpha0000000000000001');
  assert.equal(alpha.handle, '@Alpha');
  assert.equal(alpha.subscriberCount, 120000);
  assert.equal(alpha.thumbnail, 'https://example.com/thumb.jpg');
  assert.equal(alpha.videos.length, 3);
  assert.deepEqual(alpha.videos.map((v) => v.videoId), ['vid-collab-1', 'vid-collab-2', 'vid-collab-5']);
  assert.deepEqual(Object.keys(alpha.videos[0]).sort(), ['publishedAt', 'title', 'videoId']);

  // The unresolvable mention is disclosed, not hidden.
  assert.match(body.coverageNote, /Based on the 7 most recent long-form videos found/);
  assert.match(body.coverageNote, /1 mentioned channel could not be resolved and is not listed/);
  assert.deepEqual(body.videoCoverage, { withDescription: 7, total: 7 });
  assert.deepEqual(body.coverageWarnings, []);

  // 1 channel record + 1 video page + 5 successful resolves = 7 SA
  // credits. The failed @Missing resolve costs 0 (only successes
  // are billed), but it still fired, so fetchCalls counts 8.
  assert.equal(body.saCreditsUsed, 7);
  assert.equal(fetchCalls.length, 8);
  assert.ok(body.access, 'success must carry access from finalizeToolAccess');
  assertNoKeyLeak(body);
});

test('collab: continuation pages are fetched and counted, hasMore disclosed', async () => {
  const pages = [
    saVideosPage(COLLAB_VIDEOS.slice(0, 3), 'tok2'),
    saVideosPage(COLLAB_VIDEOS.slice(3, 5), 'tok3'),
    saVideosPage(COLLAB_VIDEOS.slice(5), 'tok4')
  ];
  mockSa({ pages });
  const res = mockRes();
  await collabHandler(mockReq(channelUrl('collab-pages')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videosAnalyzed, 7);
  assert.equal(res.body.collaborations.length, 5);
  assert.match(res.body.coverageNote, /older videos were not included in this run/);
  // 1 channel + 3 video pages + 5 successful resolves = 9 credits.
  assert.equal(res.body.saCreditsUsed, 9);
  const page3 = new URL(fetchCalls.find((u) => u.includes('continuationToken=tok3')));
  assert.ok(page3, 'third page must be fetched with the second continuation token');
});

test('collab: cached repeat is free and makes no SA call', async () => {
  mockSa({ pages: [saVideosPage(COLLAB_VIDEOS)] });
  const url = channelUrl('collab-cache2');
  const first = mockRes();
  await collabHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  assert.equal(fetchCalls.length, 8);

  const second = mockRes();
  await collabHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(second.body.videosAnalyzed, 7);
  assert.equal(fetchCalls.length, 8);
});

test('collab: channel with no videos returns an empty result, not a crash', async () => {
  mockSa({ pages: [saVideosPage([])] });
  const res = mockRes();
  await collabHandler(mockReq(channelUrl('collab-empty')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videosAnalyzed, 0);
  assert.deepEqual(res.body.collaborations, []);
  assert.equal(res.body.coverageNote, null);
  // 1 channel record + 1 video page (which succeeded but was empty).
  assert.equal(res.body.saCreditsUsed, 2);
});

test('collab: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 429, body: { success: false, failure: { code: 'upstream_rate_limited', message: 'slow down' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await collabHandler(mockReq(channelUrl('collab-429')), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /rate limited/i);
  assert.equal(res.body.access, undefined);
  // Channel + first video page start in parallel, so both fire.
  assert.equal(fetchCalls.length, 2);
  assertNoKeyLeak(res.body);
});

test('collab: unconfigured Scrape Atlas returns 500 without calling the API', async () => {
  const saved = process.env.SCRAPE_ATLAS_API_KEY;
  delete process.env.SCRAPE_ATLAS_API_KEY;
  try {
    global.fetch = async () => { throw new Error('fetch must not be called'); };
    const res = mockRes();
    await collabHandler(mockReq(channelUrl('collab-noconfig')), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Scrape Atlas is not configured on this site yet.');
  } finally {
    process.env.SCRAPE_ATLAS_API_KEY = saved;
  }
});

test('collab: legacy /user/ input resolves the channel first, then pages by channelId', async () => {
  mockSa({ pages: [saVideosPage(COLLAB_VIDEOS)] });
  const res = mockRes();
  await collabHandler(mockReq('https://www.youtube.com/user/oldname'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videosAnalyzed, 7);
  const videosUrl = new URL(fetchCalls.find((u) => u.includes('channel-videos')));
  assert.equal(videosUrl.searchParams.get('channelId'), 'UCtestchannel');
  assert.equal(videosUrl.searchParams.get('forUsername'), null);
});

test('documented credit cost is unchanged: collab 2', async () => {
  const { getCreditsCatalog } = await import('../lib/credits.js');
  const costs = getCreditsCatalog().toolCosts;
  assert.equal(costs.collab, 2);
});
