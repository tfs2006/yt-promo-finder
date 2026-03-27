import { applyApiGuards, handleApiError } from "../utils.js";

const TIKTOK_HOST_PATTERN = /(^|\.)tiktok\.com$/i;

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

export default async function handler(req, res) {
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