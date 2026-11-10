import {
  setCache,
  getCache,
  parseChannelIdFromUrl,
  applyApiGuards,
  handleApiError,
  extractUrls,
  domainFromUrl,
  SOCIAL_MEDIA_FILTER,
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
  collectSaWarnings
} from "../lib/scrapeAtlas.js";

// Rate on Scrape Atlas (replaces the YouTube Data API version, which
// burned shared daily quota on every run). Cost: 1 SA credit for the
// channel record + 1 per channel-videos page, max 2 pages per run.
// The videos page needs includeExtras=true: niche detection reads
// descriptions, sponsorship detection reads description links, and the
// engagement rate needs like/comment counts. Extras are slow upstream
// (about 15s for a 30-video page: two reads per video), so this function
// runs with maxDuration 60 and a global deadline guard: a second page
// is only started while enough budget remains. No YouTube quota is
// consumed. CPM table and rate formula are unchanged.
// The UI contract is unchanged (same fields as before). Extra fields
// (fetchedAt, descriptionCoverage, coverageNote, coverageWarnings,
// saCreditsUsed) are additive only.

export const config = { maxDuration: 60 };

// Vercel Hobby functions time out at the maxDuration above; stop paging
// with time to spare and return what was found so far instead of
// failing the request.
const GLOBAL_DEADLINE_MS = 55000;
const MAX_PAGES = 2;
const MAX_VIDEOS = 60;
const PAGE_TIMEOUT_MS = 40000;
const MIN_REMAINING_FOR_NEXT_PAGE_MS = 12000;

// CPM estimates by niche (USD per 1000 views)
const NICHE_CPM = {
  tech: { low: 15, high: 30, avg: 22 },
  gaming: { low: 8, high: 20, avg: 14 },
  finance: { low: 20, high: 50, avg: 35 },
  beauty: { low: 10, high: 25, avg: 17 },
  fitness: { low: 12, high: 28, avg: 20 },
  education: { low: 8, high: 20, avg: 14 },
  lifestyle: { low: 5, high: 18, avg: 12 },
  food: { low: 6, high: 16, avg: 11 },
  travel: { low: 10, high: 25, avg: 17 },
  entertainment: { low: 5, high: 15, avg: 10 },
  default: { low: 8, high: 20, avg: 14 }
};

// Sponsorship rate multipliers based on engagement
const RATE_MULTIPLIERS = {
  micro: { min: 1000, max: 10000, multiplier: 0.03 },      // $30-300 per 10k views
  small: { min: 10000, max: 100000, multiplier: 0.025 },   // $250-2500 per 100k views
  medium: { min: 100000, max: 500000, multiplier: 0.02 },  // $2k-10k per 500k views
  large: { min: 500000, max: 1000000, multiplier: 0.018 }, // $9k-18k per 1M views
  mega: { min: 1000000, max: Infinity, multiplier: 0.015 } // $15k+ per 1M views
};

function detectNiche(videos) {
  const keywords = {
    tech: /\b(tech|phone|laptop|computer|app|software|gadget|review|unbox|setup|iphone|android|mac|windows|coding|programming)\b/i,
    gaming: /\b(game|gaming|playthrough|walkthrough|stream|twitch|fps|mmorpg|esports|minecraft|fortnite|cod|gta)\b/i,
    finance: /\b(money|invest|stock|crypto|bitcoin|finance|budget|wealth|passive income|side hustle|business)\b/i,
    beauty: /\b(makeup|skincare|beauty|cosmetic|tutorial|foundation|lipstick|eyeshadow|routine|grwm)\b/i,
    fitness: /\b(workout|fitness|gym|exercise|weight|muscle|diet|nutrition|health|training|cardio|yoga)\b/i,
    education: /\b(learn|tutorial|course|how to|explained|education|study|lesson|teach|guide)\b/i,
    lifestyle: /\b(vlog|day in|routine|haul|lifestyle|room tour|apartment|morning|night|life)\b/i,
    food: /\b(recipe|cook|food|meal|restaurant|eat|taste|kitchen|chef|baking|mukbang)\b/i,
    travel: /\b(travel|trip|vacation|hotel|flight|destination|explore|adventure|tour|country)\b/i,
    entertainment: /\b(funny|comedy|prank|challenge|react|reaction|entertainment|skit|parody)\b/i
  };

  const scores = {};
  for (const [niche, regex] of Object.entries(keywords)) {
    scores[niche] = 0;
  }

  for (const v of videos) {
    const text = `${v.title} ${v.description || ''}`.toLowerCase();
    for (const [niche, regex] of Object.entries(keywords)) {
      const matches = text.match(regex);
      if (matches) scores[niche] += matches.length;
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'default';
}

function hasSponsorship(description) {
  if (!description) return false;
  const urls = extractUrls(description);
  for (const url of urls) {
    const dom = domainFromUrl(url);
    if (!SOCIAL_MEDIA_FILTER.test(dom)) {
      return true;
    }
  }
  return false;
}

function getTierInfo(avgViews) {
  for (const [tier, info] of Object.entries(RATE_MULTIPLIERS)) {
    if (avgViews >= info.min && avgViews < info.max) {
      return { tier, ...info };
    }
  }
  return { tier: 'micro', ...RATE_MULTIPLIERS.micro };
}

function formatCurrency(amount) {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  return `$${Math.round(amount)}`;
}

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "rate", maxRequests: 10, windowMs: 60_000 })) return;

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

    // Sign-in wall: every tool requires a Google account. David, Nov 2 2026.
    // Access state is kept so a successful run can deduct credits below.
    const accessState = await getToolAccessState(req, "rate");
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    // Day-granular window so the cache key is stable within a day (the
    // old code keyed on a millisecond timestamp, so the cache never hit).
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    sinceDate.setUTCHours(0, 0, 0, 0);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `rate::${input}::${sinceISO}`;
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
    // One SA call resolves the handle AND returns the channel record.
    const channel = await fetchSaChannel(spec, input, "rate");
    const channelId = channel.channelId;

    // Fetch recent videos with extras: descriptions (niche + sponsorship
    // detection) and like/comment counts (engagement rate). At most two
    // 30-video pages; a second page only starts while the global
    // deadline leaves room for it to finish.
    const videos = [];
    const coverageWarnings = [];
    let fetchedAt = channel.fetchedAt || "";
    let withDescription = 0;
    let withStats = 0;
    let pagesFetched = 0;
    let continuationToken = undefined;
    let deadlineHit = false;
    collectSaWarnings(channel, coverageWarnings);

    while (videos.length < MAX_VIDEOS && pagesFetched < MAX_PAGES) {
      const elapsed = Date.now() - startedAt;
      const remainingMs = GLOBAL_DEADLINE_MS - elapsed;
      if (pagesFetched > 0 && remainingMs < MIN_REMAINING_FOR_NEXT_PAGE_MS) {
        deadlineHit = true;
        break;
      }

      const data = await saGet("/v1/youtube/channel-videos", {
        tool: "rate",
        timeoutMs: Math.min(PAGE_TIMEOUT_MS, Math.max(remainingMs, 1000)),
        params: {
          channelId,
          sort: "latest",
          since: sinceISO,
          includeExtras: true,
          ...(continuationToken ? { continuationToken } : {})
        }
      });
      pagesFetched++;

      if (data?.fetchedAt) fetchedAt = data.fetchedAt;
      collectSaWarnings(data, coverageWarnings);

      const items = Array.isArray(data?.videos) ? data.videos : [];
      for (const item of items) {
        if (item?.type && item.type !== "video") continue;
        // Extras are incomplete for some videos (only the first 48 per
        // page are enriched): those keep a null description and null
        // like/comment counts, counted below and disclosed, never
        // treated as a video with no description or no engagement.
        if (item?.description !== null && item?.description !== undefined) withDescription++;
        if (item?.likeCountInt !== null && item?.likeCountInt !== undefined) withStats++;
        videos.push(mapSaChannelVideo(item));
        if (videos.length >= MAX_VIDEOS) break;
      }

      continuationToken = data?.continuationToken || undefined;
      if (!continuationToken) break;
    }

    if (!videos.length) {
      return res.status(400).json({ error: "No videos found in the last year." });
    }

    // Separate sponsored vs non-sponsored videos
    const sponsoredVideos = videos.filter(v => hasSponsorship(v.description));
    const nonSponsoredVideos = videos.filter(v => !hasSponsorship(v.description));

    // Calculate metrics
    const totalViews = videos.reduce((sum, v) => sum + v.viewCount, 0);
    const avgViews = Math.round(totalViews / videos.length);
    const medianViews = videos.length > 0
      ? videos.map(v => v.viewCount).sort((a, b) => a - b)[Math.floor(videos.length / 2)]
      : 0;

    const sponsoredAvgViews = sponsoredVideos.length > 0
      ? Math.round(sponsoredVideos.reduce((sum, v) => sum + v.viewCount, 0) / sponsoredVideos.length)
      : 0;

    const nonSponsoredAvgViews = nonSponsoredVideos.length > 0
      ? Math.round(nonSponsoredVideos.reduce((sum, v) => sum + v.viewCount, 0) / nonSponsoredVideos.length)
      : 0;

    // Detect niche and get CPM rates
    const niche = detectNiche(videos);
    const cpmRates = NICHE_CPM[niche] || NICHE_CPM.default;

    // Get tier info
    const tierInfo = getTierInfo(avgViews);

    // Calculate estimated sponsorship rates
    // Formula: (Average Views / 1000) * CPM * Tier Multiplier * 10 (sponsorship premium)
    const baseRate = (avgViews / 1000) * cpmRates.avg;
    const sponsorshipMultiplier = 10; // Sponsors typically pay 10x CPM

    const estimatedRateLow = Math.round(baseRate * sponsorshipMultiplier * 0.5);
    const estimatedRateHigh = Math.round(baseRate * sponsorshipMultiplier * 1.5);
    const estimatedRateAvg = Math.round(baseRate * sponsorshipMultiplier);

    // Calculate engagement rate
    const totalEngagement = videos.reduce((sum, v) => sum + v.likeCount + v.commentCount, 0);
    const engagementRate = totalViews > 0 ? ((totalEngagement / totalViews) * 100).toFixed(2) : 0;

    // Performance comparison (sponsored vs non-sponsored)
    const viewDifference = sponsoredVideos.length > 0 && nonSponsoredVideos.length > 0
      ? ((sponsoredAvgViews - nonSponsoredAvgViews) / nonSponsoredAvgViews * 100).toFixed(1)
      : null;

    // Top performing sponsored videos
    const topSponsored = sponsoredVideos
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 5)
      .map(v => ({
        videoId: v.videoId,
        title: v.title,
        viewCount: v.viewCount,
        publishedAt: v.publishedAt
      }));

    const notes = [];
    if (withDescription < videos.length) {
      notes.push(
        `Descriptions were available for ${withDescription} of ${videos.length} videos; ` +
        `videos without one were not counted as sponsored and added no niche signal.`
      );
    }
    if (withStats < videos.length) {
      notes.push(
        `Like and comment counts were available for ${withStats} of ${videos.length} videos; ` +
        `videos without counts add nothing to engagement, so the engagement rate may read low.`
      );
    }
    if (deadlineHit) {
      notes.push(
        "Video collection stopped early to stay within the response time limit; " +
        `the estimate is based on the ${videos.length} most recent videos found.`
      );
    } else if (continuationToken && videos.length >= MAX_VIDEOS) {
      notes.push(
        `The estimate is based on the ${videos.length} most recent videos from the last 12 months.`
      );
    }
    if (coverageWarnings.length) {
      notes.push(`Data source notes: ${coverageWarnings.join("; ")}`);
    }

    const payload = {
      channelId,
      sinceISO,
      videoCount: videos.length,

      // Niche detection
      detectedNiche: niche,
      nicheCPM: cpmRates,

      // View metrics
      metrics: {
        totalViews,
        averageViews: avgViews,
        medianViews,
        engagementRate: parseFloat(engagementRate)
      },

      // Tier classification
      tier: {
        name: tierInfo.tier,
        description: getTierDescription(tierInfo.tier)
      },

      // Sponsorship analysis
      sponsorshipAnalysis: {
        sponsoredVideoCount: sponsoredVideos.length,
        nonSponsoredVideoCount: nonSponsoredVideos.length,
        sponsoredAvgViews,
        nonSponsoredAvgViews,
        viewDifferencePercent: viewDifference ? parseFloat(viewDifference) : null,
        topSponsoredVideos: topSponsored
      },

      // Rate estimates
      estimatedRates: {
        perVideo: {
          low: estimatedRateLow,
          average: estimatedRateAvg,
          high: estimatedRateHigh,
          formatted: {
            low: formatCurrency(estimatedRateLow),
            average: formatCurrency(estimatedRateAvg),
            high: formatCurrency(estimatedRateHigh)
          }
        },
        per1000Views: {
          low: cpmRates.low * sponsorshipMultiplier,
          average: cpmRates.avg * sponsorshipMultiplier,
          high: cpmRates.high * sponsorshipMultiplier
        }
      },

      fetchedAt,
      descriptionCoverage: { withDescription, withStats, total: videos.length },
      coverageNote: notes.length ? notes.join(" ") : null,
      coverageWarnings,
      saCreditsUsed: 1 + pagesFetched,

      disclaimer: "These are estimates based on industry averages. Actual rates vary based on niche, engagement, audience demographics, relationship with brand, and negotiation."
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

function getTierDescription(tier) {
  const descriptions = {
    micro: "Micro Influencer (1K-10K avg views)",
    small: "Small Creator (10K-100K avg views)",
    medium: "Medium Creator (100K-500K avg views)",
    large: "Large Creator (500K-1M avg views)",
    mega: "Mega Influencer (1M+ avg views)"
  };
  return descriptions[tier] || descriptions.micro;
}
