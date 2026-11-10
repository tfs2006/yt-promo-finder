# Phase D side-by-side: Scrape Atlas vs YouTube API for Bot Detector (Nov 10, 2026)

Decision record for the Phase D migration (Bot Detector). Live SA data on
`@boyandascanner` plus a high-volume control video; the live YouTube-API
path could not be run from this VM (see "What could not be verified").

## Verdict

- **Bot Detector: MIGRATED** to Scrape Atlas (`lib/botDetector.js`, tests
  in `tests/bot-detector-sa.test.js`).
- Price unchanged (1 credit). 7 SA calls per cache-miss run: 1 channel +
  1 channel-videos page + 5 video-comments pages. Charge only after a
  successful run; cached repeats free; SA failures (including 429) fail
  soft with no charge.

## Why this tool can migrate when Analyze / Compare / Saturation could not

Bot Detector's heuristics never read video descriptions. They use channel
stats, per-video views/likes/comments/duration/publish date, and comment
text + author + likes. The SA long-URL truncation that blocked Phase C
therefore does not apply here.

## Endpoint behavior verified live (sa.py, Nov 10 2026)

### `youtube/video/comments` (new endpoint for this phase)

- `GET /v1/youtube/video/comments?url=<videoId or URL>&order=top`,
  docs at scrapeatlas.com/docs/platforms/youtube/video-comments/.
  The first probe used `videoId=` and got HTTP 400 `invalid_request`;
  the param is `url` (a bare 11-char video ID is accepted).
- Page size is exactly 20 top-level comments. Verified on dQw4w9WgXcQ
  (Rick Astley, millions of comments): page 1 returned 20, page 2 via
  `continuationToken` returned 20 more, 0 overlap between pages.
- Ordering `top` (default) is ranked by engagement: page-1 like counts
  were 570k, 71k, 221k, 0, 428k, 107k, 293k, 0, 134k, 403k; page 2
  dropped to tens/hundreds. This matches the YouTube API's
  `order=relevance` that the old code used.
- Every comment carries: `content` (text), `author.name` (with a
  leading `@`), `author.channelId`, `author.avatarUrl`,
  `engagement.likes`, `engagement.replies`, `publishedTime`,
  `repliesContinuationToken` when the comment has replies.
- Latency ~3s per page (upstream 1.3-2.9s). Five parallel pages take
  ~3-4s total.
- `publishedTime` is a coarse estimate computed from relative text
  ("3 days ago") at retrieval time: several comments on one video
  shared the identical timestamp `2026-11-07T16:10:31.142Z`. The
  heuristics never use comment dates, so this is not scored.
- One comment in a 20-comment page had empty `content`. The SA mapper
  drops empty-text comments: the YouTube API never returns them, and
  an empty string would otherwise count as "generic" in the
  authenticity signal.
- Small-channel sample: J-WWwwFg90A (`@boyandascanner`, newest video)
  claims `commentCountInt` 19 but SA returned 7 top-level comments,
  no continuation, `coverage.complete: true`. The 19 counts replies
  (the 7 threads carry reply counts summing to ~12); the YouTube
  API's `commentThreads.list` likewise returns top-level threads
  only, so the sampled set is the same shape. The heuristics need
  10+ sampled comments for authenticity and 15+ for duplicates; the
  5-video sample on this channel yields roughly 15-25 top-level
  comments, comparable to the old path.

### `youtube/channel` and `youtube/channel-videos` (already proven)

- Channel: ~4.5s. `@boyandascanner` -> UCcVAyyIGWsD3823CdeWO8lw,
  7,380 subs, 1,687,166 views, 404 videos, joined Jul 30, 2019.
  Carries `handle`, `country` ("United States", where the YouTube API
  returned the ISO code "US"), `banner` array, `avatar` sources, and
  a nullable `subscriberCount` (null when hidden) plus a nullable
  `hiddenSubscriberCount`.
- Channel-videos + `includeExtras=true`: 30 videos/page, ~11s for
  page 1. Descriptions, likes, comments, `publishDate`, `durationMs`
  all present (descriptions not needed here).
- SA video view counts match the public YouTube channel page exactly:
  1894 (shown "1.9K"), 540, 367, 667 on the four newest videos.
- One flake seen: a continuation fetch for page 2 returned 0 videos
  once (probe3), after an identical call had returned 30 (probe2).
  Bot Detector fetches one page only, so this does not affect it.

## What changed vs the YouTube path

- Comments per video: 25 -> 20 (one SA page; the heuristics only need
  10+ sampled comments). Comment video sample stays 5, video sample
  stays 20.
- Video set: SA channel-videos lists long-form uploads only (Phase C
  finding). On a Shorts-heavy channel the 20-video sample is the
  newest long-form videos, not the 20 newest uploads. Disclosed in
  every response via `coverageNote`.
- Channel join date parses to midnight UTC on the join day instead of
  an exact timestamp; growth velocity divides by whole days.
- Country is the display name ("United States") instead of the ISO
  code ("US"); the frontend only uppercases it into a chip.
- Cache key is now day-granular
  (`bot_detector::v1::<YYYY-MM-DD>::<input>`), same 15-minute TTL.
- No YouTube quota is consumed. `handleBotDetector` no longer checks
  `API_KEY` or quota; it gates on `isScrapeAtlasConfigured()` and
  answers `ScrapeAtlasError` with its own status/code (429 on
  `SA_RATE_LIMITED`), same pattern as `lib/tiktokHandlers.js`.
- A comments 404 maps to `disabled` for that video, matching the old
  `commentsDisabled` handling. Other SA comment failures propagate
  and fail the run with no charge.

## Parity evidence

- `tests/bot-detector-sa.test.js` feeds the same underlying numbers
  through the old YouTube shape and the new SA shape and asserts the
  full report is deeply equal, including overallScore, risk band, and
  every signal score/finding. An organic fixture scores low (< 20);
  a bot-like fixture (uniform views, 0.1% like rate, sub4sub spam
  comments) scores 40+ in a high/critical band.
- Handler test with mocked SA fetch asserts the response shape field
  for field (channel/video keys, `commentFetchStats`,
  `report.metadata`), `saCreditsUsed` 7, cached repeats free, 429
  fails soft with no access, and comments-404 is treated as disabled
  with the run still succeeding.
- Full suite: 179 tests pass.

## SA credit usage

- Verification probes this phase: ~20 SA calls (comments probes,
  channel/videos pages, paging flake re-checks). Negligible against
  the 50,000-credit grant.
- Per Bot Detector run after migration: 7 SA credits (~$0.0125 at the
  $89/50,000 Growth pack rate) against $0.36 of PromoFinder credit
  revenue at the 1-credit price. Margin stays above 95%.

## What could not be verified

- The live YouTube-API side-by-side was not run: the YT key in this
  VM returns 403 `PERMISSION_DENIED` on the Data API, and the SA key
  is only reachable through the sa.py surrogate (no node-side SA key
  in this environment). Parity therefore rests on the public-page
  count match and the identical-numbers test above, not on a live
  YT-API run of the old code.
- Comments-disabled behavior on SA (does a disabled-comments video
  return 403 `restricted_page`, an empty success, or something else?)
  was not probed live; only the 404 -> disabled mapping is tested.
- Live signed-in test still owed: run Bot Detector once signed in as
  David, confirm the report renders, the 1-credit deduction lands,
  and a cached repeat is free.
