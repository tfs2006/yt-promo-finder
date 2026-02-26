import { 
  consumeQuota, 
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

function getSponsorDomains(description) {
  if (!description) return [];
  const urls = extractUrls(description);
  const domains = new Set();
  for (const url of urls) {
    const dom = domainFromUrl(url);
    if (!SOCIAL_MEDIA_FILTER.test(dom)) {
      domains.add(dom);
    }
  }
  return Array.from(domains);
}

function getSaturationGrade(percentage) {
  if (percentage >= 80) return { grade: 'F', label: 'Over-Saturated', color: 'rose', description: 'Extremely high sponsorship frequency. Audience fatigue likely.' };
  if (percentage >= 60) return { grade: 'D', label: 'Heavy', color: 'amber', description: 'High sponsorship frequency. Consider selective partnerships.' };
  if (percentage >= 40) return { grade: 'C', label: 'Moderate', color: 'yellow', description: 'Moderate sponsorship presence. Room for more if strategic.' };
  if (percentage >= 20) return { grade: 'B', label: 'Balanced', color: 'emerald', description: 'Healthy balance of sponsored and organic content.' };
  return { grade: 'A', label: 'Minimal', color: 'blue', description: 'Low sponsorship saturation. High opportunity for brand deals.' };
}

function getAudienceFatigueRisk(saturationPercent, trend, avgViews, sponsoredAvgViews) {
  let score = 0;
  let factors = [];

  // High saturation increases risk
  if (saturationPercent >= 60) {
    score += 3;
    factors.push('Very high sponsorship frequency');
  } else if (saturationPercent >= 40) {
    score += 2;
    factors.push('Elevated sponsorship frequency');
  } else if (saturationPercent >= 25) {
    score += 1;
    factors.push('Moderate sponsorship frequency');
  }

  // Increasing trend is worse
  if (trend === 'increasing') {
    score += 2;
    factors.push('Sponsorship frequency is increasing');
  } else if (trend === 'stable-high') {
    score += 1;
    factors.push('Consistently high sponsorship rate');
  }

  // Performance drop indicates fatigue
  if (sponsoredAvgViews < avgViews * 0.8) {
    score += 2;
    factors.push('Sponsored videos underperform by 20%+');
  } else if (sponsoredAvgViews < avgViews * 0.95) {
    score += 1;
    factors.push('Slight performance dip on sponsored content');
  }

  let risk, color;
  if (score >= 5) {
    risk = 'High';
    color = 'rose';
  } else if (score >= 3) {
    risk = 'Moderate';
    color = 'amber';
  } else {
    risk = 'Low';
    color = 'emerald';
  }

  return { risk, color, score, factors };
}

function analyzeTrend(monthlyData) {
  if (monthlyData.length < 3) return { trend: 'insufficient-data', description: 'Not enough data to determine trend' };
  
  const recent3 = monthlyData.slice(-3);
  const earlier3 = monthlyData.slice(-6, -3);
  
  if (earlier3.length === 0) return { trend: 'insufficient-data', description: 'Not enough historical data' };
  
  const recentAvg = recent3.reduce((sum, m) => sum + m.saturation, 0) / recent3.length;
  const earlierAvg = earlier3.reduce((sum, m) => sum + m.saturation, 0) / earlier3.length;
  
  const change = recentAvg - earlierAvg;
  
  if (change > 15) return { trend: 'increasing', description: 'Sponsorship frequency is significantly increasing', change };
  if (change > 5) return { trend: 'slightly-increasing', description: 'Sponsorship frequency is slightly increasing', change };
  if (change < -15) return { trend: 'decreasing', description: 'Sponsorship frequency is decreasing', change };
  if (change < -5) return { trend: 'slightly-decreasing', description: 'Sponsorship frequency is slightly decreasing', change };
  
  if (recentAvg > 50) return { trend: 'stable-high', description: 'Consistently high sponsorship rate', change };
  return { trend: 'stable', description: 'Sponsorship frequency is stable', change };
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

    const cacheKey = `saturation::${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Fetch recent videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 200) break;
    }
    
    if (!recent.length) {
      return res.status(400).json({ error: "No videos found in the last year." });
    }

    // Get video details
    const details = await getVideoDetails(recent.map(v => v.videoId));
    const videos = recent.map(v => {
      const d = details.find(x => x.videoId === v.videoId);
      return { 
        videoId: v.videoId, 
        title: d?.title || v.title, 
        description: d?.description || "", 
        publishedAt: d?.publishedAt || v.publishedAt,
        viewCount: parseInt(d?.viewCount || 0, 10)
      };
    });

    // Analyze each video
    const analyzedVideos = videos.map(v => ({
      ...v,
      hasSponsorship: hasSponsorship(v.description),
      sponsors: getSponsorDomains(v.description)
    }));

    // Calculate overall saturation
    const sponsoredVideos = analyzedVideos.filter(v => v.hasSponsorship);
    const nonSponsoredVideos = analyzedVideos.filter(v => !v.hasSponsorship);
    
    const saturationPercent = (sponsoredVideos.length / analyzedVideos.length) * 100;
    const saturationGrade = getSaturationGrade(saturationPercent);

    // Calculate monthly breakdown
    const monthlyData = [];
    const monthMap = new Map();
    
    for (const v of analyzedVideos) {
      const date = new Date(v.publishedAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, { total: 0, sponsored: 0, views: 0, sponsoredViews: 0 });
      }
      const m = monthMap.get(monthKey);
      m.total++;
      m.views += v.viewCount;
      if (v.hasSponsorship) {
        m.sponsored++;
        m.sponsoredViews += v.viewCount;
      }
    }

    for (const [month, data] of monthMap.entries()) {
      monthlyData.push({
        month,
        totalVideos: data.total,
        sponsoredVideos: data.sponsored,
        saturation: data.total > 0 ? Math.round((data.sponsored / data.total) * 100) : 0,
        avgViews: data.total > 0 ? Math.round(data.views / data.total) : 0,
        sponsoredAvgViews: data.sponsored > 0 ? Math.round(data.sponsoredViews / data.sponsored) : 0
      });
    }
    monthlyData.sort((a, b) => a.month.localeCompare(b.month));

    // Analyze trend
    const trendAnalysis = analyzeTrend(monthlyData);

    // Calculate view performance
    const avgViews = videos.length > 0 
      ? Math.round(videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length)
      : 0;
    const sponsoredAvgViews = sponsoredVideos.length > 0
      ? Math.round(sponsoredVideos.reduce((sum, v) => sum + v.viewCount, 0) / sponsoredVideos.length)
      : 0;
    const nonSponsoredAvgViews = nonSponsoredVideos.length > 0
      ? Math.round(nonSponsoredVideos.reduce((sum, v) => sum + v.viewCount, 0) / nonSponsoredVideos.length)
      : 0;

    // Calculate audience fatigue risk
    const fatigueRisk = getAudienceFatigueRisk(
      saturationPercent, 
      trendAnalysis.trend, 
      avgViews, 
      sponsoredAvgViews
    );

    // Top sponsors
    const sponsorCounts = {};
    for (const v of analyzedVideos) {
      for (const sponsor of v.sponsors) {
        sponsorCounts[sponsor] = (sponsorCounts[sponsor] || 0) + 1;
      }
    }
    const topSponsors = Object.entries(sponsorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count, percentage: Math.round((count / analyzedVideos.length) * 100) }));

    // Recent sponsored videos
    const recentSponsored = sponsoredVideos
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 5)
      .map(v => ({
        videoId: v.videoId,
        title: v.title,
        publishedAt: v.publishedAt,
        viewCount: v.viewCount,
        sponsors: v.sponsors.slice(0, 3)
      }));

    const payload = {
      channelId,
      sinceISO,
      videoCount: analyzedVideos.length,
      
      // Main saturation metrics
      saturation: {
        percentage: Math.round(saturationPercent * 10) / 10,
        grade: saturationGrade,
        sponsoredCount: sponsoredVideos.length,
        organicCount: nonSponsoredVideos.length
      },
      
      // Trend analysis
      trend: trendAnalysis,
      
      // Audience fatigue risk
      audienceFatigue: fatigueRisk,
      
      // View performance comparison
      performance: {
        overallAvgViews: avgViews,
        sponsoredAvgViews,
        nonSponsoredAvgViews,
        performanceDiff: avgViews > 0 
          ? Math.round(((sponsoredAvgViews - nonSponsoredAvgViews) / nonSponsoredAvgViews) * 100)
          : 0
      },
      
      // Monthly breakdown
      monthlyBreakdown: monthlyData,
      
      // Top sponsors
      topSponsors,
      
      // Recent sponsored videos
      recentSponsored,
      
      // Recommendations
      recommendations: generateRecommendations(saturationPercent, trendAnalysis.trend, fatigueRisk.risk)
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}

function generateRecommendations(saturation, trend, fatigueRisk) {
  const recs = [];
  
  if (saturation >= 60) {
    recs.push({
      type: 'warning',
      title: 'Consider reducing sponsorship frequency',
      description: 'High saturation may be causing audience fatigue. Consider spacing out sponsored content.'
    });
  }
  
  if (trend === 'increasing') {
    recs.push({
      type: 'caution',
      title: 'Sponsorship rate is climbing',
      description: 'The channel is increasingly monetizing through sponsorships. Monitor audience retention.'
    });
  }
  
  if (fatigueRisk === 'High') {
    recs.push({
      type: 'warning',
      title: 'High audience fatigue risk',
      description: 'Multiple factors indicate potential audience fatigue. Brands should negotiate carefully.'
    });
  }
  
  if (saturation < 30 && fatigueRisk !== 'High') {
    recs.push({
      type: 'opportunity',
      title: 'Good opportunity for sponsorship',
      description: 'Low saturation and healthy metrics make this channel attractive for brand partnerships.'
    });
  }
  
  if (saturation >= 30 && saturation < 50) {
    recs.push({
      type: 'info',
      title: 'Selective partnerships recommended',
      description: 'Moderate saturation. Best results with highly relevant, well-integrated sponsorships.'
    });
  }

  return recs;
}
