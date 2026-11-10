import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handlers load.
process.env.YOUTUBE_API_KEY = 'test-youtube-key-DO-NOT-USE';
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { default: growthHandler } = await import('../api/growth.js');
const { default: rateHandler } = await import('../api/rate.js');
const { default: revenueHandler } = await import('../api/revenue.js');
const {
  saChannelParams,
  parseSaJoinedDate,
  mapSaChannelVideo
} = await import('../lib/scrapeAtlas.js');

// Growth, Rate and Revenue on Scrape Atlas (Phase A). global fetch is
// mocked so no live SA calls happen. The SA key below is a fake
// placeholder that only flips isScrapeAtlasConfigured() on; it is not a
// real credential and must never appear in any response body (asserted
// in the tests).

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

function joinedText(days) {
  const d = new Date(Date.now() - days * 86400000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `Joined ${d}`;
}

function saChannel(overrides = {}) {
  return {
    success: true,
    status: 'success',
    channelId: 'UCtestchannel',
    name: 'Test Channel',
    description: 'Tech phone reviews, setups and tutorials for scanner radios.',
    subscriberCount: 7380,
    videoCount: 404,
    viewCount: 1687166,
    joinedDateText: joinedText(900),
    tags: 'tech, review, tutorial',
    keywords: ['tech', 'review', 'tutorial'],
    avatar: { image: { sources: [
      { url: 'https://example.com/avatar-72.jpg', width: 72, height: 72 },
      { url: 'https://example.com/avatar-160.jpg', width: 160, height: 160 }
    ] } },
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    ...overrides
  };
}

function saVideo(overrides = {}) {
  return {
    type: 'video',
    id: 'vid-x',
    title: 'Tech Review: Phone Setup Tutorial',
    description: 'A plain description with no links.',
    publishDate: daysAgo(9),
    publishedTime: daysAgo(9),
    viewCountInt: 10000,
    likeCountInt: 400,
    commentCountInt: 50,
    durationMs: 390000,
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

// Mock fetch routing SA calls: channel first, then channel-videos pages
// in order. channel-videos must be matched before channel (its path
// contains the channel path as a prefix).
function mockSa({ channel = saChannel(), pages = [saVideosPage([])] } = {}) {
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

// ---------- shared SA helpers ----------

test('saChannelParams maps every parseChannelIdFromUrl spec type', () => {
  assert.deepEqual(saChannelParams({ type: 'channelId', value: 'UCabc' }, 'x'), { channelId: 'UCabc' });
  assert.deepEqual(saChannelParams({ type: 'handle', value: '@foo' }, 'x'), { handle: '@foo' });
  assert.deepEqual(saChannelParams({ type: 'handle', value: 'foo' }, 'x'), { handle: '@foo' });
  assert.deepEqual(saChannelParams({ type: 'username', value: 'oldname' }, 'x'), { forUsername: 'oldname' });
  assert.deepEqual(saChannelParams({ type: 'custom', value: 'name' }, 'x'), { url: 'https://www.youtube.com/c/name' });
  assert.deepEqual(
    saChannelParams({ type: 'unknown', value: 'https://www.youtube.com/@foo' }, 'https://www.youtube.com/@foo'),
    { url: 'https://www.youtube.com/@foo' }
  );
  assert.deepEqual(saChannelParams({ type: 'unknown', value: 'foo' }, 'foo'), { handle: '@foo' });
});

test('parseSaJoinedDate parses "Joined Jul 30, 2019" and rejects junk', () => {
  const parsed = parseSaJoinedDate('Joined Jul 30, 2019');
  assert.match(parsed, /^2019-07-(29|30)T/);
  assert.equal(parseSaJoinedDate('not a date'), null);
  assert.equal(parseSaJoinedDate(null), null);
  assert.equal(parseSaJoinedDate(''), null);
});

test('mapSaChannelVideo normalizes null extras to empty/zero', () => {
  const mapped = mapSaChannelVideo({
    id: 'vid1', title: 'T', description: null, publishDate: null,
    publishedTime: '2026-11-01T00:00:00Z',
    viewCountInt: 5, likeCountInt: null, commentCountInt: null
  });
  assert.deepEqual(mapped, {
    videoId: 'vid1', title: 'T', description: '',
    publishedAt: '2026-11-01T00:00:00Z',
    viewCount: 5, likeCount: 0, commentCount: 0,
    durationSeconds: 0
  });
});

// ---------- growth ----------

test('growth: stats, 50-video snapshot over two pages, and upload pattern', async () => {
  // 40 videos, 7 days apart, newest first: weekly cadence, one weekday.
  const videos = Array.from({ length: 40 }, (_, i) => saVideo({
    id: `grow-vid-${String(i + 1).padStart(2, '0')}`,
    title: `Growth video ${i + 1}`,
    publishedAt: daysAgo(1 + i * 7),
    publishDate: daysAgo(1 + i * 7)
  }));
  mockSa({ pages: [saVideosPage(videos.slice(0, 30), 'tok2'), saVideosPage(videos.slice(30))] });

  const res = mockRes();
  await growthHandler(mockReq(channelUrl('growth-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // UI contract: same fields as the YouTube version.
  assert.equal(body.channelId, 'UCtestchannel');
  assert.deepEqual(body.stats, {
    subscriberCount: 7380,
    videoCount: 404,
    viewCount: 1687166,
    publishedAt: parseSaJoinedDate(joinedText(900))
  });
  assert.equal(body.recentVideos.length, 40);
  assert.deepEqual(Object.keys(body.recentVideos[0]).sort(), ['description', 'publishedAt', 'title', 'videoId']);
  assert.equal(body.recentVideos[0].videoId, 'grow-vid-01');
  assert.equal(body.uploadPattern.averageFrequency, 'Weekly');
  assert.equal(body.uploadPattern.latestUpload, 'Yesterday');
  assert.equal(body.uploadPattern.mostCommonDay, new Date(daysAgo(1)).toLocaleDateString('en-US', { weekday: 'long' }));

  // 1 channel call + 2 video pages = 3 SA credits.
  assert.equal(body.saCreditsUsed, 3);
  assert.equal(fetchCalls.length, 3);
  assert.ok(fetchCalls[0].includes('/v1/youtube/channel?') || fetchCalls[0].includes('/v1/youtube/channel'));
  assert.ok(!fetchCalls[0].includes('channel-videos'), 'first call must be the channel record');
  const page2 = new URL(fetchCalls[2]);
  assert.equal(page2.searchParams.get('continuationToken'), 'tok2');
  // No extras on the growth pages: only id, title and publish date needed.
  assert.equal(new URL(fetchCalls[1]).searchParams.get('includeExtras'), null);
  assert.equal(body.coverageNote, null);
  assert.ok(body.access, 'success must carry access from finalizeToolAccess');
  assertNoKeyLeak(body);
});

test('growth: channel with no videos returns the empty pattern, not an error', async () => {
  mockSa({ pages: [saVideosPage([])] });
  const res = mockRes();
  await growthHandler(mockReq(channelUrl('growth-empty')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recentVideos.length, 0);
  assert.equal(res.body.uploadPattern.averageFrequency, 'No data');
  assert.equal(res.body.saCreditsUsed, 2);
});

test('growth: cached repeat is free and makes no SA call', async () => {
  mockSa({ pages: [saVideosPage([saVideo({ id: 'cache-vid' })])] });
  const url = channelUrl('growth-cache2');
  const first = mockRes();
  await growthHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  assert.equal(fetchCalls.length, 2);

  const second = mockRes();
  await growthHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(second.body.recentVideos.length, 1);
  assert.equal(fetchCalls.length, 2);
});

// ---------- rate ----------

function rateVideos() {
  return Array.from({ length: 12 }, (_, i) => saVideo({
    id: `rate-vid-${String(i + 1).padStart(2, '0')}`,
    title: `Tech Review ${i + 1}: Phone Setup Tutorial`,
    description: i === 0
      ? 'Sponsored by ExampleBrand, see https://examplebrand.com/deal for details.'
      : `Description for test video ${i + 1}.`,
    publishedAt: daysAgo((i + 1) * 9),
    publishDate: daysAgo((i + 1) * 9),
    viewCountInt: i === 0 ? 200000 : 12000 - (i - 1) * 1000,
    likeCountInt: 8000 - i * 600,
    commentCountInt: 900 - i * 70
  }));
}

test('rate: niche, sponsorship split and engagement come from SA extras', async () => {
  mockSa({ pages: [saVideosPage(rateVideos())] });
  const res = mockRes();
  await rateHandler(mockReq(channelUrl('rate-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  assert.equal(body.channelId, 'UCtestchannel');
  assert.equal(body.videoCount, 12);
  assert.equal(body.detectedNiche, 'tech');
  assert.equal(body.nicheCPM.avg, 22);
  assert.ok(body.metrics.averageViews > 0, `averageViews must be real, got ${body.metrics.averageViews}`);
  assert.ok(body.metrics.engagementRate > 0, `engagement rate must be real, got ${body.metrics.engagementRate}`);
  assert.ok(body.estimatedRates.perVideo.average > 0, 'estimated rate must be non-zero');
  assert.ok(body.estimatedRates.perVideo.low > 0, 'estimated rate low must be non-zero');
  assert.equal(body.sponsorshipAnalysis.sponsoredVideoCount, 1);
  assert.equal(body.sponsorshipAnalysis.nonSponsoredVideoCount, 11);
  assert.equal(body.sponsorshipAnalysis.topSponsoredVideos[0].videoId, 'rate-vid-01');
  assert.equal(body.sponsorshipAnalysis.topSponsoredVideos[0].viewCount, 200000);

  // Extras were requested (descriptions + like/comment counts).
  const videosUrl = new URL(fetchCalls.find((u) => u.includes('channel-videos')));
  assert.equal(videosUrl.searchParams.get('includeExtras'), 'true');
  assert.ok(videosUrl.searchParams.get('since'), 'videos must be windowed to the last year');

  // 1 channel call + 1 video page = 2 SA credits.
  assert.equal(body.saCreditsUsed, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(body.descriptionCoverage, { withDescription: 12, withStats: 12, total: 12 });
  assert.equal(body.coverageNote, null);
  assert.ok(body.access);
  assertNoKeyLeak(body);
});

test('rate: second page is fetched when the first has a continuation', async () => {
  const videos = rateVideos();
  mockSa({ pages: [
    saVideosPage(videos.slice(0, 6), 'tok2'),
    saVideosPage(videos.slice(6))
  ] });
  const res = mockRes();
  await rateHandler(mockReq(channelUrl('rate-pages')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videoCount, 12);
  assert.equal(res.body.saCreditsUsed, 3);
  assert.equal(fetchCalls.length, 3);
});

test('rate: partial extras are disclosed, not hidden', async () => {
  const videos = rateVideos().map((v, i) => (i === 1 ? { ...v, description: null, likeCountInt: null, commentCountInt: null } : v));
  mockSa({ pages: [saVideosPage(videos)] });
  const res = mockRes();
  await rateHandler(mockReq(channelUrl('rate-partial')), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.descriptionCoverage, { withDescription: 11, withStats: 11, total: 12 });
  assert.match(res.body.coverageNote, /Descriptions were available for 11 of 12 videos/);
  assert.match(res.body.coverageNote, /Like and comment counts were available for 11 of 12 videos/);
});

test('rate: cached repeat is free and makes no SA call', async () => {
  mockSa({ pages: [saVideosPage(rateVideos())] });
  const url = channelUrl('rate-cache2');
  const first = mockRes();
  await rateHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  const callsAfterFirst = fetchCalls.length;

  const second = mockRes();
  await rateHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(fetchCalls.length, callsAfterFirst);
});

test('rate: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 429, body: { success: false, failure: { code: 'upstream_rate_limited', message: 'slow down' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await rateHandler(mockReq(channelUrl('rate-429')), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /rate limited/i);
  assert.equal(res.body.access, undefined);
  assert.equal(fetchCalls.length, 1);
  assertNoKeyLeak(res.body);
});

// ---------- revenue ----------

test('revenue: one channel call, estimate from totals over channel age', async () => {
  mockSa({ channel: saChannel(), pages: [saVideosPage([])] });
  const res = mockRes();
  await revenueHandler(mockReq(channelUrl('revenue-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // Only the channel endpoint is called: 1 SA credit, no video pages.
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].includes('/v1/youtube/channel'));
  assert.ok(!fetchCalls[0].includes('channel-videos'));
  assert.equal(body.saCreditsUsed, 1);

  assert.equal(body.channelId, 'UCtestchannel');
  assert.equal(body.channelName, 'Test Channel');
  assert.equal(body.channelThumbnail, 'https://example.com/avatar-160.jpg');
  assert.equal(body.subscriberCount, 7380);
  assert.equal(body.totalChannelViews, 1687166);
  assert.equal(body.videosAnalyzed, 404);
  assert.equal(body.niche.primary, 'tech');
  assert.deepEqual(body.cpmRates, {
    low: 2.5, avg: 4, high: 7,
    formatted: { low: '$2.50', avg: '$4.00', high: '$7.00' }
  });

  // Yearly views = lifetime views / ~2.46y age (900 days). Loose bounds
  // so the test does not depend on the exact day it runs.
  assert.ok(body.viewMetrics.totalViews > 600000 && body.viewMetrics.totalViews < 750000,
    `yearly views must be lifetime/age, got ${body.viewMetrics.totalViews}`);
  assert.equal(body.viewMetrics.averageViews, Math.round(1687166 / 404));
  assert.ok(body.estimatedRevenue.yearly.avg > 0, 'yearly revenue must be non-zero');
  assert.ok(body.estimatedRevenue.monthly.avg > 0, 'monthly revenue must be non-zero');
  assert.ok(body.estimatedRevenue.perVideo.avg > 0, 'per-video revenue must be non-zero');
  assert.equal(body.revenueGrade.grade, 'D');

  // No per-video history in a channel-only lookup: same fields, empty.
  assert.deepEqual(body.monthlyBreakdown, []);
  assert.deepEqual(body.topEarningVideos, []);
  assert.equal(body.viewTrends.trend, 'stable');
  assert.match(body.coverageNote, /Yearly views are estimated from channel totals/);
  assert.match(body.coverageNote, /Monthly breakdown, view trends and top-earning videos need per-video history/);
  assert.ok(body.access);
  assertNoKeyLeak(body);
});

test('revenue: missing join date falls back to lifetime views as-is', async () => {
  mockSa({ channel: saChannel({ joinedDateText: undefined }), pages: [saVideosPage([])] });
  const res = mockRes();
  await revenueHandler(mockReq(channelUrl('revenue-nodate')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.viewMetrics.totalViews, 1687166);
  assert.match(res.body.coverageNote, /lifetime views as-is/);
});

test('revenue: cached repeat is free and makes no SA call', async () => {
  mockSa({ channel: saChannel(), pages: [saVideosPage([])] });
  const url = channelUrl('revenue-cache2');
  const first = mockRes();
  await revenueHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  assert.equal(fetchCalls.length, 1);

  const second = mockRes();
  await revenueHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(fetchCalls.length, 1);
});

test('revenue: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 404, body: { success: false, failure: { code: 'not_found', message: 'no channel' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await revenueHandler(mockReq(channelUrl('revenue-404')), res);
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.body.access, undefined);
  assert.equal(fetchCalls.length, 1);
  assertNoKeyLeak(res.body);
});

test('growth: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 503, body: { success: false, failure: { code: 'busy', message: 'overloaded' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await growthHandler(mockReq(channelUrl('growth-fail')), res);
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.body.access, undefined);
  assertNoKeyLeak(res.body);
});

test('growth: unconfigured Scrape Atlas returns 500 without calling the API', async () => {
  const saved = process.env.SCRAPE_ATLAS_API_KEY;
  delete process.env.SCRAPE_ATLAS_API_KEY;
  try {
    global.fetch = async () => { throw new Error('fetch must not be called'); };
    const res = mockRes();
    await growthHandler(mockReq(channelUrl('growth-noconfig')), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Scrape Atlas is not configured on this site yet.');
  } finally {
    process.env.SCRAPE_ATLAS_API_KEY = saved;
  }
});

test('documented credit costs are unchanged: growth 2, rate 1, revenue 1', async () => {
  const { getCreditsCatalog } = await import('../lib/credits.js');
  const costs = getCreditsCatalog().toolCosts;
  assert.equal(costs.growth, 2);
  assert.equal(costs.rate, 1);
  assert.equal(costs.revenue, 1);
});
