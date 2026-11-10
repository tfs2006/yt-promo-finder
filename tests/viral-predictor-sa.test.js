import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handlers load.
process.env.YOUTUBE_API_KEY = 'test-youtube-key-DO-NOT-USE';
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { default: viralHandler } = await import('../api/viral.js');
const { default: predictorHandler } = await import('../api/predictor.js');

// Viral + Predictor on Scrape Atlas (Phase B). global fetch is mocked
// so no live SA calls happen. The SA key below is a fake placeholder
// that only flips isScrapeAtlasConfigured() on; it is not a real
// credential and must never appear in any response body (asserted in
// the tests).

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
    description: 'A test channel about tech reviews and tutorials.',
    subscriberCount: 42000,
    videoCount: 120,
    viewCount: 1500000,
    joinedDateText: joinedText(900),
    tags: 'tech, review, tutorial',
    keywords: ['tech', 'review', 'tutorial'],
    avatar: { image: { sources: [{ url: 'https://example.com/thumb.jpg', width: 160, height: 160 }] } },
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] },
    ...overrides
  };
}

function saVideo(overrides = {}) {
  return {
    type: 'video',
    id: 'vid-x',
    title: 'Test Video Review and Tutorial',
    description: 'A plain description with no links.',
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

// Twelve recent videos with a clear outlier: video 1 has 200,000 views
// (about 8.7x the channel average), the rest sit between 2,000 and
// 12,000 views. Same shape as tests/video-statistics.test.js.
const VIRAL_VIDEOS = [
  { videoId: 'vid01outlier', title: 'Test Video 1 Review and Tutorial', publishedAt: daysAgo(9), viewCount: 200000, likeCount: 8000, commentCount: 900 },
  { videoId: 'vid02testxx', title: 'Test Video 2 Review and Tutorial', publishedAt: daysAgo(18), viewCount: 12000, likeCount: 480, commentCount: 60 },
  { videoId: 'vid03testxx', title: 'Test Video 3 Review and Tutorial', publishedAt: daysAgo(27), viewCount: 11000, likeCount: 440, commentCount: 55 },
  { videoId: 'vid04testxx', title: 'Test Video 4 Review and Tutorial', publishedAt: daysAgo(36), viewCount: 10000, likeCount: 400, commentCount: 50 },
  { videoId: 'vid05testxx', title: 'Test Video 5 Review and Tutorial', publishedAt: daysAgo(45), viewCount: 9000, likeCount: 360, commentCount: 45 },
  { videoId: 'vid06testxx', title: 'Test Video 6 Review and Tutorial', publishedAt: daysAgo(54), viewCount: 8000, likeCount: 320, commentCount: 40 },
  { videoId: 'vid07testxx', title: 'Test Video 7 Review and Tutorial', publishedAt: daysAgo(63), viewCount: 7000, likeCount: 280, commentCount: 35 },
  { videoId: 'vid08testxx', title: 'Test Video 8 Review and Tutorial', publishedAt: daysAgo(72), viewCount: 6000, likeCount: 240, commentCount: 30 },
  { videoId: 'vid09testxx', title: 'Test Video 9 Review and Tutorial', publishedAt: daysAgo(81), viewCount: 5000, likeCount: 200, commentCount: 25 },
  { videoId: 'vid10testxx', title: 'Test Video 10 Review and Tutorial', publishedAt: daysAgo(90), viewCount: 4000, likeCount: 160, commentCount: 20 },
  { videoId: 'vid11testxx', title: 'Test Video 11 Review and Tutorial', publishedAt: daysAgo(99), viewCount: 3000, likeCount: 120, commentCount: 15 },
  { videoId: 'vid12testxx', title: 'Test Video 12 Review and Tutorial', publishedAt: daysAgo(108), viewCount: 2000, likeCount: 80, commentCount: 10 }
].map((v) => saVideo({
  id: v.videoId,
  title: v.title,
  description: `Description for ${v.videoId}.`,
  publishDate: v.publishedAt,
  publishedTime: v.publishedAt,
  viewCountInt: v.viewCount,
  likeCountInt: v.likeCount,
  commentCountInt: v.commentCount
}));

// Twelve videos in three bands so the predictor's scoring bands
// compute: 5 medium-duration (600s) / medium-title videos at 20,000
// views, 4 short (150s) / short-title at 5,000, 3 micro (45s) /
// long-title at 2,000. Average views 10,500, so the medium band
// scores about 190 and must win both best-duration and best-title.
const PREDICTOR_VIDEOS = [
  ...Array.from({ length: 5 }, (_, i) => saVideo({
    id: `pred-med-0${i + 1}`,
    title: `Scanner Radio Setup Guide for Beginners ${i + 1}`,
    publishDate: daysAgo(9 + i * 9),
    publishedTime: daysAgo(9 + i * 9),
    viewCountInt: 20000,
    likeCountInt: 800,
    commentCountInt: 90,
    durationMs: 600000,
    lengthSeconds: 600
  })),
  ...Array.from({ length: 4 }, (_, i) => saVideo({
    id: `pred-short-0${i + 1}`,
    title: `Scanner Tips ${i + 1}`,
    publishDate: daysAgo(54 + i * 9),
    publishedTime: daysAgo(54 + i * 9),
    viewCountInt: 5000,
    likeCountInt: 200,
    commentCountInt: 25,
    durationMs: 150000,
    lengthSeconds: 150
  })),
  ...Array.from({ length: 3 }, (_, i) => saVideo({
    id: `pred-micro-0${i + 1}`,
    title: `The Complete Beginner Guide to Programming Your First Scanner Radio ${i + 1}`,
    publishDate: daysAgo(90 + i * 9),
    publishedTime: daysAgo(90 + i * 9),
    viewCountInt: 2000,
    likeCountInt: 80,
    commentCountInt: 10,
    durationMs: 45000,
    lengthSeconds: 45
  }))
];

// Mock fetch routing SA calls: channel-videos must be matched before
// channel (its path contains the channel path as a prefix). The channel
// record and the first video page are fetched in parallel by the
// handler, so both land in fetchCalls before any continuation page.
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

// ---------- viral ----------

test('viral: same response shape as the YouTube version, scores from real SA stats', async () => {
  mockSa({ pages: [saVideosPage(VIRAL_VIDEOS)] });
  const res = mockRes();
  await viralHandler(mockReq(channelUrl('viral-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // UI contract: same fields as the YouTube version.
  assert.equal(body.channelId, 'UCtestchannel');
  assert.equal(body.videoCount, 12);
  assert.equal(typeof body.sinceISO, 'string');
  assert.deepEqual(body.metrics, {
    totalViews: 277000,
    averageViews: 23083,
    medianViews: 8000,
    viralRate: '8.3'
  });
  assert.deepEqual(body.distribution, {
    megaViral: 0, viral: 1, hit: 0, aboveAverage: 0, average: 1, belowAverage: 10
  });
  assert.equal(body.topViral.length, 10);
  assert.equal(body.topViral[0].videoId, 'vid01outlier');
  assert.equal(body.topViral[0].viralScore, 8.7);
  assert.deepEqual(Object.keys(body.topViral[0]).sort(), ['category', 'publishedAt', 'title', 'videoId', 'viewCount', 'viralScore']);
  assert.deepEqual(body.topViral[0].category, { category: 'viral', label: 'Viral', color: 'amber', description: '5-10x average views' });
  assert.ok(body.biggestFlops.length > 0, 'flops must be listed');
  assert.deepEqual(body.patterns.commonKeywords, []);
  assert.equal(body.patterns.titleInsights, null);
  assert.deepEqual(body.summary, {
    viralVideoCount: 1,
    hitVideoCount: 0,
    flopVideoCount: 10,
    highestViralScore: 8.7,
    lowestViralScore: 0.09
  });

  // Viral scores must vary with real view counts, not all 1.
  const scores = body.topViral.map((v) => v.viralScore);
  assert.ok(Math.max(...scores) > 3, `top viral score must clear 3x, got ${Math.max(...scores)}`);
  assert.ok(Math.min(...scores) < 1, `lowest top-10 viral score must be under 1x, got ${Math.min(...scores)}`);
  assert.ok(new Set(scores).size > 1, 'viral scores must vary, not all 1');

  // Extras were requested (exact view counts), windowed to last year.
  const videosUrl = new URL(fetchCalls.find((u) => u.includes('channel-videos')));
  assert.equal(videosUrl.searchParams.get('includeExtras'), 'true');
  assert.equal(videosUrl.searchParams.get('sort'), 'latest');
  assert.ok(videosUrl.searchParams.get('since'), 'videos must be windowed to the last year');

  // 1 channel call + 1 video page = 2 SA credits.
  assert.equal(body.saCreditsUsed, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(body.videoCoverage, { withViews: 12, withDuration: 12, withStats: 12, total: 12 });
  assert.equal(body.coverageNote, null);
  assert.ok(body.access, 'success must carry access from finalizeToolAccess');
  assertNoKeyLeak(body);
});

test('viral: continuation page is fetched and counted', async () => {
  mockSa({ pages: [
    saVideosPage(VIRAL_VIDEOS.slice(0, 6), 'tok2'),
    saVideosPage(VIRAL_VIDEOS.slice(6))
  ] });
  const res = mockRes();
  await viralHandler(mockReq(channelUrl('viral-pages')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videoCount, 12);
  assert.equal(res.body.saCreditsUsed, 3);
  assert.equal(fetchCalls.length, 3);
  const page2 = new URL(fetchCalls[2]);
  assert.equal(page2.searchParams.get('continuationToken'), 'tok2');
});

test('viral: partial extras are disclosed, not hidden', async () => {
  const videos = VIRAL_VIDEOS.map((v, i) => (i === 1
    ? { ...v, description: null, viewCountInt: null, likeCountInt: null, commentCountInt: null, durationMs: null }
    : v));
  mockSa({ pages: [saVideosPage(videos)] });
  const res = mockRes();
  await viralHandler(mockReq(channelUrl('viral-partial')), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.videoCoverage, { withViews: 11, withDuration: 11, withStats: 11, total: 12 });
  assert.match(res.body.coverageNote, /View counts were available for 11 of 12 videos/);
});

test('viral: channel with no videos in the last year returns 400, not a crash', async () => {
  mockSa({ pages: [saVideosPage([])] });
  const res = mockRes();
  await viralHandler(mockReq(channelUrl('viral-empty')), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'No videos found in the last year.');
  assert.equal(res.body.access, undefined);
});

test('viral: cached repeat is free and makes no SA call', async () => {
  mockSa({ pages: [saVideosPage(VIRAL_VIDEOS)] });
  const url = channelUrl('viral-cache2');
  const first = mockRes();
  await viralHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  assert.equal(fetchCalls.length, 2);

  const second = mockRes();
  await viralHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(second.body.videoCount, 12);
  assert.equal(fetchCalls.length, 2);
});

test('viral: legacy /user/ input resolves the channel first, then pages by channelId', async () => {
  mockSa({ pages: [saVideosPage(VIRAL_VIDEOS)] });
  const res = mockRes();
  await viralHandler(mockReq('https://www.youtube.com/user/oldname'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videoCount, 12);
  const videosUrl = new URL(fetchCalls.find((u) => u.includes('channel-videos')));
  assert.equal(videosUrl.searchParams.get('channelId'), 'UCtestchannel');
  assert.equal(videosUrl.searchParams.get('forUsername'), null);
});

// ---------- predictor ----------

test('predictor: same response shape as the YouTube version, bands from real SA stats', async () => {
  mockSa({ pages: [saVideosPage(PREDICTOR_VIDEOS)] });
  const res = mockRes();
  await predictorHandler(mockReq(channelUrl('predict-shape')), res);
  assert.equal(res.statusCode, 200);
  const body = res.body;

  // UI contract: same fields as the YouTube version.
  assert.equal(body.channelId, 'UCtestchannel');
  assert.equal(body.channelName, 'Test Channel');
  assert.equal(body.channelThumbnail, 'https://example.com/thumb.jpg');
  assert.equal(body.videosAnalyzed, 12);
  assert.equal(body.analysisTimeframe, '12 months');
  assert.deepEqual(body.averages, {
    views: 10500,
    duration: '5:11',
    durationSeconds: 311,
    titleLength: 39
  });
  assert.equal(body.topPerformers[0].viewCount, 20000);
  assert.equal(body.topPerformers[0].duration, '10:00');
  assert.equal(body.bottomPerformers[0].viewCount, 2000);

  // Duration band: the 600s medium band (5 videos, 20,000 views) must
  // win with a ~190 performance score.
  const mediumBand = body.correlations.duration.find((d) => d.category === 'medium');
  assert.ok(mediumBand, 'duration correlations must include the medium band');
  assert.equal(mediumBand.count, 5);
  assert.equal(mediumBand.performanceScore, 190);
  assert.equal(body.optimal.duration.best, 'medium');
  assert.equal(body.optimal.duration.score, 190);
  assert.equal(body.optimal.duration.bestLabel, '8-15 minutes');
  assert.equal(body.optimal.titleLength.best, 'medium');
  assert.equal(body.optimal.titleLength.score, 190);
  assert.ok(body.recommendations.length >= 2, 'duration + title recommendations must fire');
  assert.ok(body.recommendations.some((r) => r.category === 'duration'), 'duration recommendation expected');
  assert.ok(body.recommendations.some((r) => r.category === 'title'), 'title recommendation expected');
  assert.match(body.disclaimer, /based on historical patterns/);

  // Extras were requested (exact durations + publish dates + views).
  const videosUrl = new URL(fetchCalls.find((u) => u.includes('channel-videos')));
  assert.equal(videosUrl.searchParams.get('includeExtras'), 'true');
  assert.equal(videosUrl.searchParams.get('sort'), 'latest');
  assert.ok(videosUrl.searchParams.get('since'), 'videos must be windowed to the last year');

  // 1 channel call + 1 video page = 2 SA credits.
  assert.equal(body.saCreditsUsed, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(body.videoCoverage, { withViews: 12, withDuration: 12, withStats: 12, total: 12 });
  assert.equal(body.coverageNote, null);
  assert.ok(body.access, 'success must carry access from finalizeToolAccess');
  assertNoKeyLeak(body);
});

test('predictor: fewer than 10 videos returns 400 and charges nothing', async () => {
  mockSa({ pages: [saVideosPage(PREDICTOR_VIDEOS.slice(0, 5))] });
  const res = mockRes();
  await predictorHandler(mockReq(channelUrl('predict-few')), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /at least 10 videos/);
  assert.equal(res.body.access, undefined);
});

test('predictor: duration falls back to the listed length when extras lack durationMs', async () => {
  const videos = PREDICTOR_VIDEOS.map((v, i) => (i === 0 ? { ...v, durationMs: null } : v));
  mockSa({ pages: [saVideosPage(videos)] });
  const res = mockRes();
  await predictorHandler(mockReq(channelUrl('predict-nodur')), res);
  assert.equal(res.statusCode, 200);
  // The first video still counts as 600s via lengthSeconds, so the
  // averages and the medium band are unchanged.
  assert.equal(res.body.averages.durationSeconds, 311);
  assert.equal(res.body.optimal.duration.best, 'medium');
  assert.deepEqual(res.body.videoCoverage, { withViews: 12, withDuration: 11, withStats: 12, total: 12 });
  assert.match(res.body.coverageNote, /Durations were available for 11 of 12 videos/);
});

test('predictor: cached repeat is free and makes no SA call', async () => {
  mockSa({ pages: [saVideosPage(PREDICTOR_VIDEOS)] });
  const url = channelUrl('predict-cache2');
  const first = mockRes();
  await predictorHandler(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  const callsAfterFirst = fetchCalls.length;

  const second = mockRes();
  await predictorHandler(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.equal(fetchCalls.length, callsAfterFirst);
});

test('predictor: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 429, body: { success: false, failure: { code: 'upstream_rate_limited', message: 'slow down' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await predictorHandler(mockReq(channelUrl('predict-429')), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /rate limited/i);
  assert.equal(res.body.access, undefined);
  // Channel + first video page start in parallel, so both fire.
  assert.equal(fetchCalls.length, 2);
  assertNoKeyLeak(res.body);
});

test('viral: SA failure returns an error and charges nothing', async () => {
  mockSa({
    channel: { __http: 503, body: { success: false, failure: { code: 'busy', message: 'overloaded' } } },
    pages: [saVideosPage([])]
  });
  const res = mockRes();
  await viralHandler(mockReq(channelUrl('viral-fail')), res);
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.body.access, undefined);
  assertNoKeyLeak(res.body);
});

test('viral: unconfigured Scrape Atlas returns 500 without calling the API', async () => {
  const saved = process.env.SCRAPE_ATLAS_API_KEY;
  delete process.env.SCRAPE_ATLAS_API_KEY;
  try {
    global.fetch = async () => { throw new Error('fetch must not be called'); };
    const res = mockRes();
    await viralHandler(mockReq(channelUrl('viral-noconfig')), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Scrape Atlas is not configured on this site yet.');
  } finally {
    process.env.SCRAPE_ATLAS_API_KEY = saved;
  }
});

test('documented credit costs are unchanged: viral 2, predictor 3', async () => {
  const { getCreditsCatalog } = await import('../lib/credits.js');
  const costs = getCreditsCatalog().toolCosts;
  assert.equal(costs.viral, 2);
  assert.equal(costs.predictor, 3);
});
