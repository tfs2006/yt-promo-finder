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
  validateChannelInput,
  initQuota
} from "../utils.js";

// Parse ISO 8601 duration to seconds
function parseDuration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(mins).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function getDurationCategory(seconds) {
  if (seconds < 60) return 'micro';         // < 1 min (Shorts)
  if (seconds < 180) return 'short';        // 1-3 min
  if (seconds < 480) return 'medium-short'; // 3-8 min
  if (seconds < 900) return 'medium';       // 8-15 min
  if (seconds < 1200) return 'medium-long'; // 15-20 min
  if (seconds < 1800) return 'long';        // 20-30 min
  if (seconds < 3600) return 'extended';    // 30-60 min
  return 'ultra-long';                      // 60+ min
}

function getTitleLengthCategory(length) {
  if (length < 30) return 'short';
  if (length < 50) return 'medium';
  if (length < 70) return 'long';
  return 'very-long';
}

function analyzeCorrelations(videos) {
  if (videos.length < 5) return null;
  
  const avgViews = videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length;
  
  // Analyze by duration category
  const byDuration = {};
  const byTitleLength = {};
  const byDayOfWeek = {};
  const byHourOfDay = {};
  const byTitlePatterns = {
    hasNumbers: { true: [], false: [] },
    hasEmoji: { true: [], false: [] },
    hasQuestion: { true: [], false: [] },
    hasBrackets: { true: [], false: [] },
    hasColons: { true: [], false: [] },
    allCaps: { true: [], false: [] }
  };
  
  for (const v of videos) {
    // Duration analysis
    const durCat = getDurationCategory(v.durationSeconds);
    if (!byDuration[durCat]) byDuration[durCat] = [];
    byDuration[durCat].push(v.viewCount);
    
    // Title length analysis
    const titleLenCat = getTitleLengthCategory(v.title.length);
    if (!byTitleLength[titleLenCat]) byTitleLength[titleLenCat] = [];
    byTitleLength[titleLenCat].push(v.viewCount);
    
    // Day of week analysis
    const date = new Date(v.publishedAt);
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()];
    if (!byDayOfWeek[day]) byDayOfWeek[day] = [];
    byDayOfWeek[day].push(v.viewCount);

    // Hour of day analysis
    const hour = date.getUTCHours();
    if (!byHourOfDay[hour]) byHourOfDay[hour] = [];
    byHourOfDay[hour].push(v.viewCount);
    
    // Title pattern analysis
    byTitlePatterns.hasNumbers[/\d/.test(v.title)].push(v.viewCount);
    byTitlePatterns.hasEmoji[/[\u{1F300}-\u{1F9FF}]/u.test(v.title)].push(v.viewCount);
    byTitlePatterns.hasQuestion[/\?/.test(v.title)].push(v.viewCount);
    byTitlePatterns.hasBrackets[/[\[\]()]/.test(v.title)].push(v.viewCount);
    byTitlePatterns.hasColons[/:/.test(v.title)].push(v.viewCount);
    byTitlePatterns.allCaps[v.title === v.title.toUpperCase()].push(v.viewCount);
  }
  
  // Calculate averages and performance scores
  const calcStats = (arr) => {
    if (!arr || arr.length === 0) return null;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const performanceScore = (avg / avgViews) * 100;
    return {
      avgViews: Math.round(avg),
      count: arr.length,
      performanceScore: Math.round(performanceScore),
      aboveAverage: performanceScore > 100
    };
  };
  
  // Duration analysis results
  const durationResults = {};
  for (const [cat, views] of Object.entries(byDuration)) {
    durationResults[cat] = calcStats(views);
  }
  
  // Title length results
  const titleLengthResults = {};
  for (const [cat, views] of Object.entries(byTitleLength)) {
    titleLengthResults[cat] = calcStats(views);
  }
  
  // Day of week results
  const dayResults = {};
  for (const [day, views] of Object.entries(byDayOfWeek)) {
    dayResults[day] = calcStats(views);
  }
  
  // Hour of day results
  const hourResults = {};
  for (const [hour, views] of Object.entries(byHourOfDay)) {
    hourResults[hour] = calcStats(views);
  }
  
  // Title pattern results
  const patternResults = {};
  for (const [pattern, data] of Object.entries(byTitlePatterns)) {
    patternResults[pattern] = {
      with: calcStats(data.true),
      without: calcStats(data.false)
    };
  }
  
  return {
    duration: durationResults,
    titleLength: titleLengthResults,
    dayOfWeek: dayResults,
    hourOfDay: hourResults,
    titlePatterns: patternResults
  };
}

function findOptimalFactors(correlations, videos) {
  if (!correlations) return null;
  
  // Find best duration
  let bestDuration = null;
  let bestDurationScore = 0;
  for (const [cat, stats] of Object.entries(correlations.duration)) {
    if (stats && stats.count >= 3 && stats.performanceScore > bestDurationScore) {
      bestDurationScore = stats.performanceScore;
      bestDuration = cat;
    }
  }
  
  // Find best title length
  let bestTitleLength = null;
  let bestTitleLengthScore = 0;
  for (const [cat, stats] of Object.entries(correlations.titleLength)) {
    if (stats && stats.count >= 3 && stats.performanceScore > bestTitleLengthScore) {
      bestTitleLengthScore = stats.performanceScore;
      bestTitleLength = cat;
    }
  }
  
  // Find best day
  let bestDay = null;
  let bestDayScore = 0;
  for (const [day, stats] of Object.entries(correlations.dayOfWeek)) {
    if (stats && stats.count >= 3 && stats.performanceScore > bestDayScore) {
      bestDayScore = stats.performanceScore;
      bestDay = day;
    }
  }
  
  // Find best hour range
  const hourScores = Object.entries(correlations.hourOfDay)
    .filter(([_, stats]) => stats && stats.count >= 2)
    .sort((a, b) => b[1].performanceScore - a[1].performanceScore);
  const bestHours = hourScores.slice(0, 3).map(([hour, stats]) => ({
    hour: parseInt(hour),
    performanceScore: stats.performanceScore
  }));
  
  // Find effective title patterns
  const effectivePatterns = [];
  for (const [pattern, data] of Object.entries(correlations.titlePatterns)) {
    if (data.with && data.without && data.with.count >= 5 && data.without.count >= 5) {
      const impact = data.with.performanceScore - data.without.performanceScore;
      if (Math.abs(impact) > 10) {
        effectivePatterns.push({
          pattern,
          impact,
          recommendation: impact > 0 ? 'use' : 'avoid',
          withAvg: data.with.avgViews,
          withoutAvg: data.without.avgViews
        });
      }
    }
  }
  effectivePatterns.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  
  // Calculate actual duration ranges from videos
  const durationRanges = {
    'micro': { min: 0, max: 60, label: 'Under 1 minute (Shorts)' },
    'short': { min: 60, max: 180, label: '1-3 minutes' },
    'medium-short': { min: 180, max: 480, label: '3-8 minutes' },
    'medium': { min: 480, max: 900, label: '8-15 minutes' },
    'medium-long': { min: 900, max: 1200, label: '15-20 minutes' },
    'long': { min: 1200, max: 1800, label: '20-30 minutes' },
    'extended': { min: 1800, max: 3600, label: '30-60 minutes' },
    'ultra-long': { min: 3600, max: Infinity, label: '60+ minutes' }
  };
  
  const titleLengthRanges = {
    'short': { min: 0, max: 30, label: 'Under 30 characters' },
    'medium': { min: 30, max: 50, label: '30-50 characters' },
    'long': { min: 50, max: 70, label: '50-70 characters' },
    'very-long': { min: 70, max: Infinity, label: '70+ characters' }
  };
  
  return {
    duration: {
      best: bestDuration,
      bestLabel: bestDuration ? durationRanges[bestDuration]?.label : 'N/A',
      score: bestDurationScore,
      ranges: durationRanges
    },
    titleLength: {
      best: bestTitleLength,
      bestLabel: bestTitleLength ? titleLengthRanges[bestTitleLength]?.label : 'N/A',
      score: bestTitleLengthScore
    },
    bestDay: {
      day: bestDay,
      score: bestDayScore
    },
    bestHours,
    effectivePatterns
  };
}

function generateRecommendations(optimal, correlations) {
  const recommendations = [];
  
  if (optimal.duration.best && optimal.duration.score > 110) {
    recommendations.push({
      category: 'duration',
      icon: '⏱️',
      title: 'Optimal Video Length',
      description: `Videos ${optimal.duration.bestLabel} perform ${optimal.duration.score - 100}% better than average for this channel.`,
      impact: 'high'
    });
  }
  
  if (optimal.titleLength.best && optimal.titleLength.score > 110) {
    recommendations.push({
      category: 'title',
      icon: '📝',
      title: 'Title Length Sweet Spot',
      description: `Titles with ${optimal.titleLength.bestLabel} get ${optimal.titleLength.score - 100}% more views on average.`,
      impact: 'medium'
    });
  }
  
  if (optimal.bestDay.day && optimal.bestDay.score > 110) {
    recommendations.push({
      category: 'timing',
      icon: '📅',
      title: 'Best Posting Day',
      description: `Videos posted on ${optimal.bestDay.day} perform ${optimal.bestDay.score - 100}% better than average.`,
      impact: 'medium'
    });
  }
  
  if (optimal.bestHours.length > 0 && optimal.bestHours[0].performanceScore > 110) {
    const hourStr = optimal.bestHours.map(h => `${h.hour}:00 UTC`).join(', ');
    recommendations.push({
      category: 'timing',
      icon: '🕐',
      title: 'Optimal Posting Time',
      description: `Best performing upload times: ${hourStr}`,
      impact: 'medium'
    });
  }
  
  for (const pattern of optimal.effectivePatterns.slice(0, 3)) {
    const patternLabels = {
      hasNumbers: { use: 'Include numbers in titles', avoid: 'Avoid numbers in titles' },
      hasEmoji: { use: 'Use emojis in titles', avoid: 'Avoid emojis in titles' },
      hasQuestion: { use: 'Ask questions in titles', avoid: 'Avoid questions in titles' },
      hasBrackets: { use: 'Use brackets [like this]', avoid: 'Avoid brackets in titles' },
      hasColons: { use: 'Use colons in titles', avoid: 'Avoid colons in titles' },
      allCaps: { use: 'Use ALL CAPS titles', avoid: 'Avoid ALL CAPS titles' }
    };
    
    const label = patternLabels[pattern.pattern]?.[pattern.recommendation];
    if (label) {
      recommendations.push({
        category: 'title',
        icon: pattern.recommendation === 'use' ? '✅' : '❌',
        title: label,
        description: `${pattern.recommendation === 'use' ? 'Videos with' : 'Videos without'} this pattern get ${Math.abs(pattern.impact)}% ${pattern.impact > 0 ? 'more' : 'fewer'} views.`,
        impact: Math.abs(pattern.impact) > 20 ? 'high' : 'medium'
      });
    }
  }
  
  return recommendations;
}

function predictVideoScore(title, durationSeconds, publishDay, publishHour, correlations) {
  if (!correlations) return null;
  
  let score = 100; // Base score
  let factors = [];
  
  // Duration factor
  const durCat = getDurationCategory(durationSeconds);
  const durStats = correlations.duration[durCat];
  if (durStats) {
    const durImpact = durStats.performanceScore - 100;
    score += durImpact * 0.3;
    factors.push({
      factor: 'Duration',
      impact: durImpact,
      description: `${formatDuration(durationSeconds)} (${durStats.performanceScore}% of avg)`
    });
  }
  
  // Title length factor
  const titleCat = getTitleLengthCategory(title.length);
  const titleStats = correlations.titleLength[titleCat];
  if (titleStats) {
    const titleImpact = titleStats.performanceScore - 100;
    score += titleImpact * 0.2;
    factors.push({
      factor: 'Title Length',
      impact: titleImpact,
      description: `${title.length} chars (${titleStats.performanceScore}% of avg)`
    });
  }
  
  // Day factor
  const dayStats = correlations.dayOfWeek[publishDay];
  if (dayStats) {
    const dayImpact = dayStats.performanceScore - 100;
    score += dayImpact * 0.2;
    factors.push({
      factor: 'Day',
      impact: dayImpact,
      description: `${publishDay} (${dayStats.performanceScore}% of avg)`
    });
  }
  
  // Time factor
  const hourStats = correlations.hourOfDay[publishHour];
  if (hourStats) {
    const hourImpact = hourStats.performanceScore - 100;
    score += hourImpact * 0.15;
    factors.push({
      factor: 'Time',
      impact: hourImpact,
      description: `${publishHour}:00 UTC (${hourStats.performanceScore}% of avg)`
    });
  }
  
  // Title patterns factor
  let patternScore = 0;
  const patternFactors = [];
  
  const patterns = {
    hasNumbers: /\d/.test(title),
    hasEmoji: /[\u{1F300}-\u{1F9FF}]/u.test(title),
    hasQuestion: /\?/.test(title),
    hasBrackets: /[\[\]()]/.test(title)
  };
  
  for (const [pattern, hasIt] of Object.entries(patterns)) {
    const patternData = correlations.titlePatterns[pattern];
    if (patternData) {
      const relevantStats = hasIt ? patternData.with : patternData.without;
      if (relevantStats && relevantStats.count >= 3) {
        const impact = relevantStats.performanceScore - 100;
        patternScore += impact * 0.05;
        if (Math.abs(impact) > 10) {
          patternFactors.push(`${pattern}: ${impact > 0 ? '+' : ''}${impact}%`);
        }
      }
    }
  }
  
  score += patternScore;
  if (patternFactors.length > 0) {
    factors.push({
      factor: 'Title Patterns',
      impact: patternScore,
      description: patternFactors.join(', ')
    });
  }
  
  return {
    score: Math.round(Math.max(0, Math.min(200, score))),
    factors
  };
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

    const quotaCheck = checkQuota(300);
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

    const cacheKey = `predictor::${input}::${sinceISO}`;
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

    // Fetch videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 200) break;
    }
    
    if (recent.length < 10) {
      return res.status(400).json({ error: "Need at least 10 videos for meaningful predictions. This channel has fewer videos in the past 12 months." });
    }

    // Get video details with duration and stats
    const videoIds = recent.map(v => v.videoId);
    const videos = [];
    
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      consumeQuota(1);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${chunk.join(",")}&key=${API_KEY}`;
      const data = await fetchJson(url);
      for (const it of data.items || []) {
        videos.push({
          videoId: it.id,
          title: it.snippet?.title || "",
          publishedAt: it.snippet?.publishedAt,
          viewCount: parseInt(it.statistics?.viewCount || 0, 10),
          likeCount: parseInt(it.statistics?.likeCount || 0, 10),
          commentCount: parseInt(it.statistics?.commentCount || 0, 10),
          duration: it.contentDetails?.duration,
          durationSeconds: parseDuration(it.contentDetails?.duration)
        });
      }
    }

    // Analyze correlations
    const correlations = analyzeCorrelations(videos);
    const optimal = findOptimalFactors(correlations, videos);
    const recommendations = generateRecommendations(optimal, correlations);

    // Calculate channel averages
    const avgViews = videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length;
    const avgDuration = videos.reduce((sum, v) => sum + v.durationSeconds, 0) / videos.length;
    const avgTitleLength = videos.reduce((sum, v) => sum + v.title.length, 0) / videos.length;

    // Top and bottom performing videos for comparison
    const sortedByViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
    const topPerformers = sortedByViews.slice(0, 5).map(v => ({
      videoId: v.videoId,
      title: v.title,
      viewCount: v.viewCount,
      duration: formatDuration(v.durationSeconds),
      titleLength: v.title.length,
      publishedAt: v.publishedAt
    }));
    
    const bottomPerformers = sortedByViews.slice(-5).reverse().map(v => ({
      videoId: v.videoId,
      title: v.title,
      viewCount: v.viewCount,
      duration: formatDuration(v.durationSeconds),
      titleLength: v.title.length,
      publishedAt: v.publishedAt
    }));

    // Format correlations for frontend
    const formattedCorrelations = {
      duration: Object.entries(correlations.duration)
        .filter(([_, stats]) => stats && stats.count >= 2)
        .map(([cat, stats]) => ({
          category: cat,
          label: optimal.duration.ranges[cat]?.label || cat,
          ...stats
        }))
        .sort((a, b) => b.performanceScore - a.performanceScore),
      
      titleLength: Object.entries(correlations.titleLength)
        .filter(([_, stats]) => stats && stats.count >= 2)
        .map(([cat, stats]) => ({
          category: cat,
          ...stats
        }))
        .sort((a, b) => b.performanceScore - a.performanceScore),
      
      dayOfWeek: Object.entries(correlations.dayOfWeek)
        .filter(([_, stats]) => stats && stats.count >= 2)
        .map(([day, stats]) => ({
          day,
          ...stats
        }))
        .sort((a, b) => b.performanceScore - a.performanceScore),
      
      hourOfDay: Object.entries(correlations.hourOfDay)
        .filter(([_, stats]) => stats && stats.count >= 1)
        .map(([hour, stats]) => ({
          hour: parseInt(hour),
          ...stats
        }))
        .sort((a, b) => a.hour - b.hour)
    };

    const payload = {
      channelId,
      channelName: channelInfo.snippet?.title,
      channelThumbnail: channelInfo.snippet?.thumbnails?.medium?.url,
      
      videosAnalyzed: videos.length,
      analysisTimeframe: '12 months',
      
      averages: {
        views: Math.round(avgViews),
        duration: formatDuration(Math.round(avgDuration)),
        durationSeconds: Math.round(avgDuration),
        titleLength: Math.round(avgTitleLength)
      },
      
      optimal,
      recommendations,
      correlations: formattedCorrelations,
      
      topPerformers,
      bottomPerformers,
      
      disclaimer: "Predictions are based on historical patterns from this channel's videos. Many factors affect video performance including content quality, trends, algorithm changes, and audience behavior. Use these insights as guidelines, not guarantees."
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
