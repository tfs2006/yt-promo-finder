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
  iterateUploads,
  getVideoDetails,
  validateChannelInput,
  initQuota
} from "../utils.js";

// Common stop words to filter out
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because',
  'until', 'while', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our',
  'ours', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'new', 'now', 'get', 'got', 'like', 'make', 'made', 'going',
  'go', 'gone', 'come', 'came', 'see', 'seen', 'look', 'take', 'took', 'taken', 'know', 'known',
  'think', 'thought', 'want', 'wanted', 'say', 'said', 'tell', 'told', 'use', 'using', 'also',
  'back', 'even', 'still', 'way', 'well', 'first', 'last', 'long', 'great', 'little', 'own',
  'right', 'best', 'better', 'biggest', 'ever', 'every', 'must', 'much', 'never', 'really',
  'thing', 'things', 'something', 'anything', 'everything', 'nothing', 'someone', 'anyone',
  'everyone', 'time', 'year', 'years', 'day', 'days', 'week', 'month', 'video', 'videos',
  'channel', 'subscribe', 'subscribed', 'like', 'likes', 'comment', 'comments', 'watch',
  'watching', 'watched', 'part', 'episode', 'ep', 'official', 'full', 'HD', '4k', '1080p'
]);

// Category definitions with keywords
const CATEGORIES = {
  tech: {
    name: 'Technology',
    icon: '💻',
    keywords: ['tech', 'phone', 'laptop', 'computer', 'app', 'apps', 'software', 'gadget', 'review', 'unbox', 'unboxing', 'setup', 'iphone', 'android', 'mac', 'windows', 'coding', 'programming', 'developer', 'apple', 'samsung', 'google', 'ai', 'artificial intelligence', 'machine learning', 'robot', 'automation', 'smart', 'device', 'devices', 'cpu', 'gpu', 'ram', 'ssd', 'monitor', 'keyboard', 'mouse', 'headphones', 'earbuds', 'wireless', 'bluetooth', 'wifi', '5g'],
    brands: ['Apple', 'Samsung', 'Google', 'Microsoft', 'Adobe', 'Intel', 'AMD', 'NVIDIA', 'Sony', 'Dell', 'HP', 'Razer', 'Logitech']
  },
  gaming: {
    name: 'Gaming',
    icon: '🎮',
    keywords: ['game', 'gaming', 'gamer', 'playthrough', 'walkthrough', 'gameplay', 'stream', 'streaming', 'twitch', 'fps', 'mmorpg', 'esports', 'minecraft', 'fortnite', 'cod', 'call of duty', 'gta', 'apex', 'valorant', 'league', 'dota', 'csgo', 'overwatch', 'pokemon', 'nintendo', 'playstation', 'xbox', 'pc gaming', 'speedrun', 'lets play', 'boss', 'level', 'multiplayer', 'pvp', 'pve', 'raid'],
    brands: ['PlayStation', 'Xbox', 'Nintendo', 'Steam', 'Epic Games', 'EA', 'Ubisoft', 'Rockstar', 'Blizzard', 'Activision']
  },
  finance: {
    name: 'Finance & Business',
    icon: '💰',
    keywords: ['money', 'invest', 'investing', 'investment', 'stock', 'stocks', 'crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'finance', 'financial', 'budget', 'budgeting', 'wealth', 'passive income', 'side hustle', 'business', 'entrepreneur', 'startup', 'trading', 'forex', 'economy', 'economics', 'millionaire', 'billionaire', 'rich', 'retire', 'retirement', 'portfolio', 'dividend', 'real estate', 'property', 'tax', 'taxes', 'credit', 'debt', 'loan', 'mortgage', 'savings', 'bank', 'banking'],
    brands: ['Robinhood', 'Coinbase', 'Fidelity', 'Vanguard', 'Charles Schwab', 'Binance', 'PayPal', 'Stripe']
  },
  beauty: {
    name: 'Beauty & Fashion',
    icon: '💄',
    keywords: ['makeup', 'skincare', 'skin', 'beauty', 'cosmetic', 'cosmetics', 'tutorial', 'foundation', 'lipstick', 'eyeshadow', 'mascara', 'routine', 'grwm', 'get ready', 'nails', 'hair', 'hairstyle', 'fashion', 'style', 'outfit', 'outfits', 'clothing', 'clothes', 'dress', 'wardrobe', 'closet', 'shopping', 'haul', 'lookbook', 'aesthetic', 'glow', 'glam', 'natural', 'drugstore', 'luxury', 'affordable'],
    brands: ['Sephora', 'Ulta', 'MAC', 'NYX', 'Maybelline', 'LOreal', 'Fenty', 'Rare Beauty', 'Charlotte Tilbury', 'NARS', 'Glossier', 'The Ordinary']
  },
  fitness: {
    name: 'Fitness & Health',
    icon: '💪',
    keywords: ['workout', 'fitness', 'gym', 'exercise', 'weight', 'muscle', 'diet', 'nutrition', 'health', 'healthy', 'training', 'cardio', 'yoga', 'meditation', 'stretch', 'stretching', 'abs', 'arms', 'legs', 'full body', 'hiit', 'strength', 'running', 'marathon', 'weightlifting', 'bodybuilding', 'crossfit', 'protein', 'supplements', 'calories', 'macro', 'vegan', 'keto', 'intermittent fasting', 'wellness', 'mental health'],
    brands: ['Nike', 'Adidas', 'Under Armour', 'Lululemon', 'Peloton', 'MyFitnessPal', 'Fitbit', 'Whoop', 'Gymshark']
  },
  education: {
    name: 'Education & Learning',
    icon: '📚',
    keywords: ['learn', 'learning', 'tutorial', 'course', 'how to', 'explained', 'explanation', 'education', 'educational', 'study', 'studying', 'lesson', 'teach', 'teaching', 'guide', 'tips', 'advice', 'beginner', 'beginners', 'advanced', 'masterclass', 'university', 'college', 'school', 'student', 'exam', 'test', 'science', 'math', 'history', 'language', 'english', 'spanish', 'programming', 'coding', 'skill', 'skills'],
    brands: ['Coursera', 'Udemy', 'Skillshare', 'Khan Academy', 'MasterClass', 'Brilliant', 'Duolingo', 'LinkedIn Learning']
  },
  lifestyle: {
    name: 'Lifestyle & Vlogs',
    icon: '🏠',
    keywords: ['vlog', 'vlogging', 'day in', 'daily', 'routine', 'morning routine', 'night routine', 'haul', 'lifestyle', 'room tour', 'apartment', 'house', 'home', 'decor', 'decoration', 'organizing', 'minimalist', 'minimalism', 'aesthetic', 'living', 'life', 'story', 'storytime', 'relationship', 'dating', 'family', 'kids', 'parenting', 'wedding', 'birthday', 'celebration', 'productive', 'productivity', 'self care', 'self improvement'],
    brands: ['IKEA', 'Target', 'Amazon', 'Wayfair', 'West Elm', 'CB2', 'Container Store']
  },
  food: {
    name: 'Food & Cooking',
    icon: '🍳',
    keywords: ['recipe', 'recipes', 'cook', 'cooking', 'food', 'meal', 'meals', 'restaurant', 'eat', 'eating', 'taste', 'tasting', 'kitchen', 'chef', 'baking', 'bake', 'mukbang', 'asmr eating', 'food review', 'trying', 'dinner', 'lunch', 'breakfast', 'dessert', 'snack', 'snacks', 'homemade', 'easy', 'quick', 'delicious', 'yummy', 'foodie', 'cuisine', 'italian', 'mexican', 'asian', 'indian', 'vegan', 'vegetarian'],
    brands: ['HelloFresh', 'Blue Apron', 'DoorDash', 'Uber Eats', 'Whole Foods', 'Trader Joes']
  },
  travel: {
    name: 'Travel & Adventure',
    icon: '✈️',
    keywords: ['travel', 'traveling', 'trip', 'vacation', 'hotel', 'resort', 'flight', 'flying', 'airline', 'destination', 'explore', 'exploring', 'adventure', 'tour', 'touring', 'country', 'city', 'cities', 'beach', 'mountain', 'island', 'europe', 'asia', 'america', 'africa', 'backpacking', 'road trip', 'camping', 'hiking', 'tourist', 'tourism', 'passport', 'visa', 'airport'],
    brands: ['Airbnb', 'Booking.com', 'Expedia', 'Delta', 'United', 'American Airlines', 'Southwest', 'Hilton', 'Marriott']
  },
  entertainment: {
    name: 'Entertainment',
    icon: '🎭',
    keywords: ['funny', 'comedy', 'prank', 'pranks', 'challenge', 'challenges', 'react', 'reaction', 'reacting', 'entertainment', 'skit', 'parody', 'meme', 'memes', 'viral', 'trend', 'trending', 'tiktok', 'shorts', 'compilation', 'fails', 'win', 'wins', 'epic', 'crazy', 'insane', 'wow', 'amazing', 'incredible', 'shock', 'shocking', 'surprise'],
    brands: ['Netflix', 'Disney', 'HBO', 'Hulu', 'Amazon Prime', 'YouTube', 'TikTok']
  },
  music: {
    name: 'Music',
    icon: '🎵',
    keywords: ['music', 'song', 'songs', 'cover', 'covers', 'official', 'music video', 'mv', 'album', 'lyrics', 'lyric', 'remix', 'live', 'performance', 'concert', 'band', 'singer', 'artist', 'rap', 'hip hop', 'pop', 'rock', 'jazz', 'classical', 'edm', 'producer', 'beat', 'beats', 'instrumental', 'acoustic', 'guitar', 'piano', 'drums', 'vocal', 'vocals', 'studio'],
    brands: ['Spotify', 'Apple Music', 'SoundCloud', 'Tidal', 'YouTube Music', 'Bandcamp']
  },
  automotive: {
    name: 'Automotive',
    icon: '🚗',
    keywords: ['car', 'cars', 'vehicle', 'truck', 'suv', 'sedan', 'sports car', 'supercar', 'hypercar', 'motor', 'motorcycle', 'bike', 'driving', 'drive', 'test drive', 'review', 'automotive', 'auto', 'engine', 'horsepower', 'hp', 'mph', 'speed', 'racing', 'race', 'drag', 'drift', 'mod', 'modification', 'tuning', 'exhaust', 'tesla', 'electric', 'ev', 'hybrid'],
    brands: ['Tesla', 'BMW', 'Mercedes', 'Audi', 'Porsche', 'Ferrari', 'Lamborghini', 'Ford', 'Chevrolet', 'Toyota', 'Honda']
  },
  news: {
    name: 'News & Commentary',
    icon: '📰',
    keywords: ['news', 'breaking', 'update', 'report', 'reporting', 'analysis', 'politics', 'political', 'current events', 'documentary', 'investigation', 'investigative', 'opinion', 'debate', 'discussion', 'interview', 'podcast', 'commentary', 'critic', 'review', 'reviews', 'drama', 'controversy', 'exposed', 'truth', 'fact', 'facts'],
    brands: ['CNN', 'Fox', 'NBC', 'BBC', 'Vice', 'Vox', 'The New York Times', 'Washington Post']
  },
  diy: {
    name: 'DIY & Crafts',
    icon: '🛠️',
    keywords: ['diy', 'do it yourself', 'craft', 'crafts', 'crafting', 'handmade', 'homemade', 'build', 'building', 'make', 'making', 'create', 'creating', 'project', 'projects', 'woodworking', 'wood', 'metal', 'sewing', 'knitting', 'crochet', 'art', 'artist', 'painting', 'drawing', 'design', 'upcycle', 'recycle', 'restore', 'restoration', 'repair', 'fix'],
    brands: ['Home Depot', 'Lowes', 'Michaels', 'Joann', 'Etsy', 'Pinterest']
  },
  science: {
    name: 'Science & Nature',
    icon: '🔬',
    keywords: ['science', 'scientific', 'experiment', 'research', 'discovery', 'space', 'nasa', 'physics', 'chemistry', 'biology', 'nature', 'animal', 'animals', 'wildlife', 'planet', 'earth', 'universe', 'cosmos', 'astronomy', 'quantum', 'evolution', 'climate', 'environment', 'ocean', 'marine', 'documentary', 'explained', 'theory'],
    brands: ['NASA', 'National Geographic', 'Discovery', 'PBS', 'BBC Earth']
  }
};

function extractKeywords(text) {
  if (!text) return [];
  
  // Clean and tokenize
  const words = text.toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  
  return words;
}

function extractPhrases(text) {
  if (!text) return [];
  
  const phrases = [];
  const lowerText = text.toLowerCase();
  
  // Extract 2-3 word phrases
  const wordPattern = /\b([a-z]+(?:\s+[a-z]+){1,2})\b/gi;
  let match;
  while ((match = wordPattern.exec(lowerText)) !== null) {
    const phrase = match[1].trim();
    const words = phrase.split(/\s+/);
    // Filter out phrases that are mostly stop words
    const meaningfulWords = words.filter(w => !STOP_WORDS.has(w));
    if (meaningfulWords.length >= words.length / 2 && phrase.length > 5) {
      phrases.push(phrase);
    }
  }
  
  return phrases;
}

function categorizeContent(videos) {
  const categoryScores = {};
  
  for (const [catId, catDef] of Object.entries(CATEGORIES)) {
    categoryScores[catId] = { 
      score: 0, 
      matchedKeywords: new Set(),
      videoCount: 0 
    };
  }
  
  for (const v of videos) {
    const text = `${v.title} ${v.description || ''}`.toLowerCase();
    const videoCategories = new Set();
    
    for (const [catId, catDef] of Object.entries(CATEGORIES)) {
      for (const kw of catDef.keywords) {
        const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const matches = text.match(regex);
        if (matches) {
          categoryScores[catId].score += matches.length;
          categoryScores[catId].matchedKeywords.add(kw);
          videoCategories.add(catId);
        }
      }
    }
    
    // Increment video count for matched categories
    for (const catId of videoCategories) {
      categoryScores[catId].videoCount++;
    }
  }
  
  // Convert to array and sort
  const results = Object.entries(categoryScores)
    .filter(([_, data]) => data.score > 0)
    .map(([catId, data]) => ({
      id: catId,
      name: CATEGORIES[catId].name,
      icon: CATEGORIES[catId].icon,
      score: data.score,
      matchedKeywords: Array.from(data.matchedKeywords).slice(0, 10),
      videoCount: data.videoCount,
      percentage: Math.round((data.videoCount / videos.length) * 100),
      relevantBrands: CATEGORIES[catId].brands
    }))
    .sort((a, b) => b.score - a.score);
  
  return results;
}

function extractTopKeywords(videos, limit = 50) {
  const keywordCounts = {};
  const keywordViews = {};
  
  for (const v of videos) {
    const text = `${v.title} ${v.description || ''}`;
    const keywords = extractKeywords(text);
    const uniqueKeywords = new Set(keywords);
    
    for (const kw of uniqueKeywords) {
      keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
      keywordViews[kw] = (keywordViews[kw] || 0) + v.viewCount;
    }
  }
  
  // Calculate average views per keyword
  const keywordData = Object.entries(keywordCounts)
    .filter(([kw, count]) => count >= 2) // Must appear in at least 2 videos
    .map(([kw, count]) => ({
      keyword: kw,
      count,
      totalViews: keywordViews[kw],
      avgViews: Math.round(keywordViews[kw] / count)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  
  return keywordData;
}

function extractTopPhrases(videos, limit = 20) {
  const phraseCounts = {};
  
  for (const v of videos) {
    const text = `${v.title}`;
    const phrases = extractPhrases(text);
    const uniquePhrases = new Set(phrases);
    
    for (const phrase of uniquePhrases) {
      phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    }
  }
  
  return Object.entries(phraseCounts)
    .filter(([_, count]) => count >= 2)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function analyzeContentThemes(videos) {
  // Group videos by common themes based on titles
  const themes = {};
  
  for (const v of videos) {
    const keywords = extractKeywords(v.title);
    
    // Find significant keywords (not in stop words, >= 4 chars)
    const significantKeywords = keywords.filter(kw => kw.length >= 4);
    
    for (const kw of significantKeywords) {
      if (!themes[kw]) {
        themes[kw] = { keyword: kw, videos: [], totalViews: 0 };
      }
      themes[kw].videos.push({ 
        videoId: v.videoId, 
        title: v.title, 
        viewCount: v.viewCount 
      });
      themes[kw].totalViews += v.viewCount;
    }
  }
  
  // Filter and sort themes
  const significantThemes = Object.values(themes)
    .filter(t => t.videos.length >= 3)
    .map(t => ({
      ...t,
      videoCount: t.videos.length,
      avgViews: Math.round(t.totalViews / t.videos.length),
      topVideo: t.videos.sort((a, b) => b.viewCount - a.viewCount)[0]
    }))
    .sort((a, b) => b.videoCount - a.videoCount)
    .slice(0, 15);
  
  return significantThemes;
}

function suggestBrandMatches(categories, avgViews, subscriberCount) {
  const suggestions = [];
  
  // Get top 3 categories
  const topCategories = categories.slice(0, 3);
  
  for (const cat of topCategories) {
    if (cat.relevantBrands && cat.relevantBrands.length > 0) {
      suggestions.push({
        category: cat.name,
        icon: cat.icon,
        brands: cat.relevantBrands.slice(0, 5),
        matchScore: cat.percentage,
        reason: `${cat.percentage}% of content is ${cat.name.toLowerCase()}-related`
      });
    }
  }
  
  return suggestions;
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

    const quotaCheck = checkQuota(250);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ 
        error: quotaCheck.message,
        code: 'QUOTA_EXCEEDED',
        quotaStatus: quotaCheck.status
      });
    }

    // Use 12 months of data
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 1);
    const sinceISO = sinceDate.toISOString();

    const cacheKey = `niche::${input}::${sinceISO}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    const spec = parseChannelIdFromUrl(input);
    const channelId = await resolveChannelId(spec);
    const uploadsId = await getUploadsPlaylistId(channelId);

    // Get channel info
    consumeQuota(1);
    const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${API_KEY}`;
    const channelData = await fetchJson(channelUrl);
    const channelInfo = channelData.items?.[0];
    
    if (!channelInfo) {
      return res.status(404).json({ error: "Channel not found." });
    }

    // Fetch videos
    const recent = [];
    for await (const item of iterateUploads(uploadsId, sinceISO)) {
      recent.push(item);
      if (recent.length >= 200) break;
    }
    
    if (recent.length < 5) {
      return res.status(400).json({ error: "Need at least 5 videos for meaningful analysis." });
    }

    // Get video details
    const details = await getVideoDetails(recent.map(v => v.videoId));
    const videos = recent.map(v => {
      const d = details.find(x => x.videoId === v.videoId);
      return { 
        videoId: v.videoId, 
        title: d?.title || v.title, 
        description: d?.description || "", 
        publishedAt: d?.publishedAt || v.publishedAt
      };
    });

    // Get view counts
    const videoIds = videos.map(v => v.videoId);
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      consumeQuota(1);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${chunk.join(",")}&key=${API_KEY}`;
      const data = await fetchJson(url);
      for (const it of data.items || []) {
        const video = videos.find(v => v.videoId === it.id);
        if (video) {
          video.viewCount = parseInt(it.statistics?.viewCount || 0, 10);
        }
      }
    }

    // Analyze content
    const categories = categorizeContent(videos);
    const topKeywords = extractTopKeywords(videos, 50);
    const topPhrases = extractTopPhrases(videos, 20);
    const contentThemes = analyzeContentThemes(videos);

    // Calculate averages
    const totalViews = videos.reduce((sum, v) => sum + (v.viewCount || 0), 0);
    const avgViews = videos.length > 0 ? totalViews / videos.length : 0;
    const subscriberCount = parseInt(channelInfo.statistics?.subscriberCount || 0);

    // Suggest brand matches
    const brandMatches = suggestBrandMatches(categories, avgViews, subscriberCount);

    // Determine primary niche
    const primaryNiche = categories.length > 0 ? categories[0] : null;
    const secondaryNiches = categories.slice(1, 4);

    // Find keyword performance champions
    const keywordsByViews = [...topKeywords].sort((a, b) => b.avgViews - a.avgViews);
    const highPerformingKeywords = keywordsByViews.slice(0, 10);

    const payload = {
      channelId,
      channelName: channelInfo.snippet?.title,
      channelThumbnail: channelInfo.snippet?.thumbnails?.medium?.url,
      subscriberCount,
      
      videosAnalyzed: videos.length,
      analysisTimeframe: '12 months',
      
      primaryNiche: primaryNiche ? {
        id: primaryNiche.id,
        name: primaryNiche.name,
        icon: primaryNiche.icon,
        confidence: Math.min(95, primaryNiche.percentage + 20),
        percentage: primaryNiche.percentage,
        matchedKeywords: primaryNiche.matchedKeywords
      } : null,
      
      secondaryNiches: secondaryNiches.map(n => ({
        id: n.id,
        name: n.name,
        icon: n.icon,
        percentage: n.percentage
      })),
      
      allCategories: categories,
      
      topKeywords: topKeywords.slice(0, 30),
      highPerformingKeywords,
      topPhrases,
      
      contentThemes,
      
      brandMatches,
      
      summary: {
        totalViews,
        avgViews: Math.round(avgViews),
        nicheDescription: primaryNiche 
          ? `This channel primarily creates ${primaryNiche.name.toLowerCase()} content${secondaryNiches.length > 0 ? `, with secondary focus on ${secondaryNiches.map(n => n.name.toLowerCase()).join(', ')}` : ''}.`
          : 'Unable to determine primary niche from available content.'
      },
      
      disclaimer: "Niche analysis is based on keyword extraction from video titles and descriptions. Results may not capture all nuances of channel content. Brand suggestions are based on category relevance, not actual partnership data."
    };
    
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    return handleApiError(res, err);
  }
}
