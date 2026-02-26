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
  iterateUploads,
  getVideoDetails,
  validateChannelInput,
  initQuota
} from "../utils.js";

function analyzeViralPatterns(videos, avgViews) {
  const patterns = {
    titleLength: { short: 0, medium: 0, long: 0 },
    hasNumbers: { yes: 0, no: 0 },
    hasEmoji: { yes: 0, no: 0 },
    hasQuestion: { yes: 0, no: 0 },
    hasBrackets: { yes: 0, no: 0 },
    dayOfWeek: {},
    hourOfDay: {}
  };

  for (const v of videos) {
    const title = v.title || '';
    
    // Title length
    if (title.length < 40) patterns.titleLength.short++;
    else if (title.length < 70) patterns.titleLength.medium++;
    else patterns.titleLength.long++;

    // Title patterns
    patterns.hasNumbers[/\d/.test(title) ? 'yes' : 'no']++;
    patterns.hasEmoji[/[\u{1F300}-\u{1F9FF}]/u.test(title) ? 'yes' : 'no']++;
    patterns.hasQuestion[/\?/.test(title) ? 'yes' : 'no']++;
    patterns.hasBrackets[/[\[\]()]/.test(title) ? 'yes' : 'no']++;

    // Posting time
    const date = new Date(v.publishedAt);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
    const hour = date.getUTCHours();
    
    patterns.dayOfWeek[day] = (patterns.dayOfWeek[day] || 0) + 1;
    patterns.hourOfDay[hour] = (patterns.hourOfDay[hour] || 0) + 1;
  }

  return patterns;
}

function getViralScore(viewCount, avgViews) {
  if (avgViews === 0) return 1;
  return viewCount / avgViews;
}

function categorizeVideo(score) {
  if (score >= 10) return { category: 'mega-viral', label: 'Mega Viral', color: 'rose', description: '10x+ average views' };
  if (score >= 5) return { category: 'viral', label: 'Viral', color: 'amber', description: '5-10x average views' };
  if (score >= 3) return { category: 'hit', label: 'Hit', color: 'emerald', description: '3-5x average views' };
  if (score >= 2) return { category: 'above-average', label: 'Above Average', color: 'blue', description: '2-3x average views' };
  if (score >= 0.5) return { category: 'average', label: 'Average', color: 'slate', description: 'Within normal range' };
  return { category: 'below-average', label: 'Below Average', color: 'slate', description: 'Under 50% of average' };
}

function extractKeywords(title) {
  // Remove common words and extract potential keywords
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who', 'whom']);
  
  const words = title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  
  return words;
}

function findCommonPatterns(viralVideos) {
  const keywordCounts = {};
  
  for (const v of viralVideos) {
    const keywords = extractKeywords(v.title);
    for (const kw of keywords) {
      keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
    }
  }

  return Object.entries(keywordCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
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

    const cacheKey = `viral::${input}::${sinceISO}`;
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
        commentCount: parseInt(d?.commentCount || 0, 10),
        duration: d?.duration || ''
      };
    });

    // Calculate metrics
    const totalViews = videos.reduce((sum, v) => sum + v.viewCount, 0);
    const avgViews = Math.round(totalViews / videos.length);
    const medianViews = videos.length > 0 
      ? [...videos].map(v => v.viewCount).sort((a, b) => a - b)[Math.floor(videos.length / 2)]
      : 0;

    // Calculate viral scores and categorize
    const scoredVideos = videos.map(v => ({
      ...v,
      viralScore: getViralScore(v.viewCount, avgViews),
      category: categorizeVideo(getViralScore(v.viewCount, avgViews))
    }));

    // Sort by viral score (highest first)
    scoredVideos.sort((a, b) => b.viralScore - a.viralScore);

    // Get viral videos (3x+ average)
    const viralVideos = scoredVideos.filter(v => v.viralScore >= 3);
    const hitVideos = scoredVideos.filter(v => v.viralScore >= 2 && v.viralScore < 3);
    const flopVideos = scoredVideos.filter(v => v.viralScore < 0.5);

    // Analyze patterns in viral videos
    const viralPatterns = viralVideos.length >= 3 ? analyzeViralPatterns(viralVideos, avgViews) : null;
    const commonKeywords = viralVideos.length >= 3 ? findCommonPatterns(viralVideos) : [];

    // Calculate distribution
    const distribution = {
      megaViral: scoredVideos.filter(v => v.viralScore >= 10).length,
      viral: scoredVideos.filter(v => v.viralScore >= 5 && v.viralScore < 10).length,
      hit: scoredVideos.filter(v => v.viralScore >= 3 && v.viralScore < 5).length,
      aboveAverage: scoredVideos.filter(v => v.viralScore >= 2 && v.viralScore < 3).length,
      average: scoredVideos.filter(v => v.viralScore >= 0.5 && v.viralScore < 2).length,
      belowAverage: scoredVideos.filter(v => v.viralScore < 0.5).length
    };

    // Best posting patterns
    let bestDay = null;
    let bestHour = null;
    
    if (viralPatterns) {
      const dayEntries = Object.entries(viralPatterns.dayOfWeek);
      if (dayEntries.length > 0) {
        bestDay = dayEntries.sort((a, b) => b[1] - a[1])[0][0];
      }
      
      const hourEntries = Object.entries(viralPatterns.hourOfDay);
      if (hourEntries.length > 0) {
        bestHour = parseInt(hourEntries.sort((a, b) => b[1] - a[1])[0][0]);
      }
    }

    const payload = {
      channelId,
      sinceISO,
      videoCount: videos.length,
      
      // Overall metrics
      metrics: {
        totalViews,
        averageViews: avgViews,
        medianViews,
        viralRate: videos.length > 0 ? ((viralVideos.length / videos.length) * 100).toFixed(1) : 0
      },
      
      // Distribution
      distribution,
      
      // Top viral videos
      topViral: scoredVideos.slice(0, 10).map(v => ({
        videoId: v.videoId,
        title: v.title,
        viewCount: v.viewCount,
        viralScore: Math.round(v.viralScore * 10) / 10,
        category: v.category,
        publishedAt: v.publishedAt
      })),
      
      // Biggest flops (for contrast)
      biggestFlops: flopVideos.slice(-5).reverse().map(v => ({
        videoId: v.videoId,
        title: v.title,
        viewCount: v.viewCount,
        viralScore: Math.round(v.viralScore * 100) / 100,
        publishedAt: v.publishedAt
      })),
      
      // Pattern analysis
      patterns: {
        commonKeywords,
        bestPostingDay: bestDay,
        bestPostingHour: bestHour,
        titleInsights: viralPatterns ? {
          avgTitleLength: viralVideos.length > 0 
            ? Math.round(viralVideos.reduce((sum, v) => sum + v.title.length, 0) / viralVideos.length)
            : 0,
          numbersInTitle: viralPatterns.hasNumbers.yes > viralPatterns.hasNumbers.no,
          questionsWork: viralPatterns.hasQuestion.yes > viralPatterns.hasQuestion.no,
          bracketsWork: viralPatterns.hasBrackets.yes > viralPatterns.hasBrackets.no
        } : null
      },
      
      // Summary stats
      summary: {
        viralVideoCount: viralVideos.length,
        hitVideoCount: hitVideos.length,
        flopVideoCount: flopVideos.length,
        highestViralScore: scoredVideos.length > 0 ? Math.round(scoredVideos[0].viralScore * 10) / 10 : 0,
        lowestViralScore: scoredVideos.length > 0 ? Math.round(scoredVideos[scoredVideos.length - 1].viralScore * 100) / 100 : 0
      }
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
