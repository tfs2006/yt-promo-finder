import { Readable } from "node:stream";
import { applyApiGuards, handleApiError } from "../utils.js";

const TIKTOK_HOST_PATTERN = /(^|\.)tiktok\.com$/i;

const ALLOWED_MEDIA_HOSTS = [
  /(^|\.)tiktokcdn(?:-[a-z0-9-]+)?\.com$/i,
  /(^|\.)muscdn(?:-[a-z0-9-]+)?\.com$/i,
  /(^|\.)byteoversea(?:-[a-z0-9-]+)?\.com$/i,
  /(^|\.)ibyteimg\.com$/i,
  /(^|\.)tiktokv\.com$/i,
  /(^|\.)tikwm\.com$/i,
  /(^|\.)tikwm\.net$/i
];

function sanitizeTikTokInput(raw) {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "TikTok URL is required." };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "TikTok URL is required." };
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
  if (!TIKTOK_HOST_PATTERN.test(parsed.hostname)) {
    return { ok: false, error: "Only TikTok URLs are allowed." };
  }

  return { ok: true, value: parsed.toString() };
}

function validateMediaUrl(raw) {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "Media URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid media URL." };
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return { ok: false, error: "Only http and https URLs are allowed." };
  }

  const allowed = ALLOWED_MEDIA_HOSTS.some((pattern) => pattern.test(parsed.hostname));
  if (!allowed) {
    return { ok: false, error: "Blocked media host." };
  }

  return { ok: true, value: parsed.toString() };
}

async function fetchTikwm(url) {
  const endpoint = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!response.ok) {
    throw new Error(`TikWM request failed (${response.status}).`);
  }

  return response.json();
}

export async function handleTikTokMeta(req, res) {
  if (applyApiGuards(req, res, { rateKey: "tiktok", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = sanitizeTikTokInput((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const payload = await fetchTikwm(validation.value);
    if (payload?.code !== 0 || !payload?.data) {
      return res.status(400).json({ error: payload?.msg || "Unable to process that TikTok URL." });
    }

    const media = payload.data;
    const audioUrl = media.music || media.music_info?.play || "";

    return res.status(200).json({
      title: media.title || "TikTok video",
      author: media.author?.nickname || media.author?.unique_id || "TikTok creator",
      coverUrl: media.cover || media.origin_cover || "",
      videoUrl: media.play || media.wmplay || "",
      audioUrl,
      sourceUrl: validation.value
    });
  } catch (err) {
    return handleApiError(res, err, req);
  }
}

export async function handleTikTokVideo(req, res) {
  if (applyApiGuards(req, res, { rateKey: "tiktok-video", maxRequests: 15, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = validateMediaUrl((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const upstream = await fetch(validation.value, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://www.tiktok.com/"
      }
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: "Failed to retrieve video file." });
    }

    const contentType = upstream.headers.get("content-type") || "video/mp4";
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", contentType.startsWith("video/") ? contentType : "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="tiktok-video.mp4"');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    return handleApiError(res, err, req);
  }
}

export async function handleTikTokAudio(req, res) {
  if (applyApiGuards(req, res, { rateKey: "tiktok-audio", maxRequests: 15, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const validation = validateMediaUrl((req.query.url || "").toString());
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const upstream = await fetch(validation.value, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://www.tiktok.com/"
      }
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: "Failed to retrieve audio file." });
    }

    const contentType = upstream.headers.get("content-type") || "audio/mpeg";
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", contentType.startsWith("audio/") ? contentType : "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="tiktok-audio.mp3"');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    return handleApiError(res, err, req);
  }
}