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
