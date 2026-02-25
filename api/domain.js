import { 
  consumeQuota, 
  fetchJson, 
  API_KEY,
  setCache,
  getCache,
  setCorsHeaders,
  handleApiError,
  checkQuota,
  validateDomainInput,
  initQuota
} from "../utils.js";

export default async function handler(req, res) {
  // Enable CORS
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Initialize quota from persistent storage
  await initQuota();

  try {
    const rawInput = (req.query.domain || "").toString();
    const validation = validateDomainInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid domain." });
    }
    const domain = validation.sanitized;

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    // Check quota before starting (domain search uses 500+ units)
    const quotaCheck = checkQuota(600);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
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
    return handleApiError(res, err);
  }
}
