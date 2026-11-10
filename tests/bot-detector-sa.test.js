import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Env vars must be set BEFORE the handler loads.
process.env.YOUTUBE_API_KEY = 'test-youtube-key';
process.env.SCRAPE_ATLAS_API_KEY = 'test-sa-key';
process.env.OWNER_DEMO_MODE = '1';
process.env.OWNER_DEMO_KEY = 'test-owner-demo-key';

const { handleBotDetector, analyzeBotDetectorData, mapSaBotChannel, mapSaBotVideo, mapSaBotComment } =
  await import('../lib/botDetector.js');

// Bot Detector on Scrape Atlas (Phase D). global fetch is mocked so no
// live SA calls happen. The SA key below is a fake placeholder that only
// flips isScrapeAtlasConfigured() on; it is not a real credential and
// must never appear in any response body.
//
// Side-by-side evidence for this migration (Nov 10 2026,
// @boyandascanner, live SA probes): SA video view counts match the
// public YouTube channel page exactly; SA video comments return 20
// top-level comments per page ranked by likes with continuation paging
// and zero overlap; SA channel stats 7,380 subs / 1,687,166 views. The
// live YouTube-API path could not be run from this VM (the local YT
// key returns 403 PERMISSION_DENIED and the SA key is only available
// through the sa.py surrogate), so parity is proven here by feeding
// the same underlying numbers through the old YouTube shape and the
// new SA shape and asserting identical verdicts. Full record:
// docs/phase-d-side-by-side.md.

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

// Twelve recent videos with organic-looking engagement: views vary
// widely, likes run about 4% of views, comments about 0.5%.
const VIDEOS = Array.from({ length: 12 }, (_, i) => ({
  videoId: `vid${String(i + 1).padStart(2, '0')}test`,
  title: `Test Video ${i + 1} Review and Tutorial`,
  description: `Description for test video ${i + 1}.`,
  publishedAt: daysAgo((i + 1) * 9),
  viewCount: [12000, 3400, 9800, 2100, 15600, 4700, 8300, 2900, 11200, 6100, 19800, 5400][i],
  likeCount: [520, 140, 410, 95, 640, 190, 350, 120, 470, 250, 810, 220][i],
  commentCount: [58, 17, 49, 11, 78, 24, 41, 15, 56, 31, 99, 27][i],
  durationSeconds: 390
}));

function ytChannelData() {
  return {
    id: 'UCtestchannel',
    title: 'Test Channel',
    handle: '@testchannel',
    description: 'A test channel.',
    thumbnail: 'https://example.com/thumb.jpg',
    banner: 'https://example.com/banner.jpg',
    customUrl: '@testchannel',
    publishedAt: daysAgo(900),
    country: 'US',
    subscriberCount: 42000,
    viewCount: 1500000,
    videoCount: 120,
    hiddenSubscriberCount: false
  };
}

function ytVideosData() {
  return VIDEOS.map((v) => ({
    id: v.videoId,
    title: v.title,
    publishedAt: v.publishedAt,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
    durationSeconds: v.durationSeconds,
    thumbnail: `https://example.com/${v.videoId}.jpg`
  }));
}

function ytCommentsData() {
  const comments = [];
  for (let videoIdx = 0; videoIdx < 5; videoIdx += 1) {
    for (let i = 0; i < 5; i += 1) {
      comments.push({
        id: `comment-${videoIdx}-${i}`,
        videoId: VIDEOS[videoIdx].videoId,
        authorName: `Viewer${videoIdx}${i}`,
        authorChannelId: `UCcommenter${videoIdx}${i}`,
        authorThumbnail: 'https://example.com/avatar.jpg',
        text: `Really helpful walkthrough, the part about video ${videoIdx + 1} point ${i} cleared it up for me.`,
        likeCount: 3,
        publishedAt: daysAgo(2)
      });
    }
  }
  return comments;
}

function saChannelBody() {
  const joined = new Date(Date.now() - 900 * 86400000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return {
    success: true,
    status: 'success',
    channelId: 'UCtestchannel',
    name: 'Test Channel',
    handle: '@testchannel',
    description: 'A test channel.',
    subscriberCount: 42000,
    videoCount: 120,
    viewCount: 1500000,
    joinedDateText: `Joined ${joined}`,
    country: 'US',
    avatar: { image: { sources: [{ url: 'https://example.com/thumb.jpg', width: 160, height: 160 }] } },
    banner: [{ url: 'https://example.com/banner.jpg', width: 1060, height: 165 }],
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
      durationMs: v.durationSeconds * 1000,
      thumbnail: `https://example.com/${v.videoId}.jpg`
    })),
    continuationToken: null,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] }
  };
}

function saCommentsBody(videoId) {
  const videoIdx = Math.max(0, VIDEOS.findIndex((v) => v.videoId === videoId));
  return {
    success: true,
    status: 'success',
    comments: Array.from({ length: 5 }, (_, i) => ({
      id: `comment-${videoIdx}-${i}`,
      content: `Really helpful walkthrough, the part about video ${videoIdx + 1} point ${i} cleared it up for me.`,
      publishedTime: daysAgo(2),
      author: {
        name: `@Viewer${videoIdx}${i}`,
        channelId: `UCcommenter${videoIdx}${i}`,
        avatarUrl: 'https://example.com/avatar.jpg'
      },
      engagement: { likes: 3, replies: 0 }
    })),
    continuationToken: null,
    fetchedAt: '2026-11-06T07:00:00Z',
    coverage: { complete: true, warnings: [] }
  };
}

function mockSaSuccess() {
  fetchCalls = [];
  global.fetch = async (url) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.includes('/v1/youtube/video/comments')) {
      const videoId = new URL(u).searchParams.get('url')?.split('v=')[1] || VIDEOS[0].videoId;
      return { ok: true, status: 200, json: async () => saCommentsBody(videoId) };
    }
    if (u.includes('/v1/youtube/channel-videos')) {
      return { ok: true, status: 200, json: async () => saChannelVideosBody() };
    }
    if (u.includes('/v1/youtube/channel')) {
      return { ok: true, status: 200, json: async () => saChannelBody() };
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

test('parity: same numbers through the YouTube shape and the SA shape give the same verdict', () => {
  const ytData = { channel: ytChannelData(), videos: ytVideosData(), comments: ytCommentsData() };
  const saData = {
    channel: mapSaBotChannel(saChannelBody()),
    videos: saChannelVideosBody().videos.map((item) => mapSaBotVideo(item)),
    comments: VIDEOS.slice(0, 5).flatMap((v) =>
      saCommentsBody(v.videoId).comments.map((item) => mapSaBotComment(item, v.videoId)).filter(Boolean))
  };
  // The SA channel join date parses to midnight UTC while the YouTube
  // fixture carries an exact timestamp; growth velocity divides by
  // whole days, so align the YouTube publishedAt to the same midnight
  // before comparing, otherwise the subs/day finding differs in the
  // first decimal.
  ytData.channel.publishedAt = saData.channel.publishedAt;
  const ytReport = analyzeBotDetectorData(ytData);
  const saReport = analyzeBotDetectorData(saData);
  assert.deepEqual(saReport, ytReport);
  assert.equal(saReport.risk, 'low');
  assert.ok(saReport.overallScore < 20, `organic fixture should score under 20, got ${saReport.overallScore}`);
});

test('parity: bot-like numbers through the SA shape land in a high band', () => {
  const channel = mapSaBotChannel({ ...saChannelBody(), subscriberCount: 100000, viewCount: 150000 });
  const videos = VIDEOS.map((v) => mapSaBotVideo({
    type: 'video', id: v.videoId, title: v.title, publishDate: v.publishedAt,
    viewCountInt: 10000, likeCountInt: 10, commentCountInt: 1,
    durationMs: 390000, thumbnail: ''
  }));
  const comments = VIDEOS.slice(0, 5).flatMap((v) =>
    Array.from({ length: 5 }, (_, i) => mapSaBotComment({
      id: `spam-${i}`,
      content: 'sub4sub check out my channel for free subscribers',
      author: { name: `@Farmer${i}`, channelId: `UCfarmer${i}`, avatarUrl: '' },
      engagement: { likes: 0, replies: 0 },
      publishedTime: daysAgo(1)
    }, v.videoId)).filter(Boolean));
  const report = analyzeBotDetectorData({ channel, videos, comments });
  assert.ok(report.overallScore >= 40, `bot-like fixture should score 40+, got ${report.overallScore}`);
  assert.ok(['high', 'critical'].includes(report.risk), `expected high/critical, got ${report.risk}`);
});

test('handler: SA run returns the same response shape, 7 SA calls, access from finalize', async () => {
  mockSaSuccess();
  const res = mockRes();
  await handleBotDetector(mockReq(channelUrl('botdetector-sa')), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.report, 'must return a report');
  assert.equal(res.body.channel.subscriberCount, 42000);
  assert.equal(res.body.channel.viewCount, 1500000);
  assert.equal(res.body.videos.length, 12);
  assert.deepEqual(Object.keys(res.body.videos[0]).sort(), [
    'commentCount', 'durationSeconds', 'id', 'likeCount', 'publishedAt', 'thumbnail', 'title', 'viewCount'
  ]);
  assert.deepEqual(res.body.commentFetchStats, { attempted: 5, succeeded: 5, disabled: 0 });
  assert.equal(res.body.report.metadata.videosAnalyzed, 12);
  assert.equal(res.body.report.metadata.commentsAnalyzed, 25);
  assert.equal(res.body.report.risk, 'low');
  assert.equal(res.body.saCreditsUsed, 7, '1 channel + 1 videos page + 5 comment pages');
  assert.ok(res.body.coverageNote && res.body.coverageNote.includes('long-form'), 'must disclose the long-form-only sample');
  assert.ok(res.body.access, 'success must carry access from finalizeToolAccess');
  assert.equal(res.body.access.mode, 'owner_demo');
  assert.equal(res.body.access.chargedCredits, 0);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY), 'fake SA key must never appear in the response');
  const saCalls = fetchCalls.filter((u) => u.includes('api.scrapeatlas.com'));
  assert.equal(saCalls.length, 7);
});

test('handler: cached repeat returns fromCache with access and no charge', async () => {
  mockSaSuccess();
  const url = channelUrl('botdetector-sa-cache');
  const first = mockRes();
  await handleBotDetector(mockReq(url), first);
  assert.equal(first.statusCode, 200);
  const callsAfterFirst = fetchCalls.length;
  const second = mockRes();
  await handleBotDetector(mockReq(url), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fromCache, true);
  assert.ok(second.body.access, 'cached repeat must still carry access');
  assert.equal(fetchCalls.length, callsAfterFirst, 'cached repeat must make no SA calls');
});

test('handler: SA 429 fails soft with no access (no charge)', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ success: false, status: 'failed', failure: { code: 'upstream_rate_limited', message: 'slow down' } })
  });
  const res = mockRes();
  await handleBotDetector(mockReq(channelUrl('botdetector-sa-429')), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'SA_RATE_LIMITED');
  assert.equal(res.body.access, undefined, 'failure must not run finalize');
});

test('handler: comments 404 on every video is treated as disabled, run still succeeds', async () => {
  fetchCalls = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/video/comments')) {
      return { ok: false, status: 404, json: async () => ({ success: false, status: 'failed', failure: { code: 'not_found', message: 'no comments' } }) };
    }
    if (u.includes('/v1/youtube/channel-videos')) {
      return { ok: true, status: 200, json: async () => saChannelVideosBody() };
    }
    if (u.includes('/v1/youtube/channel')) {
      return { ok: true, status: 200, json: async () => saChannelBody() };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  const res = mockRes();
  await handleBotDetector(mockReq(channelUrl('botdetector-sa-nocomments')), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.commentFetchStats, { attempted: 5, succeeded: 0, disabled: 5 });
  assert.equal(res.body.report.metadata.commentsAnalyzed, 0);
  assert.equal(res.body.saCreditsUsed, 2, 'only channel + videos page succeeded');
  assert.ok(res.body.access, 'disabled comments still finalize as a successful run');
});
