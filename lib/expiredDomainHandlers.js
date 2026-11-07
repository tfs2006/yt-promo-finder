import {
  applyApiGuards,
  handleApiError,
  kvGet,
  kvSet,
  getCache,
  setCache,
  CACHE_TTL
} from "../utils.js";
import {
  buildPaymentRequiredResponse,
  finalizeToolAccess,
  getToolAccessState
} from "./credits.js";

// Expired Domain Finder v1 (Nov 6 2026). Free data only, deterministic,
// rules-based. No AI keys, no paid traffic APIs.
//
// How it works:
// 1. The drop pool is the public deleted-domains list at
//    ExpiredDomains.net (/deleted-domains/, 25 domains per page, no login
//    required). It is fetched server-side, parsed, cached in KV for 6h,
//    and keyword-filtered. It is the most recently deleted domains, not
//    the whole database: keyword search covers the pool, and the response
//    says exactly how big that pool was.
// 2. Each candidate is verified against two free sources before it is
//    shown: RDAP (https://rdap.org/domain/<domain>; 404 = available to
//    register, 200 = still registered) and the Wayback Machine CDX API
//    (first capture, last capture, capture count). Only domains confirmed
//    available AND with real site history are returned.
// 3. Honesty rule: Wayback history is labelled site history, never
//    traffic. No visitor counts, backlink counts, or traffic numbers are
//    claimed anywhere. A domain with no history is left out, never
//    presented as a gem.
//
// Charging follows the ad-libraries pattern: access is checked first,
// the work runs, and credits are deducted only after a successful
// response. Every failure path returns before finalize, so nothing is
// charged on failure.

export const TOOL_KEY = "expired-domains";
export const POOL_CACHE_KEY = "expired_domains:pool:v1";
export const POOL_TTL_SECONDS = 6 * 60 * 60;
export const VERIFY_CACHE_PREFIX = "expired_domains:verify:v1:";
export const VERIFY_TTL_SECONDS = 24 * 60 * 60;

const EDN_LIST_URL = "https://www.expireddomains.net/deleted-domains/";
const USER_AGENT = "Mozilla/5.0 (compatible; PromoFinder/1.0; +https://promofinder.4ourmedia.com)";

// Pages of 25 fetched per pool refresh (800 domains). The refresh runs
// only when the KV/memory cache is stale, so most searches cost no
// upstream list fetch at all.
const POOL_PAGES = 32;
const POOL_PAGE_SIZE = 25;
const POOL_FETCH_CONCURRENCY = 8;
const POOL_FETCH_TIMEOUT_MS = 8000;

const MAX_KEYWORD_LENGTH = 40;
const MAX_CANDIDATES_TO_VERIFY = 20;
const MAX_RESULTS = 20;
const VERIFY_CONCURRENCY = 5;
const RDAP_TIMEOUT_MS = 5000;
const CDX_TIMEOUT_MS = 8000;
const CDX_LIMIT = 500;
// The whole search (pool refresh + verification) must finish inside the
// 30s Vercel ceiling for this function, with margin for the charge write.
const GLOBAL_DEADLINE_MS = 24000;

export const ALLOWED_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "co",
  "ai",
  "app",
  "dev",
  "me",
  "us",
  "info",
  "biz"
]);

function sanitizeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

// Keyword: 2-40 chars, lowercase letters, digits, hyphens. Surrounding
// quotes are stripped (the same defect ad-libraries hit: a quoted query
// echoed back with doubled quotes).
export function normalizeKeyword(raw) {
  const cleaned = sanitizeText(raw)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim()
    .toLowerCase();
  if (cleaned.length < 2 || cleaned.length > MAX_KEYWORD_LENGTH) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) return "";
  return cleaned;
}

// TLD: one allowlisted TLD, or "all". Anything else is rejected so a
// crafted value can never widen the search to junk TLDs.
export function normalizeTld(raw) {
  const cleaned = sanitizeText(raw).toLowerCase().replace(/^\./, "");
  if (cleaned === "" || cleaned === "all") return "all";
  if (ALLOWED_TLDS.has(cleaned)) return cleaned;
  return "";
}

function splitDomain(domain) {
  const idx = domain.lastIndexOf(".");
  if (idx <= 0) return { name: domain, tld: "" };
  return { name: domain.slice(0, idx), tld: domain.slice(idx + 1) };
}

// Quality gate for pool candidates. The raw drop list is dominated by
// bulk-registered junk (random strings, digit soup, odd TLDs). A real
// expired domain worth showing is a pronounceable name on a mainstream
// TLD. This is a heuristic, not a verdict: it only decides what enters
// verification, and verification (RDAP + Wayback) decides what is shown.
export function isQualityCandidate(domain) {
  const { name, tld } = splitDomain(String(domain || "").toLowerCase());
  if (!ALLOWED_TLDS.has(tld)) return false;
  if (name.length < 3 || name.length > 30) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return false;
  const digitCount = (name.match(/\d/g) || []).length;
  if (digitCount > 2) return false;
  if (/^\d+$/.test(name)) return false;
  return true;
}

export function keywordMatches(domain, keyword) {
  const { name } = splitDomain(String(domain || "").toLowerCase());
  return name.includes(keyword);
}

// Parse one ExpiredDomains.net deleted-domains list page. The domain name
// lives in the link's title attribute (the visible text truncates long
// names with "..."), so parse the title, never the text. Both attribute
// orders are accepted so a layout tweak does not silently empty the pool.
const NAMELINK_RE =
  /<a\b[^>]*\btitle="([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})"[^>]*\bclass="namelinks"|<a\b[^>]*\bclass="namelinks"[^>]*\btitle="([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})"/g;

export function parseDeletedDomainsPage(html) {
  const found = new Set();
  if (typeof html !== "string" || !html) return [];
  NAMELINK_RE.lastIndex = 0;
  let match;
  while ((match = NAMELINK_RE.exec(html)) !== null) {
    const domain = String(match[1] || match[2] || "").toLowerCase();
    if (!domain || domain.includes("..")) continue;
    const { name, tld } = splitDomain(domain);
    if (!name || !tld || name.length > 63) continue;
    found.add(domain);
  }
  return [...found];
}

function toIsoDate(timestamp) {
  const text = String(timestamp || "").trim();
  if (!/^\d{14}$/.test(text)) return "";
  const year = text.slice(0, 4);
  const month = text.slice(4, 6);
  const day = text.slice(6, 8);
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

// Parse a Wayback CDX JSON response (output=json with
// fl=timestamp,original,statuscode). Rows are time-ascending, so the
// first row is the earliest capture and the last row the latest. The
// header row (["timestamp","original","statuscode"]) is skipped by the
// timestamp shape check. Returns null when there is no usable history.
export function parseWaybackHistory(payload, limit = CDX_LIMIT) {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const stamps = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const iso = toIsoDate(row[0]);
    if (iso) stamps.push(iso);
  }
  if (stamps.length === 0) return null;
  return {
    hasHistory: true,
    firstCapture: stamps[0],
    lastCapture: stamps[stamps.length - 1],
    captureCount: stamps.length,
    capturesCapped: stamps.length >= limit
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs)
  });
  return res;
}

async function mapPool(items, worker, concurrency) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Fetch one list page and parse it. A single page failing must not kill
// the pool: it contributes zero domains and the refresh continues.
async function fetchListPage(start) {
  const url = `${EDN_LIST_URL}?start=${start}`;
  const res = await fetchWithTimeout(url, POOL_FETCH_TIMEOUT_MS);
  if (!res.ok) return [];
  const html = await res.text();
  return parseDeletedDomainsPage(html);
}

function isFreshPool(cached) {
  if (!cached || typeof cached !== "object") return false;
  if (!Array.isArray(cached.domains) || cached.domains.length === 0) return false;
  if (!cached.fetchedAt) return false;
  return Date.now() - Date.parse(cached.fetchedAt) < POOL_TTL_SECONDS * 1000;
}

function normalizePool(raw) {
  if (!raw || typeof raw !== "object") return null;
  const domains = Array.isArray(raw.domains) ? [...new Set(raw.domains.map((d) => String(d).toLowerCase()))] : [];
  if (domains.length === 0) return null;
  return {
    domains,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : new Date().toISOString(),
    stale: false
  };
}

// Load the drop pool: in-memory cache, then KV, then a live refresh.
// A refresh that fails with a usable cached pool behind it serves the
// stale pool with stale: true. A refresh that fails with nothing cached
// throws, and the handler answers 502 without charging.
export async function loadDropPool(deadlineMs) {
  const memCached = getCache(POOL_CACHE_KEY);
  if (isFreshPool(memCached)) return { ...normalizePool(memCached), stale: false };

  const kvCached = await kvGet(POOL_CACHE_KEY);
  const kvPool = normalizePool(kvCached);
  if (kvPool && isFreshPool(kvPool)) {
    setCache(POOL_CACHE_KEY, kvPool, CACHE_TTL.MEDIUM);
    return { ...kvPool, stale: false };
  }

  const fetchedAt = new Date().toISOString();
  const found = new Set(kvPool ? kvPool.domains : []);
  const starts = Array.from({ length: POOL_PAGES }, (_, i) => i * POOL_PAGE_SIZE);
  let pagesOk = 0;
  await mapPool(starts, async (start) => {
    if (Date.now() > deadlineMs) return;
    try {
      const domains = await fetchListPage(start);
      if (domains.length) pagesOk += 1;
      for (const domain of domains) found.add(domain);
    } catch {
      // One page failing is not a pool failure; other pages still count.
    }
  }, POOL_FETCH_CONCURRENCY);

  if (found.size === 0) {
    if (kvPool) return { ...kvPool, stale: true };
    throw new Error("Deleted-domains list unreachable.");
  }

  const pool = { domains: [...found], fetchedAt, stale: false };
  setCache(POOL_CACHE_KEY, pool, CACHE_TTL.MEDIUM);
  // Best-effort KV write: a KV failure must not fail the search, the
  // in-memory pool above is enough for this request.
  try {
    await kvSet(POOL_CACHE_KEY, pool, { ex: POOL_TTL_SECONDS });
  } catch {
    // Ignore: KV is a cross-request optimization, not a requirement.
  }
  return { ...pool, stale: pagesOk === 0 && !!kvPool };
}

// RDAP availability: 404 = the domain is not registered (available),
// 200 = still registered, anything else (or a network error) = unknown.
// Unknown is never shown as available: only a confirmed 404 passes.
export async function checkRdapAvailable(domain) {
  try {
    const res = await fetchWithTimeout(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      RDAP_TIMEOUT_MS
    );
    if (res.status === 404) return true;
    if (res.status === 200) return false;
    return null;
  } catch {
    return null;
  }
}

// Wayback history for one domain. Returns { hasHistory: false } when
// the archive has no captures, null when the lookup itself failed.
export async function fetchWaybackHistory(domain) {
  try {
    const url =
      "https://web.archive.org/cdx/search/cdx?url=" +
      encodeURIComponent(domain) +
      "&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&limit=" +
      CDX_LIMIT;
    const res = await fetchWithTimeout(url, CDX_TIMEOUT_MS);
    if (!res.ok) return null;
    const payload = await res.json();
    const parsed = parseWaybackHistory(payload, CDX_LIMIT);
    if (!parsed) return { hasHistory: false };
    return parsed;
  } catch {
    return null;
  }
}

function verifyCacheKey(domain) {
  return VERIFY_CACHE_PREFIX + domain.toLowerCase();
}

// Verify one candidate: RDAP availability, then Wayback history. Results
// are cached per domain (KV 24h + in-memory) so repeat searches do not
// re-hit RDAP and the archive for the same names.
export async function verifyDomain(domain) {
  const key = verifyCacheKey(domain);
  const memCached = getCache(key);
  if (memCached && typeof memCached === "object") return memCached;

  let kvCached = null;
  try {
    kvCached = await kvGet(key);
  } catch {
    kvCached = null;
  }
  if (kvCached && typeof kvCached === "object") {
    setCache(key, kvCached, CACHE_TTL.MEDIUM);
    return kvCached;
  }

  const available = await checkRdapAvailable(domain);
  if (available !== true) {
    const result = { domain, available: available === false ? false : null, hasHistory: false };
    setCache(key, result, CACHE_TTL.MEDIUM);
    try {
      await kvSet(key, result, { ex: VERIFY_TTL_SECONDS });
    } catch {
      // Ignore KV failures; the memory cache still serves this request.
    }
    return result;
  }

  const history = await fetchWaybackHistory(domain);
  if (history === null) {
    // The archive lookup itself failed: unknown, not "no history".
    const result = { domain, available: true, hasHistory: false, historyUnknown: true };
    setCache(key, result, CACHE_TTL.MEDIUM);
    try {
      await kvSet(key, result, { ex: VERIFY_TTL_SECONDS });
    } catch {
      // Ignore KV failures; the memory cache still serves this request.
    }
    return result;
  }
  const result =
    history.hasHistory
      ? { domain, available: true, ...history }
      : { domain, available: true, hasHistory: false };
  setCache(key, result, CACHE_TTL.MEDIUM);
  try {
    await kvSet(key, result, { ex: VERIFY_TTL_SECONDS });
  } catch {
    // Ignore KV failures; the memory cache still serves this request.
  }
  return result;
}

export async function handleExpiredDomainsSearch(req, res) {
  if (applyApiGuards(req, res, { rateKey: "expired-domains", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const keyword = normalizeKeyword(req.query.keyword || "");
  if (!keyword) {
    return res.status(400).json({
      error: "Enter a keyword of 2 to 40 letters, digits, or hyphens to search expired domains."
    });
  }

  const tld = normalizeTld(req.query.tld || "com");
  if (!tld) {
    return res.status(400).json({
      error: "Choose a supported domain ending (.com, .net, .org, .io, .co, .ai, .app, .dev, .me, .us, .info, .biz) or All."
    });
  }

  // Mirror api/domain.js and the ad-libraries handler: check access
  // first, charge only after a successful upstream response.
  const accessState = await getToolAccessState(req, TOOL_KEY);
  if (!accessState.allowed) {
    return res.status(402).json(buildPaymentRequiredResponse(accessState));
  }

  const deadlineMs = Date.now() + GLOBAL_DEADLINE_MS;

  let pool;
  try {
    pool = await loadDropPool(deadlineMs);
  } catch (err) {
    // The feed is down and nothing is cached: fail open with a 502 and
    // no charge, never a faked empty result.
    return res.status(502).json({
      error: "The deleted-domains list is unreachable right now. Try again in a few minutes.",
      code: "UPSTREAM_UNAVAILABLE"
    });
  }

  const candidates = pool.domains
    .filter(
      (domain) =>
        keywordMatches(domain, keyword) &&
        (tld === "all" || splitDomain(domain).tld === tld) &&
        isQualityCandidate(domain)
    )
    .slice(0, MAX_CANDIDATES_TO_VERIFY);

  const verified = [];
  const excluded = { registered: 0, noHistory: 0, unknown: 0 };
  await mapPool(
    candidates,
    async (domain) => {
      if (Date.now() > deadlineMs) {
        excluded.unknown += 1;
        return;
      }
      const result = await verifyDomain(domain);
      if (result.available === false) {
        excluded.registered += 1;
        return;
      }
      if (result.available === null || result.historyUnknown) {
        excluded.unknown += 1;
        return;
      }
      if (!result.hasHistory) {
        excluded.noHistory += 1;
        return;
      }
      verified.push(result);
    },
    VERIFY_CONCURRENCY
  );

  verified.sort((a, b) => b.captureCount - a.captureCount);
  const results = verified.slice(0, MAX_RESULTS).map((item) => ({
    domain: item.domain,
    tld: splitDomain(item.domain).tld,
    available: true,
    firstCapture: item.firstCapture,
    lastCapture: item.lastCapture,
    captureCount: item.captureCount,
    capturesCapped: item.capturesCapped,
    historyUrl: `https://web.archive.org/web/${encodeURIComponent(item.domain)}`,
    rdapUrl: `https://rdap.org/domain/${encodeURIComponent(item.domain)}`
  }));

  const notes = [];
  notes.push(
    `Searched ${pool.domains.length.toLocaleString()} recently deleted domains from the public drop list` +
      (pool.stale ? " (list refresh failed, showing the last cached list)" : "") +
      `.`
  );
  if (candidates.length === 0) {
    notes.push(
      "No domains in this batch matched that keyword. Try a broader keyword, another ending, or check back after the list refreshes."
    );
  }
  if (excluded.noHistory > 0) {
    notes.push(
      `${excluded.noHistory} available ${excluded.noHistory === 1 ? "domain was" : "domains were"} left out because the archive has no site history for ${excluded.noHistory === 1 ? "it" : "them"}.`
    );
  }
  if (excluded.unknown > 0) {
    notes.push(
      `${excluded.unknown} ${excluded.unknown === 1 ? "candidate" : "candidates"} could not be verified in time and were left out rather than shown unverified.`
    );
  }
  notes.push(
    "Site history comes from the Wayback Machine: it shows a domain once hosted a real site, not how much traffic it had. No visitor or backlink counts are shown because none were measured."
  );

  const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: true });
  if (!finalized.ok) {
    return res.status(402).json(finalized.payload);
  }

  return res.status(200).json({
    keyword,
    tld,
    results,
    resultCount: results.length,
    checkedCount: candidates.length,
    searchedPoolSize: pool.domains.length,
    poolFetchedAt: pool.fetchedAt,
    poolStale: pool.stale,
    excluded,
    notes,
    access: finalized.access
  });
}
