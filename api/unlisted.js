import { 
  consumeQuota, 
  fetchJson, 
  API_KEY,
  setCache,
  getCache,
  parseChannelIdFromUrl,
  resolveChannelId,
  setCorsHeaders,
  handleApiError,
  checkQuota
} from "../utils.js";

async function getChannelPlaylists(channelId) {
  const playlists = [];
  let pageToken = "";
  
  while (true) {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&channelId=${channelId}&maxResults=50&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await fetchJson(url);
    
    for (const item of data.items || []) {
      playlists.push({
        playlistId: item.id,
        title: item.snippet?.title || "Untitled Playlist",
        videoCount: item.contentDetails?.itemCount || 0
      });
    }
    
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (playlists.length >= 200) break; // Safety limit
  }
  
  return playlists;
}

async function getPlaylistVideos(playlistId) {
  const videos = [];
  let pageToken = "";
  
  while (true) {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&playlistId=${playlistId}&maxResults=50&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await fetchJson(url);
    
    for (const item of data.items || []) {
      const privacyStatus = item.status?.privacyStatus;
      const videoId = item.snippet?.resourceId?.videoId;
      
      if (privacyStatus === 'unlisted' && videoId) {
        videos.push({
          videoId: videoId,
          title: item.snippet?.title || "Untitled Video",
          publishedAt: item.snippet?.publishedAt,
          thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url
        });
      }
    }
    
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (videos.length >= 500) break; // Safety limit
  }
  
  return videos;
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

    // Check quota before starting (unlisted search can use many units)
    const quotaCheck = checkQuota(300);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    const cacheKey = `unlisted::${input}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    
    // Get all playlists from the channel
    const playlists = await getChannelPlaylists(channelId);
    
    if (!playlists.length) {
      const payload = { channelId, playlistCount: 0, unlistedVideos: [] };
      setCache(cacheKey, payload);
      return res.json(payload);
    }
    
    // Search through all playlists for unlisted videos
    const unlistedVideos = [];
    const seenVideoIds = new Set();
    
    for (const playlist of playlists) {
      try {
        const videos = await getPlaylistVideos(playlist.playlistId);
        
        for (const video of videos) {
          // Avoid duplicates
          if (!seenVideoIds.has(video.videoId)) {
            seenVideoIds.add(video.videoId);
            unlistedVideos.push({
              ...video,
              playlistTitle: playlist.title,
              playlistId: playlist.playlistId
            });
          }
        }
      } catch (err) {
        // Continue if one playlist fails
        console.error(`Error fetching playlist ${playlist.playlistId}:`, err.message);
      }
    }
    
    // Sort by publish date (newest first)
    unlistedVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    
    const payload = { 
      channelId, 
      playlistCount: playlists.length, 
      unlistedVideos 
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
