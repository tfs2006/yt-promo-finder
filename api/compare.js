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

async function analyzeChannel(input, sinceISO) {
  const spec = parseChannelIdFromUrl(input);
  const channelId = await resolveChannelId(spec);
  const uploadsId = await getUploadsPlaylistId(channelId);

  const recent = [];
  for await (const item of iterateUploads(uploadsId, sinceISO)) {
    recent.push(item);
    if (recent.length >= 500) break; // Limit for comparison to save quota
  }

  if (!recent.length) {
    return { channelId, videoCount: 0, sponsors: new Map() };
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

  // Extract sponsors
  const sponsors = new Map();
  for (const v of merged) {
    const lines = (v.description || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const urls = extractUrls(v.description);
    for (const u of urls) {
      const nurl = normalizeUrl(u);
      const dom = domainFromUrl(nurl);
      // Filter out social media
      if (/(patreon|instagram|twitter|x\.com|facebook|tiktok|threads\.net|linkedin|discord|paypal|buymeacoffee|linktr|linktree|beacons\.ai|bitly\.page|youtube\.com)/i.test(dom)) continue;
      
      const line = lines.find(L => L.includes(u)) || "";
      const productName = guessProductNameFromLine(line, u);
      const key = dom; // Use domain as the key for comparison
      
      if (!sponsors.has(key)) {
        sponsors.set(key, { 
          domain: dom, 
          url: nurl, 
          productName, 
          occurrences: 0, 
          videos: [] 
        });
      }
      const rec = sponsors.get(key);
      rec.occurrences += 1;
      if (rec.videos.length < 3) {
        rec.videos.push({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt });
      }
    }
  }

  return { channelId, videoCount: merged.length, sponsors };
}

async function getChannelInfo(channelId) {
  consumeQuota(1);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${API_KEY}`;
  const data = await fetchJson(url);
  if (data.items?.length) {
    return {
      title: data.items[0].snippet?.title || "Unknown",
      thumbnail: data.items[0].snippet?.thumbnails?.default?.url || ""
    };
  }
  return { title: "Unknown", thumbnail: "" };
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const channel1 = (req.query.channel1 || "").toString().trim();
    const channel2 = (req.query.channel2 || "").toString().trim();
    
    if (!channel1 || !channel2) {
      return res.status(400).json({ error: "Missing 'channel1' and/or 'channel2' query params." });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    // Check quota before starting (compare uses ~400+ units for both channels)
    const quotaCheck = checkQuota(500);
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

    // Check cache
    const cacheKey = `compare::${channel1}::${channel2}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    // Analyze both channels
    const [result1, result2] = await Promise.all([
      analyzeChannel(channel1, sinceISO),
      analyzeChannel(channel2, sinceISO)
    ]);

    // Get channel info
    const [info1, info2] = await Promise.all([
      getChannelInfo(result1.channelId),
      getChannelInfo(result2.channelId)
    ]);

    // Compare sponsors
    const domains1 = new Set(result1.sponsors.keys());
    const domains2 = new Set(result2.sponsors.keys());
    
    const sharedDomains = [...domains1].filter(d => domains2.has(d));
    const uniqueTo1 = [...domains1].filter(d => !domains2.has(d));
    const uniqueTo2 = [...domains2].filter(d => !domains1.has(d));
    
    const totalUnique = new Set([...domains1, ...domains2]).size;
    const overlapPercentage = totalUnique > 0 ? Math.round((sharedDomains.length / totalUnique) * 100) : 0;

    // Build sponsor lists with details
    const sharedSponsors = sharedDomains.map(d => ({
      domain: d,
      channel1: result1.sponsors.get(d),
      channel2: result2.sponsors.get(d)
    })).sort((a, b) => (b.channel1.occurrences + b.channel2.occurrences) - (a.channel1.occurrences + a.channel2.occurrences));

    const uniqueToChannel1 = uniqueTo1.map(d => result1.sponsors.get(d))
      .sort((a, b) => b.occurrences - a.occurrences);
    
    const uniqueToChannel2 = uniqueTo2.map(d => result2.sponsors.get(d))
      .sort((a, b) => b.occurrences - a.occurrences);

    const payload = {
      channel1: {
        id: result1.channelId,
        name: info1.title,
        thumbnail: info1.thumbnail,
        videoCount: result1.videoCount,
        sponsorCount: domains1.size
      },
      channel2: {
        id: result2.channelId,
        name: info2.title,
        thumbnail: info2.thumbnail,
        videoCount: result2.videoCount,
        sponsorCount: domains2.size
      },
      comparison: {
        sharedCount: sharedDomains.length,
        uniqueToChannel1Count: uniqueTo1.length,
        uniqueToChannel2Count: uniqueTo2.length,
        overlapPercentage,
        sharedSponsors: sharedSponsors.slice(0, 20),
        uniqueToChannel1: uniqueToChannel1.slice(0, 15),
        uniqueToChannel2: uniqueToChannel2.slice(0, 15)
      },
      sinceISO
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
