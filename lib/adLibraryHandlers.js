import { applyApiGuards } from "../utils.js";

const MAX_QUERY_LENGTH = 140;
const DEFAULT_REGION = "US";

function sanitizeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function sanitizeRegion(value) {
  const normalized = sanitizeText(value).toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return DEFAULT_REGION;
  return normalized;
}

function buildLibraries(query, region) {
  const encodedQuery = encodeURIComponent(query);
  const encodedRegion = encodeURIComponent(region);

  return [
    {
      id: "meta",
      name: "Meta Ad Library",
      network: "Facebook / Instagram",
      description: "Search active and inactive ads from Meta properties.",
      url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&q=${encodedQuery}&search_type=keyword_unordered`
    },
    {
      id: "google",
      name: "Google Ads Transparency",
      network: "Google",
      description: "Search active ads shown across Google services.",
      url: `https://adstransparency.google.com/?region=${encodedRegion}&searchTerm=${encodedQuery}`
    },
    {
      id: "linkedin",
      name: "LinkedIn Ad Library",
      network: "LinkedIn",
      description: "Search paid social ads published on LinkedIn.",
      url: `https://www.linkedin.com/ad-library/search?keywords=${encodedQuery}`
    },
    {
      id: "tiktok",
      name: "TikTok Creative Center",
      network: "TikTok",
      description: "Explore top ad creatives and trends on TikTok.",
      url: `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?search=${encodedQuery}&period=30`
    },
    {
      id: "reddit",
      name: "Reddit Ads Transparency",
      network: "Reddit",
      description: "Search ads and advertisers currently visible on Reddit.",
      url: `https://www.reddit.com/ads-transparency/?q=${encodedQuery}`
    },
    {
      id: "youtube-paid",
      name: "YouTube Paid Promotions",
      network: "YouTube",
      description: "Review paid promotions related to your search query.",
      url: `https://www.youtube.com/results?sv=1&search_query=${encodedQuery}`
    }
  ];
}

export async function handleAdLibrariesSearch(req, res) {
  if (applyApiGuards(req, res, { rateKey: "ad-libraries", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const query = sanitizeText(req.query.query || "");
  const region = sanitizeRegion(req.query.region || DEFAULT_REGION);

  if (!query) {
    return res.status(400).json({ error: "Search query is required." });
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: "Search query is too long." });
  }

  const libraries = buildLibraries(query, region);

  return res.status(200).json({
    query,
    region,
    libraries,
    notes: [
      "Results, filters, and history vary by library.",
      "Some libraries may require login or additional verification.",
      "Use advertiser name, domain, or exact brand spelling for best matching."
    ]
  });
}
