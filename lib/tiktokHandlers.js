import { Readable } from "node:stream";
import { applyApiGuards, handleApiError } from "../utils.js";
import { saGet, saText, ScrapeAtlasError } from "./scrapeAtlas.js";
import {
  buildPaymentRequiredResponse,
  finalizeToolAccess,
  getToolAccessState
} from "./credits.js";

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

/**
 * Scrape Atlas TikTok metadata mapping.
 *
 * SA returns { itemInfo: { itemStruct: {...} } } but field names inside
 * itemStruct can vary, so every field is picked defensively from several
 * likely names and never crashes on a missing field. The UI contract is
 * unchanged: { title, author, coverUrl, videoUrl, audioUrl, sourceUrl }.
 * The key lives in SCRAPE_ATLAS_API_KEY server-side only and is never
 * logged or returned; saGet sends it as the x-api-key header.
 */

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function extractItemStruct(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body?.itemInfo?.itemStruct,
    body?.itemStruct,
    body?.data?.itemStruct,
    body?.data,
    body?.itemInfo
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      (candidate.desc || candidate.caption || candidate.video || candidate.playAddr || candidate.id)
    ) {
      return candidate;
    }
  }
  return null;
}

function mapTikTokMeta(itemStruct) {
  const video = pickObject(itemStruct?.video) || pickObject(itemStruct?.videoInfo);
  const music = pickObject(itemStruct?.music) || pickObject(itemStruct?.music_info);
  const author = pickObject(itemStruct?.author);

  const videoUrl = pickString(
    video?.playAddr,
    video?.play_addr,
    video?.playUrl,
    video?.play,
    video?.url,
    typeof itemStruct?.video === "string" ? itemStruct.video : "",
    itemStruct?.playAddr,
    itemStruct?.play,
    itemStruct?.videoUrl,
    itemStruct?.video_url
  );

  return {
    title: saText(pickString(itemStruct?.desc, itemStruct?.caption, itemStruct?.title, itemStruct?.text), 600) || "TikTok video",
    author:
      saText(
        pickString(
          author?.nickname,
          author?.nickName,
          author?.displayName,
          author?.uniqueId,
          author?.unique_id,
          author?.username,
          author?.name,
          typeof itemStruct?.author === "string" ? itemStruct.author : ""
        ),
        200
      ) || "TikTok creator",
    coverUrl: pickString(
      video?.cover,
      video?.coverUrl,
      video?.originCover,
      video?.origin_cover,
      video?.poster,
      itemStruct?.cover,
      itemStruct?.coverUrl,
      itemStruct?.origin_cover
    ),
    videoUrl,
    audioUrl: pickString(
      music?.playUrl,
      music?.play_url,
      music?.play,
      music?.url,
      itemStruct?.musicUrl
    )
  };
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

    // Gate first: a blocked caller must never burn a Scrape Atlas credit.
    // tiktok costs 1 PromoFinder credit (TOOL_CREDIT_COSTS.tiktok); it was
    // previously gated but never deducted, so the listed 1-credit price
    // only becomes real with the charge below.
    const accessState = await getToolAccessState(req, "tiktok");
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    const payload = await saGet("/v1/tiktok/video", {
      tool: "tiktok",
      timeoutMs: 8000,
      params: { url: validation.value }
    });

    const itemStruct = extractItemStruct(payload);
    const mapped = itemStruct ? mapTikTokMeta(itemStruct) : null;
    if (!mapped || !mapped.videoUrl) {
      // No usable video data. No user charge: finalizeToolAccess is only
      // reached on the success path below.
      return res.status(400).json({ error: "Unable to process that TikTok URL." });
    }

    // Charge only after a successful SA response with usable video data.
    const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: true });
    if (!finalized.ok) {
      return res.status(402).json(finalized.payload);
    }

    return res.status(200).json({
      title: mapped.title,
      author: mapped.author,
      coverUrl: mapped.coverUrl,
      videoUrl: mapped.videoUrl,
      audioUrl: mapped.audioUrl,
      sourceUrl: validation.value,
      access: finalized.access
    });
  } catch (err) {
    if (err instanceof ScrapeAtlasError) {
      // NOTE: handleApiError maps every non-quota error to 500, which
      // would erase the SA status (404/429/503/504). Return the SA error
      // with its own status directly so the caller can tell "not found"
      // from "rate limited"; the message is already key-free (saGet +
      // sanitizeErrorMessage redact the key). No charge on this path.
      const status = Number.isInteger(err.status) ? err.status : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }
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