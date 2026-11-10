# Phase C side-by-side: Scrape Atlas vs YouTube API (Nov 10, 2026)

Decision record for the Phase C migration (Analyze, Compare, Saturation,
Collab). Live data, two channels: `@boyandascanner` and `@DavidJWoodbury`.

## Verdict

- **Collab: MIGRATED** to Scrape Atlas (`api/collab.js`, tests in
  `tests/collab-sa.test.js`).
- **Analyze, Compare, Saturation: KEPT on the YouTube Data API.** The SA
  data path is materially worse for them (see below). Do not retry the
  migration for these three until SA descriptions carry full URLs.

## Endpoint behavior verified live (sa.py, Nov 10 2026)

- `youtube/channel-videos`, no extras: 30 videos/page, ~5s, but
  **descriptions are absent entirely** (0/30), no likes, no
  `publishDate`, no `durationMs`. View counts and `lengthSeconds` are
  present. Useless for description tools.
- `youtube/channel-videos` + `includeExtras=true`: 30 videos/page,
  **all 30 carry descriptions** (median ~2,340 chars, max ~5,000),
  likes, comments, `publishDate`, `durationMs`. No `items_truncated`
  warning: the 48-enrichment cap does not bind at the 30-item page
  size. Latency 12-21s per page (first page ~12s, later pages ~19-21s).
- `extrasDetail=player`: 18.7s, same descriptions, comments null. No
  speed win over full extras. Not used.
- `limit=100`: HTTP 400 `invalid_request`. There is no page-size
  parameter; pages are 30 items (YouTube's own tab page size).
- Date windows do NOT shard (Phase B finding re-verified): a
  `since=2026-03-01&until=2026-06-01` call returned **0 videos** on
  page 1 with a continuation token: the call starts at the newest
  video and filters while paging. Parallel windows would re-walk the
  same videos. Paging is sequential continuation tokens only.
- `sort=popular` returns `sort_unavailable` and falls back to latest
  (Phase B). Not used.
- `youtube/channel`: ~4-6s per call; 5 parallel calls took 13.5s
  total. A 404 for an unknown handle took 13.2s to return.
- `youtube/video` for one video: ~4s. Its `description` is truncated
  the same way (below), but it carries a `descriptionLinks` array
  with the FULL URLs.

## The blocking finding: SA descriptions truncate long URLs

Every URL longer than ~35 characters in an SA description is rendered
truncated to 38 characters plus a literal `...`, e.g.:

- `http://info.uniden.com/twiki/bin/view...` (full:
  `.../view/UnidenMan4/SDS150FirmwareUpdate`)
- `https://www.boyandascanner.com/progra...` (full:
  `.../program-my-county.html` and `.../program-my-region-australia.html`
  collapse to the SAME truncated string)
- `https://archive.org/details/american-...` (22 occurrences under one
  truncated key)

Verified on 48 of 89 shared videos (@boyandascanner). Median
description length differs by only 14 chars, 38/89 descriptions are
byte-identical, so the truncation is confined to long URLs, but it is
exactly the field these tools sell:

- **Analyze / Compare**: promotion records are keyed by URL, so the
  response would carry broken truncated links, and distinct links that
  share a 38-character prefix merge into one record (e.g. all
  `radioreference.com/db/sid/*` pages become one `.../db/sid` record).
  Full URLs exist only in per-video `youtube/video` `descriptionLinks`
  (1 credit + ~4s per video): infeasible inside a 60s function for
  90 videos. Linkcheck mode would also false-positive every long URL
  as broken, so it stays on the YouTube API too.
- **Saturation**: its response carries domains only (no full URLs),
  so truncation alone would not break it. What breaks it is the video
  set (below): on @boyandascanner SA-90 says **90.0% grade F** vs the
  YouTube API full 12 months **66.0% grade D** (and 74.4% grade D on
  the newest 90 uploads). The monthly breakdown drops from 11 months
  to 5 scattered months, so the trend analysis is unreliable. The
  current tool costs only ~8 YT units/run, so the quota win does not
  justify a grade flip.
- **Collab**: unaffected. It extracts `@mentions`, never URLs, and the
  mention sets matched the YouTube API on **102 of 102** shared
  videos (89 BAAS + 13 DJW).

## Video-set difference: SA lists long-form only

- @boyandascanner: SA-90 vs YT 12-month set (156 videos) overlap
  89/90. One SA-only video is members-only (`YPWT7jPXgxs`, "The
  SDS150 Masterclass"), which the public YouTube API uploads playlist
  does not return.
- @DavidJWoodbury (Shorts-heavy): SA-60 vs YT newest 100 overlap
  only **13/60**. The uploads playlist is dominated by Shorts with
  empty descriptions; SA channel-videos lists long-form videos only.
  For sponsor/mention finding the SA set is arguably better (DJW
  SA-60 found 2 distinct mentions vs YT-60's 1), but it is a
  different set, and for Analyze it would silently change what "last
  90 videos" means.
- SA `publishDate` values agree exactly with YouTube `publishedAt`
  where both exist. The June 2026 cluster (23 videos) inside SA-90
  is a real publishing burst, not a date error.

## Coverage reality inside a 60s function

Sequential extras paging at ~20s/page fits **2 pages (~60 videos)**
reliably in the 55s deadline guard, occasionally 3 (~90). The old
caps (Analyze 1,200 videos / 12 months, Compare 500/channel,
Saturation 200, Collab 100) are unreachable on SA in one run. Collab
is the only tool whose cap (100) is close to what SA can deliver, and
its coverage shortfall is disclosed in the response (`coverageNote`).

## SA credit usage (verified live)

- SA calls spent on this verification: ~25 (probes + side-by-side
  fetches + parallel-call test). Balance impact is negligible against
  the 50,000-credit grant.
- Collab per run after migration: 1 channel record + 2-3 video pages
  + 1 per successfully resolved mention (max 20) = typically 4-8,
  worst case ~24. Old cost: up to ~2,000 YT units.
- Analyze / Compare / Saturation per-run YT cost today is small
  (resolve is already SA-first): ~50 / ~100 / ~8 units. That is why
  keeping them on the YouTube API costs little and loses nothing.
