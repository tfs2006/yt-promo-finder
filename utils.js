import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export const API_KEY = process.env.YOUTUBE_API_KEY;

const QUOTA_FILE = process.env.VERCEL 
  ? path.join("/tmp", "quota.json") 
  : path.join(process.cwd(), "quota.json");

const DAILY_LIMIT = 10000;
const SAFETY_BUFFER = 500; // Reserve some quota to prevent hitting hard limit

/**
 * Get current quota status
 */
export function getQuotaStatus() {
  const today = new Date().toISOString().split("T")[0];
  let currentUsed = 0;
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
      if (data.date === today) {
        currentUsed = data.used;
      }
    }
  } catch (e) {}

  const remaining = DAILY_LIMIT - currentUsed;
  const usableRemaining = Math.max(0, remaining - SAFETY_BUFFER);
  
  return {
    used: currentUsed,
    remaining,
    usableRemaining,
    limit: DAILY_LIMIT,
    percentUsed: Math.round((currentUsed / DAILY_LIMIT) * 100),
    isLow: usableRemaining < 1000,
    isExhausted: usableRemaining <= 0,
    resetsAt: new Date(new Date().setHours(24, 0, 0, 0) - new Date().getTimezoneOffset() * 60000).toISOString()
  };
}

/**
 * Check if we have enough quota for an operation
 */
export function checkQuota(cost) {
  const status = getQuotaStatus();
  if (status.usableRemaining < cost) {
    return {
      allowed: false,
      status,
      message: `Insufficient API quota. Need ${cost} units but only ${status.usableRemaining} remaining. Quota resets at midnight PT.`
    };
  }
  return { allowed: true, status };
}

export function consumeQuota(cost) {
  const today = new Date().toISOString().split("T")[0];
  let currentUsed = 0;
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
      if (data.date === today) {
        currentUsed = data.used;
      }
    }
  } catch (e) {}

  const usableLimit = DAILY_LIMIT - SAFETY_BUFFER;
  if (currentUsed + cost > usableLimit) {
    const error = new Error(`Daily API limit reached. Please try again tomorrow when the quota resets at midnight PT.`);
    error.code = 'QUOTA_EXCEEDED';
    error.quotaStatus = getQuotaStatus();
    throw error;
  }

  const newUsed = currentUsed + cost;
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: today, used: newUsed }));
  } catch (e) {
    console.error("Error writing quota file:", e);
  }
  return newUsed;
}

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    // Check for YouTube API quota errors
    if (res.status === 403 && txt.includes('quotaExceeded')) {
      const error = new Error('YouTube API quota exceeded. Please try again tomorrow.');
      error.code = 'YOUTUBE_QUOTA_EXCEEDED';
      throw error;
    }
    throw new Error(`HTTP ${res.status} for ${url}\n${txt}`);
  }
  return res.json();
}

// ============================================
// Shared utility functions used across API handlers
// ============================================

/**
 * Simple in-memory cache with TTL
 */
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 15; // 15 minutes

export function setCache(key, data) { 
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS }); 
}

export function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { 
    cache.delete(key); 
    return null; 
  }
  return entry.data;
}

/**
 * Parse channel ID from various YouTube URL formats
 */
export function parseChannelIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const channelMatch = url.pathname.match(/\/channel\/(UC[\w-]+)/i);
    if (channelMatch) return { type: "channelId", value: channelMatch[1] };
    const userMatch = url.pathname.match(/\/user\/([\w\.-]+)/i);
    if (userMatch) return { type: "username", value: userMatch[1] };
    const handleMatch = url.pathname.match(/\/(@[\w\.-]+)/);
    if (handleMatch) return { type: "handle", value: handleMatch[1] };
    const customMatch = url.pathname.match(/\/c\/([\w\.-]+)/i);
    if (customMatch) return { type: "custom", value: customMatch[1] };
  } catch {
    const trimmed = rawUrl.trim();
    if (/^UC[\w-]+$/i.test(trimmed)) return { type: "channelId", value: trimmed };
    if (/^@[\w\.-]+$/.test(trimmed)) return { type: "handle", value: trimmed };
  }
  return { type: "unknown", value: rawUrl };
}

/**
 * Resolve a channel ID from various URL formats
 */
export async function resolveChannelId(spec) {
  if (spec.type === "channelId") return spec.value;
  if (spec.type === "username") {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(spec.value)}&key=${API_KEY}`;
    const data = await fetchJson(url);
    if (data.items?.length) return data.items[0].id;
  }
  const q = spec.value.replace(/^@/, "");
  consumeQuota(100);
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(q)}&key=${API_KEY}`;
  const data = await fetchJson(url);
  if (data.items?.length) {
    return data.items[0].snippet?.channelId || data.items[0].id?.channelId;
  }
  throw new Error("Unable to resolve channel ID from the provided URL or handle.");
}

/**
 * Get uploads playlist ID for a channel
 */
export async function getUploadsPlaylistId(channelId) {
  consumeQuota(1);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${API_KEY}`;
  const data = await fetchJson(url);
  const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("Uploads playlist not available for this channel.");
  return uploads;
}

/**
 * Standard CORS headers for API responses
 */
export function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Handle API errors consistently
 */
export function handleApiError(res, err) {
  console.error(err);
  
  if (err.code === 'QUOTA_EXCEEDED' || err.code === 'YOUTUBE_QUOTA_EXCEEDED') {
    return res.status(429).json({ 
      error: err.message,
      code: 'QUOTA_EXCEEDED',
      quotaStatus: err.quotaStatus || getQuotaStatus()
    });
  }
  
  return res.status(500).json({ error: err.message || "Unexpected server error." });
}
