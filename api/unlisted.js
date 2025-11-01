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

async function getChannelPlaylists(channelId) {
  const playlists = [];
  let pageToken = "";
  
  while (true) {
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
    console.error(err);
    res.status(500).json({ error: err.message || "Unexpected server error." });
  }
}
