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
  extractUrls,
  domainFromUrl,
  normalizeUrl,
  guessProductNameFromLine,
  iterateUploads,
  getVideoDetails,
  SOCIAL_MEDIA_FILTER,
  validateChannelInput,
  initQuota
} from "../utils.js";

// ============================================
// Link Checker Utilities
// ============================================

/**
 * Check if a URL matches the filter pattern
 * Supports: exact domain, subdomains (sub.domain.com), paths (domain.com/path)
 */
function matchesDomainFilter(url, filter) {
  if (!filter) return true;
  
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    const fullPath = hostname + parsedUrl.pathname.toLowerCase();
    const filterLower = filter.toLowerCase().replace(/^www\./, '');
    
    if (filterLower.includes('/')) {
      return fullPath.startsWith(filterLower) || fullPath.includes(filterLower);
    }
    if (hostname === filterLower) return true;
    if (hostname.endsWith('.' + filterLower)) return true;
    if (filterLower.endsWith('.' + hostname)) return true;
    if (hostname.includes(filterLower)) return true;
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is accessible (returns HTTP 2xx or 3xx)
 */
async function checkUrlStatus(url, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (response.status === 405) {
      const getController = new AbortController();
      const getTimeoutId = setTimeout(() => getController.abort(), timeout);
      
      response = await fetch(url, {
        method: 'GET',
        signal: getController.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      
      clearTimeout(getTimeoutId);
    }
    
    const working = response.status >= 200 && response.status < 400;
    const result = { working, status: response.status };
    
    if (response.url && response.url !== url) {
      result.redirectUrl = response.url;
    }
    
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === 'AbortError') {
      return { working: false, error: 'Timeout' };
    }
    
    const errorMessage = err.message || 'Unknown error';
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
      return { working: false, error: 'Domain not found' };
    }
    if (errorMessage.includes('ECONNREFUSED')) {
      return { working: false, error: 'Connection refused' };
    }
    if (errorMessage.includes('CERT') || errorMessage.includes('SSL')) {
      return { working: false, error: 'SSL certificate error' };
    }
    
    return { working: false, error: errorMessage.substring(0, 100) };
  }
}

/**
 * Process URLs in batches with concurrency limit
 */
async function checkUrlsBatch(urls, concurrency = 5, timeout = 10000) {
  const results = [];
  
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (urlInfo) => {
        const status = await checkUrlStatus(urlInfo.url, timeout);
        return { ...urlInfo, ...status };
      })
    );
    results.push(...batchResults);
  }
  
  return results;
}

// ============================================
// Promotion Analysis
// ============================================

async function analyzeDescriptions(videos) {
  const promotions = [];
  const byKey = new Map();
  for (const v of videos) {
    const lines = (v.description || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const urls = extractUrls(v.description);
    for (const u of urls) {
      const nurl = normalizeUrl(u);
      const dom = domainFromUrl(nurl);
      if (SOCIAL_MEDIA_FILTER.test(dom)) continue;
      const line = lines.find(L => L.includes(u)) || "";
      const productName = guessProductNameFromLine(line, u);
      const key = `${dom}::${productName || nurl}`;
      if (!byKey.has(key)) {
        byKey.set(key, { key, domain: dom, url: nurl, productName, occurrences: 0, videos: [] });
      }
      const rec = byKey.get(key);
      rec.occurrences += 1;
      rec.videos.push({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt });
    }
  }
  for (const rec of byKey.values()) promotions.push(rec);
  promotions.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    return (a.productName || "").localeCompare(b.productName || "");
  });
  return promotions;
}

export default async function handler(req, res) {
  // Enable CORS
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Initialize quota from persistent storage
  await initQuota();

  try {
    const rawInput = (req.query.url || "").toString();
    const mode = (req.query.mode || "").toString().toLowerCase();
    const validation = validateChannelInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid input." });
    }
    const input = validation.sanitized;

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    // Check quota before starting (analyze can use ~200+ units)
    const quotaCheck = checkQuota(200);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    // Link check mode
    if (mode === 'linkcheck') {
      return await handleLinkCheck(req, res, input);
    }

    // Default: Promotion analysis mode
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 1200) break;
    }
    
    if (!recent.length) {
      const payload = { channelId, sinceISO, videoCount: 0, promotions: [] };
      setCache(cacheKey, payload);
      return res.json(payload);
    }

    const details = await getVideoDetails(recent.map(v => v.videoId));
    const merged = recent.map(v => {
      const d = details.find(x => x.videoId === v.videoId);
      return { 
        videoId: v.videoId, 
        title: d?.title || v.title, 
        description: d?.description || "", 
        publishedAt: d?.publishedAt || v.publishedAt 
      };
    });

    const promotions = await analyzeDescriptions(merged);
    const payload = { channelId, sinceISO, videoCount: merged.length, promotions };
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}

// ============================================
// Link Check Handler
// ============================================

async function handleLinkCheck(req, res, input) {
  const domainFilter = (req.query.filter || "").toString().trim().toLowerCase();
  const checkLinks = req.query.check !== 'false';
  const maxVideos = Math.min(parseInt(req.query.maxVideos) || 500, 1000);
  const monthsBack = Math.min(parseInt(req.query.months) || 12, 36);

  // Calculate date range
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - monthsBack);
  const sinceISO = sinceDate.toISOString();

  // Resolve channel
  const spec = parseChannelIdFromUrl(input);
  const channelId = await resolveChannelId(spec);
  
  // Get channel info
  consumeQuota(1);
  const channelInfoUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${API_KEY}`;
  const channelData = await fetchJson(channelInfoUrl);
  const channelInfo = {
    id: channelId,
    title: channelData.items?.[0]?.snippet?.title || 'Unknown Channel',
    thumbnail: channelData.items?.[0]?.snippet?.thumbnails?.default?.url || ''
  };
  
  // Fetch videos
  const uploadsId = await getUploadsPlaylistId(channelId);
  const videos = [];
  for await (const item of iterateUploads(uploadsId, sinceISO)) {
    videos.push(item);
    if (videos.length >= maxVideos) break;
  }
  
  const videoCount = videos.length;
  
  if (!videos.length) {
    return res.json({
      channel: channelInfo,
      filter: domainFilter || null,
      sinceISO,
      videoCount: 0,
      totalLinks: 0,
      workingLinks: [],
      brokenLinks: [],
      summary: { working: 0, broken: 0, total: 0 }
    });
  }

  // Get video details (descriptions)
  const details = await getVideoDetails(videos.map(v => v.videoId));
  
  // Extract all URLs from descriptions
  const urlMap = new Map();
  
  for (const video of details) {
    const urls = extractUrls(video.description);
    
    for (const url of urls) {
      const domain = domainFromUrl(url);
      if (domain.includes('youtube.com') || domain.includes('youtu.be')) continue;
      
      if (domainFilter && !matchesDomainFilter(url, domainFilter)) continue;
      
      if (!urlMap.has(url)) {
        urlMap.set(url, { url, domain, videos: [] });
      }
      
      urlMap.get(url).videos.push({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt
      });
    }
  }
  
  let urlsToCheck = Array.from(urlMap.values());
  urlsToCheck.sort((a, b) => b.videos.length - a.videos.length);

  // Check link status if requested
  let workingLinks = [];
  let brokenLinks = [];
  
  if (checkLinks && urlsToCheck.length > 0) {
    const maxLinksToCheck = Math.min(urlsToCheck.length, 100);
    const linksToCheck = urlsToCheck.slice(0, maxLinksToCheck);
    
    const checkedLinks = await checkUrlsBatch(linksToCheck, 5, 8000);
    
    workingLinks = checkedLinks.filter(l => l.working);
    brokenLinks = checkedLinks.filter(l => !l.working);
    
    if (urlsToCheck.length > maxLinksToCheck) {
      const unchecked = urlsToCheck.slice(maxLinksToCheck).map(l => ({
        ...l,
        working: null,
        status: null,
        unchecked: true
      }));
      workingLinks.push(...unchecked);
    }
  } else {
    workingLinks = urlsToCheck.map(l => ({ ...l, working: null, unchecked: true }));
  }

  const payload = {
    channel: channelInfo,
    filter: domainFilter || null,
    sinceISO,
    videoCount,
    totalLinks: urlsToCheck.length,
    checkedLinks: checkLinks ? Math.min(urlsToCheck.length, 100) : 0,
    workingLinks: workingLinks.map(l => ({
      url: l.url,
      domain: l.domain,
      status: l.status,
      redirectUrl: l.redirectUrl,
      occurrences: l.videos.length,
      videos: l.videos.slice(0, 5),
      unchecked: l.unchecked || false
    })),
    brokenLinks: brokenLinks.map(l => ({
      url: l.url,
      domain: l.domain,
      status: l.status,
      error: l.error,
      occurrences: l.videos.length,
      videos: l.videos.slice(0, 5)
    })),
    summary: {
      working: workingLinks.length,
      broken: brokenLinks.length,
      total: urlsToCheck.length
    }
  };

  res.json(payload);
}
}
