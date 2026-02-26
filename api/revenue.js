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
  iterateUploads,
  getVideoDetails,
  validateChannelInput,
  initQuota
} from "../utils.js";

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
  
  for (const v of videos) {
    const date = new Date(v.publishedAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!months[key]) {
      months[key] = { views: 0, videoCount: 0 };
    }
    months[key].views += v.viewCount;
    months[key].videoCount++;
  }
  
  return Object.entries(months)
    .map(([month, data]) => ({
      month,
      ...data
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
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

    // Check quota before starting
    const quotaCheck = checkQuota(250);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    // Use 12 months of data
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `revenue::${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Get channel info
    consumeQuota(1);
    const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${API_KEY}`;
    const channelData = await fetchJson(channelUrl);
    const channelInfo = channelData.items?.[0];
    
    if (!channelInfo) {
      return res.status(404).json({ error: "Channel not found." });
    }

    // Fetch recent videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 200) break;
    }
    
    if (!recent.length) {
      return res.status(400).json({ error: "No videos found in the last 12 months." });
    }

    // Get video details with view counts
    consumeQuota(Math.ceil(recent.length / 50));
    const videoIds = recent.map(v => v.videoId);
    const details = [];
    
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${chunk.join(",")}&key=${API_KEY}`;
      const data = await fetchJson(url);
      for (const it of data.items || []) {
        details.push({
          videoId: it.id,
          title: it.snippet?.title || "",
          description: it.snippet?.description || "",
          publishedAt: it.snippet?.publishedAt,
          viewCount: parseInt(it.statistics?.viewCount || 0, 10),
          likeCount: parseInt(it.statistics?.likeCount || 0, 10),
          commentCount: parseInt(it.statistics?.commentCount || 0, 10)
        });
      }
    }

    // Detect niche
    const nicheAnalysis = detectNiche(details);
    const cpmRates = AD_CPM_BY_NICHE[nicheAnalysis.primary] || AD_CPM_BY_NICHE.default;

    // Calculate totals
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
    const monthlyBreakdown = getMonthlyBreakdown(details);

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

    const payload = {
      channelId,
      channelName: channelInfo.snippet?.title,
      channelThumbnail: channelInfo.snippet?.thumbnails?.medium?.url,
      subscriberCount: parseInt(channelInfo.statistics?.subscriberCount || 0),
      totalChannelViews: parseInt(channelInfo.statistics?.viewCount || 0),
      
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
      
      assumptions: {
        monetizationRate: `${(MONETIZATION_RATE * 100).toFixed(0)}%`,
        description: 'Not all views are monetized (ad blockers, non-monetizable content, viewer location)',
        note: 'CPM varies significantly based on viewer demographics, content type, and advertiser demand'
      },
      
      disclaimer: "These are rough estimates based on industry averages. Actual revenue depends on many factors including viewer demographics, ad blockers, content type, and YouTube's revenue share (creators receive ~55% of ad revenue). This does not include revenue from sponsorships, merchandise, memberships, or other income sources."
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
