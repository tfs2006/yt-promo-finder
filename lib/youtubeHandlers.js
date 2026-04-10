import { Readable } from "node:stream";
import ytdl from "@distube/ytdl-core";
import { applyApiGuards, handleApiError } from "../utils.js";

const YOUTUBE_HOST_PATTERN = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

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
  if (!ytdl.validateURL(normalized)) {
    return { ok: false, error: "Please provide a valid YouTube video URL." };
  }

  return { ok: true, value: normalized };
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
  const progressive = formats.filter((fmt) => fmt.hasVideo && fmt.hasAudio);
  const mp4Progressive = progressive.filter((fmt) => fmt.container === "mp4");
  const source = mp4Progressive.length ? mp4Progressive : progressive;
  if (!source.length) return null;

  return source
    .slice()
    .sort((a, b) => {
      const bHeight = Number(b.height || 0);
      const aHeight = Number(a.height || 0);
      if (bHeight !== aHeight) return bHeight - aHeight;
      return Number(b.bitrate || 0) - Number(a.bitrate || 0);
    })[0];
}

function pickAudioFormat(formats) {
  const audioOnly = formats.filter((fmt) => fmt.hasAudio && !fmt.hasVideo);
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

function streamDownload(res, stream, fallbackErrorMessage) {
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({ error: fallbackErrorMessage });
      return;
    }
    res.destroy();
  });

  const nodeReadable = stream.readableWebStream
    ? Readable.fromWeb(stream.readableWebStream())
    : stream;

  nodeReadable.pipe(res);
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

    const info = await ytdl.getInfo(validation.value);
    const videoFormat = pickVideoFormat(info.formats);
    const audioFormat = pickAudioFormat(info.formats);

    if (!videoFormat) {
      return res.status(400).json({ error: "No downloadable video format is available for this URL." });
    }

    const details = info.videoDetails || {};

    return res.status(200).json({
      title: details.title || "YouTube video",
      author: details.author?.name || details.ownerChannelName || "YouTube creator",
      coverUrl: pickThumbnail(details),
      sourceUrl: validation.value,
      videoId: details.videoId || "",
      durationSeconds: Number(details.lengthSeconds || 0),
      hasAudioDownload: Boolean(audioFormat)
    });
  } catch (err) {
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

    const info = await ytdl.getInfo(validation.value);
    const format = pickVideoFormat(info.formats);
    if (!format) {
      return res.status(400).json({ error: "No progressive video format is available for download." });
    }

    const extension = format.container === "webm" ? "webm" : "mp4";
    const filename = toSafeFilename(info.videoDetails?.title, "youtube-video", extension);

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", format.mimeType?.split(";")[0] || "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = ytdl.downloadFromInfo(info, {
      quality: format.itag,
      filter: "audioandvideo"
    });

    streamDownload(res, stream, "Failed to retrieve video file.");
  } catch (err) {
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

    const info = await ytdl.getInfo(validation.value);
    const format = pickAudioFormat(info.formats);
    if (!format) {
      return res.status(400).json({ error: "No audio-only format is available for download." });
    }

    const extension = format.container === "webm" ? "webm" : "m4a";
    const filename = toSafeFilename(info.videoDetails?.title, "youtube-audio", extension);

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", format.mimeType?.split(";")[0] || "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = ytdl.downloadFromInfo(info, {
      quality: format.itag,
      filter: "audioonly"
    });

    streamDownload(res, stream, "Failed to retrieve audio file.");
  } catch (err) {
    return handleApiError(res, err, req);
  }
}
