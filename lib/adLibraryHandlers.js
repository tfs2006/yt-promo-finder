import { applyApiGuards, handleApiError } from "../utils.js";
import { saGet, saText, ScrapeAtlasError } from "./scrapeAtlas.js";
import {
  buildPaymentRequiredResponse,
  finalizeToolAccess,
  getToolAccessState
} from "./credits.js";

const MAX_QUERY_LENGTH = 140;
const DEFAULT_REGION = "US";
const TOOL_KEY = "ad-libraries";
// Meta Ads is browser-backed and slow; Vercel Hobby allows a longer
// function time here, so give Scrape Atlas 20s for this tool.
const SA_TIMEOUT_MS = 20000;
// Cap the ads returned so one search stays well under the Vercel
// response cap even when the library returns a long list.
const MAX_ADS = 50;

function sanitizeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function sanitizeRegion(value) {
  const normalized = sanitizeText(value).toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return DEFAULT_REGION;
  return normalized;
}

// Map the UI region value to the Scrape Atlas country param:
// a two-letter country code passes through, anything else means ALL.
function toSaCountry(value) {
  const normalized = sanitizeText(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return "ALL";
}

// The snapshot object holds the creative, but its exact inner field names
// vary, so check several likely names and never crash on a missing field.
// Live defect (Nov 6 2026): the real SA snapshot body field is an object,
// not a string, and String(object) renders as "[object Object]". So text
// extraction must walk objects and arrays instead of stringifying them.
const TEXT_KEYS = ["text", "body", "content", "message", "value", "description", "title", "name"];

// A bare Meta dynamic-creative template, e.g. "{{product.name}}". Live
// defect (Nov 6 2026): several card titles rendered exactly this string.
// No "{{" string exists in this repo, so the placeholder arrives in the SA
// data itself (Meta catalog ads carry literal templates). It carries no
// information, so treat it as empty and let a fallback field, or no title,
// take its place.
const TEMPLATE_PLACEHOLDER = /^\{\{[^}]*\}\}$/;

// Extract readable text from a string, number, array, or nested object.
// Never returns "[object Object]": objects without a readable text key
// yield "" so the caller can try the next field name.
function extractText(value, maxLen = 600) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim().slice(0, maxLen);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, maxLen);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item, maxLen))
      .filter(Boolean)
      .join(" ")
      .slice(0, maxLen);
  }
  if (typeof value === "object") {
    for (const key of TEXT_KEYS) {
      if (value[key] === undefined || value[key] === null || value[key] === "") continue;
      const text = extractText(value[key], maxLen);
      if (text) return text;
    }
    return "";
  }
  return "";
}

// First defined, non-empty, readable text across the given objects and
// field names. Bare "{{...}}" template values are skipped so a later field
// name can supply the real value.
function pickText(objects, names, maxLen = 600) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const name of names) {
      if (obj[name] === undefined || obj[name] === null || obj[name] === "") continue;
      const text = extractText(obj[name], maxLen);
      if (!text) continue;
      if (TEMPLATE_PLACEHOLDER.test(text)) continue;
      return text;
    }
  }
  return "";
}

// Normalize a start date to an ISO date (YYYY-MM-DD). The real SA snapshot
// carries ad_delivery_start_time as a Unix epoch (seconds, e.g. 1752044400),
// which the page rendered raw because new Date("1752044400") is invalid.
// ISO date strings pass through unchanged.
function normalizeStartDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) >= 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text);
    const ms = text.length >= 13 ? num : num * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  return text.slice(0, 40);
}

// Strip one layer of surrounding quote characters from a search query.
// Live defect (Nov 6 2026): the results header read Found 30 ads for
// ""nike"" because the echoed query still carried its quotes.
function stripSurroundingQuotes(value) {
  return String(value || "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

function pickValue(objects, names) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const name of names) {
      const value = obj[name];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return "";
}

function pickArray(objects, names) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const name of names) {
      if (Array.isArray(obj[name])) return obj[name];
    }
  }
  return [];
}

function firstMediaUrl(items, names) {
  for (const item of items || []) {
    if (typeof item === "string" && item) return item;
    if (item && typeof item === "object") {
      const url = pickText([item], names, 500);
      if (url) return url;
    }
  }
  return "";
}

// Trim one raw Scrape Atlas ad to exactly the fields the UI needs.
// Never forward raw SA JSON to the browser.
function trimAd(raw) {
  const ad = raw && typeof raw === "object" ? raw : {};
  const snapshot = ad.snapshot && typeof ad.snapshot === "object" ? ad.snapshot : {};
  const sources = [snapshot, ad];

  const id = pickText(sources, ["ad_archive_id", "adArchiveId", "id"], 64);
  const pageName = pickText(
    sources,
    ["page_name", "pageName", "advertiser_name", "advertiserName", "page", "name"],
    200
  );
  // Meta's library fields are plural arrays (ad_creative_bodies,
  // ad_creative_link_titles); the SA snapshot may also nest the body in an
  // object. pickText handles all three shapes.
  const text = pickText(
    sources,
    ["ad_creative_bodies", "ad_creative_body", "body", "text", "ad_text", "adText", "message", "creative_body"],
    600
  );
  const headline = pickText(
    sources,
    ["ad_creative_link_titles", "ad_creative_link_title", "headline", "title", "link_title", "linkTitle"],
    200
  );
  const startDate = normalizeStartDate(
    pickValue(sources, ["ad_delivery_start_time", "start_date", "startDate", "ad_start_date"])
  );
  const platforms = pickArray(sources, ["publisher_platforms", "platforms", "publisherPlatforms"])
    .map((platform) => saText(platform, 40))
    .filter(Boolean)
    .slice(0, 8);
  const imageUrl = saText(
    firstMediaUrl(pickArray(sources, ["images", "image_urls", "imageUrls"]), [
      "original_image_url",
      "url",
      "src",
      "image_url",
      "imageUrl"
    ]),
    500
  );
  const videoUrl = saText(
    firstMediaUrl(pickArray(sources, ["videos", "video_urls", "videoUrls"]), [
      "video_url",
      "video_hd_url",
      "url",
      "src",
      "videoUrl"
    ]),
    500
  );
  const snapshotUrl = pickText(
    sources,
    ["ad_snapshot_url", "snapshot_url", "snapshotUrl", "ad_url"],
    500
  );
  const isActiveRaw = ad.is_active ?? snapshot.is_active ?? null;
  const isActive = typeof isActiveRaw === "boolean" ? isActiveRaw : null;

  return {
    id,
    pageId: pickText(sources, ["page_id", "pageId"], 64),
    pageName,
    text,
    headline,
    startDate,
    isActive,
    platforms,
    imageUrl,
    videoUrl,
    snapshotUrl,
    libraryUrl: id ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}` : ""
  };
}

export async function handleAdLibrariesSearch(req, res) {
  if (applyApiGuards(req, res, { rateKey: "ad-libraries", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const query = stripSurroundingQuotes(sanitizeText(req.query.query || ""));
  const region = sanitizeRegion(req.query.region || DEFAULT_REGION);

  if (!query) {
    return res.status(400).json({ error: "Search query is required." });
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: "Search query is too long." });
  }

  // Mirror api/domain.js: check access first, charge only after a
  // successful upstream response. This tool used to be gated but never
  // deducted; charging here makes the listed 2-credit price real.
  const accessState = await getToolAccessState(req, TOOL_KEY);
  if (!accessState.allowed) {
    return res.status(402).json(buildPaymentRequiredResponse(accessState));
  }

  let data;
  try {
    data = await saGet("/v1/facebook/adLibrary/search/ads", {
      tool: TOOL_KEY,
      timeoutMs: SA_TIMEOUT_MS,
      params: { query, country: toSaCountry(req.query.region), status: "ALL" }
    });
  } catch (err) {
    if (err instanceof ScrapeAtlasError) {
      // handleApiError collapses every error to a 500, which would hide
      // the real SA status (429 rate limited, 404 not found, 502
      // upstream), so answer SA errors directly with their own status
      // and code. No credits are charged on failure.
      return res.status(err.status || 502).json({ error: err.message, code: err.code });
    }
    return handleApiError(res, err, req);
  }

  const rawAds = Array.isArray(data?.ads)
    ? data.ads
    : Array.isArray(data?.searchResults)
      ? data.searchResults
      : [];
  const ads = rawAds.slice(0, MAX_ADS).map(trimAd);
  const coverage = data?.coverage && typeof data.coverage === "object" ? data.coverage : null;

  const notes = [];
  if (ads.length === 0) {
    notes.push("No ads found for that search in the Meta Ad Library. Try a brand name or a broader keyword.");
  }
  if (coverage && coverage.complete === false) {
    notes.push("Some ad data may be incomplete.");
  }
  if (Array.isArray(coverage?.warnings)) {
    for (const warning of coverage.warnings.slice(0, 3)) {
      if (warning) notes.push(String(warning).slice(0, 200));
    }
  }

  const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: true });
  if (!finalized.ok) {
    return res.status(402).json(finalized.payload);
  }

  return res.status(200).json({
    query,
    region,
    ads,
    adCount: ads.length,
    searchResultsCount: Number.isFinite(Number(data?.searchResultsCount))
      ? Number(data.searchResultsCount)
      : ads.length,
    fetchedAt: data?.fetchedAt || null,
    coverage,
    sourceUrl: data?.sourceUrl || "",
    notes,
    access: finalized.access
  });
}
