import { Readable } from "node:stream";
import { YtdlCore } from "@ybd-project/ytdl-core/serverless";
import { applyApiGuards, handleApiError } from "../utils.js";

const YOUTUBE_HOST_PATTERN = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const YOUTUBE_PO_TOKEN = String(process.env.YOUTUBE_PO_TOKEN || "").trim() || undefined;
const YOUTUBE_VISITOR_DATA = String(process.env.YOUTUBE_VISITOR_DATA || "").trim() || undefined;
const YOUTUBE_CLIENT_GROUPS = [
  ["mweb", "ios"],
  ["android", "tv"],
  ["web"],
  ["mweb", "ios", "android", "tv", "web"]
];

const youtube = new YtdlCore({
  clients: ["mweb", "ios", "android", "tv", "web"],
  disableDefaultClients: true,
  noUpdate: true
});

function sanitizeYouTubeInput(raw) {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "YouTube URL is required." };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "YouTube URL is required." };
  }
  if (trimmed.length > 600) {
    return { ok: false, error: "URL is too long." };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return { ok: false, error: "Only http and https URLs are allowed." };
  }
  if (!YOUTUBE_HOST_PATTERN.test(parsed.hostname)) {
    return { ok: false, error: "Only YouTube URLs are allowed." };
  }

  const normalized = parsed.toString();
  if (!YtdlCore.validateURL(normalized)) {
    return { ok: false, error: "Please provide a valid YouTube video URL." };
  }

  return { ok: true, value: normalized };
}

function normalizeYouTubeWatchUrl(rawUrl) {
  try {
    const videoId = YtdlCore.getURLVideoID(rawUrl);
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return rawUrl;
  }
}

function toErrorMessage(err) {
  return String(err?.message || err || "Unknown error");
}

function toFriendlyYouTubeError(err) {
  const message = toErrorMessage(err);

  if (/sign in to confirm|login_required|not a bot/i.test(message)) {
    if (!YOUTUBE_PO_TOKEN || !YOUTUBE_VISITOR_DATA) {
      return "YouTube is challenging this request. Configure YOUTUBE_PO_TOKEN and YOUTUBE_VISITOR_DATA to improve downloader reliability, or try another video URL.";
    }
    return "YouTube is temporarily challenging this request. Please try again in a minute or try another video URL.";
  }
  if (/playable formats|no such format found|not available due to lack of video format/i.test(message)) {
    return "Could not find downloadable streams for this video right now. Try a different public YouTube URL.";
  }
  if (/no formats returned|no playable formats were returned/i.test(message)) {
    return "This video did not expose downloadable streams from the server. Please try a different YouTube URL.";
  }
  if (/private video|members-only|age-restricted|video unavailable/i.test(message)) {
    return "This video is restricted or unavailable for server-side download.";
  }

  return null;
}

async function getInfoWithFallback(rawUrl) {
  const watchUrl = normalizeYouTubeWatchUrl(rawUrl);
  let lastError;
  const authOptions = {
    ...(YOUTUBE_PO_TOKEN ? { poToken: YOUTUBE_PO_TOKEN } : {}),
    ...(YOUTUBE_VISITOR_DATA ? { visitorData: YOUTUBE_VISITOR_DATA } : {})
  };
  const hasAuthTokens = Boolean(authOptions.poToken || authOptions.visitorData);
  const attemptGroups = hasAuthTokens
    ? [
      { auth: authOptions },
      {}
    ]
    : [{}];

  for (const attempt of attemptGroups) {
    for (const clients of YOUTUBE_CLIENT_GROUPS) {
      try {
        const info = await youtube.getFullInfo(watchUrl, {
          clients,
          disableDefaultClients: true,
          ...attempt.auth
        });

        if (Array.isArray(info?.formats) && info.formats.length > 0) {
          return info;
        }
        lastError = new Error("No playable formats were returned.");
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error("Failed to retrieve YouTube video info.");
}

function parseQualityScore(format) {
  const label = String(format?.quality?.label || format?.qualityLabel || "");
  const score = Number.parseInt(label.replace(/\D+/g, ""), 10);
  return Number.isFinite(score) ? score : 0;
}

function toSafeFilename(raw, fallback, extension) {
  const base = String(raw || "")
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .trim()
    .slice(0, 120)
    .replace(/\s+/g, "-")
    .toLowerCase();

  const stem = base || fallback;
  return `${stem}.${extension}`;
}

function pickThumbnail(videoDetails) {
  const thumbnails = Array.isArray(videoDetails?.thumbnails) ? videoDetails.thumbnails : [];
  return thumbnails.length ? thumbnails[thumbnails.length - 1].url : "";
}

function pickVideoFormat(formats) {
  const progressive = formats.filter((fmt) => fmt.hasVideo && fmt.hasAudio && fmt.url);
  const mp4Progressive = progressive.filter((fmt) => fmt.container === "mp4");
  const source = mp4Progressive.length ? mp4Progressive : progressive;
  if (!source.length) return null;

  return source
    .slice()
    .sort((a, b) => {
      const bHeight = parseQualityScore(b);
      const aHeight = parseQualityScore(a);
      if (bHeight !== aHeight) return bHeight - aHeight;
      return Number(b.bitrate || 0) - Number(a.bitrate || 0);
    })[0];
}

function pickVideoCandidates(formats, max = 5) {
  const progressive = formats.filter((fmt) => fmt.hasVideo && fmt.hasAudio && fmt.url);
  const mp4Progressive = progressive.filter((fmt) => fmt.container === "mp4");
  const source = mp4Progressive.length ? mp4Progressive : progressive;

  return source
    .slice()
    .sort((a, b) => {
      const bHeight = parseQualityScore(b);
      const aHeight = parseQualityScore(a);
      if (bHeight !== aHeight) return bHeight - aHeight;
      return Number(b.bitrate || 0) - Number(a.bitrate || 0);
    })
    .slice(0, max);
}

function pickAudioFormat(formats) {
  const audioOnly = formats.filter((fmt) => fmt.hasAudio && !fmt.hasVideo && fmt.url);
  if (!audioOnly.length) return null;

  return audioOnly
    .slice()
    .sort((a, b) => {
      const bBitrate = Number(b.audioBitrate || 0);
      const aBitrate = Number(a.audioBitrate || 0);
      if (bBitrate !== aBitrate) return bBitrate - aBitrate;
      return Number(b.bitrate || 0) - Number(a.bitrate || 0);
    })[0];
}

function pickAudioCandidates(formats, max = 5) {
  const audioOnly = formats.filter((fmt) => fmt.hasAudio && !fmt.hasVideo && fmt.url);

  return audioOnly
    .slice()
    .sort((a, b) => {
      const bBitrate = Number(b.audioBitrate || 0);
      const aBitrate = Number(a.audioBitrate || 0);
      if (bBitrate !== aBitrate) return bBitrate - aBitrate;
      return Number(b.bitrate || 0) - Number(a.bitrate || 0);
    })
    .slice(0, max);
}

function buildStreamHeaders(sourceUrl) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    Accept: "*/*",
    Origin: "https://www.youtube.com",
    Referer: sourceUrl
  };
}

async function proxyMediaCandidate(url, sourceUrl) {
  return fetch(url, {
    headers: buildStreamHeaders(sourceUrl)
  });
}

function pipeUpstreamToResponse(upstream, res, { fallbackType, filename }) {
  if (!upstream.body) {
    throw new Error("No media stream body received.");
  }

  const contentType = upstream.headers.get("content-type") || fallbackType;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  Readable.fromWeb(upstream.body).pipe(res);
}

function getMetaFromInfo(info, sourceUrl) {
  const details = info.videoDetails || {};
  const audioFormat = pickAudioFormat(info.formats || []);
  const videoFormat = pickVideoFormat(info.formats || []);

  return {
    title: details.title || "YouTube video",
    author: details.author?.name || details.ownerChannelName || "YouTube creator",
    coverUrl: pickThumbnail(details),
    sourceUrl,
    videoId: details.videoId || "",
    durationSeconds: Number(details.lengthSeconds || 0),
    hasAudioDownload: Boolean(audioFormat),
    downloadable: Boolean(videoFormat)
  };
}

async function fetchOembedMeta(sourceUrl) {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
  });

  if (!response.ok) {
    throw new Error("Failed to fetch YouTube oEmbed metadata.");
  }

  const data = await response.json();
  const normalized = normalizeYouTubeWatchUrl(sourceUrl);
  let videoId = "";
  try {
    videoId = YtdlCore.getURLVideoID(normalized);
  } catch {
    videoId = "";
  }

  return {
    title: data?.title || "YouTube video",
    author: data?.author_name || "YouTube creator",
    coverUrl: data?.thumbnail_url || "",
    sourceUrl,
    videoId,
    durationSeconds: 0,
    hasAudioDownload: false,
    downloadable: false
  };
}

export async function handleYouTubeMeta(req, res) {
  if (applyApiGuards(req, res, { rateKey: "youtube-meta", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = sanitizeYouTubeInput((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    try {
      const info = await getInfoWithFallback(validation.value);
      const meta = getMetaFromInfo(info, validation.value);

      if (!meta.downloadable) {
        meta.warning = "This video did not expose downloadable streams from the server. Please try another YouTube URL.";
      }

      return res.status(200).json(meta);
    } catch (innerErr) {
      const friendly = toFriendlyYouTubeError(innerErr)
        || "YouTube is currently limiting stream extraction for this video.";
      const fallbackMeta = await fetchOembedMeta(validation.value);
      fallbackMeta.warning = friendly;
      return res.status(200).json(fallbackMeta);
    }
  } catch (err) {
    const friendly = toFriendlyYouTubeError(err);
    if (friendly) {
      return res.status(502).json({ error: friendly });
    }
    return handleApiError(res, err, req);
  }
}

export async function handleYouTubeVideo(req, res) {
  if (applyApiGuards(req, res, { rateKey: "youtube-video", maxRequests: 12, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = sanitizeYouTubeInput((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const info = await getInfoWithFallback(validation.value);
    const candidates = pickVideoCandidates(info.formats || []);
    if (!candidates.length) {
      return res.status(400).json({ error: "No progressive video format is available for download." });
    }

    const primary = candidates[0];
    const extension = primary.container === "webm" ? "webm" : "mp4";
    const filename = toSafeFilename(info.videoDetails?.title, "youtube-video", extension);

    for (const format of candidates) {
      const upstream = await proxyMediaCandidate(format.url, validation.value);
      if (!upstream.ok || !upstream.body) {
        continue;
      }

      pipeUpstreamToResponse(upstream, res, {
        fallbackType: format.mimeType?.split(";")[0] || "video/mp4",
        filename
      });
      return;
    }

    return res.status(502).json({ error: "YouTube blocked video stream access for this request. Please try another URL." });
  } catch (err) {
    const friendly = toFriendlyYouTubeError(err);
    if (friendly) {
      return res.status(502).json({ error: friendly });
    }
    return handleApiError(res, err, req);
  }
}

export async function handleYouTubeAudio(req, res) {
  if (applyApiGuards(req, res, { rateKey: "youtube-audio", maxRequests: 12, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = sanitizeYouTubeInput((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const info = await getInfoWithFallback(validation.value);
    const candidates = pickAudioCandidates(info.formats || []);
    if (!candidates.length) {
      return res.status(400).json({ error: "No audio-only format is available for download." });
    }

    const primary = candidates[0];
    const extension = primary.container === "webm" ? "webm" : "m4a";
    const filename = toSafeFilename(info.videoDetails?.title, "youtube-audio", extension);

    for (const format of candidates) {
      const upstream = await proxyMediaCandidate(format.url, validation.value);
      if (!upstream.ok || !upstream.body) {
        continue;
      }

      pipeUpstreamToResponse(upstream, res, {
        fallbackType: format.mimeType?.split(";")[0] || "audio/mpeg",
        filename
      });
      return;
    }

    return res.status(502).json({ error: "YouTube blocked audio stream access for this request. Please try another URL." });
  } catch (err) {
    const friendly = toFriendlyYouTubeError(err);
    if (friendly) {
      return res.status(502).json({ error: friendly });
    }
    return handleApiError(res, err, req);
  }
}
