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
  saGet,
  fetchSaChannel,
  mapSaChannelVideo,
  parseSaJoinedDate,
  collectSaWarnings,
  saNumber
} from "../lib/scrapeAtlas.js";

// Growth on Scrape Atlas (replaces the YouTube Data API version, which
// burned shared daily quota on every run). Cost: 1 SA credit for the
// channel record + 1 per channel-videos page, max 2 pages per run.
// Channel-videos is fetched WITHOUT includeExtras: growth only needs
// video id, title and publish date, and the no-extras page answers in
// about a second (an extras page takes 15s+ upstream and would blow the
// 10s function budget). No YouTube quota is consumed.
// The UI contract is unchanged: { channelId, stats: { subscriberCount,
// videoCount, viewCount, publishedAt }, uploadPattern, recentVideos:
// [{ videoId, title, description, publishedAt }] }. Extra fields
// (fetchedAt, coverageNote, coverageWarnings, saCreditsUsed) are
// additive only.

const MAX_VIDEOS = 50;
const MAX_PAGES = 2;
const PER_CALL_TIMEOUT_MS = 8000;

function analyzeUploadPattern(videos) {
  if (!videos.length) {
    return {
      averageFrequency: "No data",
      mostCommonDay: "No data",
      latestUpload: "No data",
      dayDistribution: {}
    };
  }

  // Calculate day distribution
  const dayDistribution = {};
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  videos.forEach(v => {
    const date = new Date(v.publishedAt);
    const day = date.getDay();
    dayDistribution[day] = (dayDistribution[day] || 0) + 1;
  });

  // Find most common day
  let maxCount = 0;
  let mostCommonDay = 'Various';
  Object.entries(dayDistribution).forEach(([day, count]) => {
    if (count > maxCount) {
      maxCount = count;
      mostCommonDay = dayNames[parseInt(day)];
    }
  });

  // Calculate average frequency
  const dates = videos.map(v => new Date(v.publishedAt)).sort((a, b) => b - a);
  const daysBetween = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const diff = Math.abs(dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24);
    daysBetween.push(diff);
  }

  const avgDays = daysBetween.length ? daysBetween.reduce((a, b) => a + b, 0) / daysBetween.length : 0;
  let averageFrequency = "Unknown";
  if (avgDays < 1) averageFrequency = "Multiple times daily";
  else if (avgDays < 2) averageFrequency = "Daily";
  else if (avgDays < 4) averageFrequency = "Every 2-3 days";
  else if (avgDays < 8) averageFrequency = "Weekly";
  else if (avgDays < 15) averageFrequency = "Every 1-2 weeks";
  else if (avgDays < 32) averageFrequency = "Monthly";
  else averageFrequency = "Infrequent";

  // Latest upload
  const latest = dates[0];
  const daysAgo = Math.floor((Date.now() - latest) / (1000 * 60 * 60 * 24));
  let latestUpload = "Unknown";
  if (daysAgo === 0) latestUpload = "Today";
  else if (daysAgo === 1) latestUpload = "Yesterday";
  else if (daysAgo < 7) latestUpload = `${daysAgo} days ago`;
  else if (daysAgo < 30) latestUpload = `${Math.floor(daysAgo / 7)} weeks ago`;
  else latestUpload = `${Math.floor(daysAgo / 30)} months ago`;

  return {
    averageFrequency,
    mostCommonDay,
    latestUpload,
    dayDistribution
  };
}

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "growth", maxRequests: 12, windowMs: 60_000 })) return;

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

    // Sign-in wall: every tool requires a Google account. David, Nov 2 2026.
    // Access state is kept so a successful run can deduct credits below.
    const accessState = await getToolAccessState(req, "growth");
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    const cacheKey = `growth::${input}`;
    const cached = getCache(cacheKey);
    if (cached) {
      // Cached repeat: same result, no charge (mirrors api/unlisted.js).
      const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: false });
      if (!finalized.ok) {
        return res.status(402).json(finalized.payload);
      }
      return res.json({ fromCache: true, ...cached, access: finalized.access });
    }

    const spec = parseChannelIdFromUrl(input);
    // One SA call resolves the handle AND returns the channel stats.
    const channel = await fetchSaChannel(spec, input, "growth");
    const channelId = channel.channelId;

    const stats = {
      subscriberCount: saNumber(channel.subscriberCount),
      videoCount: saNumber(channel.videoCount),
      viewCount: saNumber(channel.viewCount),
      publishedAt: parseSaJoinedDate(channel.joinedDateText)
    };

    // Latest 50 videos, newest first (same snapshot the YouTube version
    // built from the uploads playlist). No extras: only id, title and
    // publish date are needed here.
    const recentVideos = [];
    const coverageWarnings = [];
    let fetchedAt = channel.fetchedAt || "";
    let pagesFetched = 0;
    let continuationToken = undefined;
    collectSaWarnings(channel, coverageWarnings);

    while (recentVideos.length < MAX_VIDEOS && pagesFetched < MAX_PAGES) {
      const data = await saGet("/v1/youtube/channel-videos", {
        tool: "growth",
        timeoutMs: PER_CALL_TIMEOUT_MS,
        params: {
          channelId,
          sort: "latest",
          ...(continuationToken ? { continuationToken } : {})
        }
      });
      pagesFetched++;

      if (data?.fetchedAt) fetchedAt = data.fetchedAt;
      collectSaWarnings(data, coverageWarnings);

      const videos = Array.isArray(data?.videos) ? data.videos : [];
      for (const video of videos) {
        // Skip Shorts/live shelves: only long-form videos carry the
        // upload cadence the pattern analysis measures.
        if (video?.type && video.type !== "video") continue;
        const mapped = mapSaChannelVideo(video);
        recentVideos.push({
          videoId: mapped.videoId,
          title: mapped.title,
          description: mapped.description,
          publishedAt: mapped.publishedAt
        });
        if (recentVideos.length >= MAX_VIDEOS) break;
      }

      continuationToken = data?.continuationToken || undefined;
      if (!continuationToken) break;
    }

    // Analyze upload patterns
    const uploadPattern = analyzeUploadPattern(recentVideos);

    const notes = [];
    if (stats.publishedAt === null) {
      notes.push("The channel creation date was not available from the data source.");
    }
    if (coverageWarnings.length) {
      notes.push(`Data source notes: ${coverageWarnings.join("; ")}`);
    }

    const payload = {
      channelId,
      stats,
      uploadPattern,
      recentVideos,
      fetchedAt,
      coverageNote: notes.length ? notes.join(" ") : null,
      coverageWarnings,
      saCreditsUsed: 1 + pagesFetched
    };

    setCache(cacheKey, payload);
    // Charge only after a successful run (mirrors api/unlisted.js).
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
