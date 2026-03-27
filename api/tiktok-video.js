import { Readable } from "node:stream";
import { applyApiGuards, handleApiError } from "../utils.js";

const ALLOWED_MEDIA_HOSTS = [
  /(^|\.)tiktokcdn\.com$/i,
  /(^|\.)muscdn\.com$/i,
  /(^|\.)byteoversea\.com$/i,
  /(^|\.)ibyteimg\.com$/i,
  /(^|\.)tikwm\.com$/i,
  /(^|\.)tikwm\.net$/i
];

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

export default async function handler(req, res) {
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