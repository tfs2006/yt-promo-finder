import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export const API_KEY = process.env.YOUTUBE_API_KEY;

// ============================================
// Storage Abstraction (Upstash Redis for production, file for local)
// ============================================

let redisClient = null;
const IS_VERCEL = process.env.VERCEL === '1' || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;

// Lazy load Upstash Redis client
async function getRedisClient() {
  if (redisClient) return redisClient;
  if (!IS_VERCEL) return null;
  
  try {
    const { Redis } = await import('@upstash/redis');
    // Support both Upstash and Vercel KV environment variable names
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    
    if (!url || !token) {
      console.warn('Redis credentials not found, falling back to file storage');
      return null;
    }
    
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (e) {
    console.warn('Upstash Redis not available, falling back to file storage:', e.message);
    return null;
  }
}

// File-based storage fallback for local development
const LOCAL_STORAGE_DIR = process.cwd();
const QUOTA_FILE = path.join(LOCAL_STORAGE_DIR, "quota.json");

async function kvGet(key) {
  const redis = await getRedisClient();
  if (redis) {
    try {
      return await redis.get(key);
    } catch (e) {
      console.error('Redis get error:', e.message);
      return null;
    }
  }
  // File fallback
  try {
    const filePath = path.join(LOCAL_STORAGE_DIR, `cache_${key.replace(/[^a-z0-9]/gi, '_')}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return null;
}

async function kvSet(key, value, options = {}) {
  const redis = await getRedisClient();
  if (redis) {
    try {
      // Upstash Redis supports ex (expiration in seconds)
      if (options.ex) {
        await redis.set(key, value, { ex: options.ex });
      } else {
        await redis.set(key, value);
      }
      return true;
    } catch (e) {
      console.error('Redis set error:', e.message);
      return false;
    }
  }
  // File fallback
  try {
    const filePath = path.join(LOCAL_STORAGE_DIR, `cache_${key.replace(/[^a-z0-9]/gi, '_')}.json`);
    fs.writeFileSync(filePath, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================
// Input Validation
// ============================================

/**
 * Validate and sanitize YouTube channel input
 * @param {string} input - User input (URL, handle, or channel ID)
 * @returns {{ valid: boolean, sanitized?: string, error?: string }}
 */
export function validateChannelInput(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Input is required' };
  }

  const trimmed = input.trim();
  
  // Check length
  if (trimmed.length < 2) {
    return { valid: false, error: 'Input is too short' };
  }
  if (trimmed.length > 500) {
    return { valid: false, error: 'Input is too long' };
  }

  // Check for malicious patterns
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /data:/i,
    /vbscript:/i
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: 'Invalid characters in input' };
    }
  }

  // Validate URL format if it looks like a URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      // Only allow youtube.com domains
      if (!url.hostname.match(/^(www\.)?(youtube\.com|youtu\.be)$/i)) {
        return { valid: false, error: 'Only YouTube URLs are allowed' };
      }
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  // Validate channel ID format
  if (/^UC[\w-]+$/i.test(trimmed)) {
    if (trimmed.length < 20 || trimmed.length > 30) {
      return { valid: false, error: 'Invalid channel ID format' };
    }
  }

  // Validate handle format
  if (trimmed.startsWith('@')) {
    if (!/^@[\w\.-]{1,50}$/.test(trimmed)) {
      return { valid: false, error: 'Invalid handle format' };
    }
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validate domain input for domain search
 * @param {string} input - Domain to search for
 * @returns {{ valid: boolean, sanitized?: string, error?: string }}
 */
export function validateDomainInput(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Domain is required' };
  }

  let domain = input.trim().toLowerCase();
  
  // Remove protocol if present
  domain = domain.replace(/^https?:\/\//, '');
  // Remove www. prefix
  domain = domain.replace(/^www\./, '');
  // Remove trailing slash and path
  domain = domain.split('/')[0];
  // Remove port if present
  domain = domain.split(':')[0];

  // Check length
  if (domain.length < 3 || domain.length > 253) {
    return { valid: false, error: 'Invalid domain length' };
  }

  // Validate domain format
  const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
  if (!domainRegex.test(domain)) {
    return { valid: false, error: 'Invalid domain format' };
  }

  return { valid: true, sanitized: domain };
}

// ============================================
// Quota Management (uses KV in production, file locally)
// ============================================

const DAILY_LIMIT = 10000;
const SAFETY_BUFFER = 500; // Reserve some quota to prevent hitting hard limit
const QUOTA_KEY_PREFIX = 'yt_promo_quota';

// In-memory quota cache to reduce KV calls within same request
let quotaCache = { date: null, used: 0 };

function getQuotaKey() {
  const today = new Date().toISOString().split("T")[0];
  return `${QUOTA_KEY_PREFIX}:${today}`;
}

/**
 * Get current quota status (async for KV support)
 */
export async function getQuotaStatusAsync() {
  const today = new Date().toISOString().split("T")[0];
  let currentUsed = 0;
  
  // Check in-memory cache first
  if (quotaCache.date === today) {
    currentUsed = quotaCache.used;
  } else {
    // Fetch from KV or file
    const data = await kvGet(getQuotaKey());
    if (data && data.date === today) {
      currentUsed = data.used;
      quotaCache = { date: today, used: currentUsed };
    } else {
      quotaCache = { date: today, used: 0 };
    }
  }

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
 * Synchronous quota status (uses cached value, for backward compatibility)
 */
export function getQuotaStatus() {
  const today = new Date().toISOString().split("T")[0];
  const currentUsed = (quotaCache.date === today) ? quotaCache.used : 0;

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
 * Check if we have enough quota for an operation (async)
 */
export async function checkQuotaAsync(cost) {
  const status = await getQuotaStatusAsync();
  if (status.usableRemaining < cost) {
    return {
      allowed: false,
      status,
      message: `Insufficient API quota. Need ${cost} units but only ${status.usableRemaining} remaining. Quota resets at midnight PT.`
    };
  }
  return { allowed: true, status };
}

/**
 * Synchronous quota check (uses cached value, for backward compatibility)
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

/**
 * Consume quota (updates in-memory cache immediately, persists async)
 * This is synchronous for compatibility but uses background persist
 */
export function consumeQuota(cost) {
  const today = new Date().toISOString().split("T")[0];
  
  // Initialize cache if needed
  if (quotaCache.date !== today) {
    quotaCache = { date: today, used: 0 };
  }

  const usableLimit = DAILY_LIMIT - SAFETY_BUFFER;
  if (quotaCache.used + cost > usableLimit) {
    const error = new Error(`Daily API limit reached. Please try again tomorrow when the quota resets at midnight PT.`);
    error.code = 'QUOTA_EXCEEDED';
    error.quotaStatus = getQuotaStatus();
    throw error;
  }

  // Update in-memory immediately
  quotaCache.used += cost;
  
  // Persist to storage asynchronously (fire and forget)
  persistQuota(today, quotaCache.used).catch(e => {
    console.error("Error persisting quota:", e.message);
  });
  
  return quotaCache.used;
}

/**
 * Persist quota to storage (KV or file)
 */
async function persistQuota(date, used) {
  await kvSet(getQuotaKey(), { date, used }, { ex: 86400 }); // Expires in 24 hours
}

/**
 * Initialize quota from storage (call at start of request)
 */
export async function initQuota() {
  const today = new Date().toISOString().split("T")[0];
  if (quotaCache.date === today) return; // Already initialized
  
  const data = await kvGet(getQuotaKey());
  if (data && data.date === today) {
    quotaCache = { date: today, used: data.used };
  } else {
    quotaCache = { date: today, used: 0 };
  }
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

// ============================================
// Video/Description Analysis Utilities
// ============================================

/**
 * Extract URLs from text (video descriptions)
 */
export function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s)\]>"']+)/gi;
  const matches = text.match(urlRegex) || [];
  return matches.map(u => u.replace(/[)\],.;:"'!\?\s]+$/, ""));
}

/**
 * Get domain from a URL
 */
export function domainFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return "unknown"; }
}

/**
 * Normalize URL by removing tracking parameters
 */
export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    const toRemove = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","tag","ascsubtag","source","ref","aff","aff_id","affid"];
    for (const k of toRemove) x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}

/**
 * Guess product name from description line containing URL
 */
export function guessProductNameFromLine(line, url) {
  const idx = line.indexOf(url);
  const before = idx > -1 ? line.slice(0, idx).trim() : line.trim();
  const parts = before.split(/[:\-–]|\\|/).map(s => s.trim()).filter(Boolean);
  if (parts.length) {
    const guess = parts[parts.length - 1];
    if (guess.length >= 3 && !/^(link|product|buy|amazon|gear)$/i.test(guess)) return guess;
  }
  return "";
}

/**
 * Regex pattern for filtering out social media domains
 */
export const SOCIAL_MEDIA_FILTER = /(patreon|instagram|twitter|x\.com|facebook|tiktok|threads\.net|linkedin|discord|paypal|buymeacoffee|linktr|linktree|beacons\.ai|bitly\.page|youtube\.com)/i;

/**
 * Iterate through uploads playlist videos since a given date
 */
export async function* iterateUploads(playlistId, sinceISO) {
  let pageToken = "";
  const since = new Date(sinceISO);
  while (true) {
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await fetchJson(url);
    const items = data.items || [];
    for (const it of items) {
      const publishedAt = it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt;
      if (!publishedAt) continue;
      const d = new Date(publishedAt);
      if (d < since) return;
      yield {
        videoId: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId,
        title: it.snippet?.title,
        publishedAt
      };
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
}

/**
 * Get video details (title, description) for a list of video IDs
 */
export async function getVideoDetails(videoIds) {
  const details = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    consumeQuota(1);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${chunk.join(",")}&key=${API_KEY}`;
    const data = await fetchJson(url);
    for (const it of data.items || []) {
      details.push({
        videoId: it.id,
        title: it.snippet?.title || "",
        description: it.snippet?.description || "",
        publishedAt: it.snippet?.publishedAt
      });
    }
  }
  return details;
}
