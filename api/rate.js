import { 
  consumeQuota, 
  fetchJson, 
  API_KEY, 
  setCache, 
  getCache,
  parseChannelIdFromUrl,
  resolveChannelId,
  getUploadsPlaylistId,
  setCorsHeaders,
  handleApiError,
  checkQuota,
  extractUrls,
  domainFromUrl,
  iterateUploads,
  getVideoDetails,
  SOCIAL_MEDIA_FILTER,
  validateChannelInput,
  initQuota
} from "../utils.js";

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
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  await initQuota();

  try {
    const rawInput = (req.query.url || "").toString();
    const validation = validateChannelInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid input." });
    }
    const input = validation.sanitized;

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    const quotaCheck = checkQuota(250);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `rate::${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Fetch recent videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 100) break; // Limit for rate estimation
    }
    
    if (!recent.length) {
      return res.status(400).json({ error: "No videos found in the last year." });
    }

    // Get video details including view counts
    const details = await getVideoDetails(recent.map(v => v.videoId));
    const videos = recent.map(v => {
      const d = details.find(x => x.videoId === v.videoId);
      return { 
        videoId: v.videoId, 
        title: d?.title || v.title, 
        description: d?.description || "", 
        publishedAt: d?.publishedAt || v.publishedAt,
        viewCount: parseInt(d?.viewCount || 0, 10),
        likeCount: parseInt(d?.likeCount || 0, 10),
        commentCount: parseInt(d?.commentCount || 0, 10)
      };
    });

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
      
      disclaimer: "These are estimates based on industry averages. Actual rates vary based on niche, engagement, audience demographics, relationship with brand, and negotiation."
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
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
