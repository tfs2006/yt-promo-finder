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

// Known sponsor/affiliate domain patterns
const KNOWN_SPONSORS = new Map([
  ['squarespace.com', { name: 'Squarespace', category: 'Website Builder', icon: '🌐' }],
  ['audible.com', { name: 'Audible', category: 'Audiobooks', icon: '🎧' }],
  ['audible.co.uk', { name: 'Audible', category: 'Audiobooks', icon: '🎧' }],
  ['nordvpn.com', { name: 'NordVPN', category: 'VPN', icon: '🔒' }],
  ['expressvpn.com', { name: 'ExpressVPN', category: 'VPN', icon: '🔒' }],
  ['surfshark.com', { name: 'Surfshark', category: 'VPN', icon: '🔒' }],
  ['privatevpn.com', { name: 'PrivateVPN', category: 'VPN', icon: '🔒' }],
  ['skillshare.com', { name: 'Skillshare', category: 'Education', icon: '📚' }],
  ['brilliant.org', { name: 'Brilliant', category: 'Education', icon: '💡' }],
  ['curiositystream.com', { name: 'CuriosityStream', category: 'Education', icon: '🎓' }],
  ['nebula.tv', { name: 'Nebula', category: 'Streaming', icon: '🌌' }],
  ['nebula.app', { name: 'Nebula', category: 'Streaming', icon: '🌌' }],
  ['raid.com', { name: 'Raid Shadow Legends', category: 'Gaming', icon: '🎮' }],
  ['plarium.com', { name: 'Raid Shadow Legends', category: 'Gaming', icon: '🎮' }],
  ['betterhelp.com', { name: 'BetterHelp', category: 'Mental Health', icon: '🧠' }],
  ['hellofresh.com', { name: 'HelloFresh', category: 'Meal Kits', icon: '🍽️' }],
  ['factor75.com', { name: 'Factor', category: 'Meal Kits', icon: '🥗' }],
  ['factormeals.com', { name: 'Factor', category: 'Meal Kits', icon: '🥗' }],
  ['manscaped.com', { name: 'Manscaped', category: 'Personal Care', icon: '✂️' }],
  ['keeps.com', { name: 'Keeps', category: 'Personal Care', icon: '💇' }],
  ['hims.com', { name: 'Hims', category: 'Personal Care', icon: '💊' }],
  ['athletic-greens.com', { name: 'AG1', category: 'Health', icon: '🥬' }],
  ['athleticgreens.com', { name: 'AG1', category: 'Health', icon: '🥬' }],
  ['drinkag1.com', { name: 'AG1', category: 'Health', icon: '🥬' }],
  ['shopify.com', { name: 'Shopify', category: 'E-commerce', icon: '🛒' }],
  ['wix.com', { name: 'Wix', category: 'Website Builder', icon: '🌐' }],
  ['honey.com', { name: 'Honey', category: 'Shopping', icon: '🍯' }],
  ['joinhoney.com', { name: 'Honey', category: 'Shopping', icon: '🍯' }],
  ['raycon.com', { name: 'Raycon', category: 'Electronics', icon: '🎵' }],
  ['ridge.com', { name: 'Ridge Wallet', category: 'Accessories', icon: '👛' }],
  ['dbrand.com', { name: 'dbrand', category: 'Tech Accessories', icon: '📱' }],
  ['glasswire.com', { name: 'GlassWire', category: 'Software', icon: '🔥' }],
  ['lastpass.com', { name: 'LastPass', category: 'Software', icon: '🔐' }],
  ['1password.com', { name: '1Password', category: 'Software', icon: '🔐' }],
  ['dashlane.com', { name: 'Dashlane', category: 'Software', icon: '🔐' }],
  ['privateinternetaccess.com', { name: 'PIA VPN', category: 'VPN', icon: '🔒' }],
  ['casetify.com', { name: 'Casetify', category: 'Phone Cases', icon: '📱' }],
  ['established.titles', { name: 'Established Titles', category: 'Novelty', icon: '👑' }],
  ['operagx.gg', { name: 'Opera GX', category: 'Software', icon: '🌐' }],
  ['opera.com', { name: 'Opera', category: 'Software', icon: '🌐' }],
  ['linqto.com', { name: 'Linqto', category: 'Finance', icon: '💰' }],
  ['fundrise.com', { name: 'Fundrise', category: 'Finance', icon: '🏠' }],
  ['public.com', { name: 'Public', category: 'Finance', icon: '📈' }],
  ['trading212.com', { name: 'Trading 212', category: 'Finance', icon: '📊' }],
  ['grammarly.com', { name: 'Grammarly', category: 'Software', icon: '✍️' }],
  ['incogni.com', { name: 'Incogni', category: 'Privacy', icon: '🕵️' }],
  ['aura.com', { name: 'Aura', category: 'Security', icon: '🛡️' }],
  ['deleteme.com', { name: 'DeleteMe', category: 'Privacy', icon: '🗑️' }],
  ['ground.news', { name: 'Ground News', category: 'News', icon: '📰' }],
  ['anker.com', { name: 'Anker', category: 'Electronics', icon: '🔋' }],
  ['lttstore.com', { name: 'LTT Store', category: 'Merchandise', icon: '👕' }],
  ['seatgeek.com', { name: 'SeatGeek', category: 'Tickets', icon: '🎫' }],
  ['stamps.com', { name: 'Stamps.com', category: 'Shipping', icon: '📬' }],
  ['warbyparker.com', { name: 'Warby Parker', category: 'Eyewear', icon: '👓' }],
  ['zenni.com', { name: 'Zenni Optical', category: 'Eyewear', icon: '👓' }],
  ['zennioptical.com', { name: 'Zenni Optical', category: 'Eyewear', icon: '👓' }],
  ['mvmt.com', { name: 'MVMT', category: 'Watches', icon: '⌚' }],
  ['vincero.com', { name: 'Vincero', category: 'Watches', icon: '⌚' }],
  ['dollar-shave-club.com', { name: 'Dollar Shave Club', category: 'Personal Care', icon: '🪒' }],
  ['dollarshaveclub.com', { name: 'Dollar Shave Club', category: 'Personal Care', icon: '🪒' }],
  ['harrys.com', { name: "Harry's", category: 'Personal Care', icon: '🪒' }],
  ['meundies.com', { name: 'MeUndies', category: 'Apparel', icon: '👙' }],
  ['blinkist.com', { name: 'Blinkist', category: 'Education', icon: '📖' }],
  ['expressvpn.com', { name: 'ExpressVPN', category: 'VPN', icon: '🔒' }],
]);

// Normalize brand names
function normalizeBrandName(name, domain) {
  // Check known sponsors first
  const known = KNOWN_SPONSORS.get(domain);
  if (known) return known.name;
  
  // Try to clean up product name
  if (!name) return null;
  
  // Remove common suffixes
  let cleaned = name
    .replace(/\s*(promo|code|link|discount|deal|offer|sponsor|ad)\s*/gi, '')
    .replace(/[^\w\s-]/g, '')
    .trim();
    
  return cleaned || null;
}

// Calculate loyalty metrics
function calculateLoyaltyScore(sponsor) {
  const { occurrences, firstSeen, lastSeen, gapDays } = sponsor;
  
  // More occurrences = higher loyalty
  const occurrenceScore = Math.min(occurrences * 10, 40);
  
  // Longer partnership = higher loyalty
  const durationDays = (new Date(lastSeen) - new Date(firstSeen)) / (1000 * 60 * 60 * 24);
  const durationScore = Math.min(durationDays / 10, 30);
  
  // Lower gap = more consistent = higher loyalty
  const avgGap = gapDays.length > 0 ? gapDays.reduce((a, b) => a + b, 0) / gapDays.length : 0;
  const consistencyScore = avgGap < 30 ? 30 : avgGap < 60 ? 20 : avgGap < 90 ? 10 : 5;
  
  return Math.round(occurrenceScore + durationScore + consistencyScore);
}

// Get loyalty tier based on score
function getLoyaltyTier(score) {
  if (score >= 80) return { tier: 'Elite Partner', color: 'emerald', icon: '👑' };
  if (score >= 60) return { tier: 'Long-term Partner', color: 'blue', icon: '🤝' };
  if (score >= 40) return { tier: 'Regular Partner', color: 'violet', icon: '💼' };
  if (score >= 20) return { tier: 'Occasional Partner', color: 'amber', icon: '🔄' };
  return { tier: 'One-time Sponsor', color: 'slate', icon: '📍' };
}

// Analyze sponsorship patterns
async function analyzeSponsors(videos) {
  const sponsorMap = new Map();
  
  for (const v of videos) {
    const lines = (v.description || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const urls = extractUrls(v.description);
    const videoDate = new Date(v.publishedAt);
    
    for (const u of urls) {
      const nurl = normalizeUrl(u);
      const dom = domainFromUrl(nurl);
      
      // Skip social media
      if (SOCIAL_MEDIA_FILTER.test(dom)) continue;
      
      // Get the line context
      const line = lines.find(L => L.includes(u)) || "";
      const productName = guessProductNameFromLine(line, u);
      
      // Normalize brand name
      const knownSponsor = KNOWN_SPONSORS.get(dom);
      const brandName = knownSponsor?.name || normalizeBrandName(productName, dom) || dom;
      const category = knownSponsor?.category || 'Unknown';
      const icon = knownSponsor?.icon || '🔗';
      
      // Use brand name as key for grouping
      const key = brandName.toLowerCase();
      
      if (!sponsorMap.has(key)) {
        sponsorMap.set(key, {
          brandName,
          category,
          icon,
          domain: dom,
          occurrences: 0,
          videos: [],
          firstSeen: v.publishedAt,
          lastSeen: v.publishedAt,
          dates: [],
          urls: new Set()
        });
      }
      
      const sponsor = sponsorMap.get(key);
      
      // Only count once per video
      if (!sponsor.videos.find(x => x.videoId === v.videoId)) {
        sponsor.occurrences++;
        sponsor.videos.push({
          videoId: v.videoId,
          title: v.title,
          publishedAt: v.publishedAt,
          viewCount: v.viewCount
        });
        sponsor.dates.push(videoDate);
        
        // Update first/last seen
        if (new Date(v.publishedAt) < new Date(sponsor.firstSeen)) {
          sponsor.firstSeen = v.publishedAt;
        }
        if (new Date(v.publishedAt) > new Date(sponsor.lastSeen)) {
          sponsor.lastSeen = v.publishedAt;
        }
      }
      
      sponsor.urls.add(nurl);
    }
  }
  
  // Convert to array and calculate metrics
  const sponsors = [];
  
  for (const [key, sponsor] of sponsorMap.entries()) {
    // Sort dates chronologically
    sponsor.dates.sort((a, b) => a - b);
    
    // Calculate gaps between sponsorships
    const gapDays = [];
    for (let i = 1; i < sponsor.dates.length; i++) {
      const gap = (sponsor.dates[i] - sponsor.dates[i-1]) / (1000 * 60 * 60 * 24);
      gapDays.push(Math.round(gap));
    }
    
    // Calculate average views
    const avgViews = sponsor.videos.length > 0 
      ? Math.round(sponsor.videos.reduce((sum, v) => sum + (v.viewCount || 0), 0) / sponsor.videos.length)
      : 0;
    
    // Calculate loyalty score
    const loyaltyScore = calculateLoyaltyScore({ ...sponsor, gapDays });
    const loyaltyTier = getLoyaltyTier(loyaltyScore);
    
    // Calculate partnership duration
    const durationDays = Math.round((new Date(sponsor.lastSeen) - new Date(sponsor.firstSeen)) / (1000 * 60 * 60 * 24));
    
    sponsors.push({
      brandName: sponsor.brandName,
      category: sponsor.category,
      icon: sponsor.icon,
      domain: sponsor.domain,
      occurrences: sponsor.occurrences,
      firstSeen: sponsor.firstSeen,
      lastSeen: sponsor.lastSeen,
      durationDays,
      avgGapDays: gapDays.length > 0 ? Math.round(gapDays.reduce((a, b) => a + b, 0) / gapDays.length) : 0,
      avgViews,
      loyaltyScore,
      loyaltyTier: loyaltyTier.tier,
      tierColor: loyaltyTier.color,
      tierIcon: loyaltyTier.icon,
      videos: sponsor.videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      urls: Array.from(sponsor.urls)
    });
  }
  
  // Sort by loyalty score, then occurrences
  sponsors.sort((a, b) => {
    if (b.loyaltyScore !== a.loyaltyScore) return b.loyaltyScore - a.loyaltyScore;
    return b.occurrences - a.occurrences;
  });
  
  return sponsors;
}

// Generate summary statistics
function generateSummary(sponsors, totalVideos) {
  const totalSponsors = sponsors.length;
  const recurringSponsors = sponsors.filter(s => s.occurrences >= 2).length;
  const loyalSponsors = sponsors.filter(s => s.occurrences >= 3).length;
  const elitePartners = sponsors.filter(s => s.loyaltyScore >= 80).length;
  
  // Calculate sponsorship frequency
  const totalSponsorships = sponsors.reduce((sum, s) => sum + s.occurrences, 0);
  const sponsorshipRate = totalVideos > 0 ? Math.round((totalSponsorships / totalVideos) * 100) : 0;
  
  // Find top categories
  const categoryCount = {};
  for (const s of sponsors) {
    categoryCount[s.category] = (categoryCount[s.category] || 0) + s.occurrences;
  }
  const topCategories = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));
  
  // Overall loyalty assessment
  let loyaltyAssessment;
  if (elitePartners >= 3) {
    loyaltyAssessment = 'Excellent brand loyalty with multiple elite partnerships';
  } else if (loyalSponsors >= 3) {
    loyaltyAssessment = 'Strong repeat partnerships indicating reliable collaboration';
  } else if (recurringSponsors >= 2) {
    loyaltyAssessment = 'Moderate loyalty with some recurring sponsors';
  } else {
    loyaltyAssessment = 'Limited repeat partnerships observed';
  }
  
  return {
    totalSponsors,
    recurringSponsors,
    loyalSponsors,
    elitePartners,
    totalSponsorships,
    sponsorshipRate,
    topCategories,
    loyaltyAssessment
  };
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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

    const quotaCheck = checkQuota(200);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    // Analyze last 12 months of content
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `loyalty::${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Get channel info
    consumeQuota(1);
    const channelData = await fetchJson(
      `https://www.googleapis.com/youtube/v3/channels?key=${API_KEY}&id=${channelId}&part=snippet,statistics`
    );
    const channelInfo = channelData.items?.[0];
    const channelName = channelInfo?.snippet?.title || 'Unknown Channel';
    const channelThumbnail = channelInfo?.snippet?.thumbnails?.medium?.url || '';
    const subscriberCount = parseInt(channelInfo?.statistics?.subscriberCount || 0);

    // Fetch recent videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 500) break;
    }
    
    if (!recent.length) {
      const payload = { 
        channelId, 
        channelName,
        channelThumbnail,
        subscriberCount,
        sinceISO, 
        videoCount: 0, 
        sponsors: [],
        summary: generateSummary([], 0),
        disclaimer: "No videos found in the last 12 months."
      };
      setCache(cacheKey, payload);
      return res.json(payload);
    }

    // Get video details including view counts
    const details = await getVideoDetails(recent.map(v => v.videoId));
    const merged = recent.map(v => {
      const d = details.find(x => x.videoId === v.videoId);
      return { 
        videoId: v.videoId, 
        title: d?.title || v.title, 
        description: d?.description || "", 
        publishedAt: d?.publishedAt || v.publishedAt,
        viewCount: parseInt(d?.viewCount || 0)
      };
    });

    // Analyze sponsors
    const sponsors = await analyzeSponsors(merged);
    const summary = generateSummary(sponsors, merged.length);

    const payload = { 
      channelId, 
      channelName,
      channelThumbnail,
      subscriberCount,
      sinceISO, 
      videoCount: merged.length, 
      sponsors,
      summary,
      disclaimer: "Loyalty scores are estimates based on link frequency. Long-term partnerships may include unpaid mentions or affiliate relationships, not just paid sponsorships."
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
