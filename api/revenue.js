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
  fetchSaLatestVideosForChannel,
  saChannelAvatarUrl,
  collectSaWarnings,
  saNumber
} from "../lib/scrapeAtlas.js";

// Revenue on Scrape Atlas (replaces the YouTube Data API version, which
// burned shared daily quota on every run). Cost: 1-4 SA credits per run
// (1 channel call + 1-3 channel-videos pages with extras). No YouTube
// quota is consumed.
//
// The yearly estimate, monthly breakdown, view trends and top-earning
// videos are all built from the last 12 months of per-video views
// (up to 200 videos), same as the pre-migration YouTube version: the
// yearly figure is the sum the monthly breakdown is built from, and
// the top videos are the 10 highest-viewed in the window. Niche
// detection reads the fetched video titles and descriptions. CPM table,
// monetization rate and revenue formulas are unchanged.
// The UI contract keeps every field the frontend expects. Extra fields
// (fetchedAt, coverageNote, coverageWarnings, saCreditsUsed) are
// additive only.

// An extras page takes about 15s upstream, so this function runs with
// maxDuration 60 and the helper's 55s deadline guard (same pattern as
// api/viral.js and api/rate.js).
export const config = { maxDuration: 60 };

// Ad revenue CPM estimates by niche (USD per 1000 views)
// These are estimated YouTube ad revenue rates (after YT's 45% cut)
const AD_CPM_BY_NICHE = {
  tech: { low: 2.50, avg: 4.00, high: 7.00 },
  gaming: { low: 1.50, avg: 3.00, high: 5.00 },
  finance: { low: 5.00, avg: 8.00, high: 15.00 },
  beauty: { low: 2.00, avg: 3.50, high: 6.00 },
  fitness: { low: 2.00, avg: 4.00, high: 7.00 },
  education: { low: 2.00, avg: 4.00, high: 8.00 },
  lifestyle: { low: 1.50, avg: 3.00, high: 5.00 },
  food: { low: 1.50, avg: 3.00, high: 5.50 },
  travel: { low: 2.00, avg: 4.00, high: 7.00 },
  entertainment: { low: 1.00, avg: 2.50, high: 4.50 },
  news: { low: 2.00, avg: 3.50, high: 6.00 },
  music: { low: 0.80, avg: 1.50, high: 3.00 },
  default: { low: 1.50, avg: 3.00, high: 5.00 }
};

// Monetization rate (% of views that are monetized - not all views show ads)
const MONETIZATION_RATE = 0.65; // ~65% of views typically see ads

function detectNiche(videos) {
  const keywords = {
    tech: /\b(tech|phone|laptop|computer|app|software|gadget|review|unbox|setup|iphone|android|mac|windows|coding|programming|ai|artificial intelligence)\b/i,
    gaming: /\b(game|gaming|playthrough|walkthrough|stream|twitch|fps|mmorpg|esports|minecraft|fortnite|cod|gta|lets play|gameplay)\b/i,
    finance: /\b(money|invest|stock|crypto|bitcoin|finance|budget|wealth|passive income|side hustle|business|trading|forex|economy)\b/i,
    beauty: /\b(makeup|skincare|beauty|cosmetic|tutorial|foundation|lipstick|eyeshadow|routine|grwm|nails|hair)\b/i,
    fitness: /\b(workout|fitness|gym|exercise|weight|muscle|diet|nutrition|health|training|cardio|yoga|meditation)\b/i,
    education: /\b(learn|tutorial|course|how to|explained|education|study|lesson|teach|guide|tips|advice)\b/i,
    lifestyle: /\b(vlog|day in|routine|haul|lifestyle|room tour|apartment|morning|night|life|shopping)\b/i,
    food: /\b(recipe|cook|food|meal|restaurant|eat|taste|kitchen|chef|baking|mukbang|eating)\b/i,
    travel: /\b(travel|trip|vacation|hotel|flight|destination|explore|adventure|tour|country|city)\b/i,
    entertainment: /\b(funny|comedy|prank|challenge|react|reaction|entertainment|skit|parody|meme)\b/i,
    news: /\b(news|breaking|update|report|analysis|politics|current events|documentary)\b/i,
    music: /\b(music|song|cover|official|album|lyrics|remix|live performance|concert|band)\b/i
  };

  const scores = {};
  for (const [niche, regex] of Object.entries(keywords)) {
    scores[niche] = 0;
  }

  for (const v of videos) {
    const text = `${v.title} ${v.description || ''}`.toLowerCase();
    for (const [niche, regex] of Object.entries(keywords)) {
      const matches = text.match(new RegExp(regex, 'gi'));
      if (matches) scores[niche] += matches.length;
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  // Return top 3 niches for mixed content channels
  const topNiches = sorted.filter(([_, score]) => score > 0).slice(0, 3);
  const primaryNiche = topNiches.length > 0 ? topNiches[0][0] : 'default';

  return {
    primary: primaryNiche,
    all: topNiches.map(([niche, score]) => ({ niche, score })),
    scores
  };
}

function calculateRevenue(views, cpm) {
  const monetizedViews = views * MONETIZATION_RATE;
  return (monetizedViews / 1000) * cpm;
}

function formatCurrency(amount) {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  if (amount >= 1) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(2)}`;
}

function getRevenueGrade(monthlyRevenue) {
  if (monthlyRevenue >= 100000) return { grade: 'S', label: 'Elite Creator', color: 'rose', description: 'Top 0.1% of YouTube creators' };
  if (monthlyRevenue >= 50000) return { grade: 'A+', label: 'Full-Time Pro', color: 'amber', description: 'Highly successful full-time creator' };
  if (monthlyRevenue >= 20000) return { grade: 'A', label: 'Professional', color: 'emerald', description: 'Sustainable full-time income' };
  if (monthlyRevenue >= 10000) return { grade: 'B+', label: 'Growing Creator', color: 'teal', description: 'Strong supplemental income' };
  if (monthlyRevenue >= 5000) return { grade: 'B', label: 'Part-Time Income', color: 'blue', description: 'Viable part-time income' };
  if (monthlyRevenue >= 2000) return { grade: 'C+', label: 'Side Hustle', color: 'violet', description: 'Decent supplemental income' };
  if (monthlyRevenue >= 500) return { grade: 'C', label: 'Hobby Creator', color: 'slate', description: 'Some ad revenue earnings' };
  return { grade: 'D', label: 'Starting Out', color: 'slate', description: 'Building audience and revenue' };
}

function analyzeViewTrends(videos) {
  // Sort by date, newest first
  const sorted = [...videos].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Split into recent (last 3 months) vs older
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const recent = sorted.filter(v => new Date(v.publishedAt) >= threeMonthsAgo);
  const older = sorted.filter(v => new Date(v.publishedAt) < threeMonthsAgo);

  const recentAvg = recent.length > 0
    ? recent.reduce((sum, v) => sum + v.viewCount, 0) / recent.length
    : 0;
  const olderAvg = older.length > 0
    ? older.reduce((sum, v) => sum + v.viewCount, 0) / older.length
    : 0;

  let trend = 'stable';
  let trendPercent = 0;

  if (olderAvg > 0 && recentAvg > 0) {
    trendPercent = ((recentAvg - olderAvg) / olderAvg) * 100;
    if (trendPercent > 25) trend = 'growing';
    else if (trendPercent > 10) trend = 'slightly-growing';
    else if (trendPercent < -25) trend = 'declining';
    else if (trendPercent < -10) trend = 'slightly-declining';
  }

  return {
    trend,
    trendPercent: Math.round(trendPercent),
    recentAvgViews: Math.round(recentAvg),
    olderAvgViews: Math.round(olderAvg),
    recentVideoCount: recent.length,
    olderVideoCount: older.length
  };
}

function getMonthlyBreakdown(videos) {
  const months = {};
  let undated = 0;

  for (const v of videos) {
    const date = new Date(v.publishedAt);
    if (!Number.isFinite(date.getTime())) {
      // No usable publish date: the video still counts toward the
      // yearly total, but it cannot be placed in a month. The caller
      // discloses the gap in the coverage note.
      undated++;
      continue;
    }
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!months[key]) {
      months[key] = { views: 0, videoCount: 0 };
    }
    months[key].views += v.viewCount;
    months[key].videoCount++;
  }

  const breakdown = Object.entries(months)
    .map(([month, data]) => ({
      month,
      ...data
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return { breakdown, undated };
}

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "revenue", maxRequests: 10, windowMs: 60_000 })) return;

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
    const accessState = await getToolAccessState(req, "revenue");
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    // Day-granular window, kept so the cache key format is unchanged.
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    sinceDate.setUTCHours(0, 0, 0, 0);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `revenue::${input}::${sinceISO}`;
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
    // One SA call resolves the handle AND returns the channel record;
    // the last 12 months of videos with extras arrive alongside it
    // (see fetchSaLatestVideosForChannel in lib/scrapeAtlas.js).
    // Capped at 200 videos and 3 video pages so the run stays fast.
    const collected = await fetchSaLatestVideosForChannel({
      tool: "revenue",
      spec,
      input,
      sinceISO,
      maxVideos: 200,
      maxPages: 3,
      startedAt
    });
    const channel = collected.channel;
    const channelId = collected.channelId;
    const details = collected.videos;

    if (!details.length) {
      return res.status(400).json({ error: "No videos found in the last 12 months." });
    }

    const subscriberCount = saNumber(channel.subscriberCount);
    const totalChannelViews = saNumber(channel.viewCount);
    const videoCount = saNumber(channel.videoCount);

    // Niche from the fetched video titles and descriptions (same as
    // the pre-migration version).
    const nicheAnalysis = detectNiche(details);
    const cpmRates = AD_CPM_BY_NICHE[nicheAnalysis.primary] || AD_CPM_BY_NICHE.default;

    // Totals from the last 12 months of per-video views, same as the
    // pre-migration version: the yearly figure is the sum the monthly
    // breakdown is built from.
    const totalViews = details.reduce((sum, v) => sum + v.viewCount, 0);
    const avgViews = details.length > 0 ? totalViews / details.length : 0;

    // Calculate revenue estimates
    const yearlyRevenue = {
      low: calculateRevenue(totalViews, cpmRates.low),
      avg: calculateRevenue(totalViews, cpmRates.avg),
      high: calculateRevenue(totalViews, cpmRates.high)
    };

    const monthlyRevenue = {
      low: yearlyRevenue.low / 12,
      avg: yearlyRevenue.avg / 12,
      high: yearlyRevenue.high / 12
    };

    // Per video average revenue
    const perVideoRevenue = {
      low: details.length > 0 ? yearlyRevenue.low / details.length : 0,
      avg: details.length > 0 ? yearlyRevenue.avg / details.length : 0,
      high: details.length > 0 ? yearlyRevenue.high / details.length : 0
    };

    // Analyze trends
    const viewTrends = analyzeViewTrends(details);

    // Monthly breakdown
    const { breakdown: monthlyBreakdown, undated } = getMonthlyBreakdown(details);

    // Add revenue estimates to monthly breakdown
    const monthlyBreakdownWithRevenue = monthlyBreakdown.map(m => ({
      ...m,
      estimatedRevenue: {
        low: formatCurrency(calculateRevenue(m.views, cpmRates.low)),
        avg: formatCurrency(calculateRevenue(m.views, cpmRates.avg)),
        high: formatCurrency(calculateRevenue(m.views, cpmRates.high))
      }
    }));

    // Get top earning videos
    const topVideos = [...details]
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 10)
      .map(v => ({
        videoId: v.videoId,
        title: v.title,
        publishedAt: v.publishedAt,
        viewCount: v.viewCount,
        estimatedRevenue: {
          low: formatCurrency(calculateRevenue(v.viewCount, cpmRates.low)),
          avg: formatCurrency(calculateRevenue(v.viewCount, cpmRates.avg)),
          high: formatCurrency(calculateRevenue(v.viewCount, cpmRates.high))
        }
      }));

    // Revenue grade
    const revenueGrade = getRevenueGrade(monthlyRevenue.avg);

    const coverageWarnings = [];
    collectSaWarnings(channel, coverageWarnings);
    for (const w of collected.coverageWarnings || []) {
      if (w && !coverageWarnings.includes(w)) coverageWarnings.push(w);
    }

    const notes = [];
    notes.push(
      `Yearly views are the sum of the last 12 months of videos (${details.length} videos analyzed).`
    );
    if (collected.hasMore) {
      notes.push(
        `More videos exist in the last 12 months past the ${details.length} analyzed; the figures cover the newest ${details.length}.`
      );
    }
    if (collected.deadlineHit) {
      notes.push(
        "The data fetch hit its time limit; the figures cover the newest videos fetched."
      );
    }
    if (undated > 0) {
      notes.push(
        `${undated} video${undated === 1 ? "" : "s"} had no usable publish date and ${undated === 1 ? "is" : "are"} counted in the yearly total but not in the monthly breakdown.`
      );
    }
    if (collected.withViews < details.length) {
      notes.push(
        `View counts were available for ${collected.withViews} of ${details.length} videos; the rest count as 0 views.`
      );
    }
    if (coverageWarnings.length) {
      notes.push(`Data source notes: ${coverageWarnings.join("; ")}`);
    }

    const payload = {
      channelId,
      channelName: channel.name || "",
      channelThumbnail: saChannelAvatarUrl(channel),
      subscriberCount,
      totalChannelViews,

      videosAnalyzed: details.length,
      analysisTimeframe: '12 months',

      niche: {
        primary: nicheAnalysis.primary,
        all: nicheAnalysis.all
      },

      cpmRates: {
        ...cpmRates,
        formatted: {
          low: `$${cpmRates.low.toFixed(2)}`,
          avg: `$${cpmRates.avg.toFixed(2)}`,
          high: `$${cpmRates.high.toFixed(2)}`
        }
      },

      viewMetrics: {
        totalViews,
        averageViews: Math.round(avgViews),
        totalViewsFormatted: formatCurrency(totalViews).replace('$', ''),
        averageViewsFormatted: formatCurrency(avgViews).replace('$', '')
      },

      estimatedRevenue: {
        yearly: {
          low: yearlyRevenue.low,
          avg: yearlyRevenue.avg,
          high: yearlyRevenue.high,
          formatted: {
            low: formatCurrency(yearlyRevenue.low),
            avg: formatCurrency(yearlyRevenue.avg),
            high: formatCurrency(yearlyRevenue.high)
          }
        },
        monthly: {
          low: monthlyRevenue.low,
          avg: monthlyRevenue.avg,
          high: monthlyRevenue.high,
          formatted: {
            low: formatCurrency(monthlyRevenue.low),
            avg: formatCurrency(monthlyRevenue.avg),
            high: formatCurrency(monthlyRevenue.high)
          }
        },
        perVideo: {
          low: perVideoRevenue.low,
          avg: perVideoRevenue.avg,
          high: perVideoRevenue.high,
          formatted: {
            low: formatCurrency(perVideoRevenue.low),
            avg: formatCurrency(perVideoRevenue.avg),
            high: formatCurrency(perVideoRevenue.high)
          }
        }
      },

      revenueGrade,

      viewTrends,

      monthlyBreakdown: monthlyBreakdownWithRevenue,

      topEarningVideos: topVideos,

      fetchedAt: collected.fetchedAt || "",
      coverageNote: notes.join(" "),
      coverageWarnings,
      saCreditsUsed: collected.saCreditsUsed,

      assumptions: {
        monetizationRate: `${(MONETIZATION_RATE * 100).toFixed(0)}%`,
        description: 'Not all views are monetized (ad blockers, non-monetizable content, viewer location)',
        note: 'CPM varies significantly based on viewer demographics, content type, and advertiser demand'
      },

      disclaimer: "These are rough estimates based on industry averages. Actual revenue depends on many factors including viewer demographics, ad blockers, content type, and YouTube's revenue share (creators receive ~55% of ad revenue). This does not include revenue from sponsorships, merchandise, memberships, or other income sources."
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
