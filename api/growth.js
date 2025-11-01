import * as dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.YOUTUBE_API_KEY;

// Simple in-memory cache (15 min)
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 15;
function setCache(key, data) { cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS }); }
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${txt}`);
  }
  return res.json();
}

function parseChannelIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const channelMatch = url.pathname.match(/\/channel\/(UC[\w-]+)/i);
    if (channelMatch) return { type: "channelId", value: channelMatch[1] };
    const userMatch = url.pathname.match(/\/user\/([\w\.-]+)/i);
    if (userMatch) return { type: "username", value: userMatch[1] };
    const handleMatch = url.pathname.match(/\/(@[\w\.-]+)/);
    if (handleMatch) return { type: "handle", value: handleMatch[1] };
    const customMatch = url.pathname.match(/\/c\/([\w\.-]+)/i);
    if (customMatch) return { type: "custom", value: customMatch[1] };
  } catch {
    const trimmed = rawUrl.trim();
    if (/^UC[\w-]+$/i.test(trimmed)) return { type: "channelId", value: trimmed };
    if (/^@[\w\.-]+$/.test(trimmed)) return { type: "handle", value: trimmed };
  }
  return { type: "unknown", value: rawUrl };
}

async function resolveChannelId(spec) {
  if (spec.type === "channelId") return spec.value;
  if (spec.type === "username") {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(spec.value)}&key=${API_KEY}`;
    const data = await fetchJson(url);
    if (data.items?.length) return data.items[0].id;
  }
  const q = spec.value.replace(/^@/, "");
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}&key=${API_KEY}`;
  const data = await fetchJson(url);
  if (data.items?.length) {
    return data.items[0].snippet?.channelId || data.items[0].id?.channelId;
  }
  throw new Error("Unable to resolve channel ID from the provided URL or handle.");
}

async function getChannelStats(channelId) {
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

async function getRecentVideos(channelId, maxResults = 50) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&type=video&maxResults=${maxResults}&key=${API_KEY}`;
  const data = await fetchJson(url);
  
  return (data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    publishedAt: item.snippet?.publishedAt
  })).filter(v => v.videoId);
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
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const input = (req.query.url || "").toString().trim();
    if (!input) return res.status(400).json({ error: "Missing 'url' query param (channel URL, handle, or channel ID)." });

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    const cacheKey = `growth::${input}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    
    // Get channel statistics
    const stats = await getChannelStats(channelId);
    
    // Get recent videos for upload pattern analysis
    const recentVideos = await getRecentVideos(channelId, 50);
    
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
    console.error(err);
    res.status(500).json({ error: err.message || "Unexpected server error." });
  }
}
