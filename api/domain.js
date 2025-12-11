import { consumeQuota, fetchJson, API_KEY } from "../utils.js";

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

function normalizeDomain(input) {
  let domain = input.trim().toLowerCase();
  // Remove protocol if present
  domain = domain.replace(/^https?:\/\//, '');
  // Remove www. prefix
  domain = domain.replace(/^www\./, '');
  // Remove trailing slash and path
  domain = domain.split('/')[0];
  // Remove port if present
  domain = domain.split(':')[0];
  return domain;
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
    const input = (req.query.domain || "").toString().trim();
    if (!input) {
      return res.status(400).json({ error: "Missing 'domain' query param (e.g., amazon.com, gfuel.com)." });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    const domain = normalizeDomain(input);
    if (!domain || domain.length < 3) {
      return res.status(400).json({ error: "Invalid domain provided." });
    }

    // Check cache
    const cacheKey = `domain::${domain}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    // Search YouTube for videos mentioning this domain
    const videos = [];
    let pageToken = "";
    const maxPages = 5; // Limit to prevent excessive API usage
    let pagesSearched = 0;

    while (pagesSearched < maxPages) {
      consumeQuota(100); // Search costs 100 units
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&q="${encodeURIComponent(domain)}"&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
      
      const searchData = await fetchJson(searchUrl);
      const items = searchData.items || [];
      
      if (items.length === 0) break;

      // Get video IDs to fetch full descriptions
      const videoIds = items.map(it => it.id?.videoId).filter(Boolean);
      
      if (videoIds.length > 0) {
        consumeQuota(1);
        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds.join(",")}&key=${API_KEY}`;
        const detailsData = await fetchJson(detailsUrl);
        
        for (const video of detailsData.items || []) {
          const description = (video.snippet?.description || "").toLowerCase();
          // Check if the domain actually appears in the description
          if (description.includes(domain) || description.includes(`www.${domain}`)) {
            videos.push({
              videoId: video.id,
              title: video.snippet?.title || "",
              channelTitle: video.snippet?.channelTitle || "",
              channelId: video.snippet?.channelId || "",
              publishedAt: video.snippet?.publishedAt || "",
              thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || "",
              viewCount: parseInt(video.statistics?.viewCount || "0", 10),
              description: video.snippet?.description || ""
            });
          }
        }
      }

      pageToken = searchData.nextPageToken;
      pagesSearched++;
      
      if (!pageToken) break;
      
      // Stop if we have enough results
      if (videos.length >= 100) break;
    }

    // Sort by view count (most popular first)
    videos.sort((a, b) => b.viewCount - a.viewCount);

    // Limit to top 50 results
    const topVideos = videos.slice(0, 50);

    const payload = {
      domain,
      videoCount: topVideos.length,
      totalFound: videos.length,
      videos: topVideos.map(v => ({
        videoId: v.videoId,
        title: v.title,
        channelTitle: v.channelTitle,
        channelId: v.channelId,
        publishedAt: v.publishedAt,
        thumbnail: v.thumbnail,
        viewCount: v.viewCount
      }))
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Unexpected server error." });
  }
}
