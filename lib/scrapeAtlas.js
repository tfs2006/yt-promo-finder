/**
 * Shared Scrape Atlas client for PromoFinder (server-side only).
 *
 * Scrape Atlas: https://api.scrapeatlas.com, auth via the x-api-key header,
 * 1 credit per successful request, 0 credits for failed requests.
 * The key lives in the SCRAPE_ATLAS_API_KEY Vercel env var and is never
 * logged, never returned to the browser, and never embedded in error text.
 *
 * Rules enforced here:
 * - A pasted literal trailing "\r" / "\n" is stripped from the env value
 *   (same defect broke the Supabase key Nov 2 2026 and was the prime
 *   suspect in the Stripe webhook failure Nov 5 2026).
 * - A 429 (upstream_rate_limited) is never retried blindly: the call fails
 *   soft with a clear message and the caller must not charge the user.
 * - Every call is counted in a server-side KV ledger (total + daily) so a
 *   runaway loop or abuse spike cannot silently drain the 50,000-credit
 *   grant. The ledger is fire-and-forget and never blocks a response.
 * - Responses are returned trimmed by the caller: never forward raw SA JSON
 *   to the browser (Vercel response cap ~4.5 MB).
 */
import { kvIncr } from "../utils.js";

const SA_BASE = "https://api.scrapeatlas.com";

function stripEnvKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/(\\[rn])+$/, "");
}

export function getScrapeAtlasKey() {
  return stripEnvKey(process.env.SCRAPE_ATLAS_API_KEY);
}

export function isScrapeAtlasConfigured() {
  return getScrapeAtlasKey().length > 0;
}

export class ScrapeAtlasError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "ScrapeAtlasError";
    this.code = code;
    this.status = status;
  }
}

function errorFromStatus(status, body) {
  const failureCode = body?.failure?.code || "";
  const failureMessage = body?.failure?.message || "";
  if (status === 401) {
    return new ScrapeAtlasError(
      "SA_UNAUTHORIZED",
      "Scrape Atlas rejected the API key. The site owner has been notified.",
      502
    );
  }
  if (status === 404) {
    return new ScrapeAtlasError(
      "SA_NOT_FOUND",
      "Scrape Atlas found nothing for that input.",
      404
    );
  }
  if (status === 429 || failureCode === "upstream_rate_limited") {
    return new ScrapeAtlasError(
      "SA_RATE_LIMITED",
      "The data source is rate limited right now. Please try again in a minute. No credits were charged.",
      429
    );
  }
  if (status === 503 || failureCode === "busy") {
    return new ScrapeAtlasError(
      "SA_BUSY",
      "Scrape Atlas is busy right now. Please try again shortly. No credits were charged.",
      503
    );
  }
  if (status === 504 || failureCode === "timeout") {
    return new ScrapeAtlasError(
      "SA_TIMEOUT",
      "The data source took too long to answer. Please try again. No credits were charged.",
      504
    );
  }
  const detail = failureMessage ? ` (${failureMessage})` : "";
  return new ScrapeAtlasError(
    "SA_UPSTREAM_ERROR",
    `Scrape Atlas could not complete that request${detail}. No credits were charged.`,
    502
  );
}

/**
 * Count one SA call in the server-side ledger. Fire-and-forget: a ledger
 * failure must never fail the user's request.
 */
export function logSaCall(tool, endpoint, success) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const calls = [
      kvIncr("sa_ledger:total"),
      kvIncr(`sa_ledger:day:${day}`),
      kvIncr(`sa_ledger:tool:${tool || "unknown"}`),
      kvIncr(`sa_ledger:endpoint:${(endpoint || "unknown").replace(/[^a-z0-9/_-]/gi, "_")}`)
    ];
    if (!success) calls.push(kvIncr("sa_ledger:failed"));
    Promise.all(calls).catch(() => {});
  } catch {
    // Ledger is best-effort only.
  }
}

/**
 * Call a Scrape Atlas GET endpoint and return the parsed JSON body.
 * Throws ScrapeAtlasError on any failure (including success:false bodies).
 * options: { tool (ledger label), timeoutMs (default 8000), params (object) }
 * The returned body always carries { status, coverage, fetchedAt } when SA
 * provides them; callers surface coverage.complete === false to the user
 * instead of presenting partial data as complete.
 */
export async function saGet(path, options = {}) {
  const tool = options.tool || "unknown";
  const timeoutMs = options.timeoutMs || 8000;
  const key = getScrapeAtlasKey();
  if (!key) {
    throw new ScrapeAtlasError(
      "SA_NOT_CONFIGURED",
      "Scrape Atlas is not configured on this site yet.",
      502
    );
  }

  const url = new URL(path.startsWith("http") ? path : `${SA_BASE}${path}`);
  for (const [name, value] of Object.entries(options.params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    logSaCall(tool, path, false);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ScrapeAtlasError(
        "SA_TIMEOUT",
        "The data source took too long to answer. Please try again. No credits were charged.",
        504
      );
    }
    throw new ScrapeAtlasError(
      "SA_UPSTREAM_ERROR",
      "Could not reach Scrape Atlas. Please try again. No credits were charged.",
      502
    );
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.success === false) {
    logSaCall(tool, path, false);
    throw errorFromStatus(response.status, body);
  }

  logSaCall(tool, path, true);
  return body;
}

/** Trim a value to a short plain string for UI responses. */
export function saText(value, maxLen = 600) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, maxLen);
}

/** Null-safe integer: SA counts are null when the About panel or the
 *  video extras could not be read. Callers treat a missing count as 0
 *  and disclose the gap through coverage warnings, never as a real 0
 *  the user would mistake for measured data. */
export function saNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Map a parseChannelIdFromUrl() spec onto youtube/channel query params.
 * channelId / handle / forUsername map one-to-one; /user/ and /c/ forms
 * and full channel URLs go through the url param, which the endpoint
 * documents as accepting /channel/UC..., /user/name, /c/name and legacy
 * youtube.com/name links. A bare non-URL value is tried as a handle.
 */
export function saChannelParams(spec, input) {
  if (!spec) return { url: input };
  if (spec.type === "channelId") return { channelId: spec.value };
  if (spec.type === "handle") {
    return { handle: spec.value.startsWith("@") ? spec.value : `@${spec.value}` };
  }
  if (spec.type === "username") return { forUsername: spec.value };
  if (spec.type === "custom") return { url: `https://www.youtube.com/c/${spec.value}` };
  if (/^https?:\/\//i.test(String(input || "").trim())) return { url: String(input).trim() };
  return { handle: `@${String(spec.value || "").replace(/^@/, "")}` };
}

/**
 * Fetch one channel record from Scrape Atlas and return the raw body.
 * This single call serves as both the handle resolve and the channel
 * stats fetch, so handlers must not also call resolveChannelId() (which
 * would spend a second SA call resolving the same channel). Throws a
 * plain Error("Channel not found.") when SA returns no channelId.
 */
export async function fetchSaChannel(spec, input, tool) {
  const body = await saGet("/v1/youtube/channel", {
    tool,
    timeoutMs: 8000,
    params: saChannelParams(spec, input)
  });
  if (!body || typeof body.channelId !== "string" || !body.channelId) {
    throw new Error("Channel not found.");
  }
  return body;
}

/**
 * Parse a youtube/channel joinedDateText ("Joined Jul 30, 2019") into an
 * ISO date string. Returns null when the text is missing or unparseable
 * (About panel unavailable); callers keep the field null rather than
 * inventing a date.
 */
export function parseSaJoinedDate(joinedDateText) {
  if (!joinedDateText) return null;
  const cleaned = String(joinedDateText).replace(/^Joined\s+/i, "").trim();
  const ms = Date.parse(cleaned);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Largest avatar source URL from a youtube/channel body, or "". */
export function saChannelAvatarUrl(channel) {
  const sources = channel?.avatar?.image?.sources;
  if (!Array.isArray(sources) || !sources.length) return "";
  let best = sources[0];
  for (const s of sources) {
    if (Number(s?.width || 0) > Number(best?.width || 0)) best = s;
  }
  return best?.url || "";
}

/**
 * Normalize one youtube/channel-videos item onto the fields the handlers
 * compute from. Without includeExtras, description/likeCount/commentCount
 * are null in the SA body and come back as "" / 0 here; publishDate is
 * the exact ISO date (extras only), publishedTime the computed one.
 */
export function mapSaChannelVideo(video) {
  return {
    videoId: video?.id || "",
    title: video?.title || "",
    description: video?.description ?? "",
    publishedAt: video?.publishDate || video?.publishedTime || "",
    viewCount: saNumber(video?.viewCountInt),
    likeCount: saNumber(video?.likeCountInt),
    commentCount: saNumber(video?.commentCountInt)
  };
}

/** Collect SA coverage warnings into a deduped list. */
export function collectSaWarnings(body, warnings) {
  if (Array.isArray(body?.coverage?.warnings)) {
    for (const warning of body.coverage.warnings) {
      if (warning && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  return warnings;
}
