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
  checkQuota
} from "../utils.js";

async function getRecentVideoDescriptions(playlistId, maxResults = 50) {
  const videos = [];
  let pageToken = "";
  let fetched = 0;
  
  while (fetched < maxResults) {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await fetchJson(url);
    
    for (const item of data.items || []) {
      videos.push({
        videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
        title: item.snippet?.title,
        description: item.snippet?.description || "",
        publishedAt: item.snippet?.publishedAt
      });
      fetched++;
      if (fetched >= maxResults) break;
    }
    
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  
  return videos;
}

function extractChannelMentions(text) {
  const mentions = new Set();
  
  // Match @handles
  const handleMatches = text.match(/@[\w\.-]+/g) || [];
  handleMatches.forEach(h => mentions.add(h));
  
  // Match youtube.com/@handle
  const handleUrlMatches = text.match(/youtube\.com\/@([\w\.-]+)/gi) || [];
  handleUrlMatches.forEach(url => {
    const match = url.match(/@([\w\.-]+)/);
    if (match) mentions.add(`@${match[1]}`);
  });
  
  // Match youtube.com/channel/UC...
  const channelIdMatches = text.match(/youtube\.com\/channel\/(UC[\w-]+)/gi) || [];
  channelIdMatches.forEach(url => {
    const match = url.match(/channel\/(UC[\w-]+)/i);
    if (match) mentions.add(match[1]);
  });
  
  // Match youtube.com/c/CustomName
  const customMatches = text.match(/youtube\.com\/c\/([\w\.-]+)/gi) || [];
  customMatches.forEach(url => {
    const match = url.match(/\/c\/([\w\.-]+)/i);
    if (match) mentions.add(match[1]);
  });
  
  return Array.from(mentions);
}

async function resolveChannelInfo(mention) {
  try {
    // If it's a channel ID
    if (/^UC[\w-]+$/.test(mention)) {
      consumeQuota(1);
      const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${mention}&key=${API_KEY}`;
      const data = await fetchJson(url);
      if (data.items?.length) {
        const item = data.items[0];
        return {
          channelId: item.id,
          title: item.snippet?.title,
          handle: item.snippet?.customUrl || null,
          thumbnail: item.snippet?.thumbnails?.default?.url,
          subscriberCount: parseInt(item.statistics?.subscriberCount || 0)
        };
      }
    }
    
    // If it's a handle or custom name
    const cleanMention = mention.replace(/^@/, "");
    consumeQuota(100);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(cleanMention)}&key=${API_KEY}`;
    const data = await fetchJson(url);
    
    if (data.items?.length) {
      const item = data.items[0];
      const channelId = item.snippet?.channelId || item.id?.channelId;
      
      // Get full channel info
      consumeQuota(1);
      const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${API_KEY}`;
      const channelData = await fetchJson(channelUrl);
      
      if (channelData.items?.length) {
        const channelItem = channelData.items[0];
        return {
          channelId: channelItem.id,
          title: channelItem.snippet?.title,
          handle: channelItem.snippet?.customUrl || null,
          thumbnail: channelItem.snippet?.thumbnails?.default?.url,
          subscriberCount: parseInt(channelItem.statistics?.subscriberCount || 0)
        };
      }
    }
  } catch (err) {
    console.error(`Error resolving channel ${mention}:`, err.message);
  }
  
  return null;
}

export default async function handler(req, res) {
  // Enable CORS
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const input = (req.query.url || "").toString().trim();
    if (!input) return res.status(400).json({ error: "Missing 'url' query param (channel URL, handle, or channel ID)." });

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    // Check quota before starting (collab can use 2000+ units for resolving mentions)
    const quotaCheck = checkQuota(500);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    const cacheKey = `collab::${input}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);
    
    // Get recent video descriptions
    const videos = await getRecentVideoDescriptions(uploadsId, 100);
    
    // Extract all channel mentions
    const mentionCounts = {};
    const videosByMention = {};
    
    for (const video of videos) {
      const mentions = extractChannelMentions(video.description);
      
      for (const mention of mentions) {
        mentionCounts[mention] = (mentionCounts[mention] || 0) + 1;
        
        if (!videosByMention[mention]) {
          videosByMention[mention] = [];
        }
        videosByMention[mention].push({
          videoId: video.videoId,
          title: video.title,
          publishedAt: video.publishedAt
        });
      }
    }
    
    // Resolve channel information for top mentions
    const collaborations = [];
    const sortedMentions = Object.entries(mentionCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 20); // Top 20 most mentioned
    
    for (const [mention, count] of sortedMentions) {
      const channelInfo = await resolveChannelInfo(mention);
      
      if (channelInfo) {
        collaborations.push({
          ...channelInfo,
          mentionCount: count,
          videos: videosByMention[mention].slice(0, 5) // Show up to 5 videos
        });
      }
    }
    
    const payload = {
      channelId,
      videosAnalyzed: videos.length,
      collaborations
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
