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

async function* iterateUploads(playlistId, sinceISO) {
  let pageToken = "";
  const since = new Date(sinceISO);
  while (true) {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await fetchJson(url);
    const items = data.items || [];
    for (const it of items) {
      const publishedAt = it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt;
      if (!publishedAt) continue;
      const d = new Date(publishedAt);
      if (d < since) return;
      yield {
        videoId: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId,
        title: it.snippet?.title,
        publishedAt
      };
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
}

async function getVideoDetails(videoIds) {
  const details = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${chunk.join(",")}&key=${API_KEY}`;
    const data = await fetchJson(url);
    for (const it of data.items || []) {
      details.push({
        videoId: it.id,
        title: it.snippet?.title || "",
        description: it.snippet?.description || "",
        publishedAt: it.snippet?.publishedAt
      });
    }
  }
  return details;
}

function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s)\]>"']+)/gi;
  const matches = text.match(urlRegex) || [];
  return matches.map(u => u.replace(/[)\],.;:"'!\?\s]+$/, ""));
}

function domainFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return "unknown"; }
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    const toRemove = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","tag","ascsubtag","source","ref","aff","aff_id","affid"];
    for (const k of toRemove) x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}

function guessProductNameFromLine(line, url) {
  const idx = line.indexOf(url);
  const before = idx > -1 ? line.slice(0, idx).trim() : line.trim();
  const parts = before.split(/[:\-–]|\\|/).map(s => s.trim()).filter(Boolean);
  if (parts.length) {
    const guess = parts[parts.length - 1];
    if (guess.length >= 3 && !/^(link|product|buy|amazon|gear)$/i.test(guess)) return guess;
  }
  return "";
}

async function analyzeDescriptions(videos) {
  const promotions = [];
  const byKey = new Map();
  for (const v of videos) {
    const lines = (v.description || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const urls = extractUrls(v.description);
    for (const u of urls) {
      const nurl = normalizeUrl(u);
      const dom = domainFromUrl(nurl);
      if (/(patreon|instagram|twitter|x\.com|facebook|tiktok|threads\.net|linkedin|discord|paypal|buymeacoffee|linktr|linktree|beacons\.ai|bitly\.page)/i.test(dom)) continue;
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

  try {
    const input = (req.query.url || "").toString().trim();
    if (!input) return res.status(400).json({ error: "Missing 'url' query param (channel URL, handle, or channel ID)." });

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
