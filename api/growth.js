import { 
  consumeQuota, 
  fetchJson, 
  API_KEY,
  setCache,
  getCache,
  parseChannelIdFromUrl,
  resolveChannelId,
  getChannelSnapshot,
  applyApiGuards,
  handleApiError,
  checkQuota,
  validateChannelInput,
  initQuota
} from "../utils.js";

async function getChannelStats(channelId) {
  consumeQuota(1);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${API_KEY}`;
  const data = await fetchJson(url);
  
  if (!data.items?.length) throw new Error("Channel not found");
  
  const item = data.items[0];
  return {
    subscriberCount: parseInt(item.statistics?.subscriberCount || 0),
    videoCount: parseInt(item.statistics?.videoCount || 0),
    viewCount: parseInt(item.statistics?.viewCount || 0),
    publishedAt: item.snippet?.publishedAt
  };
}

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

  // Initialize quota from persistent storage
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
    const quotaCheck = checkQuota(200);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    const cacheKey = `growth::${input}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    
    // Get channel statistics
    const stats = await getChannelStats(channelId);
    
    // Use a shared snapshot so other tools can reuse this base dataset.
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 3);
    sinceDate.setUTCHours(0, 0, 0, 0);
    const snapshot = await getChannelSnapshot(input, sinceDate.toISOString(), {
      maxVideos: 50,
      includeStatistics: false,
      cacheTtlSeconds: 3600
    });
    const recentVideos = snapshot.videos;
    
    // Analyze upload patterns
    const uploadPattern = analyzeUploadPattern(recentVideos);
    
    const payload = {
      channelId,
      stats,
      uploadPattern,
      recentVideos
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
