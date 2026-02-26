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
  iterateUploads,
  getVideoDetails,
  validateChannelInput,
  initQuota
} from "../utils.js";

/**
 * Check if a URL matches the filter pattern
 * Supports: exact domain, subdomains (sub.domain.com), paths (domain.com/path)
 * @param {string} url - The full URL to check
 * @param {string} filter - The filter pattern (optional)
 * @returns {boolean}
 */
function matchesDomainFilter(url, filter) {
  if (!filter) return true;
  
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    const fullPath = hostname + parsedUrl.pathname.toLowerCase();
    const filterLower = filter.toLowerCase().replace(/^www\./, '');
    
    // Check for path-based filter (e.g., "domain.com/affiliate")
    if (filterLower.includes('/')) {
      return fullPath.startsWith(filterLower) || fullPath.includes(filterLower);
    }
    
    // Check for exact domain match
    if (hostname === filterLower) return true;
    
    // Check for subdomain match (e.g., "sub.domain.com" matches filter "domain.com")
    if (hostname.endsWith('.' + filterLower)) return true;
    
    // Check if filter is a subdomain pattern (e.g., filter "sub.domain.com")
    if (filterLower.endsWith('.' + hostname)) return true;
    if (hostname.includes(filterLower)) return true;
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is accessible (returns HTTP 2xx or 3xx)
 * @param {string} url - URL to check
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{working: boolean, status?: number, error?: string, redirectUrl?: string}>}
 */
async function checkUrlStatus(url, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Try HEAD request first (faster, less bandwidth)
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
    
    // Some servers don't support HEAD, try GET if we get 405
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
    const result = {
      working,
      status: response.status
    };
    
    // Capture redirect URL if different from original
    if (response.url && response.url !== url) {
      result.redirectUrl = response.url;
    }
    
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === 'AbortError') {
      return { working: false, error: 'Timeout' };
    }
    
    // Handle specific error types
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

export default async function handler(req, res) {
  // Enable CORS
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Initialize quota from persistent storage
  await initQuota();

  try {
    // Parse input parameters
    const rawInput = (req.query.url || "").toString();
    const domainFilter = (req.query.filter || "").toString().trim().toLowerCase();
    const checkLinks = req.query.check !== 'false'; // Default to checking links
    const maxVideos = Math.min(parseInt(req.query.maxVideos) || 500, 1000);
    const monthsBack = Math.min(parseInt(req.query.months) || 12, 36);
    
    // Validate channel input
    const validation = validateChannelInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid channel URL." });
    }
    const input = validation.sanitized;

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    // Check quota before starting (link check uses ~200+ units for channel data)
    const quotaCheck = checkQuota(200);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    // Calculate date range
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - monthsBack);
    const sinceISO = sinceDate.toISOString();

    // Check cache (cache without link status for faster subsequent scans)
    const cacheKey = `linkcheck::${input}::${domainFilter}::${monthsBack}`;
    const cached = getCache(cacheKey);
    
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
    
    let urlsToCheck;
    let videoCount;
    
    if (cached && !checkLinks) {
      // Return cached URL data without re-checking
      return res.json({ fromCache: true, ...cached, channel: channelInfo });
    }
    
    // Fetch fresh data
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Collect videos
    const videos = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      videos.push(item);
      if (videos.length >= maxVideos) break;
    }
    
    videoCount = videos.length;
    
    if (!videos.length) {
      return res.json({
        channel: channelInfo,
        filter: domainFilter || null,
        sinceISO,
        videoCount: 0,
        totalLinks: 0,
        workingLinks: [],
        brokenLinks: [],
        summary: {
          working: 0,
          broken: 0,
          filtered: 0
        }
      });
    }

    // Get video details (descriptions)
    const details = await getVideoDetails(videos.map(v => v.videoId));
    
    // Extract all URLs from descriptions
    const urlMap = new Map(); // Use map to deduplicate URLs
    
    for (const video of details) {
      const urls = extractUrls(video.description);
      
      for (const url of urls) {
        // Skip YouTube links (internal)
        const domain = domainFromUrl(url);
        if (domain.includes('youtube.com') || domain.includes('youtu.be')) continue;
        
        // Apply domain filter if specified
        if (domainFilter && !matchesDomainFilter(url, domainFilter)) continue;
        
        if (!urlMap.has(url)) {
          urlMap.set(url, {
            url,
            domain,
            videos: []
          });
        }
        
        urlMap.get(url).videos.push({
          videoId: video.videoId,
          title: video.title,
          publishedAt: video.publishedAt
        });
      }
    }
    
    urlsToCheck = Array.from(urlMap.values());
    
    // Sort by number of occurrences (most common first)
    urlsToCheck.sort((a, b) => b.videos.length - a.videos.length);

    // Check link status if requested
    let workingLinks = [];
    let brokenLinks = [];
    
    if (checkLinks && urlsToCheck.length > 0) {
      // Limit number of links to check to prevent timeout
      const maxLinksToCheck = Math.min(urlsToCheck.length, 100);
      const linksToCheck = urlsToCheck.slice(0, maxLinksToCheck);
      
      const checkedLinks = await checkUrlsBatch(linksToCheck, 5, 8000);
      
      workingLinks = checkedLinks.filter(l => l.working);
      brokenLinks = checkedLinks.filter(l => !l.working);
      
      // Add unchecked links to working (assume working if not checked)
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
      // Return without checking
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
        videos: l.videos.slice(0, 5), // Limit videos per link
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

    // Cache the URL data (without status) for faster subsequent lookups
    if (!domainFilter) {
      setCache(cacheKey, {
        videoCount,
        totalLinks: urlsToCheck.length,
        urls: urlsToCheck.slice(0, 200) // Cache first 200 unique URLs
      });
    }

    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
