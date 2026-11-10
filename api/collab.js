import {
  setCache,
  getCache,
  parseChannelIdFromUrl,
  applyApiGuards,
  handleApiError,
  validateChannelInput
} from "../utils.js";
import {
  buildPaymentRequiredResponse,
  finalizeToolAccess,
  getToolAccessState
} from "../lib/credits.js";
import {
  isScrapeAtlasConfigured,
  fetchSaChannel,
  fetchSaLatestVideosForChannel,
  saChannelAvatarUrl,
  saNumber
} from "../lib/scrapeAtlas.js";

// Collab finder on Scrape Atlas (replaces the YouTube Data API version,
// which burned ~100 shared quota units per mention resolve via
// search.list: "can use 2000+ units" for 20 mentions).
//
// Data path: youtube/channel-videos with includeExtras=true for the
// descriptions, then youtube/channel once per distinct mention to
// resolve it. Resolving a mention drops from 100 YT units to 1 SA
// credit, so the 2,000-unit tool becomes a ~25-credit tool at most
// (1 channel record + up to 3 video pages + up to 20 resolves; most
// channels have only a handful of distinct mentions, so a typical run
// is 4-8 SA credits).
//
// Why Collab migrates but Analyze / Compare / Saturation do not
// (side-by-side check, Nov 10 2026, @boyandascanner + @DavidJWoodbury):
// SA channel-videos descriptions truncate every URL longer than ~35
// characters to 38 characters plus "..." (verified on 48 of 89 shared
// videos, e.g. the SDS150 firmware link and program-my-county links),
// so Analyze / Compare would return broken promotion URLs and merge
// distinct links that share a 38-character prefix. Collab does not
// read URLs at all: it extracts @mentions, and the mention sets from
// SA descriptions matched the YouTube API descriptions on 102 of 102
// shared videos. The only Collab difference is the video set itself:
// SA lists long-form videos only, while the old uploads playlist
// mixed in Shorts (whose descriptions are usually empty). On the
// Shorts-heavy test channel the SA set found MORE mentions, not
// fewer. Video counts are disclosed in the coverage note below.
//
// Paging: sequential continuation paging with extras, same helper as
// viral/predictor. An extras page takes ~20s upstream, so the video
// walk is capped by a 40s deadline (leaving room for the mention
// resolves inside the 60s function limit): realistically 2 pages,
// ~60 videos. No date window, matching the old tool, which analyzed
// the 100 most recent uploads regardless of age. Resolves run in one
// concurrent batch: a single slow or missing channel must not stall
// the run, and an unresolvable mention is skipped exactly as the old
// code skipped it (and counted in the coverage note).
//
// No YouTube quota is consumed. The response shape, the mention
// extraction regex and the price (2 credits) are unchanged. Extra
// fields (fetchedAt, videoCoverage, coverageNote, coverageWarnings,
// saCreditsUsed) are additive only.

export const config = { maxDuration: 60 };

const COLLAB_MAX_VIDEOS = 100;
const COLLAB_MAX_PAGES = 3;
const COLLAB_VIDEO_DEADLINE_MS = 40000;
const COLLAB_MAX_MENTIONS = 20;

function extractChannelMentions(text) {
  const mentions = new Set();

  // Match @handles
  const handleMatches = text.match(/@[\w\.-]+/g) || [];
  handleMatches.forEach(h => mentions.add(h));

  // Match youtube.com/@handle
  const handleUrlMatches = text.match(/youtube\.com\/@([\w\.-]+)/gi) || [];
  handleUrlMatches.forEach(url => {
    const match = url.match(/@([\w\.-]+)/);
    if (match) mentions.add(`@${match[1]}`);
  });

  // Match youtube.com/channel/UC...
  const channelIdMatches = text.match(/youtube\.com\/channel\/(UC[\w-]+)/gi) || [];
  channelIdMatches.forEach(url => {
    const match = url.match(/channel\/(UC[\w-]+)/i);
    if (match) mentions.add(match[1]);
  });

  // Match youtube.com/c/CustomName
  const customMatches = text.match(/youtube\.com\/c\/([\w\.-]+)/gi) || [];
  customMatches.forEach(url => {
    const match = url.match(/\/c\/([\w\.-]+)/i);
    if (match) mentions.add(match[1]);
  });

  return Array.from(mentions);
}

/**
 * Map a mention onto a youtube/channel query spec. fetchSaChannel
 * turns these into channelId / handle / url params; a bare custom
 * name goes through the /c/ URL form.
 */
function mentionSpec(mention) {
  if (/^UC[\w-]+$/.test(mention)) return { type: "channelId", value: mention };
  if (mention.startsWith("@")) return { type: "handle", value: mention };
  return { type: "custom", value: mention };
}

/**
 * Resolve one mention to channel info via Scrape Atlas (1 credit).
 * Returns null when the channel cannot be resolved, exactly as the
 * old YouTube-API resolver returned null; the caller skips it.
 */
async function resolveSaChannelInfo(mention) {
  try {
    const spec = mentionSpec(mention);
    const body = await fetchSaChannel(spec, mention, "collab");
    return {
      channelId: body.channelId,
      title: body.name || "Unknown",
      handle: body.handle || null,
      thumbnail: saChannelAvatarUrl(body),
      subscriberCount: saNumber(body.subscriberCount)
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "collab", maxRequests: 8, windowMs: 60_000 })) return;

  const startedAt = Date.now();

  try {
    const rawInput = (req.query.url || "").toString();
    const validation = validateChannelInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid input." });
    }
    const input = validation.sanitized;

    if (!isScrapeAtlasConfigured()) {
      return res.status(500).json({ error: "Scrape Atlas is not configured on this site yet." });
    }

    const accessState = await getToolAccessState(req, 'collab');
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    const cacheKey = `collab::${input}`;
    const cached = getCache(cacheKey);
    if (cached) {
      const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: false });
      if (!finalized.ok) {
        return res.status(402).json(finalized.payload);
      }
      return res.json({ fromCache: true, ...cached, access: finalized.access });
    }

    const spec = parseChannelIdFromUrl(input);
    // One SA call resolves the handle AND returns the channel record;
    // the newest long-form videos with extras arrive in parallel (see
    // fetchSaLatestVideosForChannel in lib/scrapeAtlas.js). No date
    // window: the old tool analyzed the 100 most recent uploads
    // regardless of age, and this keeps that behavior.
    const collected = await fetchSaLatestVideosForChannel({
      tool: "collab",
      spec,
      input,
      sinceISO: undefined,
      maxVideos: COLLAB_MAX_VIDEOS,
      maxPages: COLLAB_MAX_PAGES,
      startedAt,
      deadlineMs: COLLAB_VIDEO_DEADLINE_MS
    });
    const channelId = collected.channelId;

    const videos = collected.videos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      description: v.description,
      publishedAt: v.publishedAt
    }));

    // Extract all channel mentions
    const mentionCounts = {};
    const videosByMention = {};

    for (const video of videos) {
      const mentions = extractChannelMentions(video.description);

      for (const mention of mentions) {
        mentionCounts[mention] = (mentionCounts[mention] || 0) + 1;

        if (!videosByMention[mention]) {
          videosByMention[mention] = [];
        }
        videosByMention[mention].push({
          videoId: video.videoId,
          title: video.title,
          publishedAt: video.publishedAt
        });
      }
    }

    // Resolve channel information for top mentions, all at once: the
    // resolves are independent, and a sequential walk would take ~5s
    // per mention. One slow or missing channel resolves to null and
    // is skipped, as before.
    const collaborations = [];
    const sortedMentions = Object.entries(mentionCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, COLLAB_MAX_MENTIONS); // Top 20 most mentioned

    const resolved = await Promise.all(
      sortedMentions.map(async ([mention]) => ({
        mention,
        channelInfo: await resolveSaChannelInfo(mention)
      }))
    );
    let unresolvedMentions = 0;
    let resolvedCount = 0;
    for (const { mention, channelInfo } of resolved) {
      if (!channelInfo) {
        unresolvedMentions += 1;
        continue;
      }
      resolvedCount += 1;
      collaborations.push({
        ...channelInfo,
        mentionCount: mentionCounts[mention],
        videos: videosByMention[mention].slice(0, 5) // Show up to 5 videos
      });
    }

    const notes = [];
    if (collected.deadlineHit) {
      notes.push(
        "Video collection stopped early to stay within the response time limit; " +
        `the analysis is based on the ${videos.length} most recent long-form videos found.`
      );
    } else if (collected.hasMore) {
      notes.push(
        `Based on the ${videos.length} most recent long-form videos; ` +
        `older videos were not included in this run.`
      );
    } else if (videos.length > 0 && videos.length < COLLAB_MAX_VIDEOS) {
      notes.push(
        `Based on the ${videos.length} most recent long-form videos found.`
      );
    }
    if (collected.withDescription < videos.length) {
      notes.push(
        `Descriptions were available for ${collected.withDescription} of ${videos.length} videos; ` +
        `videos without one cannot carry mentions.`
      );
    }
    if (unresolvedMentions > 0) {
      notes.push(
        `${unresolvedMentions} mentioned channel${unresolvedMentions === 1 ? "" : "s"} ` +
        `could not be resolved and ${unresolvedMentions === 1 ? "is" : "are"} not listed.`
      );
    }
    if (collected.coverageWarnings.length) {
      notes.push(`Data source notes: ${collected.coverageWarnings.join("; ")}`);
    }

    // Failed resolves cost 0 SA credits (only successful requests are
    // billed), so only successful resolves count toward the total.
    const saCreditsUsed = collected.saCreditsUsed + resolvedCount;

    const payload = {
      channelId,
      videosAnalyzed: videos.length,
      collaborations,
      fetchedAt: collected.fetchedAt,
      videoCoverage: {
        withDescription: collected.withDescription,
        total: videos.length
      },
      coverageNote: notes.length ? notes.join(" ") : null,
      coverageWarnings: collected.coverageWarnings,
      saCreditsUsed
    };

    setCache(cacheKey, payload);
    const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: true });
    if (!finalized.ok) {
      return res.status(402).json(finalized.payload);
    }
    return res.json({ ...payload, access: finalized.access });
  } catch (err) {
    // Any Scrape Atlas failure lands here: the user is charged nothing
    // (finalizeToolAccess is never reached) and no partial result is
    // presented as complete.
    return handleApiError(res, err);
  }
}
