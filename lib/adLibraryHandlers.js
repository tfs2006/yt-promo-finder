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

// First defined, non-empty value across the given objects and field names.
// The snapshot object holds the creative, but its exact inner field names
// vary, so check several likely names and never crash on a missing field.
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
      const url = pickValue([item], names);
      if (url) return String(url);
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

  const id = saText(pickValue(sources, ["ad_archive_id", "adArchiveId", "id"]), 64);
  const pageName = saText(
    pickValue(sources, ["page_name", "pageName", "advertiser_name", "advertiserName", "page", "name"]),
    200
  );
  const text = saText(
    pickValue(sources, ["ad_creative_body", "body", "text", "ad_text", "adText", "message", "creative_body"]),
    600
  );
  const headline = saText(
    pickValue(sources, ["ad_creative_link_title", "headline", "title", "link_title", "linkTitle"]),
    200
  );
  const startDate = saText(
    pickValue(sources, ["ad_delivery_start_time", "start_date", "startDate", "ad_start_date"]),
    40
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
  const snapshotUrl = saText(
    pickValue(sources, ["ad_snapshot_url", "snapshot_url", "snapshotUrl", "ad_url"]),
    500
  );
  const isActiveRaw = ad.is_active ?? snapshot.is_active ?? null;
  const isActive = typeof isActiveRaw === "boolean" ? isActiveRaw : null;

  return {
    id,
    pageId: saText(pickValue(sources, ["page_id", "pageId"]), 64),
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

  const query = sanitizeText(req.query.query || "");
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
