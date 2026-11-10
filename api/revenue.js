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
  parseSaJoinedDate,
  saChannelAvatarUrl,
  collectSaWarnings,
  saNumber
} from "../lib/scrapeAtlas.js";

// Revenue on Scrape Atlas (replaces the YouTube Data API version, which
// burned shared daily quota on every run). Cost: 1 SA credit per run,
// the channel record only. No YouTube quota is consumed.
//
// What changed with the data source, and what it means for the numbers:
// the old version summed the last 12 months of per-video views (up to
// 200 videos) for the yearly total, monthly breakdown, view trends and
// top-earning videos. A channel-only lookup has no per-video history,
// so the yearly estimate is now built from channel totals instead:
// lifetime views divided by channel age in years. Monthly breakdown,
// view trends and top-earning videos have no data behind them and are
// returned empty (same fields, no invented months or videos); the
// coverage note says so in plain language. Niche detection now reads
// the channel description, tags and keywords instead of video
// descriptions. CPM table, monetization rate and revenue formulas are
// unchanged.
// The UI contract keeps every field the frontend expects. Extra fields
// (fetchedAt, coverageNote, coverageWarnings, saCreditsUsed) are
// additive only.

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

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

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "revenue", maxRequests: 10, windowMs: 60_000 })) return;

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
    // One SA call resolves the handle AND returns the channel record.
    const channel = await fetchSaChannel(spec, input, "revenue");
    const channelId = channel.channelId;

    const subscriberCount = saNumber(channel.subscriberCount);
    const totalChannelViews = saNumber(channel.viewCount);
    const videoCount = saNumber(channel.videoCount);

    // Channel age from the join date: the yearly estimate is lifetime
    // views spread over the channel's life. A channel under a month old
    // is floored at one month so the run-rate does not explode.
    const joinedISO = parseSaJoinedDate(channel.joinedDateText);
    const ageYears = joinedISO ? (Date.now() - Date.parse(joinedISO)) / YEAR_MS : null;
    const divisorYears = ageYears === null ? null : Math.max(ageYears, 1 / 12);
    const yearlyViews = divisorYears === null
      ? totalChannelViews
      : Math.round(totalChannelViews / divisorYears);
    const videosPerYear = divisorYears === null
      ? videoCount
      : videoCount / divisorYears;
    const avgViewsPerVideo = videoCount > 0
      ? Math.round(totalChannelViews / videoCount)
      : 0;

    // Niche from the channel's own words: description, tags, keywords.
    // (The old version read up to 200 video descriptions instead.)
    const nicheText = [
      channel.description || "",
      channel.tags || "",
      Array.isArray(channel.keywords) ? channel.keywords.join(", ") : ""
    ].filter(Boolean).join(" ");
    const nicheAnalysis = detectNiche([
      { title: channel.name || "", description: nicheText }
    ]);
    const cpmRates = AD_CPM_BY_NICHE[nicheAnalysis.primary] || AD_CPM_BY_NICHE.default;

    // Calculate revenue estimates from the yearly-views proxy.
    const yearlyRevenue = {
      low: calculateRevenue(yearlyViews, cpmRates.low),
      avg: calculateRevenue(yearlyViews, cpmRates.avg),
      high: calculateRevenue(yearlyViews, cpmRates.high)
    };

    const monthlyRevenue = {
      low: yearlyRevenue.low / 12,
      avg: yearlyRevenue.avg / 12,
      high: yearlyRevenue.high / 12
    };

    // Per video average revenue: yearly revenue spread over the videos
    // published in a typical year.
    const perVideoRevenue = {
      low: videosPerYear > 0 ? yearlyRevenue.low / videosPerYear : 0,
      avg: videosPerYear > 0 ? yearlyRevenue.avg / videosPerYear : 0,
      high: videosPerYear > 0 ? yearlyRevenue.high / videosPerYear : 0
    };

    // Revenue grade
    const revenueGrade = getRevenueGrade(monthlyRevenue.avg);

    const coverageWarnings = [];
    collectSaWarnings(channel, coverageWarnings);

    const notes = [];
    if (ageYears === null) {
      notes.push(
        "The channel creation date was not available, so the yearly estimate uses " +
        "lifetime views as-is instead of spreading them over the channel age."
      );
    } else {
      notes.push(
        `Yearly views are estimated from channel totals (${totalChannelViews.toLocaleString("en-US")} ` +
        `lifetime views over about ${ageYears.toFixed(1)} years), not from a sum of the last 12 months of videos.`
      );
    }
    notes.push(
      "Monthly breakdown, view trends and top-earning videos need per-video history and are not shown for a channel-only lookup."
    );
    if (coverageWarnings.length) {
      notes.push(`Data source notes: ${coverageWarnings.join("; ")}`);
    }

    const payload = {
      channelId,
      channelName: channel.name || "",
      channelThumbnail: saChannelAvatarUrl(channel),
      subscriberCount,
      totalChannelViews,

      videosAnalyzed: videoCount,
      analysisTimeframe: '12 months (estimated from channel totals)',

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
        totalViews: yearlyViews,
        averageViews: avgViewsPerVideo,
        totalViewsFormatted: formatCurrency(yearlyViews).replace('$', ''),
        averageViewsFormatted: formatCurrency(avgViewsPerVideo).replace('$', '')
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

      // No per-video history in a channel-only lookup: neutral trend,
      // empty monthly breakdown and no top videos. Same fields, no
      // invented data.
      viewTrends: {
        trend: 'stable',
        trendPercent: 0,
        recentAvgViews: avgViewsPerVideo,
        olderAvgViews: avgViewsPerVideo,
        recentVideoCount: 0,
        olderVideoCount: 0
      },

      monthlyBreakdown: [],

      topEarningVideos: [],

      fetchedAt: channel.fetchedAt || "",
      coverageNote: notes.join(" "),
      coverageWarnings,
      saCreditsUsed: 1,

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
