import {
  API_KEY,
  CACHE_TTL,
  applyApiGuards,
  checkQuota,
  consumeQuota,
  getCache,
  getUploadsPlaylistId,
  handleApiError,
  initQuota,
  iterateUploads,
  parseChannelIdFromUrl,
  resolveChannelId,
  setCache,
  validateChannelInput
} from "../utils.js";

const BOT_DETECTOR_VERSION = "v1";
const RECENT_VIDEOS_LIMIT = 20;
const COMMENT_VIDEO_SAMPLE = 5;
const COMMENTS_PER_VIDEO = 25;
const BOT_DETECTOR_QUOTA_BUDGET = 150;
const UPLOADS_SINCE_ISO = "2005-04-23T00:00:00.000Z";

export class YouTubeApiError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
  }
}

async function fetchYouTubeJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let reason = "";
    let message = `YouTube API error ${res.status}`;

    try {
      const body = await res.json();
      reason = body?.error?.errors?.[0]?.reason || "";
      message = body?.error?.message || reason || message;
    } catch {
      try {
        const text = await res.text();
        if (text) message = text;
        if (text && text.includes("quotaExceeded")) reason = "quotaExceeded";
      } catch {
        // Ignore body parsing failures.
      }
    }

    if (res.status === 403 && reason === "quotaExceeded") {
      const error = new Error("YouTube API quota exceeded. Please try again tomorrow.");
      error.code = "YOUTUBE_QUOTA_EXCEEDED";
      throw error;
    }

    throw new YouTubeApiError(message, res.status, reason);
  }

  return res.json();
}

function isoDurationToSeconds(iso) {
  const match = String(iso || "").match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number.parseInt(days || "0", 10) || 0) * 86400 +
    (Number.parseInt(hours || "0", 10) || 0) * 3600 +
    (Number.parseInt(minutes || "0", 10) || 0) * 60 +
    (Number.parseInt(seconds || "0", 10) || 0)
  );
}

async function fetchChannelInfo(channelId) {
  const cacheKey = `bot_detector_channel::${channelId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  consumeQuota(1);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&id=${encodeURIComponent(channelId)}&key=${API_KEY}`;
  const data = await fetchYouTubeJson(url);
  const item = data.items?.[0];

  if (!item) {
    throw new YouTubeApiError("Channel not found.", 404, "channelNotFound");
  }

  const stats = item.statistics || {};
  const channel = {
    id: item.id,
    title: item.snippet?.title || "Unknown",
    handle: item.snippet?.customUrl || "",
    description: item.snippet?.description || "",
    thumbnail:
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.default?.url ||
      "",
    banner: item.brandingSettings?.image?.bannerExternalUrl,
    customUrl: item.snippet?.customUrl,
    publishedAt: item.snippet?.publishedAt || "",
    country: item.snippet?.country,
    subscriberCount: Number.parseInt(stats.subscriberCount || "0", 10) || 0,
    viewCount: Number.parseInt(stats.viewCount || "0", 10) || 0,
    videoCount: Number.parseInt(stats.videoCount || "0", 10) || 0,
    hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount)
  };

  setCache(cacheKey, channel, CACHE_TTL.LONG);
  return channel;
}

async function fetchRecentVideos(channelId, limit = RECENT_VIDEOS_LIMIT) {
  const uploadsId = await getUploadsPlaylistId(channelId);
  const recent = [];

  for await (const item of iterateUploads(uploadsId, UPLOADS_SINCE_ISO)) {
    if (!item?.videoId) continue;
    recent.push(item);
    if (recent.length >= limit) break;
  }

  if (!recent.length) return [];

  const videoDetails = [];
  const videoIds = recent.map((video) => video.videoId);

  for (let index = 0; index < videoIds.length; index += 50) {
    const chunk = videoIds.slice(index, index + 50);
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${chunk.join(",")}&key=${API_KEY}`;
    const data = await fetchYouTubeJson(url);

    for (const item of data.items || []) {
      const stats = item.statistics || {};
      videoDetails.push({
        id: item.id,
        title: item.snippet?.title || "",
        publishedAt: item.snippet?.publishedAt || "",
        viewCount: Number.parseInt(stats.viewCount || "0", 10) || 0,
        likeCount: Number.parseInt(stats.likeCount || "0", 10) || 0,
        commentCount: Number.parseInt(stats.commentCount || "0", 10) || 0,
        durationSeconds: isoDurationToSeconds(item.contentDetails?.duration || ""),
        thumbnail:
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          ""
      });
    }
  }

  const byId = new Map(videoDetails.map((video) => [video.id, video]));
  return recent.map((video) => byId.get(video.videoId)).filter(Boolean);
}

async function fetchTopComments(videoId, maxResults = COMMENTS_PER_VIDEO) {
  consumeQuota(1);
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&order=relevance&maxResults=${Math.min(maxResults, 100)}&key=${API_KEY}`;

  try {
    const data = await fetchYouTubeJson(url);
    return {
      comments: (data.items || []).map((item) => {
        const top = item?.snippet?.topLevelComment?.snippet || {};
        return {
          id: String(item.id || ""),
          videoId,
          authorName: String(top.authorDisplayName || ""),
          authorChannelId: top.authorChannelId?.value || "",
          authorThumbnail: String(top.authorProfileImageUrl || ""),
          text: String(top.textDisplay || ""),
          likeCount: Number.parseInt(String(top.likeCount || "0"), 10) || 0,
          publishedAt: String(top.publishedAt || "")
        };
      }),
      disabled: false
    };
  } catch (error) {
    if (error instanceof YouTubeApiError && error.reason === "commentsDisabled") {
      return { comments: [], disabled: true };
    }
    throw error;
  }
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function coefficientOfVariation(numbers) {
  if (!numbers.length) return 0;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (!mean) return 0;
  const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numbers.length;
  return Math.sqrt(variance) / mean;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isMostlyEmoji(text) {
  const withoutEmoji = String(text || "")
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
      ""
    )
    .replace(/\s+/g, "")
    .trim();
  return withoutEmoji.length === 0 && String(text || "").trim().length > 0;
}

const PROMO_PATTERNS = [
  /\bsubscrib(e|ed)?\s+to\s+(my|me)\b/i,
  /\bcheck\s+(out\s+)?my\s+channel\b/i,
  /\bsub\s*(4|for)\s*sub\b/i,
  /\bsub4sub\b/i,
  /\bgrow\s+(your\s+)?channel\b/i,
  /\bsmmpannel\b/i,
  /\bpromot(e|ion)\s+(your\s+)?channel\b/i,
  /\bfree\s+sub(scribers)?\b/i,
  /\bgain\s+subscribers\b/i,
  /\bwatch\s+my\s+(new\s+)?video\b/i
];

function isPromotional(text) {
  return PROMO_PATTERNS.some((pattern) => pattern.test(text));
}

function isGeneric(text) {
  const normalized = String(text || "").toLowerCase().trim();
  if (normalized.length > 40) return false;

  const generics = new Set([
    "nice",
    "good",
    "great",
    "cool",
    "awesome",
    "nice video",
    "good video",
    "great video",
    "nice content",
    "good content",
    "love it",
    "keep it up",
    "nice one",
    "first",
    "who's watching",
    "whos watching",
    "who is watching",
    "same",
    "lol",
    "lmao"
  ]);

  return generics.has(normalized) || /^.{0,3}$/.test(normalized);
}

function channelAgeDays(publishedAt) {
  if (!publishedAt) return Number.NaN;
  const age = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
  return Math.max(0, age);
}

function likeViewSignal(videos) {
  const ratios = videos
    .filter((video) => video.viewCount > 100)
    .map((video) => (video.likeCount / Math.max(1, video.viewCount)) * 100);
  const average = ratios.length
    ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    : 0;

  let severity = "ok";
  let score = 0;
  let explanation = "";

  if (!ratios.length) {
    severity = "info";
    explanation = "Not enough viewable like data (likes may be hidden). Signal skipped.";
  } else if (average < 0.5) {
    severity = "danger";
    score = 90;
    explanation = "Organic channels typically see 2-6% like-to-view ratios. Ratios well under 1% strongly suggest bought views from sources that do not deliver engagement.";
  } else if (average < 1.5) {
    severity = "warning";
    score = 55;
    explanation = "Like-to-view is below the organic norm (usually 2-6%). This can happen on viral but polarizing videos, but across a channel it often indicates low-quality purchased views.";
  } else if (average > 12) {
    severity = "warning";
    score = 40;
    explanation = "An unusually high like-to-view ratio can indicate purchased likes rather than genuine viewership.";
  } else {
    explanation = "Like-to-view ratio sits in the healthy organic range.";
  }

  return {
    id: "like_view",
    title: "Like-to-view ratio",
    severity,
    score,
    finding: ratios.length ? `Avg ${average.toFixed(2)}% across ${ratios.length} videos` : "No data",
    explanation
  };
}

function commentViewSignal(videos) {
  const ratios = videos
    .filter((video) => video.viewCount > 100)
    .map((video) => (video.commentCount / Math.max(1, video.viewCount)) * 100);
  const average = ratios.length
    ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    : 0;

  let severity = "ok";
  let score = 0;
  let explanation = "";

  if (!ratios.length) {
    severity = "info";
    explanation = "Insufficient data to evaluate.";
  } else if (average < 0.02) {
    severity = "danger";
    score = 85;
    explanation = "Virtually no comments relative to views. Real audiences almost always leave some discussion; this pattern is common on view-botting.";
  } else if (average < 0.08) {
    severity = "warning";
    score = 40;
    explanation = "Comment rate is low for the view count. Not definitive, but leans toward passive or inauthentic viewership.";
  } else if (average > 3) {
    severity = "warning";
    score = 45;
    explanation = "Abnormally high comment rate can indicate a comment-farming operation or controversy-driven engagement rather than natural growth.";
  } else {
    explanation = "Comment-to-view ratio is within typical organic range.";
  }

  return {
    id: "comment_view",
    title: "Comment-to-view ratio",
    severity,
    score,
    finding: ratios.length ? `Avg ${average.toFixed(3)}%` : "No data",
    explanation
  };
}

function viewUniformitySignal(videos) {
  const views = videos.map((video) => video.viewCount);
  const cv = coefficientOfVariation(views);
  const mean = views.length ? views.reduce((sum, value) => sum + value, 0) / views.length : 0;

  let severity = "ok";
  let score = 0;
  let explanation = "";

  if (views.length < 5) {
    severity = "info";
    explanation = "Too few videos to evaluate consistency.";
  } else if (mean < 500) {
    severity = "info";
    explanation = "View counts are too low to draw meaningful conclusions about uniformity.";
  } else if (cv < 0.15) {
    severity = "danger";
    score = 80;
    explanation = "View counts are suspiciously uniform across uploads. Organic channels have wide swings (trending vs. flop). Consistency this tight is a classic bot-view signature.";
  } else if (cv < 0.3) {
    severity = "warning";
    score = 35;
    explanation = "Views are unusually consistent. Some creators are steady, but this level of flatness warrants caution.";
  } else {
    explanation = "View counts show the variability typical of organic channels.";
  }

  return {
    id: "view_uniformity",
    title: "View count uniformity",
    severity,
    score,
    finding: views.length >= 5 ? `CV = ${(cv * 100).toFixed(1)}% (lower = more uniform)` : "Insufficient data",
    explanation
  };
}

function growthVelocitySignal(data) {
  const { channel, videos } = data;
  const ageDays = channelAgeDays(channel.publishedAt);
  if (!ageDays || channel.hiddenSubscriberCount || channel.subscriberCount === 0) {
    return {
      id: "growth_velocity",
      title: "Subscriber growth velocity",
      severity: "info",
      score: 0,
      finding: "Hidden or unavailable",
      explanation: "Subscriber count is hidden or channel age unknown - cannot evaluate."
    };
  }

  const subsPerDay = channel.subscriberCount / ageDays;
  const viewsPerSub = channel.viewCount / Math.max(1, channel.subscriberCount);

  let severity = "ok";
  let score = 0;
  let explanation = "";

  if (subsPerDay > 500 && viewsPerSub < 5) {
    severity = "danger";
    score = 85;
    explanation = `Channel averages ${subsPerDay.toFixed(0)} subs/day but only ${viewsPerSub.toFixed(1)} lifetime views per subscriber. Real subscribers watch - bought ones do not.`;
  } else if (subsPerDay > 100 && viewsPerSub < 15) {
    severity = "warning";
    score = 55;
    explanation = `Growth rate (${subsPerDay.toFixed(0)} subs/day) is fast relative to how little the subscribers actually watch (${viewsPerSub.toFixed(1)} views each). Suggests sub-bot or sub4sub activity.`;
  } else if (subsPerDay > 50 && videos.length >= 3) {
    const avgViews = videos.reduce((sum, video) => sum + video.viewCount, 0) / videos.length;
    if (avgViews < subsPerDay * 0.1) {
      severity = "warning";
      score = 45;
      explanation = `Subscribers grow ~${subsPerDay.toFixed(0)}/day but recent videos average only ${avgViews.toFixed(0)} views - fewer than 10% of daily subs tune in.`;
    } else {
      explanation = "Growth velocity is in line with observed viewership.";
    }
  } else {
    explanation = `Growth pace (${subsPerDay.toFixed(1)} subs/day) is compatible with the channel's age and viewership.`;
  }

  return {
    id: "growth_velocity",
    title: "Subscriber growth velocity",
    severity,
    score,
    finding: `${subsPerDay.toFixed(1)} subs/day - ${viewsPerSub.toFixed(1)} views/sub lifetime`,
    explanation
  };
}

function commentAuthenticitySignal(comments) {
  if (comments.length < 10) {
    return {
      id: "comment_authenticity",
      title: "Comment authenticity",
      severity: "info",
      score: 0,
      finding: `${comments.length} comments sampled`,
      explanation: "Too few comments collected to evaluate authenticity reliably."
    };
  }

  let emojiOnly = 0;
  let generic = 0;
  let promotional = 0;
  const duplicateCounts = new Map();
  const evidence = [];

  for (const comment of comments) {
    const text = stripHtml(comment.text).toLowerCase();
    if (isMostlyEmoji(comment.text)) emojiOnly += 1;
    if (isGeneric(text)) generic += 1;
    if (isPromotional(text)) {
      promotional += 1;
      if (evidence.length < 3) {
        evidence.push(`"${stripHtml(comment.text).slice(0, 140)}"`);
      }
    }
    duplicateCounts.set(text, (duplicateCounts.get(text) || 0) + 1);
  }

  const total = comments.length;
  const duplicates = [...duplicateCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const emojiPct = (emojiOnly / total) * 100;
  const genericPct = (generic / total) * 100;
  const promoPct = (promotional / total) * 100;
  const duplicatePct = (duplicates / total) * 100;

  let score = 0;
  if (promoPct > 20) score += 40;
  else if (promoPct > 8) score += 20;
  if (genericPct > 40) score += 25;
  else if (genericPct > 25) score += 10;
  if (emojiPct > 30) score += 20;
  else if (emojiPct > 15) score += 8;
  if (duplicatePct > 10) score += 20;
  score = Math.min(100, score);

  let severity = "ok";
  if (score >= 60) severity = "danger";
  else if (score >= 30) severity = "warning";
  else if (score > 0) severity = "info";

  return {
    id: "comment_authenticity",
    title: "Comment authenticity",
    severity,
    score,
    finding: `${genericPct.toFixed(0)}% generic - ${emojiPct.toFixed(0)}% emoji-only - ${promoPct.toFixed(0)}% promo/spam - ${duplicatePct.toFixed(0)}% duplicated`,
    explanation:
      score >= 60
        ? "A large share of comments look machine-generated, duplicated, or promotional - strong evidence of comment-bot or sub4sub farming."
        : score >= 30
        ? "Some spammy or low-effort comments, which happens on many channels. Moderate concern."
        : "Comments read as typical organic viewer engagement.",
    evidence: evidence.length ? evidence : undefined
  };
}

function duplicateCommentSignal(comments) {
  if (comments.length < 15) {
    return {
      id: "duplicate_comments",
      title: "Duplicate comment patterns",
      severity: "info",
      score: 0,
      finding: "Not enough data",
      explanation: "Insufficient comments to detect cross-video duplication."
    };
  }

  const commentsByAuthor = new Map();
  for (const comment of comments) {
    if (!comment.authorChannelId) continue;
    if (!commentsByAuthor.has(comment.authorChannelId)) {
      commentsByAuthor.set(comment.authorChannelId, []);
    }
    commentsByAuthor.get(comment.authorChannelId).push(comment);
  }

  const multiCommenters = [...commentsByAuthor.entries()].filter(([, authorComments]) => authorComments.length >= 2);
  const suspiciousAuthors = [];

  for (const [, authorComments] of multiCommenters) {
    const texts = authorComments.map((comment) => stripHtml(comment.text).trim().toLowerCase());
    const uniqueTexts = new Set(texts);
    if (uniqueTexts.size < texts.length * 0.5 && texts.length >= 2) {
      suspiciousAuthors.push(authorComments[0].authorName);
    }
  }

  const score = Math.min(85, suspiciousAuthors.length * 12 + (multiCommenters.length > 5 ? 10 : 0));
  let severity = "ok";
  if (score >= 50) severity = "danger";
  else if (score >= 20) severity = "warning";
  else if (score > 0) severity = "info";

  return {
    id: "duplicate_comments",
    title: "Cross-video duplicate commenters",
    severity,
    score,
    finding: `${suspiciousAuthors.length} accounts posted near-duplicate comments across sampled videos`,
    explanation:
      score >= 50
        ? "Multiple accounts are recycling the same comments across different videos - hallmark of a comment-bot farm paid to boost engagement."
        : score > 0
        ? "A few suspicious repeat commenters detected. Minor concern."
        : "No cross-video duplicate-comment patterns detected in the sample.",
    evidence: suspiciousAuthors.length ? suspiciousAuthors.slice(0, 5).map((name) => `@${name}`) : undefined
  };
}

function uploadConsistencySignal(videos) {
  if (videos.length < 5) {
    return {
      id: "upload_consistency",
      title: "Upload cadence",
      severity: "info",
      score: 0,
      finding: "Too few videos",
      explanation: "Need at least 5 videos to evaluate upload cadence."
    };
  }

  const sorted = [...videos].sort((left, right) => new Date(left.publishedAt).getTime() - new Date(right.publishedAt).getTime());
  const gapsDays = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (new Date(sorted[index].publishedAt).getTime() - new Date(sorted[index - 1].publishedAt).getTime()) / 86400000;
    gapsDays.push(gap);
  }

  const avgGap = gapsDays.reduce((sum, value) => sum + value, 0) / gapsDays.length;
  const gapCv = coefficientOfVariation(gapsDays);
  const viewCv = coefficientOfVariation(videos.map((video) => video.viewCount));
  const scheduleRobot = gapCv < 0.15 && avgGap < 14;
  const viewRobot = viewCv < 0.3 && videos.reduce((sum, video) => sum + video.viewCount, 0) / videos.length > 500;

  let score = 0;
  if (scheduleRobot && viewRobot) score = 75;
  else if (scheduleRobot) score = 25;

  let severity = "ok";
  if (score >= 60) severity = "danger";
  else if (score >= 20) severity = "warning";
  else if (score > 0) severity = "info";

  return {
    id: "upload_consistency",
    title: "Upload cadence regularity",
    severity,
    score,
    finding: `Avg gap ${avgGap.toFixed(1)}d - CV ${(gapCv * 100).toFixed(0)}%`,
    explanation:
      score >= 60
        ? "Uploads are metronomic and views are unnaturally flat - pattern consistent with automated publishing plus purchased views."
        : scheduleRobot
        ? "Upload schedule is unusually regular. Not damning on its own; many professional creators publish on a fixed cadence."
        : "Upload timing shows the variability of a human-run channel."
  };
}

function subscriberRatioSignal(channel) {
  if (channel.hiddenSubscriberCount || channel.subscriberCount === 0) {
    return {
      id: "subscriber_ratio",
      title: "Views per subscriber",
      severity: "info",
      score: 0,
      finding: "Hidden subscriber count",
      explanation: "Cannot compute - subscriber count is hidden."
    };
  }

  const viewsPerSubscriber = channel.viewCount / channel.subscriberCount;
  let severity = "ok";
  let score = 0;
  let explanation = "";

  if (viewsPerSubscriber < 2) {
    severity = "danger";
    score = 80;
    explanation = `Channel has ${channel.subscriberCount.toLocaleString()} subscribers but only ${channel.viewCount.toLocaleString()} lifetime views (${viewsPerSubscriber.toFixed(2)} views per sub). Real subscribers watch - purchased ones do not.`;
  } else if (viewsPerSubscriber < 10) {
    severity = "warning";
    score = 45;
    explanation = `Only ${viewsPerSubscriber.toFixed(1)} lifetime views per subscriber. Most healthy channels sit at 20-100+. Low ratio strongly suggests a portion of subscribers were acquired artificially.`;
  } else if (viewsPerSubscriber > 500) {
    severity = "info";
    score = 10;
    explanation = `High views-per-sub (${viewsPerSubscriber.toFixed(0)}) typically means lots of non-subscribed viewers from search or browse traffic, which is usually healthy.`;
  } else {
    explanation = `Views per subscriber (${viewsPerSubscriber.toFixed(0)}) is in a typical range.`;
  }

  return {
    id: "subscriber_ratio",
    title: "Views per subscriber",
    severity,
    score,
    finding: `${viewsPerSubscriber.toFixed(1)} lifetime views per subscriber`,
    explanation
  };
}

const SIGNAL_WEIGHTS = {
  like_view: 1.4,
  comment_view: 1.2,
  subscriber_ratio: 1.5,
  growth_velocity: 1.3,
  view_uniformity: 1.3,
  comment_authenticity: 1.4,
  duplicate_comments: 1.1,
  upload_consistency: 0.9
};

export function analyzeBotDetectorData(data) {
  const signals = [
    likeViewSignal(data.videos),
    commentViewSignal(data.videos),
    viewUniformitySignal(data.videos),
    growthVelocitySignal(data),
    commentAuthenticitySignal(data.comments),
    duplicateCommentSignal(data.comments),
    uploadConsistencySignal(data.videos),
    subscriberRatioSignal(data.channel)
  ];

  let totalWeight = 0;
  let weightedSum = 0;

  for (const signal of signals) {
    if (signal.severity === "info" && signal.score === 0) continue;
    const weight = SIGNAL_WEIGHTS[signal.id] || 1;
    weightedSum += signal.score * weight;
    totalWeight += weight;
  }

  const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  let risk = "low";
  if (overallScore >= 65) risk = "critical";
  else if (overallScore >= 40) risk = "high";
  else if (overallScore >= 20) risk = "elevated";

  const dangerSignals = signals.filter((signal) => signal.severity === "danger").length;
  const warningSignals = signals.filter((signal) => signal.severity === "warning").length;

  let summary = "";
  if (risk === "critical") {
    summary = `Multiple strong red flags detected (${dangerSignals} critical, ${warningSignals} warnings). The engagement patterns are highly consistent with artificial growth.`;
  } else if (risk === "high") {
    summary = `Several warning signs are present (${dangerSignals} critical, ${warningSignals} warnings). Artificial growth is likely, though a few metrics remain inconclusive.`;
  } else if (risk === "elevated") {
    summary = `Some suspicious patterns are present (${warningSignals} warnings). Not definitive, but the channel deserves closer scrutiny.`;
  } else {
    summary = "No strong evidence of bot activity. Engagement patterns look broadly organic, though no heuristic is perfect.";
  }

  const views = data.videos.map((video) => video.viewCount);
  const dates = data.videos.map((video) => video.publishedAt).filter(Boolean).sort();

  return {
    overallScore: Math.round(overallScore),
    risk,
    summary,
    signals: signals.sort((left, right) => right.score - left.score),
    metadata: {
      videosAnalyzed: data.videos.length,
      commentsAnalyzed: data.comments.length,
      oldestVideoDate: dates[0],
      newestVideoDate: dates[dates.length - 1],
      avgViews: views.length ? views.reduce((sum, value) => sum + value, 0) / views.length : 0,
      medianViews: median(views)
    }
  };
}

export async function collectBotDetectorData(input, options = {}) {
  const videoSample = Math.min(Number.parseInt(String(options.videoSample || RECENT_VIDEOS_LIMIT), 10) || RECENT_VIDEOS_LIMIT, 30);
  const commentVideoSample = Math.min(Number.parseInt(String(options.commentVideoSample || COMMENT_VIDEO_SAMPLE), 10) || COMMENT_VIDEO_SAMPLE, 8);
  const commentsPerVideo = Math.min(Number.parseInt(String(options.commentsPerVideo || COMMENTS_PER_VIDEO), 10) || COMMENTS_PER_VIDEO, 50);

  const spec = parseChannelIdFromUrl(input);
  const channelId = await resolveChannelId(spec);
  const channel = await fetchChannelInfo(channelId);
  const videos = await fetchRecentVideos(channelId, videoSample);

  const sampleVideos = [...videos]
    .sort((left, right) => right.viewCount - left.viewCount)
    .slice(0, commentVideoSample);

  const comments = [];
  const commentFetchStats = {
    attempted: sampleVideos.length,
    succeeded: 0,
    disabled: 0
  };

  for (const video of sampleVideos) {
    const result = await fetchTopComments(video.id, commentsPerVideo);
    if (result.disabled) commentFetchStats.disabled += 1;
    else commentFetchStats.succeeded += 1;
    comments.push(...result.comments);
  }

  return {
    channel,
    videos,
    comments,
    commentFetchStats
  };
}

export async function runBotDetectorAnalysis(input, options = {}) {
  const cacheKey = `bot_detector::${BOT_DETECTOR_VERSION}::${input}`;
  if (!options.skipCache) {
    const cached = getCache(cacheKey);
    if (cached) return { fromCache: true, ...cached };
  }

  const data = await collectBotDetectorData(input, options);
  const report = analyzeBotDetectorData(data);
  const payload = {
    channel: data.channel,
    videos: data.videos,
    commentFetchStats: data.commentFetchStats,
    report
  };

  setCache(cacheKey, payload, CACHE_TTL.SHORT);
  return payload;
}

export async function handleBotDetector(req, res) {
  if (applyApiGuards(req, res, { rateKey: "bot-detector", maxRequests: 8, windowMs: 60_000 })) return;

  await initQuota();

  try {
    const rawInput = String(req.query.url || "");
    const validation = validateChannelInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid input." });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "YouTube API key not configured." });
    }

    const quotaCheck = checkQuota(BOT_DETECTOR_QUOTA_BUDGET);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: quotaCheck.message,
        code: "QUOTA_EXCEEDED",
        quotaStatus: quotaCheck.status
      });
    }

    const payload = await runBotDetectorAnalysis(validation.sanitized);
    return res.json(payload);
  } catch (error) {
    return handleApiError(res, error, req);
  }
}