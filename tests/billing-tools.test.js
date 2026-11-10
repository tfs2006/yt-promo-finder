import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handlers load: utils.js reads
// YOUTUBE_API_KEY at import time, and static imports are hoisted above
// this file's body, so the handlers are imported dynamically below.
process.env.YOUTUBE_API_KEY = 'test-youtube-key-DO-NOT-USE';
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { default: growthHandler } = await import('../api/growth.js');
const { default: viralHandler } = await import('../api/viral.js');
const { default: saturationHandler } = await import('../api/saturation.js');
const { default: rateHandler } = await import('../api/rate.js');
const { default: revenueHandler } = await import('../api/revenue.js');
const { default: predictorHandler } = await import('../api/predictor.js');
const { handleBotDetector } = await import('../lib/botDetector.js');
const { getCreditsCatalog } = await import('../lib/credits.js');

// Billing tests for the seven tools that were gated but never deducted
// (growth, viral, saturation, rate, revenue, predictor, bot-detector).
// Each handler now runs the shared finalizeToolAccess call on a successful
// run, mirroring api/unlisted.js and lib/adLibraryHandlers.js. global fetch
// is mocked per test, so no YouTube key or network is needed. Access is
// granted through owner demo mode (the same seam release.test.js uses),
// which never deducts credits; the charge itself is the shared
// finalizeToolAccess call. What these tests prove about charging: the
// success path runs finalize (response carries `access`) and every
// failure path returns before finalize (no `access` in the body).
// Documented costs (lib/credits.js): growth 2, viral 2, saturation 2,
// rate 1, revenue 1, predictor 3, bot-detector 1.

const OWNER_KEY = process.env.OWNER_DEMO_KEY;
const originalFetch = global.fetch;
let ipCounter = 0;

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

// Twelve recent videos, newest first. Views/likes/comments/durations are
// canned but realistic; the handlers only need well-formed values.
const VIDEOS = Array.from({ length: 12 }, (_, i) => ({
  videoId: `vid${String(i + 1).padStart(2, '0')}test`,
  title: `Test Video ${i + 1} Review and Tutorial`,
  description: `Description for test video ${i + 1}.`,
  publishedAt: daysAgo((i + 1) * 9),
  viewCount: 12000 - i * 800,
  likeCount: 500 - i * 30,
  commentCount: 60 - i * 4,
  duration: 'PT6M30S',
  durationSeconds: 390
}));

function playlistItemsBody() {
  return {
    items: VIDEOS.map((v) => ({
      snippet: {
        title: v.title,
        publishedAt: v.publishedAt,
        resourceId: { videoId: v.videoId }
      },
      contentDetails: { videoId: v.videoId, videoPublishedAt: v.publishedAt }
    }))
  };
}

function videosBody(requestedIds) {
  const ids = requestedIds.length ? requestedIds : VIDEOS.map((v) => v.videoId);
  return {
    items: VIDEOS.filter((v) => ids.includes(v.videoId)).map((v) => ({
      id: v.videoId,
      snippet: {
        title: v.title,
        description: v.description,
        publishedAt: v.publishedAt
      },
      statistics: {
        viewCount: String(v.viewCount),
        likeCount: String(v.likeCount),
        commentCount: String(v.commentCount)
      },
      contentDetails: { duration: v.duration }
    }))
  };
}

function channelBody() {
  return {
    items: [{
      id: 'UCtestchannel',
      snippet: {
        title: 'Test Channel',
        description: 'A test channel.',
        publishedAt: daysAgo(900),
        customUrl: '@testchannel',
        country: 'US',
        thumbnails: { medium: { url: 'https://example.com/thumb.jpg' } }
      },
      statistics: {
        subscriberCount: '42000',
        videoCount: '120',
        viewCount: '1500000',
        hiddenSubscriberCount: false
      },
      contentDetails: {
        relatedPlaylists: { uploads: 'UUtestuploads' }
      },
      brandingSettings: {
        image: { bannerExternalUrl: 'https://example.com/banner.jpg' }
      }
    }]
  };
}

function commentsBody() {
  return {
    items: Array.from({ length: 5 }, (_, i) => ({
      id: `comment-${i}`,
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: `Viewer ${i}`,
            authorChannelId: { value: `UCcommenter${i}` },
            authorProfileImageUrl: 'https://example.com/avatar.jpg',
            textDisplay: `Great video, really helpful tips number ${i}.`,
            likeCount: 3,
            publishedAt: daysAgo(2)
          }
        }
      }
    }))
  };
}

function mockYouTubeSuccess() {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/youtube/v3/playlistItems')) {
      return { ok: true, status: 200, json: async () => playlistItemsBody() };
    }
    if (u.includes('/youtube/v3/videos')) {
      const ids = (u.match(/[?&]id=([^&]*)/)?.[1] || '').split(',').filter(Boolean);
      return { ok: true, status: 200, json: async () => videosBody(ids) };
    }
    if (u.includes('/youtube/v3/commentThreads')) {
      return { ok: true, status: 200, json: async () => commentsBody() };
    }
    if (u.includes('/youtube/v3/channels')) {
      return { ok: true, status: 200, json: async () => channelBody() };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

function mockYouTubeFailure() {
  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'upstream boom'
  });
}

// Scrape Atlas mock for the migrated tools (growth, rate, revenue).
// Same 12 videos as the YouTube fixture, in SA response shape.
function saChannelBody() {
  const joined = new Date(Date.now() - 900 * 86400000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return {
    success: true,
    status: 'success',
    channelId: 'UCtestchannel',
    name: 'Test Channel',
    description: 'A test channel about tech reviews and tutorials.',
    subscriberCount: 42000,
    videoCount: 120,
    viewCount: 1500000,
    joinedDateText: `Joined ${joined}`,
    tags: 'tech, review, tutorial',
    keywords: ['tech', 'review', 'tutorial'],
    avatar: { image: { sources: [{ url: 'https://example.com/thumb.jpg', width: 160, height: 160 }] } },
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] }
  };
}

function saChannelVideosBody() {
  return {
    success: true,
    status: 'success',
    videos: VIDEOS.map((v) => ({
      type: 'video',
      id: v.videoId,
      title: v.title,
      description: v.description,
      publishDate: v.publishedAt,
      publishedTime: v.publishedAt,
      viewCountInt: v.viewCount,
      likeCountInt: v.likeCount,
      commentCountInt: v.commentCount,
      durationMs: 390000
    })),
    continuationToken: null,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] }
  };
}

function mockSaSuccess() {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/channel-videos')) {
      return { ok: true, status: 200, json: async () => saChannelVideosBody() };
    }
    if (u.includes('/v1/youtube/channel')) {
      return { ok: true, status: 200, json: async () => saChannelBody() };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

function mockSaFailure() {
  global.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ success: false, failure: { code: 'busy', message: 'overloaded' } })
  });
}

function cleanLedgerFiles() {
  for (const file of fs.readdirSync(process.cwd())) {
    if (file.startsWith('cache_sa_ledger_')) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

test.afterEach(() => {
  cleanLedgerFiles();
});

function restoreFetch() {
  global.fetch = originalFetch;
}

function assertFinalized(res) {
  assert.ok(res.body.access, 'success must carry access from finalizeToolAccess');
  assert.equal(res.body.access.mode, 'owner_demo');
  assert.equal(res.body.access.chargedCredits, 0);
}

function assertNotFinalized(res) {
  assert.equal(res.body.access, undefined, 'failure must not run finalize');
}

const YT_TOOLS = [
  { name: 'viral', cost: 2, handler: viralHandler },
  { name: 'saturation', cost: 2, handler: saturationHandler },
  { name: 'predictor', cost: 3, handler: predictorHandler }
];

// Growth, rate and revenue run on Scrape Atlas now (Phase A), so their
// billing tests mock the SA endpoints instead of the YouTube API.
const SA_TOOLS = [
  { name: 'growth', cost: 2, handler: growthHandler },
  { name: 'rate', cost: 1, handler: rateHandler },
  { name: 'revenue', cost: 1, handler: revenueHandler }
];

for (const tool of YT_TOOLS) {
  test(`${tool.name}: successful run carries access from finalize`, async () => {
    mockYouTubeSuccess();
    try {
      const res = mockRes();
      await tool.handler(mockReq(channelUrl(tool.name)), res);
      assert.equal(res.statusCode, 200);
      assertFinalized(res);
    } finally {
      restoreFetch();
    }
  });

  test(`${tool.name}: upstream failure returns no access (no charge)`, async () => {
    mockYouTubeFailure();
    try {
      const res = mockRes();
      await tool.handler(mockReq(channelUrl(`${tool.name}-fail`)), res);
      assert.ok(res.statusCode >= 400, `expected an error status, got ${res.statusCode}`);
      assertNotFinalized(res);
    } finally {
      restoreFetch();
    }
  });
}

for (const tool of SA_TOOLS) {
  test(`${tool.name}: successful run carries access from finalize`, async () => {
    mockSaSuccess();
    try {
      const res = mockRes();
      await tool.handler(mockReq(channelUrl(tool.name)), res);
      assert.equal(res.statusCode, 200);
      assertFinalized(res);
    } finally {
      restoreFetch();
    }
  });

  test(`${tool.name}: upstream failure returns no access (no charge)`, async () => {
    mockSaFailure();
    try {
      const res = mockRes();
      await tool.handler(mockReq(channelUrl(`${tool.name}-fail`)), res);
      assert.ok(res.statusCode >= 400, `expected an error status, got ${res.statusCode}`);
      assertNotFinalized(res);
    } finally {
      restoreFetch();
    }
  });
}

test('bot-detector: successful run carries access from finalize', async () => {
  mockYouTubeSuccess();
  try {
    const res = mockRes();
    await handleBotDetector(mockReq(channelUrl('botdetector')), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.report, 'bot-detector must return a report');
    assertFinalized(res);
  } finally {
    restoreFetch();
  }
});

test('bot-detector: upstream failure returns no access (no charge)', async () => {
  mockYouTubeFailure();
  try {
    const res = mockRes();
    await handleBotDetector(mockReq(channelUrl('botdetector-fail')), res);
    assert.ok(res.statusCode >= 400, `expected an error status, got ${res.statusCode}`);
    assertNotFinalized(res);
  } finally {
    restoreFetch();
  }
});

test('growth: cached repeat returns fromCache with access and no charge', async () => {
  mockSaSuccess();
  try {
    const url = channelUrl('growth-cache');
    const first = mockRes();
    await growthHandler(mockReq(url), first);
    assert.equal(first.statusCode, 200);
    assertFinalized(first);

    // Same input, stable cache key: the second call is served from cache.
    const second = mockRes();
    await growthHandler(mockReq(url), second);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.fromCache, true);
    assertFinalized(second);
  } finally {
    restoreFetch();
  }
});

test('documented credit costs for the seven tools', () => {
  const costs = getCreditsCatalog().toolCosts;
  assert.equal(costs.growth, 2);
  assert.equal(costs.viral, 2);
  assert.equal(costs.saturation, 2);
  assert.equal(costs.rate, 1);
  assert.equal(costs.revenue, 1);
  assert.equal(costs.predictor, 3);
  assert.equal(costs['bot-detector'], 1);
});
