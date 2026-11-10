import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handlers load: utils.js reads
// YOUTUBE_API_KEY at import time, and static imports are hoisted above
// this file's body, so the handlers are imported dynamically below.
process.env.YOUTUBE_API_KEY = 'x'.repeat(32);
process.env.SCRAPE_ATLAS_API_KEY = 'test-dummy-not-a-real-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { default: viralHandler } = await import('../api/viral.js');
const { default: saturationHandler } = await import('../api/saturation.js');
const { default: rateHandler } = await import('../api/rate.js');

// Regression tests for the missing-statistics bug: viral, saturation and
// rate called getVideoDetails() without { includeStatistics: true }, so
// every video came back with viewCount/likeCount/commentCount of 0.
// Viral scores all computed to 1, rate estimates to $0, and saturation's
// view comparisons to 0. The mock below mirrors the real YouTube API: the
// videos endpoint only returns a statistics block when the request asks
// for the statistics part. A handler that forgets includeStatistics gets
// no stats, exactly like production, so these tests fail on the old code
// and pass on the fixed code.

const OWNER_KEY = process.env.OWNER_DEMO_KEY;
const originalFetch = global.fetch;
let ipCounter = 0;
let fetchedUrls = [];

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

// Twelve recent videos with a clear outlier: video 1 has 200,000 views
// (about 8.7x the channel average) and carries a sponsor link, the rest
// sit between 2,000 and 12,000 views. If statistics flow through, viral
// scores must vary, the rate estimate must be non-zero, and saturation's
// view averages must be real numbers.
const VIDEOS = [
  { videoId: 'vid01outlier', title: 'Test Video 1 Review and Tutorial', description: 'Sponsored by ExampleBrand, see https://examplebrand.com/deal for details.', publishedAt: daysAgo(9), viewCount: 200000, likeCount: 8000, commentCount: 900, duration: 'PT6M30S' },
  { videoId: 'vid02testxx', title: 'Test Video 2 Review and Tutorial', description: 'Description for test video 2.', publishedAt: daysAgo(18), viewCount: 12000, likeCount: 480, commentCount: 60, duration: 'PT6M30S' },
  { videoId: 'vid03testxx', title: 'Test Video 3 Review and Tutorial', description: 'Description for test video 3.', publishedAt: daysAgo(27), viewCount: 11000, likeCount: 440, commentCount: 55, duration: 'PT6M30S' },
  { videoId: 'vid04testxx', title: 'Test Video 4 Review and Tutorial', description: 'Description for test video 4.', publishedAt: daysAgo(36), viewCount: 10000, likeCount: 400, commentCount: 50, duration: 'PT6M30S' },
  { videoId: 'vid05testxx', title: 'Test Video 5 Review and Tutorial', description: 'Description for test video 5.', publishedAt: daysAgo(45), viewCount: 9000, likeCount: 360, commentCount: 45, duration: 'PT6M30S' },
  { videoId: 'vid06testxx', title: 'Test Video 6 Review and Tutorial', description: 'Description for test video 6.', publishedAt: daysAgo(54), viewCount: 8000, likeCount: 320, commentCount: 40, duration: 'PT6M30S' },
  { videoId: 'vid07testxx', title: 'Test Video 7 Review and Tutorial', description: 'Description for test video 7.', publishedAt: daysAgo(63), viewCount: 7000, likeCount: 280, commentCount: 35, duration: 'PT6M30S' },
  { videoId: 'vid08testxx', title: 'Test Video 8 Review and Tutorial', description: 'Description for test video 8.', publishedAt: daysAgo(72), viewCount: 6000, likeCount: 240, commentCount: 30, duration: 'PT6M30S' },
  { videoId: 'vid09testxx', title: 'Test Video 9 Review and Tutorial', description: 'Description for test video 9.', publishedAt: daysAgo(81), viewCount: 5000, likeCount: 200, commentCount: 25, duration: 'PT6M30S' },
  { videoId: 'vid10testxx', title: 'Test Video 10 Review and Tutorial', description: 'Description for test video 10.', publishedAt: daysAgo(90), viewCount: 4000, likeCount: 160, commentCount: 20, duration: 'PT6M30S' },
  { videoId: 'vid11testxx', title: 'Test Video 11 Review and Tutorial', description: 'Description for test video 11.', publishedAt: daysAgo(99), viewCount: 3000, likeCount: 120, commentCount: 15, duration: 'PT6M30S' },
  { videoId: 'vid12testxx', title: 'Test Video 12 Review and Tutorial', description: 'Description for test video 12.', publishedAt: daysAgo(108), viewCount: 2000, likeCount: 80, commentCount: 10, duration: 'PT6M30S' }
];

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

function videosBody(requestedIds, includeStatistics) {
  const ids = requestedIds.length ? requestedIds : VIDEOS.map((v) => v.videoId);
  return {
    items: VIDEOS.filter((v) => ids.includes(v.videoId)).map((v) => {
      const item = {
        id: v.videoId,
        snippet: {
          title: v.title,
          description: v.description,
          publishedAt: v.publishedAt
        },
        contentDetails: { duration: v.duration }
      };
      if (includeStatistics) {
        item.statistics = {
          viewCount: String(v.viewCount),
          likeCount: String(v.likeCount),
          commentCount: String(v.commentCount)
        };
      }
      return item;
    })
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

function mockYouTubeFaithful() {
  fetchedUrls = [];
  global.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    if (u.includes('/youtube/v3/playlistItems')) {
      return { ok: true, status: 200, json: async () => playlistItemsBody() };
    }
    if (u.includes('/youtube/v3/videos')) {
      const ids = (u.match(/[?&]id=([^&]*)/)?.[1] || '').split(',').filter(Boolean);
      const wantsStats = (u.match(/[?&]part=([^&]*)/)?.[1] || '').split(',').includes('statistics');
      return { ok: true, status: 200, json: async () => videosBody(ids, wantsStats) };
    }
    if (u.includes('/youtube/v3/channels')) {
      return { ok: true, status: 200, json: async () => channelBody() };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// The SA ledger (logSaCall) writes cache_sa_ledger_*.json files in the
// test env; clean them so the repo stays tidy.
test.afterEach(() => {
  for (const file of fs.readdirSync(process.cwd())) {
    if (file.startsWith('cache_sa_ledger_')) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
});

function assertRequestedStatistics() {
  const videosUrls = fetchedUrls.filter((u) => u.includes('/youtube/v3/videos'));
  assert.ok(videosUrls.length > 0, 'handler must call the videos endpoint');
  assert.ok(
    videosUrls.some((u) => (u.match(/[?&]part=([^&]*)/)?.[1] || '').split(',').includes('statistics')),
    `videos request must ask for the statistics part, got: ${videosUrls.join(' | ')}`
  );
}

// Rate runs on Scrape Atlas now (Phase A): same 12 videos, in SA shape.
// The mock mirrors the real SA contract the same way mockYouTubeFaithful
// mirrors the YouTube API: extras carry description, like and comment
// counts, so a handler that forgets includeExtras gets no stats, exactly
// like production.
function mockSaFaithful() {
  fetchedUrls = [];
  global.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    if (u.includes('/v1/youtube/channel-videos')) {
      const withExtras = u.includes('includeExtras=true');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'success',
          videos: VIDEOS.map((v) => ({
            type: 'video',
            id: v.videoId,
            title: v.title,
            // Without extras the description and counts are null.
            description: withExtras ? v.description : null,
            publishDate: v.publishedAt,
            publishedTime: v.publishedAt,
            viewCountInt: v.viewCount,
            likeCountInt: withExtras ? v.likeCount : null,
            commentCountInt: withExtras ? v.commentCount : null,
            durationMs: 390000
          })),
          continuationToken: null,
          fetchedAt: '2026-11-06T07:00:00Z',
          coverage: { complete: true, warnings: [] }
        })
      };
    }
    if (u.includes('/v1/youtube/channel')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'success',
          channelId: 'UCtestchannel',
          name: 'Test Channel',
          description: 'A test channel.',
          subscriberCount: 42000,
          videoCount: 120,
          viewCount: 1500000,
          joinedDateText: 'Joined Jul 30, 2019',
          fetchedAt: '2026-11-06T07:00:00Z',
          coverage: { complete: true, warnings: [] }
        })
      };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

function assertRequestedExtras() {
  const videosUrls = fetchedUrls.filter((u) => u.includes('/v1/youtube/channel-videos'));
  assert.ok(videosUrls.length > 0, 'handler must call channel-videos');
  assert.ok(
    videosUrls.some((u) => u.includes('includeExtras=true')),
    `channel-videos request must ask for extras, got: ${videosUrls.join(' | ')}`
  );
}

test('viral: requests video statistics and scores vary with real views', async () => {
  mockYouTubeFaithful();
  try {
    const res = mockRes();
    await viralHandler(mockReq(channelUrl('viral-stats')), res);
    assert.equal(res.statusCode, 200);
    assertRequestedStatistics();
    assert.ok(res.body.metrics.averageViews > 0, `averageViews must be real, got ${res.body.metrics.averageViews}`);
    assert.ok(Array.isArray(res.body.topViral) && res.body.topViral.length > 0, 'topViral must list videos');
    const scores = res.body.topViral.map((v) => v.viralScore);
    assert.ok(Math.max(...scores) > 3, `top viral score must clear 3x, got ${Math.max(...scores)}`);
    assert.ok(Math.min(...scores) < 1, `lowest viral score must be under 1x, got ${Math.min(...scores)}`);
    assert.ok(new Set(scores).size > 1, 'viral scores must vary, not all 1');
  } finally {
    restoreFetch();
  }
});

test('rate: requests video statistics and the estimate is non-zero', async () => {
  mockSaFaithful();
  try {
    const res = mockRes();
    await rateHandler(mockReq(channelUrl('rate-stats')), res);
    assert.equal(res.statusCode, 200);
    assertRequestedExtras();
    assert.ok(res.body.metrics.averageViews > 0, `averageViews must be real, got ${res.body.metrics.averageViews}`);
    assert.ok(res.body.estimatedRates.perVideo.average > 0, `estimated rate must be non-zero, got ${res.body.estimatedRates.perVideo.average}`);
    assert.ok(res.body.estimatedRates.perVideo.low > 0, 'estimated rate low must be non-zero');
    assert.ok(res.body.metrics.engagementRate > 0, `engagement rate must be real, got ${res.body.metrics.engagementRate}`);
  } finally {
    restoreFetch();
  }
});

test('saturation: requests video statistics and view averages are real', async () => {
  mockYouTubeFaithful();
  try {
    const res = mockRes();
    await saturationHandler(mockReq(channelUrl('saturation-stats')), res);
    assert.equal(res.statusCode, 200);
    assertRequestedStatistics();
    assert.ok(res.body.performance.overallAvgViews > 0, `overallAvgViews must be real, got ${res.body.performance.overallAvgViews}`);
    assert.ok(res.body.performance.sponsoredAvgViews > 0, `sponsoredAvgViews must be real, got ${res.body.performance.sponsoredAvgViews}`);
    assert.ok(res.body.monthlyBreakdown.length > 0, 'monthlyBreakdown must have months');
    for (const month of res.body.monthlyBreakdown) {
      assert.ok(month.avgViews > 0, `month ${month.month} avgViews must be real, got ${month.avgViews}`);
    }
  } finally {
    restoreFetch();
  }
});
